/**
 * Reviewer-reported release blockers, expressed as repository regressions.
 *
 * Each test below reproduces one independently reported P1 against the real
 * adapter with a controlled fake: no timers decide ordering, no process, no
 * network, no credentials. They are grouped here rather than folded into the
 * behavioural suites so the pre-repair failure of each one is reproducible on
 * its own.
 */

import { describe, expect, it } from 'vitest';

import {
  ProviderEventInputSchema,
  type AgentError,
  type ProviderEventInput,
  type TurnInput,
} from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { createClaudeProvider } from '../src/index.ts';
import { createRunTranslator } from '../src/translate.ts';
import type { ClaudeQuery, ClaudeQueryHandle, ClaudeQueryMessage } from '../src/seam.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';

function recordingSink() {
  const events: ProviderEventInput[] = [];
  return {
    events,
    sink: {
      emit(input: ProviderEventInput): void {
        expect(ProviderEventInputSchema.safeParse(input).success).toBe(true);
        events.push(input);
      },
    },
  };
}

function textInput(text: string): TurnInput {
  return { parts: [{ type: 'text', text }] };
}

async function openSession(fake: FakeQuery): Promise<{ session: ProviderSession; events: ProviderEventInput[] }> {
  const provider = createClaudeProvider({ query: fake.query });
  const recorder = recordingSink();
  const session = await provider.createSession({
    options: {},
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: recorder.sink,
  });
  return { session, events: recorder.events };
}

async function rejectionOf(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    if (isProviderRejection(error)) return error.agentError;
    throw error;
  }
  throw new Error('expected a typed provider rejection');
}

/** Whether a run's completion has already settled, without hanging on it. */
async function settled(run: ProviderRun): Promise<boolean> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([run.completion, new Promise((resolve) => setImmediate(() => resolve(pending)))]);
  return outcome !== pending;
}

// ---------------------------------------------------------------------------
// 1 — pre-correlation result attribution
// ---------------------------------------------------------------------------

describe('claude pre-correlation attribution', () => {
  it('does not let an unstamped background turn complete the run it never belonged to', async () => {
    // Before this session has ever seen a correlation stamp, an unstamped frame
    // proves nothing: it is equally a legacy producer's reply and a background,
    // scheduled or synthetic turn that this adapter never submitted. Attributing
    // it publishes another turn's output and settles this run with its result.
    const fake = createFakeQuery();
    const { session, events: sessionEvents } = await openSession(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input: textInput('mine'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);

    // A turn this adapter did not submit, arriving before this run's first reply.
    fake.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cron work' }] } });
    fake.push({ type: 'result', subtype: 'success', is_error: false });
    await flush();

    expect(await settled(run)).toBe(false);
    expect(recorder.events).toEqual([]);
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'debug',
      message: 'claude emitted a turn that does not belong to the active run; its output is not attributed',
    });

    // This run's own turn, correlated by the stamp, still completes it.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mine' }] },
      user_message_uuid: uuid,
    });
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(recorder.events.map((event) => event.payload)).toEqual([{ type: 'run.message_delta', text: 'mine' }]);
  });
});

// ---------------------------------------------------------------------------
// 2 — terminal success versus a later interrupt rejection
// ---------------------------------------------------------------------------

