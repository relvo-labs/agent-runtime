/**
 * Route table: the one place an HTTP request becomes an SDK call.
 *
 * Every mutating route builds its command from named, individually validated
 * fields (`../commands.ts`) plus this app's own fixed policy — never from the
 * raw request body. Every route answers through `AgentExecutor`/`AgentRuntime`
 * methods directly, so the receipt, snapshot, or event page a caller sees is
 * exactly what the SDK produced, not a shape this app invented.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SequenceSchema, SessionIdSchema, type SessionId } from '@relvo-labs/agent-protocol';
import type { EventSubscription } from '@relvo-labs/agent-runtime';

import type { ReferenceAppRuntime } from '../runtime-factory.ts';
import {
  readCommandId,
  readIfRunActive,
  readOptionalReason,
  readPathSegment,
  readProviderId,
  readTurnText,
  type FieldResult,
} from '../commands.ts';
import { readJsonBody } from './json-body.ts';
import { pipeSubscriptionToSse } from './sse.ts';
import { isStaticAssetPath, readStaticAsset } from './static-assets.ts';
import { checkTransport, CSRF_HEADER_NAME } from './security.ts';

export type RouteContext = {
  readonly app: ReferenceAppRuntime;
  readonly maxRequestBodyBytes: number;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  });
  response.end(text);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

const FIELD_FAILED = Symbol('field_failed');

/**
 * Unwraps one field result, or writes the failure response and returns the
 * `FIELD_FAILED` sentinel. A dedicated sentinel — rather than `undefined` —
 * is required because several fields (`reason`, `ifRunActive`) are legally
 * absent, so `undefined` is itself a valid successful value.
 */
function readField<T>(response: ServerResponse, result: FieldResult<T>): T | typeof FIELD_FAILED {
  if (!result.ok) {
    sendError(response, result.error.status, 'invalid_request', result.error.message);
    return FIELD_FAILED;
  }
  return result.value;
}

