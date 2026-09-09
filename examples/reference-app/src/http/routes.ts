/**
 * Route table: the one place an HTTP request becomes an SDK call.
 *
 * Every mutating route builds its command from named, individually validated
 * fields (`../commands.ts`) plus this app's own fixed policy — never from the
 * raw request body, and never tolerating an unrecognised field silently (see
 * `readKnownFields`). Every route answers through `AgentExecutor`/
 * `AgentRuntime` methods directly, so the receipt, snapshot, or event page a
 * caller sees is exactly what the SDK produced, not a shape this app invented.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isAgentRuntimeError,
  RunIdSchema,
  SequenceSchema,
  SessionIdSchema,
  type SessionId,
} from '@relvo-labs/agent-protocol';
import type { EventSubscription } from '@relvo-labs/agent-runtime';

import type { ReferenceAppRuntime } from '../runtime-factory.ts';
import { SCRIPTED_FAILURE_TRIGGER_TEXT } from '../providers/scripted.ts';
import {
  readCommandId,
  readIfRunActive,
  readKnownFields,
  readOptionalReason,
  readPathSegment,
  readProviderId,
  readTurnText,
  type FieldResult,
} from '../commands.ts';
import { readJsonBody } from './json-body.ts';
import { pipeSubscriptionToSse } from './sse.ts';
import { parseStrictEnum, parseStrictNonNegativeInt } from './query.ts';
import { isStaticAssetPath, readStaticAsset } from './static-assets.ts';
import { applyBaselineHeaders, checkTransport, CSRF_HEADER_NAME } from './security.ts';

export type RouteContext = {
  readonly app: ReferenceAppRuntime;
  readonly maxRequestBodyBytes: number;
  /** This server's own actual bound port (read back after `listen()`). */
  readonly expectedPort: () => number;
  /** Registers an in-flight SSE pipe's completion promise (see `app.ts`). */
  readonly trackSseStream: (promise: Promise<void>) => void;
};

/**
 * Some `AgentExecutor` commands (`closeSession`, when cleanup fails) reject
 * their *promise* rather than returning a `disposition: "rejected"` receipt —
 * that is how the SDK distinguishes "no receipt was ever persisted, retry the
 * same commandId" from an ordinary business rejection. This app still owes
 * the caller a bounded, typed JSON answer either way: a thrown
 * `AgentRuntimeError` is this app's own generic-500 fallback otherwise, which
 * would incorrectly imply an unexpected bug rather than a named, possibly
 * retryable SDK-level failure.
 */
async function callRuntimeCommand<T>(
  response: ServerResponse,
  run: () => Promise<T>,
): Promise<{ readonly value: T } | undefined> {
  try {
    return { value: await run() };
  } catch (error) {
    if (isAgentRuntimeError(error)) {
      const status = error.error.retryable ? 503 : 500;
      sendJson(response, status, { error: error.error });
      return undefined;
    }
    throw error;
  }
}

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

