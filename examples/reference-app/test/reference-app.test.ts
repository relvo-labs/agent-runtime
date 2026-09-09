/**
 * Vertical-slice contract test: a real HTTP client drives this app's actual
 * Node server, which drives a real `AgentExecutor` (via `createAgentRuntime`)
 * composed with the public scripted-demo provider. Nothing here injects a
 * fake transport or fabricates an event — every receipt and every streamed
 * message is produced by the SDK itself.
 *
 * Related suites: `reference-app-interrupt.test.ts` (in-flight interrupt,
 * scripted failure), `reference-app-reconnect.test.ts` (reconnect, overflow,
 * backfill, disconnect-vs-cancel), `reference-app-cleanup.test.ts` (cleanup
 * failure retry, shutdown+SSE cleanup, missing real-provider setup failure).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  commandId,
  openScriptedSession,
  startTestApp,
  type JsonRecord,
  type StartedApp,
} from './helpers.ts';

describe('reference-app: credential-free scripted vertical slice', () => {
  let started: StartedApp;

  beforeAll(async () => {
    started = await startTestApp();
  });

  afterAll(async () => {
    await started.teardown();
  });

  it('lists the credential-free scripted-demo provider with an honest capability descriptor', async () => {
    const { status, body } = await started.call('/api/providers');
    expect(status).toBe(200);
    const providers = body.providers as JsonRecord[];
    const scripted = providers.find((p) => p.providerId === 'scripted-demo');
    expect(scripted).toBeDefined();
    const run = scripted!.run as JsonRecord;
    expect((run.interrupt as JsonRecord).mode).toBe('immediate');
    expect((scripted!.interaction as JsonRecord).approval).toMatchObject({ supported: false });
  });

  it('every JSON API response carries no-store, nosniff and framing-protection headers', async () => {
    function assertBaselineHeaders(headers: Headers) {
      expect(headers.get('cache-control')).toBe('no-store');
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('x-frame-options')).toBe('DENY');
      expect(headers.get('access-control-allow-origin')).toBeNull();
    }
    // The happy path.
    const success = await started.call('/api/providers');
    assertBaselineHeaders(success.headers);

    // A rejection MUST carry the same baseline headers — a 4xx response is
    // still a response an attacker could try to get cached, sniffed, or
    // framed. Three independent rejection paths, all before any route logic:
    // request-URI-too-long, missing anti-CSRF header, and a malformed path
    // segment reaching a route.
    const tooLong = await started.call(`/api/providers?${'x'.repeat(3000)}`);
    expect(tooLong.status).toBe(414);
    assertBaselineHeaders(tooLong.headers);

    const missingCsrf = await fetch(`${started.baseUrl}/api/providers`, { headers: {} });
    expect(missingCsrf.status).toBe(403);
    assertBaselineHeaders(missingCsrf.headers);

    const malformedSession = await started.call('/api/sessions/not-a-real-session-id');
    expect(malformedSession.status).toBe(400);
    assertBaselineHeaders(malformedSession.headers);
  });

  it('runs the full session lifecycle end to end through the real runtime', async () => {
    // 1. open_session — a real workspace lease and provider session are acquired.
    const openCommandId = commandId('open');
    const opened = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'scripted-demo' },
    });
    expect(opened.status).toBe(200);
    const openReceipt = opened.body.receipt as JsonRecord;
    expect(openReceipt.disposition).toBe('applied');
    const sessionId = (openReceipt.result as JsonRecord).sessionId as string;
    expect(sessionId).toMatch(/^ses_/);

    // Exact retry: same command id, same payload -> duplicate, same result.
    const retried = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'scripted-demo' },
    });
    const retriedReceipt = retried.body.receipt as JsonRecord;
    expect(retriedReceipt.disposition).toBe('duplicate');
    expect((retriedReceipt.result as JsonRecord).sessionId).toBe(sessionId);

    // Changed intent under the same command id -> a conflict, not a mutation.
    const conflicted = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: openCommandId, providerId: 'does-not-exist' },
    });
    const conflictReceipt = conflicted.body.receipt as JsonRecord;
    expect(conflictReceipt.disposition).toBe('rejected');
    expect((conflictReceipt.error as JsonRecord).code).toBe('command_id_conflict');

    // A genuinely new, distinct open attempt is blocked while this one is
    // open — this app allows only one active session at a time.
    const secondOpen = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: commandId('open'), providerId: 'scripted-demo' },
    });
    expect(secondOpen.status).toBe(409);
    expect((secondOpen.body.error as JsonRecord).code).toBe('session_already_open');

    // 2. subscribe from sequence 0, replay-then-live, before any turn exists.
    const subscription = await started.collectSubscription(sessionId, (messages) =>
      messages.some((m) => m.type === 'caught_up'),
    );
    expect(subscription.messages.some((m) => m.type === 'caught_up')).toBe(true);

    // 3. submit_turn — a real run against the scripted provider's public controller.
    const turnCommandId = commandId('turn');
    const submitted = await started.call(`/api/sessions/${sessionId}/turns`, {
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

    // The run genuinely has not progressed yet: this app no longer auto-drains
    // the scripted provider after `submit_turn`. Real in-flight interrupt is
    // covered in `reference-app-interrupt.test.ts`; here, advance it forward
    // through the same explicit, labelled HTTP affordance a human would use.
    const midFlight = await started.call(`/api/sessions/${sessionId}`);
    const midRun = (midFlight.body.snapshot as JsonRecord).runs as JsonRecord[];
    expect(midRun[0]!.state).toBe('running');
    expect((midRun[0] as JsonRecord).termination).toBeUndefined();

    const advanced = await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });
    expect(advanced.status).toBe(200);
    expect(((advanced.body.snapshot as JsonRecord).runs as JsonRecord[])[0]!.state).toBe('succeeded');

    // 4. reading forward proves the transport actually carried real streamed
    //    events, not a fabricated summary.
    const afterTurn = await started.collectSubscription(sessionId, (messages) =>
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
    const snapshot = await started.call(`/api/sessions/${sessionId}`);
    expect(snapshot.status).toBe(200);
    const snapshotBody = snapshot.body.snapshot as JsonRecord;
    expect((snapshotBody.session as JsonRecord).state).toBe('ready');
    expect((snapshotBody.turns as JsonRecord[])[0]!.state).toBe('completed');
    expect((snapshotBody.runs as JsonRecord[])[0]!.state).toBe('succeeded');

    const events = await started.call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    expect(events.status).toBe(200);
    const page = events.body.page as JsonRecord;
    expect((page.events as unknown[]).length).toBeGreaterThan(0);
    expect(page.nextSequence).toBeGreaterThan(0);

    // 6. a second, sequential turn on the same session retains the session.
    const secondTurnCommandId = commandId('turn');
    const secondSubmitted = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: secondTurnCommandId, text: 'a second message' },
    });
    const secondReceipt = secondSubmitted.body.receipt as JsonRecord;
    expect(secondReceipt.disposition).toBe('applied');
    expect((secondReceipt.result as JsonRecord).turnId).not.toBe(turnResult.turnId);
    await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });

    // 7. interrupting an already-terminal run is truthfully reported, not
    //    invented: `delivered: false`, and the command still succeeds.
    const interruptCommandId = commandId('interrupt');
    const interrupted = await started.call(`/api/sessions/${sessionId}/runs/${runId}/interrupt`, {
      method: 'POST',
      body: { commandId: interruptCommandId },
    });
    const interruptReceipt = interrupted.body.receipt as JsonRecord;
    expect(interruptReceipt.disposition).toBe('applied');
    expect((interruptReceipt.result as JsonRecord).delivered).toBe(false);

    // 8. close_session releases the provider session and the managed workspace.
    const workspaceRoot = (snapshotBody.session as JsonRecord).workspace as JsonRecord;
    const closeCommandId = commandId('close');
    const closed = await started.call(`/api/sessions/${sessionId}/close`, {
      method: 'POST',
      body: { commandId: closeCommandId },
    });
    const closeReceipt = closed.body.receipt as JsonRecord;
    expect(closeReceipt.disposition).toBe('applied');
    expect((closeReceipt.result as JsonRecord).interruptedActiveRun).toBe(false);
    expect(existsSync(workspaceRoot.root as string)).toBe(false);

    const closedSnapshot = await started.call(`/api/sessions/${sessionId}`);
    expect((closedSnapshot.body.snapshot as JsonRecord as { session: JsonRecord }).session.state).toBe('closed');

    // 9. the admission slot is now free: a new session can be opened.
    const reopened = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: commandId('open'), providerId: 'scripted-demo' },
    });
    const reopenedReceipt = reopened.body.receipt as JsonRecord;
    expect(reopenedReceipt.disposition).toBe('applied');
    // Leave this app in a clean state for later tests in this file.
    await started.call(`/api/sessions/${(reopenedReceipt.result as JsonRecord).sessionId as string}/close`, {
      method: 'POST',
      body: { commandId: commandId('close') },
    });
  });

  it('rejects a mutating request that omits the anti-CSRF header', async () => {
    const opened = await fetch(`${started.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: commandId('open'), providerId: 'scripted-demo' }),
    });
    expect(opened.status).toBe(403);
  });

  it('rejects a cross-origin request even though it targets the right host', async () => {
    const { status } = await started.call('/api/providers', { headers: { origin: 'http://evil.example' } });
    expect(status).toBe(403);
  });

  it('rejects a request whose Host header names the right hostname but the wrong port', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: started.port,
          path: '/api/providers',
          method: 'GET',
          headers: { host: `127.0.0.1:${String(started.port + 1)}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
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

  it('rejects a request whose Host header names a foreign hostname entirely', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: started.port,
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
    const { status } = await started.call('/api/sessions/ses_0000000000000000/turns', {
      method: 'POST',
      body: { commandId: commandId('turn'), text: oversizedText },
    });
    expect(status).toBe(413);
  });

  it('rejects an unknown provider id with a rejected receipt, not a crash', async () => {
    const { status, body } = await started.call('/api/sessions', {
      method: 'POST',
      body: { commandId: commandId('open'), providerId: 'no-such-provider' },
    });
    expect(status).toBe(200);
    const receipt = body.receipt as JsonRecord;
    expect(receipt.disposition).toBe('rejected');
    expect((receipt.error as JsonRecord).code).toBe('provider_not_registered');
  });

  it('rejects a malformed run id before ever reaching the runtime', async () => {
    const sessionId = await openScriptedSession(started);
    const { status } = await started.call(`/api/sessions/${sessionId}/runs/not-a-real-run-id/interrupt`, {
      method: 'POST',
      body: { commandId: commandId('interrupt') },
    });
    expect(status).toBe(400);
    await started.call(`/api/sessions/${sessionId}/close`, { method: 'POST', body: { commandId: commandId('close') } });
  });

  it('rejects fromSequence values that a truncating parse would have silently accepted', async () => {
    const sessionId = await openScriptedSession(started);
    for (const bad of ['1junk', '1.5', '-1', '', '007', '99999999999999999999999999']) {
      const { status } = await started.call(`/api/sessions/${sessionId}/events?fromSequence=${bad}`);
      expect(status, `fromSequence=${bad} must be rejected`).toBe(400);
    }
    const good = await started.call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    expect(good.status).toBe(200);
    await started.call(`/api/sessions/${sessionId}/close`, { method: 'POST', body: { commandId: commandId('close') } });
  });

  it('rejects an open_session body carrying an extra field, and never touches a borrowed sentinel directory', async () => {
    const sentinelDir = join(started.workspaceBase, 'sentinel');
    mkdirSync(sentinelDir, { recursive: true });
    const markerFile = join(sentinelDir, 'marker.txt');
    writeFileSync(markerFile, 'do not touch');

    const { status, body } = await started.call('/api/sessions', {
      method: 'POST',
      body: {
        commandId: commandId('open'),
        providerId: 'scripted-demo',
        // An escalation attempt: a browser must never be able to name a
        // workspace path. This must be rejected outright, not silently
        // dropped — a silently-dropped field is indistinguishable, from the
        // client's perspective, from one that was honoured but had no effect.
        workspace: { kind: 'existing', path: sentinelDir },
      },
    });
    expect(status).toBe(400);
    expect((body.error as JsonRecord).message).toContain('workspace');
    expect(existsSync(markerFile)).toBe(true);
  });

  it('rejects a submit_turn body carrying an extra field', async () => {
    const sessionId = await openScriptedSession(started);
    const { status } = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: 'hi', providerOptions: { model: 'anything' } },
    });
    expect(status).toBe(400);
    await started.call(`/api/sessions/${sessionId}/close`, { method: 'POST', body: { commandId: commandId('close') } });
  });
});