async function readBodyOrRespond(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<unknown | undefined> {
  const result = await readJsonBody(request, maxBytes);
  if (!result.ok) {
    sendError(response, result.status, 'invalid_request', result.message);
    return undefined;
  }
  return result.value;
}

function parseSessionId(raw: string, response: ServerResponse): SessionId | undefined {
  const parsed = SessionIdSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(response, 400, 'invalid_request', 'malformed session id');
    return undefined;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

async function handleListProviders(context: RouteContext, response: ServerResponse): Promise<void> {
  sendJson(response, 200, { providers: context.app.runtime.listProviders() });
}

async function handleOpenSession(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const commandId = readField(response, readCommandId(body));
  if (commandId === FIELD_FAILED) return;
  const providerId = readField(response, readProviderId(body));
  if (providerId === FIELD_FAILED) return;

  const receipt = await context.app.runtime.openSession({
    type: 'open_session',
    commandId,
    providerId,
    // This app always owns a fresh, disposable managed workspace. A browser
    // can never name a path or borrow an existing directory (see SECURITY.md).
    workspace: { kind: 'managed' },
  });
  sendJson(response, 200, { receipt });
}

async function handleGetSession(context: RouteContext, sessionId: SessionId, response: ServerResponse): Promise<void> {
  const snapshot = await context.app.runtime.getSession(sessionId);
  if (snapshot === undefined) {
    sendError(response, 404, 'unknown_session', `no session \`${sessionId}\``);
    return;
  }
  sendJson(response, 200, { snapshot });
}

async function handleReadEvents(
  context: RouteContext,
  sessionId: SessionId,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const fromParam = url.searchParams.get('fromSequence') ?? '0';
  const fromParsed = SequenceSchema.safeParse(Number.parseInt(fromParam, 10));
  if (!fromParsed.success) {
    sendError(response, 400, 'invalid_request', 'fromSequence must be a non-negative integer');
    return;
  }
  const page = await context.app.runtime.readEvents(sessionId, fromParsed.data);
  sendJson(response, 200, { page });
}

async function handleSubscribe(
  context: RouteContext,
  sessionId: SessionId,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const snapshot = await context.app.runtime.getSession(sessionId);
  if (snapshot === undefined) {
    sendError(response, 404, 'unknown_session', `no session \`${sessionId}\``);
    return;
  }
  const fromParam = url.searchParams.get('fromSequence') ?? '0';
  const fromParsed = SequenceSchema.safeParse(Number.parseInt(fromParam, 10));
  if (!fromParsed.success) {
    sendError(response, 400, 'invalid_request', 'fromSequence must be a non-negative integer');
    return;
  }
  let subscription: EventSubscription;
  try {
    subscription = context.app.runtime.subscribe({ sessionId, fromSequence: fromParsed.data });
  } catch {
    sendError(response, 400, 'invalid_request', 'could not open a subscription for this session');
    return;
  }
  await pipeSubscriptionToSse(subscription, response);
}

async function handleSubmitTurn(
  context: RouteContext,
  sessionId: SessionId,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const commandId = readField(response, readCommandId(body));
  if (commandId === FIELD_FAILED) return;
  const text = readField(response, readTurnText(body));
  if (text === FIELD_FAILED) return;

  const receipt = await context.app.runtime.submitTurn({
    type: 'submit_turn',
    commandId,
    sessionId,
    input: { parts: [{ type: 'text', text }] },
  });
  // The scripted-demo lane never advances on its own (see runtime-factory.ts).
  // A real provider profile paces itself and this call is then a no-op.
  await context.app.advanceScriptedProviders();
  sendJson(response, 200, { receipt });
}

async function handleInterruptRun(
  context: RouteContext,
  sessionId: SessionId,
  runIdRaw: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const commandId = readField(response, readCommandId(body));
  if (commandId === FIELD_FAILED) return;
  const reason = readField(response, readOptionalReason(body));
  if (reason === FIELD_FAILED) return;

  const receipt = await context.app.runtime.interruptRun({
    type: 'interrupt_run',
    commandId,
    sessionId,
    runId: runIdRaw,
    ...(reason === undefined ? {} : { reason }),
  });
  await context.app.advanceScriptedProviders();
  sendJson(response, 200, { receipt });
}

async function handleCloseSession(
  context: RouteContext,
  sessionId: SessionId,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const commandId = readField(response, readCommandId(body));
  if (commandId === FIELD_FAILED) return;
  const ifRunActive = readField(response, readIfRunActive(body));
  if (ifRunActive === FIELD_FAILED) return;

  const receipt = await context.app.runtime.closeSession({
    type: 'close_session',
    commandId,
    sessionId,
    ...(ifRunActive === undefined ? {} : { ifRunActive }),
  });
  sendJson(response, 200, { receipt });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/u;
const EVENTS_PATH = /^\/api\/sessions\/([^/]+)\/events$/u;
const SUBSCRIBE_PATH = /^\/api\/sessions\/([^/]+)\/subscribe$/u;
const TURNS_PATH = /^\/api\/sessions\/([^/]+)\/turns$/u;
const INTERRUPT_PATH = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/interrupt$/u;
const CLOSE_PATH = /^\/api\/sessions\/([^/]+)\/close$/u;

export async function handleRequest(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://reference-app.internal');
  const pathname = url.pathname;

  const isApiRoute = pathname.startsWith('/api/');
  const security = checkTransport({
    host: request.headers.host,
    origin: request.headers.origin,
    csrf: request.headers[CSRF_HEADER_NAME],
    // Static assets are reachable by a plain browser navigation, which cannot
    // set a custom header; every data-bearing API route requires it.
    requireCsrf: isApiRoute,
  });
  if (!security.ok) {
    sendError(response, security.status, security.code, security.message);
    return;
  }

  if (!isApiRoute) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendError(response, 405, 'method_not_allowed', 'only GET is supported for this path');
      return;
    }
    if (isStaticAssetPath(pathname)) {
      const asset = await readStaticAsset(pathname);
      if (asset === undefined) {
        sendError(response, 404, 'not_found', 'no such asset');
        return;
      }
      response.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': String(Buffer.byteLength(asset.body)),
      });
      response.end(method === 'HEAD' ? undefined : asset.body);
      return;
    }
    sendError(response, 404, 'not_found', 'no such path');
    return;
  }

  if (method === 'GET' && pathname === '/api/providers') return handleListProviders(context, response);
  if (method === 'POST' && pathname === '/api/sessions') return handleOpenSession(context, request, response);

  const sessionMatch = SESSION_PATH.exec(pathname);
  if (method === 'GET' && sessionMatch) {
    const segment = readPathSegment(sessionMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleGetSession(context, sessionId, response);
  }

  const eventsMatch = EVENTS_PATH.exec(pathname);
  if (method === 'GET' && eventsMatch) {
    const segment = readPathSegment(eventsMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleReadEvents(context, sessionId, url, response);
  }

  const subscribeMatch = SUBSCRIBE_PATH.exec(pathname);
  if (method === 'GET' && subscribeMatch) {
    const segment = readPathSegment(subscribeMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleSubscribe(context, sessionId, url, response);
  }

  const turnsMatch = TURNS_PATH.exec(pathname);
  if (method === 'POST' && turnsMatch) {
    const segment = readPathSegment(turnsMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleSubmitTurn(context, sessionId, request, response);
  }

  const interruptMatch = INTERRUPT_PATH.exec(pathname);
  if (method === 'POST' && interruptMatch) {
    const sessionSegment = readPathSegment(interruptMatch[1], 'sessionId');
    if (!sessionSegment.ok) {
      return sendError(response, sessionSegment.error.status, 'invalid_request', sessionSegment.error.message);
    }
    const runSegment = readPathSegment(interruptMatch[2], 'runId');
    if (!runSegment.ok)
      return sendError(response, runSegment.error.status, 'invalid_request', runSegment.error.message);
    const sessionId = parseSessionId(sessionSegment.value, response);
    if (sessionId === undefined) return;
    return handleInterruptRun(context, sessionId, runSegment.value, request, response);
  }

  const closeMatch = CLOSE_PATH.exec(pathname);
  if (method === 'POST' && closeMatch) {
    const segment = readPathSegment(closeMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleCloseSession(context, sessionId, request, response);
  }

  sendError(response, 404, 'not_found', 'no such route');
}