/** Enforces the strict field allowlist before any individual field is read. */
function requireKnownFields(
  response: ServerResponse,
  body: unknown,
  allowed: readonly string[],
): Record<string, unknown> | typeof FIELD_FAILED {
  return readField(response, readKnownFields(body, allowed));
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
  const fields = requireKnownFields(response, body, ['commandId', 'providerId']);
  if (fields === FIELD_FAILED) return;
  const commandId = readField(response, readCommandId(fields));
  if (commandId === FIELD_FAILED) return;
  const providerId = readField(response, readProviderId(fields));
  if (providerId === FIELD_FAILED) return;

  // Self-heal before evaluating admission: a session that failed or was
  // closed by a path other than this route (runtime-driven failure, or
  // `shutdown()`) must not permanently pin the one-session slot.
  await context.app.sessionAdmission.refresh((id) => context.app.runtime.getSession(id));

  const admission = context.app.sessionAdmission.beginOpen(commandId);
  if (!admission.ok) {
    if (admission.reason === 'session_already_open') {
      sendError(
        response,
        409,
        'session_already_open',
        `this app allows only one active session at a time (\`${admission.sessionId ?? ''}\` is open); close it before opening another`,
      );
    } else {
      sendError(response, 409, 'open_in_flight', 'another open_session attempt is already in flight');
    }
    return;
  }

  let receipt;
  try {
    receipt = await context.app.runtime.openSession({
      type: 'open_session',
      commandId,
      providerId,
      // This app always owns a fresh, disposable managed workspace. A browser
      // can never name a path or borrow an existing directory (see SECURITY.md).
      workspace: { kind: 'managed' },
    });
  } catch (error) {
    context.app.sessionAdmission.settleOpen(commandId, undefined);
    throw error;
  }

  if (receipt.disposition !== 'rejected' && receipt.result?.type === 'session_opened') {
    context.app.sessionAdmission.settleOpen(commandId, { sessionId: receipt.result.sessionId });
  } else {
    context.app.sessionAdmission.settleOpen(commandId, undefined);
  }
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
  const fromParsed = parseStrictNonNegativeInt(url.searchParams.get('fromSequence'), 0);
  if (!fromParsed.ok) {
    sendError(response, 400, 'invalid_request', `fromSequence: ${fromParsed.message}`);
    return;
  }
  const fromSequence = SequenceSchema.safeParse(fromParsed.value);
  if (!fromSequence.success) {
    sendError(response, 400, 'invalid_request', 'fromSequence must be a non-negative integer');
    return;
  }
  const snapshot = await context.app.runtime.getSession(sessionId);
  if (snapshot === undefined) {
    sendError(response, 404, 'unknown_session', `no session \`${sessionId}\``);
    return;
  }
  const page = await context.app.runtime.readEvents(sessionId, fromSequence.data);
  sendJson(response, 200, { page });
}

const OVERFLOW_POLICIES = ['signal_and_close', 'signal_and_skip'] as const;

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
  const fromParsed = parseStrictNonNegativeInt(url.searchParams.get('fromSequence'), 0);
  if (!fromParsed.ok) {
    sendError(response, 400, 'invalid_request', `fromSequence: ${fromParsed.message}`);
    return;
  }
  const fromSequence = SequenceSchema.safeParse(fromParsed.value);
  if (!fromSequence.success) {
    sendError(response, 400, 'invalid_request', 'fromSequence must be a non-negative integer');
    return;
  }
  const bufferSizeParsed = parseStrictNonNegativeInt(url.searchParams.get('bufferSize'), 1024);
  if (!bufferSizeParsed.ok || bufferSizeParsed.value < 8 || bufferSizeParsed.value > 65_536) {
    sendError(response, 400, 'invalid_request', 'bufferSize must be an integer in [8, 65536]');
    return;
  }
  const overflowPolicyParsed = parseStrictEnum(
    url.searchParams.get('overflowPolicy'),
    OVERFLOW_POLICIES,
    'signal_and_close',
  );
  if (!overflowPolicyParsed.ok) {
    sendError(response, 400, 'invalid_request', `overflowPolicy: ${overflowPolicyParsed.message}`);
    return;
  }

  let subscription: EventSubscription;
  try {
    subscription = context.app.runtime.subscribe({
      sessionId,
      fromSequence: fromSequence.data,
      bufferSize: bufferSizeParsed.value,
      overflowPolicy: overflowPolicyParsed.value,
    });
  } catch {
    sendError(response, 400, 'invalid_request', 'could not open a subscription for this session');
    return;
  }
  const pipe = pipeSubscriptionToSse(subscription, response);
  context.trackSseStream(pipe);
  await pipe;
}

async function handleSubmitTurn(
  context: RouteContext,
  sessionId: SessionId,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const fields = requireKnownFields(response, body, ['commandId', 'text']);
  if (fields === FIELD_FAILED) return;
  const commandId = readField(response, readCommandId(fields));
  if (commandId === FIELD_FAILED) return;
  const text = readField(response, readTurnText(fields));
  if (text === FIELD_FAILED) return;

  const receipt = await context.app.runtime.submitTurn({
    type: 'submit_turn',
    commandId,
    sessionId,
    input: { parts: [{ type: 'text', text }] },
  });
  // Deliberately no automatic `advanceScriptedDemo()` call here — see its
  // doc comment in `runtime-factory.ts`. The run genuinely stays in flight
  // (state `running`, undrained) until an explicit "advance script" request
  // or an `interrupt_run` reaches it, both through this same HTTP transport.
  sendJson(response, 200, { receipt });
}

