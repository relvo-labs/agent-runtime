/**
 * Vertical-slice contract test: a real HTTP client drives this app's actual
 * Node server, which drives a real `AgentExecutor` (via `createAgentRuntime`)
 * composed with the public scripted-demo provider. Nothing here injects a
 * fake transport or fabricates an event — every receipt and every streamed
 * message is produced by the SDK itself.
 *
 * Further adversarial coverage (duplicate/conflict matrices, controlled
 * in-flight interrupt via the scripted controller, overflow/backfill,
 * cleanup-failure retry, and the full negative security matrix) is tracked as
 * pending follow-up work in `progress.md`; this file proves the coherent
 * end-to-end slice plus one representative case from each required category.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReferenceApp, type ReferenceApp } from '../src/app.ts';
import type { ReferenceAppConfig } from '../src/config.ts';

const CSRF_HEADER_NAME = 'x-relvo-reference-app';
const CSRF_HEADER_VALUE = '1';

type JsonRecord = Record<string, unknown>;

function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe('reference-app: credential-free scripted vertical slice', () => {
  let app: ReferenceApp;
  let baseUrl: string;
  let workspaceBase: string;

  beforeAll(async () => {
    workspaceBase = mkdtempSync(join(tmpdir(), 'relvo-reference-app-test-'));
    const config: ReferenceAppConfig = {
      host: '127.0.0.1',
      port: 0,
      workspaceBaseDirectory: workspaceBase,
      maxRequestBodyBytes: 4096,
    };
    app = createReferenceApp(config);
    const { host, port } = await app.listen();
    baseUrl = `http://${host}:${String(port)}`;
  });

  afterAll(async () => {
    await app.close();
    rmSync(workspaceBase, { recursive: true, force: true });
  });

  async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: JsonRecord }> {
    const headers: Record<string, string> = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as JsonRecord) : {} };
  }

  /** Collects every SSE message for `sessionId` until `until` returns true. */
  async function collectSubscription(
    sessionId: string,
    until: (messages: readonly JsonRecord[]) => boolean,
  ): Promise<{ messages: JsonRecord[]; stop: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/subscribe?fromSequence=0`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const messages: JsonRecord[] = [];
    let buffer = '';

    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            messages.push(JSON.parse(line.slice('data:'.length).trim()) as JsonRecord);
          }
        }
        if (until(messages)) return;
      }
    })();

    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([pump, deadline]);
    return { messages, stop: () => controller.abort() };
  }

  it('lists the credential-free scripted-demo provider with an honest capability descriptor', async () => {
    const { status, body } = await call('/api/providers');
    expect(status).toBe(200);
    const providers = body.providers as JsonRecord[];
    const scripted = providers.find((p) => p.providerId === 'scripted-demo');
    expect(scripted).toBeDefined();
    const run = scripted!.run as JsonRecord;
    expect((run.interrupt as JsonRecord).mode).toBe('immediate');
    expect((scripted!.interaction as JsonRecord).approval).toMatchObject({ supported: false });
  });

  it('runs the full session lifecycle end to end through the real runtime', async () => {
    // 1. open_session — a real workspace lease and provider session are acquired.
    const openCommandId = commandId('open');
    const opened = await call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'scripted-demo' },
    });
    expect(opened.status).toBe(200);
    const openReceipt = opened.body.receipt as JsonRecord;
    expect(openReceipt.disposition).toBe('applied');
    const sessionId = (openReceipt.result as JsonRecord).sessionId as string;
    expect(sessionId).toMatch(/^ses_/);

    // Exact retry: same command id, same payload -> duplicate, same result.
    const retried = await call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'scripted-demo' },
    });
    const retriedReceipt = retried.body.receipt as JsonRecord;
    expect(retriedReceipt.disposition).toBe('duplicate');
    expect((retriedReceipt.result as JsonRecord).sessionId).toBe(sessionId);

    // Changed intent under the same command id -> a conflict, not a mutation.
    const conflicted = await call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'does-not-exist' },
    });
    const conflictReceipt = conflicted.body.receipt as JsonRecord;
    expect(conflictReceipt.disposition).toBe('rejected');
    expect((conflictReceipt.error as JsonRecord).code).toBe('command_id_conflict');

    // 2. subscribe from sequence 0, replay-then-live, before any turn exists.
    const subscription = await collectSubscription(sessionId, (messages) =>
      messages.some((m) => m.type === 'caught_up'),
    );
    expect(subscription.messages.some((m) => m.type === 'caught_up')).toBe(true);

    // 3. submit_turn — a real run against the scripted provider's public controller.
    const turnCommandId = commandId('turn');
    const submitted = await call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: turnCommandId, text: 'hello from the vertical-slice test' },
    });
    expect(submitted.status).toBe(200);
    const turnReceipt = submitted.body.receipt as JsonRecord;
    expect(turnReceipt.disposition).toBe('applied');
    const turnResult = turnReceipt.result as JsonRecord;
    expect(turnResult.turnId).toMatch(/^trn_/);
    const runId = turnResult.runId as string;
    expect(runId).toMatch(/^run_/);

    // 4. the run already completed (drained synchronously) by the time the
    //    receipt above returned. Reading forward proves the transport
    //    actually carried real streamed events, not a fabricated summary.
    const afterTurn = await collectSubscription(sessionId, (messages) =>
      messages.some(
        (m) =>
          m.type === 'event' &&
          (m.event as JsonRecord).payload &&
          ((m.event as JsonRecord).payload as JsonRecord).type === 'run.finished',
      ),
    );
    const deltas = afterTurn.messages
      .filter((m) => m.type === 'event')
      .map((m) => (m.event as JsonRecord).payload as JsonRecord)
      .filter((payload) => payload.type === 'run.message_delta')
      .map((payload) => payload.text as string)
      .join('');
    expect(deltas).toContain('Scripted demo provider received your message.');
    const finished = afterTurn.messages
      .map((m) => (m.type === 'event' ? ((m.event as JsonRecord).payload as JsonRecord) : undefined))
      .find((payload) => payload?.type === 'run.finished');
    expect((finished!.termination as JsonRecord).outcome).toBe('succeeded');
    afterTurn.stop();

    // 5. getSession / readEvents projections agree with what streamed.
    const snapshot = await call(`/api/sessions/${sessionId}`);
    expect(snapshot.status).toBe(200);
    const snapshotBody = snapshot.body.snapshot as JsonRecord;
    expect((snapshotBody.session as JsonRecord).state).toBe('ready');
    expect((snapshotBody.turns as JsonRecord[])[0]!.state).toBe('completed');
    expect((snapshotBody.runs as JsonRecord[])[0]!.state).toBe('succeeded');

    const events = await call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    expect(events.status).toBe(200);
    const page = events.body.page as JsonRecord;
    expect((page.events as unknown[]).length).toBeGreaterThan(0);
    expect(page.nextSequence).toBeGreaterThan(0);

    // 6. a second, sequential turn on the same session retains the session.
    const secondTurnCommandId = commandId('turn');
    const secondSubmitted = await call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: secondTurnCommandId, text: 'a second message' },
    });
    const secondReceipt = secondSubmitted.body.receipt as JsonRecord;
    expect(secondReceipt.disposition).toBe('applied');
    expect((secondReceipt.result as JsonRecord).turnId).not.toBe(turnResult.turnId);

    // 7. interrupting an already-terminal run is truthfully reported, not
    //    invented: `delivered: false`, and the command still succeeds.
    const interruptCommandId = commandId('interrupt');
    const interrupted = await call(`/api/sessions/${sessionId}/runs/${runId}/interrupt`, {
      method: 'POST',
      body: { commandId: interruptCommandId },
    });
    const interruptReceipt = interrupted.body.receipt as JsonRecord;
    expect(interruptReceipt.disposition).toBe('applied');
    expect((interruptReceipt.result as JsonRecord).delivered).toBe(false);

    // 8. close_session releases the provider session and the managed workspace.
    const workspaceRoot = (snapshotBody.session as JsonRecord).workspace as JsonRecord;
    const closeCommandId = commandId('close');
    const closed = await call(`/api/sessions/${sessionId}/close`, {
      method: 'POST',
      body: { commandId: closeCommandId },
    });
    const closeReceipt = closed.body.receipt as JsonRecord;
    expect(closeReceipt.disposition).toBe('applied');
    expect((closeReceipt.result as JsonRecord).interruptedActiveRun).toBe(false);
    expect(existsSync(workspaceRoot.root as string)).toBe(false);

    const closedSnapshot = await call(`/api/sessions/${sessionId}`);
    expect((closedSnapshot.body.snapshot as JsonRecord as { session: JsonRecord }).session.state).toBe('closed');
  });

  it('rejects a mutating request that omits the anti-CSRF header', async () => {
    const opened = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: commandId('open'), providerId: 'scripted-demo' }),
    });
    expect(opened.status).toBe(403);
  });

  it('rejects a cross-origin request even though it targets the right host', async () => {
    const { status } = await call('/api/providers', { headers: { origin: 'http://evil.example' } });
    expect(status).toBe(403);
  });

  it('rejects a request whose Host header does not name this loopback server', async () => {
    const address = new URL(baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: address.hostname,
          port: address.port,
          path: '/api/providers',
          method: 'GET',
          headers: { host: 'evil.example:9999', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it('rejects a request body over this app’s bounded size limit', async () => {
    // A syntactically valid but nonexistent session id, so the body-size
    // check (not the id-format check) is what this test exercises.
    const oversizedText = 'x'.repeat(8192);
    const { status } = await call('/api/sessions/ses_0000000000000000/turns', {
      method: 'POST',
      body: { commandId: commandId('turn'), text: oversizedText },
    });
    expect(status).toBe(413);
  });

  it('rejects an unknown provider id with a rejected receipt, not a crash', async () => {
    const { status, body } = await call('/api/sessions', {
      method: 'POST',
      body: { commandId: commandId('open'), providerId: 'no-such-provider' },
    });
    expect(status).toBe(200);
    const receipt = body.receipt as JsonRecord;
    expect(receipt.disposition).toBe('rejected');
    expect((receipt.error as JsonRecord).code).toBe('provider_not_registered');
  });
});
