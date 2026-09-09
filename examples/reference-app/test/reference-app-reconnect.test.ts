/**
 * Reconnect, overflow, and disconnect-vs-cancellation.
 *
 * Every subscription in this file goes through the real HTTP/SSE transport
 * (`fetch` against this app's real server), never a direct call into the
 * runtime's `subscribe()`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCRIPTED_BURST_TRIGGER_TEXT } from '../src/providers/scripted.ts';
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  commandId,
  openScriptedSession,
  startTestApp,
  type JsonRecord,
  type StartedApp,
} from './helpers.ts';

describe('reference-app: reconnect, overflow, and disconnect-vs-cancellation', () => {
  let started: StartedApp;
  let sessionId: string;

  beforeEach(async () => {
    started = await startTestApp();
    sessionId = await openScriptedSession(started);
  });

  afterEach(async () => {
    await started.teardown();
  });

  it('signals an explicit overflow — with a resumable cursor — rather than dropping or silently skipping events', async () => {
    const controller = new AbortController();
    const response = await fetch(`${started.baseUrl}/api/sessions/${sessionId}/subscribe?fromSequence=0&bufferSize=8`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const seen: JsonRecord[] = [];

    async function readUntil(
      predicate: (messages: readonly JsonRecord[]) => boolean,
      deadlineMs: number,
    ): Promise<void> {
      const deadline = Date.now() + deadlineMs;
      while (!predicate(seen)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for a message; saw ${String(seen.length)}`);
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            seen.push(JSON.parse(line.slice('data:'.length).trim()) as JsonRecord);
          }
        }
      }
    }

    await readUntil((messages) => messages.some((m) => m.type === 'caught_up'), 5000);

    // Trigger a burst — 400 events committed together — through a *separate*
    // connection, without this subscription's reader ever running while it
    // happens. `bufferSize: 8` guarantees the hub's per-subscriber bound is
    // exceeded long before either connection's socket does.
    const submitted = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: SCRIPTED_BURST_TRIGGER_TEXT },
    });
    expect((submitted.body.receipt as JsonRecord).disposition).toBe('applied');
    await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });

    await readUntil((messages) => messages.some((m) => m.type === 'overflow'), 5000);
    const overflow = seen.find((m) => m.type === 'overflow')!;
    expect(overflow.droppedFromSequence).toBeGreaterThan(0);
    expect(overflow.resumeCursor).toMatch(/^cur_\d+$/);
    expect(overflow.undeliveredCount as number).toBeGreaterThan(0);

    // The default policy (`signal_and_close`) ends the stream right after
    // signalling — never silently continuing as though nothing had been
    // missed. Prove this with a GENUINE end-of-stream read, not a vacuous
    // predicate: `readUntil(() => true, …)` never even calls `reader.read()`
    // because its loop condition is already false on entry, so it proved
    // nothing about whether the stream actually closed. Read until either a
    // real `done: true` (the stream ended, as required) or a real deadline —
    // and fail loudly if any further frame arrives instead, since that would
    // mean `signal_and_close` silently became `signal_and_skip`.
    let eof = false;
    const eofDeadline = Date.now() + 2000;
    for (;;) {
      if (Date.now() > eofDeadline) break;
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
        break;
      }
      const leftover = decoder.decode(value, { stream: true }).trim();
      if (leftover.length > 0) {
        throw new Error(`stream kept delivering data after overflow under signal_and_close: ${leftover}`);
      }
    }
    expect(eof).toBe(true);

    // Nothing was actually lost server-side: the durable log still has every
    // event, and the client can backfill exactly the missed range from the
    // cursor the overflow message gave it — reconstructing the transcript
    // completely, with no gap and nothing re-added that was already
    // delivered.
    const droppedFrom = overflow.droppedFromSequence as number;
    const alreadyDeliveredSequences = seen
      .filter((m) => m.type === 'event')
      .map((m) => (m.event as JsonRecord).sequence as number)
      .sort((a, b) => a - b);
    const backfill = await started.call(`/api/sessions/${sessionId}/events?fromSequence=${String(droppedFrom - 1)}`);
    expect(backfill.status).toBe(200);
    const backfillPage = backfill.body.page as JsonRecord;
    const backfilledEvents = backfillPage.events as JsonRecord[];
    expect(backfilledEvents.length).toBeGreaterThan(0);
    // The recovered range must be COMPLETE in one page — a partial recovery
    // that silently stopped part-way through would be exactly as bad as
    // never recovering at all.
    expect(backfillPage.hasMore).toBe(false);
    const backfilledSequences = backfilledEvents.map((event) => event.sequence as number);

    // No duplication: none of the backfilled sequences were already
    // delivered live before the overflow.
    const alreadyDeliveredSet = new Set(alreadyDeliveredSequences);
    for (const sequence of backfilledSequences) {
      expect(alreadyDeliveredSet.has(sequence)).toBe(false);
    }

    // Gap-free, end to end: replay (sequences 1..N delivered live before the
    // overflow) plus the backfill together must form one contiguous run from
    // 1 through the final recovered sequence — not merely "starts at the
    // right place" and "doesn't overlap", which a batch with an internal
    // hole would also satisfy.
    const allSequences = [...alreadyDeliveredSequences, ...backfilledSequences];
    expect(allSequences[0]).toBe(1);
    for (let i = 1; i < allSequences.length; i += 1) {
      expect(allSequences[i]).toBe(allSequences[i - 1]! + 1);
    }

    // And the recovered end must be the TRUE end: a fresh, independent
    // `readEvents(0)` (bypassing everything captured by this test's own
    // subscription/backfill bookkeeping) must agree on exactly how many
    // events exist and end at the same final sequence.
    const authoritative = await started.call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    const authoritativePage = authoritative.body.page as JsonRecord;
    expect(authoritativePage.hasMore).toBe(false);
    const finalSequence = allSequences[allSequences.length - 1]!;
    expect((authoritativePage.events as JsonRecord[]).length).toBe(finalSequence);
    // `nextSequence` is already a ready-to-use `fromSequence` for the NEXT
    // call (see the "resumes a fresh subscription…" test below, which relies
    // on exactly this) — i.e. it equals the last delivered sequence itself,
    // not one past it; `fromSequence` is an exclusive lower bound throughout
    // this app (see e.g. the `droppedFrom - 1` backfill call above).
    expect(authoritativePage.nextSequence).toBe(finalSequence);

    controller.abort();
  });

  it('resumes a fresh subscription from a client-tracked cursor without replaying already-seen events', async () => {
    await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: 'first message' },
    });
    await started.call(`/api/sessions/${sessionId}/advance-script`, { method: 'POST' });

    const events = await started.call(`/api/sessions/${sessionId}/events?fromSequence=0`);
    const page = events.body.page as JsonRecord;
    const nextSequence = page.nextSequence as number;
    expect(nextSequence).toBeGreaterThan(0);

    // A reconnect resumes from the last consumed sequence, not from 0 — no
    // duplicated transcript on the client.
    const resumed = await started.collectSubscription(
      sessionId,
      (messages) => messages.some((m) => m.type === 'caught_up'),
      `fromSequence=${String(nextSequence)}`,
    );
    const replayedEvents = resumed.messages.filter((m) => m.type === 'event');
    expect(replayedEvents).toHaveLength(0); // nothing before `nextSequence` is replayed again
    resumed.stop();
  });

  it('closes the backend subscription on client disconnect without cancelling the run', async () => {
    const controller = new AbortController();
    const response = await fetch(`${started.baseUrl}/api/sessions/${sessionId}/subscribe?fromSequence=0`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // at least one message, so the connection is fully established

    const submitted = await started.call(`/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { commandId: commandId('turn'), text: 'still running after disconnect' },
    });
    const runId = ((submitted.body.receipt as JsonRecord).result as JsonRecord).runId as string;

    // Disconnect the *transport* — this must never be conflated with
    // cancelling the run.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snapshot = await started.call(`/api/sessions/${sessionId}`);
    const run = ((snapshot.body.snapshot as JsonRecord).runs as JsonRecord[])[0]!;
    expect(run.state).toBe('running'); // NOT interrupted by the disconnect
    expect(run.termination).toBeUndefined();

    // The session is still fully usable — advancing and interrupting still work.
    await started.call(`/api/sessions/${sessionId}/runs/${runId}/interrupt`, {
      method: 'POST',
      body: { commandId: commandId('interrupt') },
    });
    const afterInterrupt = await started.call(`/api/sessions/${sessionId}`);
    expect(((afterInterrupt.body.snapshot as JsonRecord).runs as JsonRecord[])[0]!.state).toBe('interrupted');
  });

  it('returns 404 for a syntactically valid but unknown session — reconnect after a backend restart is visible, not a hang', async () => {
    const { status, body } = await started.call('/api/sessions/ses_00000000000000ZZ/subscribe?fromSequence=0');
    expect(status).toBe(404);
    expect((body.error as JsonRecord).code).toBe('unknown_session');
  });
});