async function handleInterruptRun(
  context: RouteContext,
  sessionId: SessionId,
  runId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const fields = requireKnownFields(response, body, ['commandId', 'reason']);
  if (fields === FIELD_FAILED) return;
  const commandId = readField(response, readCommandId(fields));
  if (commandId === FIELD_FAILED) return;
  const reason = readField(response, readOptionalReason(fields));
  if (reason === FIELD_FAILED) return;

  const receipt = await context.app.runtime.interruptRun({
    type: 'interrupt_run',
    commandId,
    sessionId,
    runId,
    ...(reason === undefined ? {} : { reason }),
  });
  sendJson(response, 200, { receipt });
}

async function handleAdvanceScript(
  context: RouteContext,
  sessionId: SessionId,
  response: ServerResponse,
): Promise<void> {
  const snapshot = await context.app.runtime.getSession(sessionId);
  if (snapshot === undefined) {
    sendError(response, 404, 'unknown_session', `no session \`${sessionId}\``);
    return;
  }
  if (snapshot.session.providerId !== context.app.scriptedDemoProviderId) {
    sendError(
      response,
      400,
      'not_scripted_provider',
      'this session is not using the scripted-demo provider, which is the only one this endpoint paces',
    );
    return;
  }
  await context.app.advanceScriptedDemo();
  const refreshed = await context.app.runtime.getSession(sessionId);
  sendJson(response, 200, { snapshot: refreshed });
}

async function handleCloseSession(
  context: RouteContext,
  sessionId: SessionId,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBodyOrRespond(request, response, context.maxRequestBodyBytes);
  if (body === undefined) return;
  const fields = requireKnownFields(response, body, ['commandId', 'ifRunActive']);
  if (fields === FIELD_FAILED) return;
  const commandId = readField(response, readCommandId(fields));
  if (commandId === FIELD_FAILED) return;
  const ifRunActive = readField(response, readIfRunActive(fields));
  if (ifRunActive === FIELD_FAILED) return;

  const outcome = await callRuntimeCommand(response, () =>
    context.app.runtime.closeSession({
      type: 'close_session',
      commandId,
      sessionId,
      ...(ifRunActive === undefined ? {} : { ifRunActive }),
    }),
  );
  if (outcome === undefined) return; // a retryable/typed failure was already answered
  const receipt = outcome.value;
  const closed = receipt.disposition !== 'rejected' && receipt.result?.type === 'session_closed';
  context.app.sessionAdmission.noteCloseOutcome(sessionId, closed);
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
const ADVANCE_SCRIPT_PATH = /^\/api\/sessions\/([^/]+)\/advance-script$/u;
const CLOSE_PATH = /^\/api\/sessions\/([^/]+)\/close$/u;

/** This module's one convenience export for the UI (avoids a magic string). */
export { SCRIPTED_FAILURE_TRIGGER_TEXT };

const MAX_URL_LENGTH = 2048;

export async function handleRequest(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Applied first, unconditionally — including on every early-return failure
  // below (URI-too-long, Host/Origin/CSRF rejection). A rejection response
  // still carries `Cache-Control: no-store`/`X-Content-Type-Options`/framing
  // protection; those are not only for the happy path.
  applyBaselineHeaders(response);

  const method = request.method ?? 'GET';
  const rawUrl = request.url ?? '/';
  if (rawUrl.length > MAX_URL_LENGTH) {
    sendError(response, 414, 'uri_too_long', 'request URI exceeds this app’s bound');
    return;
  }
  const url = new URL(rawUrl, 'http://reference-app.internal');
  const pathname = url.pathname;

  const isApiRoute = pathname.startsWith('/api/');
  const security = checkTransport({
    host: request.headers.host,
    origin: request.headers.origin,
    csrf: request.headers[CSRF_HEADER_NAME],
    expectedPort: context.expectedPort(),
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

  const advanceMatch = ADVANCE_SCRIPT_PATH.exec(pathname);
  if (method === 'POST' && advanceMatch) {
    const segment = readPathSegment(advanceMatch[1], 'sessionId');
    if (!segment.ok) return sendError(response, segment.error.status, 'invalid_request', segment.error.message);
    const sessionId = parseSessionId(segment.value, response);
    if (sessionId === undefined) return;
    return handleAdvanceScript(context, sessionId, response);
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
    const runId = RunIdSchema.safeParse(runSegment.value);
    if (!runId.success) return sendError(response, 400, 'invalid_request', 'malformed run id');
    return handleInterruptRun(context, sessionId, runId.data, request, response);
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
