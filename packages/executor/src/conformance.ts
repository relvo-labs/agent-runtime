/**
 * Executor conformance kit.
 *
 * These cases are the executable form of the foundation's acceptance criteria.
 * They are deliberately framework-agnostic — no `describe`, no `expect`, no
 * import of a test runner — so that:
 *
 *   - the kit can ship in the package and be run by an out-of-tree implementor
 *     against their own executor, under whatever runner they use;
 *   - the assertions live next to the contract they describe rather than next
 *     to one particular implementation.
 *
 * The in-repo runtime runs this same array under Vitest. If a case has to be
 * changed to make an implementation pass, the contract is under-specified —
 * fix the contract, not the case.
 */

import type { AgentExecutor, EventSubscription } from './executor.ts';
import {
  type CommandId,
  type CommandReceipt,
  type EventEnvelope,
  type Sequence,
  type SessionId,
  type SubscriptionMessage,
  isEventMessage,
  sequenceFromCursor,
} from '@relvo-labs/agent-protocol';

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

export type ConformanceHarness = {
  readonly executor: AgentExecutor;
  /** Must return a fresh, unique id on every call. */
  nextCommandId(): CommandId;
  /** Provider id registered in the harness; must be deterministic. */
  readonly providerId: string;
  /**
   * An absolute path the harness is willing to have used as an `existing`
   * workspace. It must NOT be deleted by the runtime — that is WS-01.
   */
  readonly borrowedWorkspacePath: string;
  /** Drain any provider work so the case can observe a settled state. */
  settle(): Promise<void>;
  dispose(): Promise<void>;
};

export type ConformanceCase = {
  /** Stable id, safe to use in a test name or an allow-list. */
  readonly id: string;
  readonly title: string;
  /** Foundation acceptance ids this case provides evidence for. */
  readonly acceptanceIds: readonly string[];
  run(harness: ConformanceHarness): Promise<void>;
};