describe('claude terminal result versus interrupt rejection', () => {
  it('reports the observed success when the interrupt is refused after the result', async () => {
    // Intent recorded before the round-trip is a *provisional* classification.
    // If the control request is then refused, the stop never happened, and the
    // successful turn that already landed must not be reported as interrupted.
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input: textInput('long job'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);

    const release = fake.holdNextInterrupt();
    const attempt = run.interrupt('user asked to stop');
    await flush();

    // The turn completes successfully while the control request is in flight.
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
    await flush();

    // Only now does the control request come back refused.
    fake.failNextInterrupt(new Error('control channel closed'));
    release();

    const error = await rejectionOf(attempt);
    expect(error.code).toBe('provider_rejected');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('reconciles a queued-survivor receipt that arrives after the result', async () => {
    // `still_queued` says the stop was not applied. Skipping that reconciliation
    // because the run is already terminal leaves the completion mislabelled.
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('queued job'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);

    const release = fake.holdNextInterrupt();
    const attempt = run.interrupt('user asked to stop');
    await flush();

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
    await flush();

    fake.setInterruptReceipt({ still_queued: [uuid] });
    release();

    const error = await rejectionOf(attempt);
    expect(error.details?.reason).toBe('input_still_queued');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });
});

// ---------------------------------------------------------------------------
// 2b — stream termination versus a pending interrupt reconciliation
// ---------------------------------------------------------------------------

/**
 * Drive one run to a correlated success while an interrupt round-trip is held
 * open, then end the session's stream the way `terminate` asks.
 *
 * The stream ending is the session's news, not the turn's: this turn already
 * reported its own outcome. Whether that outcome is an interruption is still
 * undecided until the held control request answers, so the stream ending must
 * not decide it early.
 */
async function successThenStreamTermination(terminate: (fake: FakeQuery) => void): Promise<{
  run: ProviderRun;
  attempt: Promise<void>;
  uuid: string;
  release: () => void;
  fake: FakeQuery;
  /** Whether the stream ending published a completion on its own. */
  settledAtTermination: boolean;
}> {
  const fake = createFakeQuery();
  const { session } = await openSession(fake);
  const run = await session.startRun({ input: textInput('long job'), sink: recordingSink().sink, runRef: 'run-1' });
  await flush();
  const uuid = submittedUuid(fake, 0);

  const release = fake.holdNextInterrupt();
  const attempt = run.interrupt('user asked to stop');
  await flush();

  // The turn reports its own success while the control request is in flight.
  fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
  await flush();

  terminate(fake);
  await flush();

  // Read, not asserted here: each case asserts the outcome first, so a failure
  // reports the completion the adapter actually published.
  return { run, attempt, uuid, release, fake, settledAtTermination: await settled(run) };
}

describe('claude stream termination versus pending interrupt reconciliation', () => {
  it('reports the observed success when the stream ends before a refused interrupt answers', async () => {
    const { run, attempt, release, fake, settledAtTermination } = await successThenStreamTermination((query) =>
      query.end(),
    );

    fake.failNextInterrupt(new Error('control channel closed'));
    release();

    const error = await rejectionOf(attempt);
    expect(error.code).toBe('provider_rejected');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(settledAtTermination).toBe(false);
  });

  it('reports the observed success when the stream ends before a queued-survivor receipt arrives', async () => {
    const { run, attempt, uuid, release, fake, settledAtTermination } = await successThenStreamTermination((query) =>
      query.end(),
    );

    fake.setInterruptReceipt({ still_queued: [uuid] });
    release();

    const error = await rejectionOf(attempt);
    expect(error.details?.reason).toBe('input_still_queued');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(settledAtTermination).toBe(false);
  });

  it('reports the observed success when the stream fails before a refused interrupt answers', async () => {
    const { run, attempt, release, fake, settledAtTermination } = await successThenStreamTermination((query) => {
      query.fail(new Error('claude cli exited'));
    });

    fake.failNextInterrupt(new Error('control channel closed'));
    release();

    const error = await rejectionOf(attempt);
    expect(error.code).toBe('provider_rejected');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(settledAtTermination).toBe(false);
  });

  it('reports the observed success when the stream fails before a queued-survivor receipt arrives', async () => {
    const { run, attempt, uuid, release, fake, settledAtTermination } = await successThenStreamTermination((query) => {
      query.fail(new Error('claude cli exited'));
    });

    fake.setInterruptReceipt({ still_queued: [uuid] });
    release();

    const error = await rejectionOf(attempt);
    expect(error.details?.reason).toBe('input_still_queued');
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(settledAtTermination).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — synchronous teardown failure retryability
// ---------------------------------------------------------------------------

/**
 * A query whose `return()` throws *synchronously* instead of returning a
 * rejected promise — an ordinary shape for an injected or host-supplied handle,
 * and the one that runs teardown's `finally` before the attempt is cached.
 */
function createSyncTeardownFailureQuery(): { query: ClaudeQuery; readonly returnCalls: number } {
  let returnCalls = 0;
  const handle: ClaudeQueryHandle = {
    [Symbol.asyncIterator](): AsyncIterator<ClaudeQueryMessage> {
      // The stream stays open; this test never starts a run.
      return { next: () => new Promise<IteratorResult<ClaudeQueryMessage>>(() => undefined) };
    },
    interrupt(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
    return(): Promise<unknown> {
      returnCalls += 1;
      if (returnCalls === 1) throw new Error('teardown exploded');
      return Promise.resolve(undefined);
    },
  };
  return {
    query: () => handle,
    get returnCalls() {
      return returnCalls;
    },
  };
}

describe('claude synchronous teardown failure', () => {
  it('stays retryable after a teardown that throws synchronously', async () => {
    // A rejected disposal must never be cached as the permanent answer: the SPI
    // requires an identical later attempt to retry the resource cleanup.
    const fake = createSyncTeardownFailureQuery();
    const provider = createClaudeProvider({ query: fake.query });
    const session = await provider.createSession({
      options: {},
      workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
      sink: recordingSink().sink,
    });

    const error = await rejectionOf(session.dispose());
    expect(error.code).toBe('provider_rejected');

    await expect(session.dispose()).resolves.toBeUndefined();
    expect(fake.returnCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4 — assistant error-body containment
// ---------------------------------------------------------------------------

describe('claude assistant error-body containment', () => {
  it('does not publish the body of an assistant message the SDK flagged as an error', () => {
    // An errored assistant frame's blocks are the upstream error body, not model
    // output. Publishing them verbatim as durable deltas defeats the closed
    // allowlist that the accompanying diagnostic goes through.
    const bearer = ['sk', 'ant', 'A'.repeat(28)].join('-');
    const secretPath = '/home/agent/.claude/credentials.json';
    const prompt = 'refactor the billing module and keep the customer list private';
    const body = `authentication failed for ${bearer} reading ${secretPath} while doing: ${prompt}`;

    const translator = createRunTranslator();
    const translation = translator.translate({
      type: 'assistant',
      error: 'authentication_failed',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: body },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
        ],
      },
    });

    for (const event of translation.events) {
      expect(ProviderEventInputSchema.safeParse(event).success).toBe(true);
    }
    const published = JSON.stringify(translation.events);
    for (const secret of [bearer, secretPath, prompt]) expect(published).not.toContain(secret);
    expect(translation.events.map((event) => event.payload)).toEqual([
      { type: 'diagnostic', level: 'warning', message: 'claude reported an assistant error: authentication_failed' },
    ]);
  });
});
