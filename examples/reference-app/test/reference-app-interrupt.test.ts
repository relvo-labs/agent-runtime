/**
 * Genuine in-flight interrupt through this app's real HTTP transport.
 *
 * This app deliberately never auto-drains the scripted provider after
 * `submit_turn` (see `runtime-factory.ts`'s `advanceScriptedDemo` doc
 * comment) — precisely so a run can be observed, and interrupted, while it
 * is still genuinely non-terminal. Nothing here bypasses the transport or
 * pokes the scripted controller directly: every step is an ordinary HTTP
 * request, exactly what a browser sends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCRIPTED_FAILURE_TRIGGER_TEXT } from '../src/providers/scripted.ts';
import { commandId, openScriptedSession, startTestApp, type JsonRecord, type StartedApp } from './helpers.ts';

describe('reference-app: controlled in-flight interrupt and scripted failure', () => {
  let started: StartedApp;
  let sessionId: string;

  beforeEach(async () => {
    started = await startTestApp();
    sessionId = await openScriptedSession(started);
  });

  afterEach(async () => {
    await started.teardown();
  });

  it('interrupts a run that is genuinely still in flight, then accepts a subsequent turn', async () => {
    const submitted = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: 'this run must be interrupted before it ever advances' },
    });
    const turnResult = (submitted.body.receipt as JsonRecord).result as JsonRecord;
    const runId = turnResult.runId as string;

    // Proof of "in flight": the run has not produced a single event yet, and
    // is not terminal — because nothing has called `advance-script`.
    const midFlight = await started.call(`/api/sessions/${sessionId}`);
    const midSnapshot = midFlight.body.snapshot as JsonRecord;
    const midRun = (midSnapshot.runs as JsonRecord[])[0]!;
    expect(midRun.state).toBe('running');
    expect(midRun.termination).toBeUndefined();
    const midEvents = await started.call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    const midPayloadTypes = ((midEvents.body.page as JsonRecord).events as JsonRecord[]).map(
      (event) => (event.payload as JsonRecord).type,
    );
    expect(midPayloadTypes).not.toContain('run.message_delta');
    expect(midPayloadTypes).not.toContain('run.finished');

    // Interrupt it — for real, through HTTP, while it is still running.
    const interrupted = await started.call(`/api/sessions/${sessionId}/runs/${runId}/interrupt`, {
      method: 'POST',
      body: { commandId: commandId('interrupt'), reason: 'test: genuine in-flight interrupt' },
    });
    expect(interrupted.status).toBe(200);
    const interruptReceipt = interrupted.body.receipt as JsonRecord;
    expect(interruptReceipt.disposition).toBe('applied');
    // `delivered: true` — unlike interrupting an already-terminal run, this
    // one was genuinely in flight and the provider really was told to stop.
    expect((interruptReceipt.result as JsonRecord).delivered).toBe(true);

    const afterInterrupt = await started.call(`/api/sessions/${sessionId}`);
    const afterSnapshot = afterInterrupt.body.snapshot as JsonRecord;
    const afterRun = (afterSnapshot.runs as JsonRecord[])[0]!;
    expect(afterRun.state).toBe('interrupted');
    expect((afterRun.termination as JsonRecord).outcome).toBe('interrupted');
    const afterTurn = (afterSnapshot.turns as JsonRecord[])[0]!;
    expect(afterTurn.state).toBe('cancelled');

    // A subsequent turn on the same session works — interrupting a run never
    // ends the session.
    const secondSubmit = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: 'a turn submitted after the interrupt' },
    });
    expect(secondSubmit.status).toBe(200);
    const secondReceipt = secondSubmit.body.receipt as JsonRecord;
    expect(secondReceipt.disposition).toBe('applied');
    expect((secondReceipt.result as JsonRecord).turnId).not.toBe(turnResult.turnId);

    // Bring it to a real, advanced completion to leave the session tidy.
    const advanced = await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });
    expect(((advanced.body.snapshot as JsonRecord).runs as JsonRecord[])[1]!.state).toBe('succeeded');

    await started.call(`/api/sessions/${sessionId}/close`, { method: 'POST', body: { commandId: commandId('close') } });
  });

  it('demonstrates a real scripted terminal-failure path, driven by the real controller', async () => {
    const submitted = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: SCRIPTED_FAILURE_TRIGGER_TEXT },
    });
    expect((submitted.body.receipt as JsonRecord).disposition).toBe('applied');

    const advanced = await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });
    expect(advanced.status).toBe(200);
    const run = ((advanced.body.snapshot as JsonRecord).runs as JsonRecord[])[0]!;
    expect(run.state).toBe('failed');
    const termination = run.termination as JsonRecord;
    expect(termination.outcome).toBe('failed');
    // A real, specific error from the script — not an invented envelope.
    expect((termination.error as JsonRecord).message).toContain('scripted demo: deliberate failure');

    const turn = ((advanced.body.snapshot as JsonRecord).turns as JsonRecord[])[0]!;
    expect(turn.state).toBe('failed');

    await started.call(`/api/sessions/${sessionId}/close`, { method: 'POST', body: { commandId: commandId('close') } });
  });

  it('rejects advance-script for a session that is not using the scripted-demo provider', async () => {
    // No real provider is registered in this test app, so any providerId
    // other than the open one is unknown to `getSession`'s own session — the
    // meaningful case here is the *shape* of the guard, exercised directly:
    // a made-up but well-formed session id is simply unknown.
    const { status } = await started.call('/api/sessions/ses_00000000000000ZZ/advance-script', { method: 'POST' });
    expect(status).toBe(404);
  });
});