export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function equal<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new ConformanceFailure(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

function requireResult(receipt: CommandReceipt, what: string): NonNullable<CommandReceipt['result']> {
  check(receipt.disposition !== 'rejected', `${what} was rejected: ${receipt.error?.code} ${receipt.error?.message}`);
  const { result } = receipt;
  check(result !== undefined, `${what} produced no result`);
  return result;
}

async function openBorrowedSession(harness: ConformanceHarness): Promise<SessionId> {
  const receipt = await harness.executor.openSession({
    commandId: harness.nextCommandId(),
    type: 'open_session',
    providerId: harness.providerId,
    workspace: { kind: 'existing', path: harness.borrowedWorkspacePath },
  });
  const result = requireResult(receipt, 'open_session');
  check(result.type === 'session_opened', 'open_session must produce a `session_opened` result');
  return result.sessionId;
}

async function collect(
  subscription: EventSubscription,
  until: (message: SubscriptionMessage) => boolean,
  limit = 500,
): Promise<SubscriptionMessage[]> {
  const messages: SubscriptionMessage[] = [];
  try {
    for await (const message of subscription) {
      messages.push(message);
      if (until(message) || messages.length >= limit) break;
    }
  } finally {
    await subscription.close();
  }
  return messages;
}

function eventsOf(messages: readonly SubscriptionMessage[]): EventEnvelope[] {
  return messages.filter(isEventMessage).map((message) => message.event);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const EXECUTOR_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    id: 'identity/distinct-ids',
    title: 'session, turn, run and interaction identities are distinct and prefixed',
    acceptanceIds: ['ID-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      const turnReceipt = await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'hello' }] },
      });
      const result = requireResult(turnReceipt, 'submit_turn');
      check(result.type === 'turn_accepted', 'submit_turn must produce `turn_accepted`');

      check(sessionId.startsWith('ses_'), `session id must be prefixed \`ses_\`, got ${sessionId}`);
      check(result.turnId.startsWith('trn_'), `turn id must be prefixed \`trn_\`, got ${result.turnId}`);
      check(result.runId.startsWith('run_'), `run id must be prefixed \`run_\`, got ${result.runId}`);

      const distinct = new Set<string>([sessionId, result.turnId, result.runId]);
      equal(distinct.size, 3, 'session, turn and run ids must all differ');

      await harness.settle();
      const snapshot = await harness.executor.getSession(sessionId);
      check(snapshot !== undefined, 'the opened session must be readable');
      equal(snapshot.session.sessionId, sessionId, 'snapshot session id');
      equal(snapshot.turns.length, 1, 'snapshot turn count');
      equal(snapshot.runs.length, 1, 'snapshot run count');
      equal(snapshot.runs[0]?.turnId, result.turnId, 'the run must reference its turn');
    },
  },

  {
    id: 'commands/duplicate-is-idempotent',
    title: 'redispatching a command id returns the original receipt without repeating the effect',
    acceptanceIds: ['CM-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      const commandId = harness.nextCommandId();
      const command: Parameters<AgentExecutor['submitTurn']>[0] = {
        commandId,
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'only once' }] },
      };

      const first = await harness.executor.submitTurn(command);
      const second = await harness.executor.submitTurn(command);

      equal(first.disposition, 'applied', 'first dispatch disposition');
      equal(second.disposition, 'duplicate', 'second dispatch disposition');
      equal(
        JSON.stringify(second.result),
        JSON.stringify(first.result),
        'a duplicate receipt must replay the original result verbatim',
      );
      equal(second.acceptedAt, first.acceptedAt, 'a duplicate must not restamp `acceptedAt`');

      await harness.settle();
      const snapshot = await harness.executor.getSession(sessionId);
      equal(snapshot?.turns.length, 1, 'a duplicate command must not create a second turn');
    },
  },

  {
    id: 'commands/id-reuse-with-different-payload-conflicts',
    title: 'reusing a command id with a different payload is rejected, not silently applied',
    acceptanceIds: ['CM-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      const commandId = harness.nextCommandId();

      await harness.executor.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'first payload' }] },
      });
      const conflicting = await harness.executor.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'DIFFERENT payload' }] },
      });

      equal(conflicting.disposition, 'rejected', 'conflicting reuse disposition');
      equal(conflicting.error?.code, 'command_id_conflict', 'conflicting reuse error code');

      await harness.settle();
      const snapshot = await harness.executor.getSession(sessionId);
      equal(snapshot?.turns.length, 1, 'a conflicting command must not create a turn');
    },
  },

  {
    id: 'events/replay-then-live-has-no-gap',
    title: 'subscribing from sequence 0 observes events emitted before the subscription existed',
    acceptanceIds: ['EV-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'before subscribing' }] },
      });
      await harness.settle();

      const page = await harness.executor.readEvents(sessionId, 0 as never);
      check(page.events.length > 0, 'the session must have durable history before subscribing');

      const subscription = harness.executor.subscribe({ sessionId, fromSequence: 0 });
      const messages = await collect(subscription, (message) => message.type === 'caught_up');
      const replayed = eventsOf(messages);

      equal(
        replayed.length,
        page.events.length,
        'replay must deliver every durable event that existed at subscription time',
      );
      for (let i = 0; i < page.events.length; i += 1) {
        equal(replayed[i]?.sequence, page.events[i]?.sequence, `replayed event ${String(i)} sequence`);
      }

      const sequences = replayed.map((event) => event.sequence);
      const gapless = sequences.every((value, index) => index === 0 || value === (sequences[index - 1] as number) + 1);
      check(gapless, `replayed sequences must be gapless, got ${sequences.join(',')}`);

      const caughtUp = messages.at(-1);
      check(caughtUp?.type === 'caught_up', 'the stream must announce `caught_up` between replay and live');
    },
  },

  {
    id: 'events/overflow-yields-resumable-cursor',
    title: 'a subscriber that cannot keep up gets an explicit overflow with a resumable cursor',
    acceptanceIds: ['EV-02'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);

      const subscription = harness.executor.subscribe({ sessionId, fromSequence: 0, bufferSize: 8 });
      const iterator = subscription[Symbol.asyncIterator]();

      // Drain to `caught_up` first. Before that point the STORE is the source,
      // so a slow consumer costs latency, not events, and reporting an overflow
      // would be a lie. Only after the transition is the bounded buffer the
      // source, which is when the bound can actually cost a delivery.
      for (let i = 0; i < 200; i += 1) {
        const next = await iterator.next();
        if (next.done === true) throw new ConformanceFailure('stream ended before `caught_up`');
        if (next.value.type === 'caught_up') break;
      }

      // Now flood without pulling. The generator is suspended, so every event
      // lands in the bounded buffer.
      for (let i = 0; i < 8; i += 1) {
        const flooded = await harness.executor.submitTurn({
          commandId: harness.nextCommandId(),
          type: 'submit_turn',
          sessionId,
          input: { parts: [{ type: 'text', text: `flood ${String(i)}` }] },
        });
        check(flooded.disposition === 'applied', `flood turn ${String(i)} must be admitted`);
        await harness.settle();
      }

      let overflow: Extract<SubscriptionMessage, { type: 'overflow' }> | undefined;
      for (let i = 0; i < 500; i += 1) {
        const next = await iterator.next();
        if (next.done === true) break;
        if (next.value.type === 'overflow') {
          overflow = next.value;
          break;
        }
      }
      await subscription.close();

      check(overflow !== undefined, 'a saturated subscriber must receive an explicit `overflow` message');
      check(overflow.undeliveredCount > 0, 'overflow must report how many events were not delivered');
      equal(overflow.bufferSize, 8, 'overflow must report the bound that was crossed');
      check(
        overflow.resumeCursor.startsWith('cur_'),
        `overflow must carry a resumable cursor, got ${overflow.resumeCursor}`,
      );

      // Nothing was lost. The cursor points at a position in DURABLE storage,
      // and reading from it returns exactly the first undelivered event.
      const resumed = await harness.executor.readEvents(
        sessionId,
        sequenceFromCursor(overflow.resumeCursor) as Sequence,
      );
      check(
        resumed.events.length >= overflow.undeliveredCount,
        'every undelivered event must still be readable from durable storage',
      );
      equal(
        resumed.events[0]?.sequence,
        overflow.droppedFromSequence,
        'resuming from the overflow cursor must return the first undelivered event',
      );
    },
  },

  {
    id: 'lifecycle/run-has-exactly-one-terminal-outcome',
    title: 'a run reaches exactly one terminal outcome and records it once',
    acceptanceIds: ['LC-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      const receipt = await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'run to completion' }] },
      });
      const result = requireResult(receipt, 'submit_turn');
      check(result.type === 'turn_accepted', 'submit_turn must produce `turn_accepted`');
      await harness.settle();

      const page = await harness.executor.readEvents(sessionId, 0 as never);
      const finished = page.events.filter(
        (event) => event.payload.type === 'run.finished' && event.runId === result.runId,
      );
      equal(finished.length, 1, 'a run must emit exactly one `run.finished`');

      const snapshot = await harness.executor.getSession(sessionId);
      const run = snapshot?.runs.find((candidate) => candidate.runId === result.runId);
      check(run !== undefined, 'the run must appear in the projection');
      check(
        run.state === 'succeeded' || run.state === 'failed' || run.state === 'interrupted',
        `a settled run must be terminal, got ${run.state}`,
      );
      check(run.termination !== undefined, 'a terminal run must carry a termination record');
      equal(run.termination.outcome, run.state, 'termination outcome must equal terminal state');
    },
  },

  {
    id: 'lifecycle/interrupt-is-not-close',
    title: 'interrupting a run leaves the session usable for another turn',
    acceptanceIds: ['LC-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      const first = requireResult(
        await harness.executor.submitTurn({
          commandId: harness.nextCommandId(),
          type: 'submit_turn',
          sessionId,
          input: { parts: [{ type: 'text', text: 'interrupt me' }] },
        }),
        'submit_turn',
      );
      check(first.type === 'turn_accepted', 'submit_turn must produce `turn_accepted`');

      const interrupt = await harness.executor.interruptRun({
        commandId: harness.nextCommandId(),
        type: 'interrupt_run',
        sessionId,
        runId: first.runId,
        reason: 'conformance',
      });
      check(interrupt.disposition !== 'rejected', `interrupt_run was rejected: ${interrupt.error?.message}`);
      await harness.settle();

      const afterInterrupt = await harness.executor.getSession(sessionId);
      equal(afterInterrupt?.session.state, 'ready', 'the session must remain `ready` after a run interrupt');

      // The decisive assertion: a second turn is still accepted.
      const second = await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'still working' }] },
      });
      equal(second.disposition, 'applied', 'a new turn must be accepted after an interrupt');
      await harness.settle();

      const close = await harness.executor.closeSession({
        commandId: harness.nextCommandId(),
        type: 'close_session',
        sessionId,
      });
      check(close.disposition !== 'rejected', `close_session was rejected: ${close.error?.message}`);
      await harness.settle();

      const afterClose = await harness.executor.getSession(sessionId);
      equal(afterClose?.session.state, 'closed', 'closing must move the session to `closed`');

      const rejected = await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'too late' }] },
      });
      equal(rejected.disposition, 'rejected', 'a closed session must not accept a turn');
      equal(rejected.error?.code, 'session_closed', 'closed-session rejection code');
    },
  },

  {
    id: 'workspace/borrowed-release-is-non-destructive',
    title: 'closing a session with a borrowed workspace performs no destructive operation',
    acceptanceIds: ['WS-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      await harness.executor.closeSession({
        commandId: harness.nextCommandId(),
        type: 'close_session',
        sessionId,
      });
      await harness.settle();

      const page = await harness.executor.readEvents(sessionId, 0 as never);
      const closed = page.events.find((event) => event.payload.type === 'session.closed');
      check(closed?.payload.type === 'session.closed', 'closing must emit `session.closed`');

      const report = closed.payload.workspaceRelease;
      equal(report.ownership, 'borrowed', 'an `existing` workspace must be leased as `borrowed`');
      equal(
        report.destructiveOperations.length,
        0,
        `releasing a borrowed workspace must perform no destructive operation, got: ${report.destructiveOperations.join(', ')}`,
      );
    },
  },

  {
    id: 'store/sequence-events-and-state-advance-together',
    title: 'projected state never reflects an event the log has not committed',
    acceptanceIds: ['ST-01'],
    async run(harness) {
      const sessionId = await openBorrowedSession(harness);
      await harness.executor.submitTurn({
        commandId: harness.nextCommandId(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'atomicity' }] },
      });
      await harness.settle();

      const snapshot = await harness.executor.getSession(sessionId);
      check(snapshot !== undefined, 'session must be readable');
      const page = await harness.executor.readEvents(sessionId, 0 as never);

      const highest = page.events.at(-1)?.sequence ?? 0;
      equal(
        snapshot.session.sequence,
        highest,
        'the projection must be exactly as far along as the committed event log',
      );
      equal(page.events.length, highest, 'sequences must be gapless and 1-based');
      equal(page.nextSequence, highest, 'the page cursor must point at the last committed sequence');
    },
  },
];

/** Look a case up by id — useful for focusing a single conformance failure. */
export function conformanceCase(id: string): ConformanceCase {
  const found = EXECUTOR_CONFORMANCE_CASES.find((candidate) => candidate.id === id);
  if (!found) throw new ConformanceFailure(`unknown conformance case \`${id}\``);
  return found;
}
