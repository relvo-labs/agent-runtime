/**
 * Issue #43 surface 2: provider event ingress, activation, caps and fault wake
 * through the private ingress seam (`src/ingress.ts`), driven against the real
 * in-memory store, the real subscription hub and captured provider sinks.
 *
 * `createAgentRuntime` does not route through this seam yet: terminal
 * submission (surface 3) and cleanup (surface 4) still commit directly, so a
 * partial cutover would leave an observable FIFO bypass. These tests therefore
 * prove the seam that the atomic cutover will install, not live runtime
 * behavior.
 *
 * Scheduling is controlled with deferred store commits and reads. No test
 * sleeps or asserts elapsed time; "promptly" means a promise settles while
 * another named promise is still held.
 */

import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  CommandIdSchema,
  RunIdSchema,
  SessionIdSchema,
  SubscriptionRequestSchema,
  TurnIdSchema,
  WIRE_VERSION,
  WorkspaceLeaseIdSchema,
  agentError,
  createCounterIdFactory,
  createFixedClock,
  type AgentSession,
  type EventEnvelope,
  type ProviderEventInput,
  type RunId,
  type Sequence,
  type SessionId,
  type SessionSnapshot,
  type SubscriptionMessage,
  type TurnId,
} from '@relvo-labs/agent-protocol';
import type { ProviderEventSink } from '@relvo-labs/agent-provider';

import { PRE_ACTIVATION_LIMIT, SESSION_OPERATION_LIMIT, type CommandIdentity } from '../src/ingestion.ts';
import {
  createIngressDriver,
  ingressPlan,
  materializePlainProviderEvent,
  type IngressPlan,
  type IngressStoreContract,
} from '../src/ingress.ts';
import { createInMemoryStore, type CommitResult, type RuntimeStore, type StoreTransaction } from '../src/store.ts';
import { createSubscriptionHub } from '../src/subscriptions.ts';

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type HeldCommit = { release(): void; fail(): void };
type ReadGate = { readonly entered: Promise<undefined>; release(): void; fail(): void };

const delta = (text: string): ProviderEventInput => ({ payload: { type: 'run.message_delta', text } });
const note = (message: string): ProviderEventInput => ({ payload: { type: 'diagnostic', level: 'info', message } });

function fixture(contract: IngressStoreContract = 'linearizable') {
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });

  // ---- controllable store wrapper -------------------------------------------------
  /** Sessions whose commits throw inside the transaction callback: a definite pre-apply rejection. */
  const failing = new Set<SessionId>();
  const held: HeldCommit[] = [];
  const heldWaiters: (() => void)[] = [];
  let holding = false;
  let applyThenRejectNext = false;
  let gate: { entered: Deferred<undefined>; open: Deferred<undefined>; fail: boolean } | undefined;
  let commitCalls = 0;
  /** Snapshot reads (`store.read`) observed; reconciliation must make at least one before certifying. */
  let snapshotReads = 0;
  /** Rewrites the next snapshot read, to simulate a store whose projection lags or disagrees with its log. */
  let snapshotTransform: ((snapshot: SessionSnapshot) => SessionSnapshot) | undefined;
  let failSnapshotReads = false;

  function guarded(tx: StoreTransaction): StoreTransaction {
    return {
      session: (sessionId) => tx.session(sessionId),
      hasSession: (sessionId) => tx.hasSession(sessionId),
      createSession: (session) => {
        tx.createSession(session);
      },
      emit: (input) => {
        if (failing.has(input.sessionId)) throw new Error(`injected pre-apply failure for ${input.sessionId}`);
        return tx.emit(input);
      },
      recordReceipt: (commandId, record) => {
        tx.recordReceipt(commandId, record);
      },
      findReceipt: (commandId) => tx.findReceipt(commandId),
    };
  }

  async function gated<T>(read: () => Promise<T>): Promise<T> {
    const current = gate;
    if (current !== undefined) {
      current.entered.resolve(undefined);
      await current.open.promise;
      if (current.fail) throw new Error('injected reconciliation read failure');
    }
    return read();
  }

  const store: RuntimeStore = {
    get revision() {
      return base.revision;
    },
    commit<T>(mutate: (tx: StoreTransaction) => T): Promise<{ value: T } & CommitResult> {
      commitCalls += 1;
      if (applyThenRejectNext) {
        applyThenRejectNext = false;
        return base.commit(mutate).then((): never => {
          throw new Error('injected rejection after the transaction applied');
        });
      }
      const run = () => base.commit((tx) => mutate(guarded(tx)));
      if (!holding) return run();
      return new Promise<{ value: T } & CommitResult>((resolve, reject) => {
        held.push({
          release: () => {
            run().then(resolve, reject);
          },
          fail: () => {
            reject(new Error('injected held rejection'));
          },
        });
        for (const waiter of heldWaiters.splice(0)) waiter();
      });
    },
    read: (sessionId) =>
      gated(async () => {
        snapshotReads += 1;
        if (failSnapshotReads) throw new Error('injected snapshot read failure');
        const snapshot = await base.read(sessionId);
        return snapshot === undefined || snapshotTransform === undefined ? snapshot : snapshotTransform(snapshot);
      }),
    readEvents: (sessionId, from, limit) => gated(() => base.readEvents(sessionId, from, limit)),
    readInteraction: (sessionId, interactionId) => base.readInteraction(sessionId, interactionId),
    findReceipt: (commandId) => gated(() => base.findReceipt(commandId)),
    listSessions: () => base.listSessions(),
  };

  const hub = createSubscriptionHub({ store, clock });
  /** Every envelope the hub was asked to publish, in call order: a duplicate publish is directly visible. */
  const published: { sessionId: SessionId; eventId: string; sequence: number }[] = [];
  const publish = hub.publish.bind(hub);
  hub.publish = (sessionId, events) => {
    for (const event of events) published.push({ sessionId, eventId: event.eventId, sequence: event.sequence });
    publish(sessionId, events);
  };
  const interrupts: { sessionId: SessionId; runId: RunId }[] = [];
  const driver = createIngressDriver({
    store,
    hub,
    storeContract: contract,
    materializeEvent: (tx, input) => {
      if (!materializePlainProviderEvent(tx, input)) {
        throw new Error('interaction materialization belongs to surface 3');
      }
    },
    interruptRun: (sessionId, runId) => {
      interrupts.push({ sessionId, runId });
      return Promise.resolve();
    },
  });

  // ---- session and run helpers -----------------------------------------------------
  let commands = 0;
  const identity = (label: string): CommandIdentity => ({
    commandId: CommandIdSchema.parse(`ingress-${String(++commands).padStart(6, '0')}-${label}`),
    fingerprint: `fp:${label}`,
    acceptedAt: clock.now(),
  });

  function sessionRecord(sessionId: SessionId): AgentSession {
    return {
      sessionId,
      state: 'opening',
      providerId: 'scripted',
      wireVersion: WIRE_VERSION,
      workspace: {
        leaseId: WorkspaceLeaseIdSchema.parse(idFactory.next('workspaceLease')),
        ownership: 'borrowed',
        root: '/workspace',
        acquiredAt: clock.now(),
        released: false,
      },
      createdAt: clock.now(),
      sequence: 0 as Sequence,
      turnIds: [],
    };
  }

  function openPlan(session: AgentSession): IngressPlan {
    return ingressPlan((tx) => {
      tx.createSession(session);
      tx.emit({
        sessionId: session.sessionId,
        payload: { type: 'session.opened', providerId: session.providerId, workspace: session.workspace },
      });
    });
  }

  /** Reserve the session-open effect; the caller decides when the provider session "resolves". */
  function beginSession(): { sessionId: SessionId; sink: ProviderEventSink; activate(): void; reject(): void } {
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const session = sessionRecord(sessionId);
    const sink = driver.openSession(sessionId, identity('open'));
    return {
      sessionId,
      sink,
      activate: () => {
        driver.settleOpen(sessionId, { kind: 'applied', plan: openPlan(session) });
      },
      reject: () => {
        driver.settleOpen(sessionId, { kind: 'rejected' });
      },
    };
  }

  async function open(): Promise<{ sessionId: SessionId; sink: ProviderEventSink }> {
    const begun = beginSession();
    begun.activate();
    await driver.settled();
    return { sessionId: begun.sessionId, sink: begun.sink };
  }

  type Run = {
    readonly runId: RunId;
    readonly turnId: TurnId;
    readonly ordinal: number;
    readonly sink: ProviderEventSink;
    resolve(): void;
    reject(): void;
  };

  function reserveRun(sessionId: SessionId): Run {
    const runId = RunIdSchema.parse(idFactory.next('run'));
    const turnId = TurnIdSchema.parse(idFactory.next('turn'));
    const submit = identity('submit');
    const reserved = driver.reserveRun(sessionId, { runId, turnId, attempt: 1, identity: submit });
    if (reserved.kind !== 'reserved') throw new Error(`start refused: ${JSON.stringify(reserved)}`);
    return {
      runId,
      turnId,
      ordinal: reserved.ordinal,
      sink: reserved.sink,
      resolve: () => {
        driver.settleStart(sessionId, reserved.ordinal, {
          kind: 'applied',
          plan: ingressPlan((tx) => {
            tx.emit({
              sessionId,
              payload: { type: 'turn.started', turnId, input: { parts: [{ type: 'text', text: 'go' }] } },
            });
            tx.emit({ sessionId, runId, payload: { type: 'run.started', turnId, attempt: 1 } });
          }),
        });
      },
      reject: () => {
        driver.settleStart(sessionId, reserved.ordinal, {
          kind: 'rejected',
          plan: ingressPlan((tx) => {
            tx.recordReceipt(submit.commandId, {
              fingerprint: submit.fingerprint,
              receipt: {
                commandId: submit.commandId,
                commandType: 'submit_turn',
                disposition: 'rejected',
                error: agentError('provider_rejected', 'start rejected'),
                acceptedAt: submit.acceptedAt,
              },
            });
          }),
        });
      },
    };
  }

  async function startRun(sessionId: SessionId): Promise<Run> {
    const run = reserveRun(sessionId);
    run.resolve();
    await driver.settled();
    return run;
  }

  function terminalPlan(sessionId: SessionId, run: Run): IngressPlan {
    return ingressPlan((tx, op) => {
      if (op.kind !== 'terminal') throw new Error('terminal plan applied to a non-terminal operation');
      const outcome = op.intent.outcome;
      const error =
        outcome === 'failed'
          ? agentError(
              'provider_contract_violation',
              op.intent.overflowed ? 'provider event history overflowed' : 'failed',
            )
          : undefined;
      tx.emit({
        sessionId,
        runId: run.runId,
        payload: {
          type: 'run.finished',
          turnId: run.turnId,
          termination: { outcome, at: clock.now(), ...(error === undefined ? {} : { error }) },
        },
      });
      tx.emit({
        sessionId,
        payload: {
          type: 'turn.settled',
          turnId: run.turnId,
          state: outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'cancelled' : 'failed',
          ...(error === undefined ? {} : { error }),
        },
      });
    });
  }

  async function history(sessionId: SessionId): Promise<readonly EventEnvelope[]> {
    return (await base.readEvents(sessionId, 0 as Sequence, 10_000)).events;
  }

  async function liveSubscriber(sessionId: SessionId): Promise<AsyncIterator<SubscriptionMessage>> {
    const subscription = hub.subscribe(SubscriptionRequestSchema.parse({ sessionId, bufferSize: 4096 }));
    const iterator = subscription[Symbol.asyncIterator]();
    for (;;) {
      const message = await iterator.next();
      if (message.done === true) throw new Error('subscription ended before caught_up');
      if (message.value.type === 'caught_up') return iterator;
    }
  }

  return {
    clock,
    base,
    store,
    hub,
    driver,
    failing,
    interrupts,
    beginSession,
    open,
    reserveRun,
    startRun,
    terminalPlan,
    history,
    liveSubscriber,
    commitCalls: () => commitCalls,
    snapshotReads: () => snapshotReads,
    published,
    tamperSnapshots(transform: ((snapshot: SessionSnapshot) => SessionSnapshot) | undefined): void {
      snapshotTransform = transform;
    },
    failSnapshotReads(fail: boolean): void {
      failSnapshotReads = fail;
    },
    hold(): void {
      holding = true;
    },
    unhold(): void {
      holding = false;
    },
    held: (): readonly HeldCommit[] => held,
    /** Resolves once at least `count` commits are being held. */
    heldCount(count: number): Promise<void> {
      if (held.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (held.length >= count) resolve();
          else heldWaiters.push(check);
        };
        heldWaiters.push(check);
      });
    },
    applyThenRejectNext(): void {
      applyThenRejectNext = true;
    },
    gateReads(): ReadGate {
      const current = { entered: deferred<undefined>(), open: deferred<undefined>(), fail: false };
      gate = current;
      return {
        entered: current.entered.promise,
        release: () => {
          gate = undefined;
          current.open.resolve(undefined);
        },
        fail: () => {
          gate = undefined;
          current.fail = true;
          current.open.resolve(undefined);
        },
      };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function texts(events: readonly EventEnvelope[]): string[] {
  return events.flatMap((event) => (event.payload.type === 'run.message_delta' ? [event.payload.text] : []));
}

function messages(events: readonly EventEnvelope[]): string[] {
  return events.flatMap((event) => (event.payload.type === 'diagnostic' ? [event.payload.message] : []));
}

function counted(value: Fixture, sessionId: SessionId): number {
  const state = value.driver.inspect(sessionId);
  if (state === undefined) throw new Error('no ingestion state');
  return state.counted;
}

/** Emit session-sink diagnostics until exactly the session budget is used. */
function fillSessionBudget(value: Fixture, sessionId: SessionId, sink: ProviderEventSink): number {
  let emitted = 0;
  while (counted(value, sessionId) < SESSION_OPERATION_LIMIT) {
    sink.emit(note(`fill-${String(emitted)}`));
    emitted += 1;
  }
  return emitted;
}

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentRuntimeError) return error;
    throw error;
  }
  throw new Error('expected an AgentRuntimeError rejection');
}

// ---------------------------------------------------------------------------
// A2: shared FIFO, per-session stall, prompt retry, count-only cap
// ---------------------------------------------------------------------------

describe('S2-A2 shared session/run FIFO and capacity', () => {
  it('interleaves session and run sinks in one FIFO, including emissions captured before the start resolved', async () => {
    const value = fixture();
    const { sessionId, sink: sessionSink } = await value.open();
    const run = value.reserveRun(sessionId);
    run.sink.emit(delta('early-1'));
    sessionSink.emit(note('early-session'));
    run.sink.emit(delta('early-2'));
    await value.driver.settled();
    // The pending start owns the head: nothing captured behind it has persisted.
    expect((await value.history(sessionId)).map((event) => event.payload.type)).toEqual(['session.opened']);

    run.resolve();
    run.sink.emit(delta('live-1'));
    sessionSink.emit(note('live-session'));
    run.sink.emit(delta('live-2'));
    await value.driver.settled();

    const events = await value.history(sessionId);
    expect(
      events.map((event) =>
        event.payload.type === 'run.message_delta'
          ? `run:${event.payload.text}`
          : event.payload.type === 'diagnostic'
            ? `session:${event.payload.message}`
            : event.payload.type,
      ),
    ).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run:early-1',
      'session:early-session',
      'run:early-2',
      'run:live-1',
      'session:live-session',
      'run:live-2',
    ]);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    // Every committed envelope was published exactly once, in commit order.
    expect(value.published.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.eventId)).toEqual(
      events.map((event) => event.eventId),
    );
    expect(value.driver.fault(sessionId)).toBeUndefined();
  });

  it('a failed head stalls only its own session and retry returns promptly with F', async () => {
    const value = fixture();
    const a = await value.open();
    const b = await value.open();

    value.failing.add(a.sessionId);
    a.sink.emit(note('a-1'));
    a.sink.emit(note('a-2'));
    b.sink.emit(note('b-1'));
    await value.driver.settled();

    expect(value.driver.fault(a.sessionId)).toMatchObject({
      kind: 'failure',
      failureCount: 1,
      error: { code: 'store_unavailable', retryable: true },
    });
    expect(value.driver.fault(b.sessionId)).toBeUndefined();
    expect(messages(await value.history(a.sessionId))).toEqual([]);
    expect(messages(await value.history(b.sessionId))).toEqual(['b-1']);
    const head = value.driver.inspect(a.sessionId)?.queue[0];
    expect(value.driver.inspect(a.sessionId)?.queue).toHaveLength(2);

    // Session B's next commit is held in flight. A's retry must not wait for it.
    value.hold();
    b.sink.emit(note('b-2'));
    await value.heldCount(1);
    value.unhold();
    const retried = await rejection(value.driver.retry(a.sessionId));
    expect(retried.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    expect(value.driver.fault(a.sessionId)).toMatchObject({ kind: 'failure', failureCount: 2 });
    // The retained head is the same immutable operation, not a rebuilt copy.
    expect(value.driver.inspect(a.sessionId)?.queue[0]).toBe(head);
    expect(Object.isFrozen(head)).toBe(true);
    // B is still in flight: A's stalled head and its retry never blocked or depended on B.
    expect(messages(await value.history(b.sessionId))).toEqual(['b-1']);

    value.held()[0]?.release();
    value.failing.delete(a.sessionId);
    await value.driver.retry(a.sessionId);
    await value.driver.settled();
    expect(value.driver.fault(a.sessionId)).toBeUndefined();
    expect(messages(await value.history(a.sessionId))).toEqual(['a-1', 'a-2']);
    expect(messages(await value.history(b.sessionId))).toEqual(['b-1', 'b-2']);
  });

  it('1,024 tiny operations at a blocked head retain at most 1,023 plus the terminal', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const run = await value.startRun(sessionId);

    value.hold();
    run.sink.emit(delta('d-0'));
    await value.heldCount(1);
    for (let index = 1; index < SESSION_OPERATION_LIMIT + 1; index += 1) run.sink.emit(delta(`d-${String(index)}`));

    const state = value.driver.inspect(sessionId);
    // The in-flight head counts: 1 + 1,022 accepted, the 1,024th refused before acceptance.
    expect(state?.counted).toBe(SESSION_OPERATION_LIMIT);
    expect(state?.queue).toHaveLength(SESSION_OPERATION_LIMIT);
    expect(state?.head).toMatchObject({ status: 'in-flight' });
    expect(value.driver.fault(sessionId)).toMatchObject({
      kind: 'overflow',
      permanent: true,
      error: { code: 'store_unavailable', retryable: false },
    });

    // The terminal slot is reserved outside the nonterminal budget; overflow fails a success intent.
    value.driver.chooseTerminal(sessionId, run.runId, 'succeeded', value.terminalPlan(sessionId, run));
    expect(state?.queue).toHaveLength(SESSION_OPERATION_LIMIT + 1);
    expect(state?.counted).toBe(SESSION_OPERATION_LIMIT);
    expect(state?.queue.at(-1)).toMatchObject({ kind: 'terminal', intent: { outcome: 'failed', overflowed: true } });

    value.unhold();
    value.held()[0]?.release();
    await value.driver.settled();
    // The overflow interrupted the current run exactly once, after a handle existed.
    expect(value.interrupts).toEqual([{ sessionId, runId: run.runId }]);

    const events = await value.history(sessionId);
    expect(texts(events)).toEqual(Array.from({ length: SESSION_OPERATION_LIMIT }, (_, index) => `d-${String(index)}`));
    expect(events.at(-2)?.payload).toMatchObject({ type: 'run.finished', termination: { outcome: 'failed' } });
    expect(events.at(-1)?.payload).toMatchObject({ type: 'turn.settled', state: 'failed' });
    // The accepted prefix drained, but O is permanent: history is still incomplete.
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
  });

  it('caps operation count, not bytes: one large body is one operation', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const run = await value.startRun(sessionId);
    // `run.message_delta` text is schema-bounded; a tool-activity JSON detail is not.
    const blob = 'x'.repeat(1 << 20);

    value.hold();
    run.sink.emit(delta('small'));
    await value.heldCount(1);
    run.sink.emit({ payload: { type: 'run.tool_activity', toolName: 'large', phase: 'succeeded', detail: { blob } } });
    expect(counted(value, sessionId)).toBe(2);
    value.unhold();
    value.held()[0]?.release();
    await value.driver.settled();
    const events = await value.history(sessionId);
    expect(texts(events)).toEqual(['small']);
    const large = events.find((event) => event.payload.type === 'run.tool_activity');
    expect(large?.payload).toMatchObject({ type: 'run.tool_activity', detail: { blob } });
    expect(messages(events)).toEqual([]);
    expect(value.driver.fault(sessionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A6: overflow target, retired sinks, activation bound
// ---------------------------------------------------------------------------

describe('S2-A6 overflow target, retired sinks and activation', () => {
  it('a session-sink overflow during a pending start targets the current run; a late retired sink takes no slot', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const first = await value.startRun(sessionId);
    value.driver.chooseTerminal(sessionId, first.runId, 'succeeded', value.terminalPlan(sessionId, first));
    await value.driver.settled();
    expect(value.driver.inspect(sessionId)?.run).toBeUndefined();

    const second = value.reserveRun(sessionId);
    fillSessionBudget(value, sessionId, sink);
    // The retired emitter is discarded before counting: no slot and no overflow at the cap.
    first.sink.emit(delta('late from a retired run'));
    expect(counted(value, sessionId)).toBe(SESSION_OPERATION_LIMIT);
    expect(value.driver.fault(sessionId)).toBeUndefined();

    sink.emit(note('excess'));
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
    await value.driver.settled();
    // No provider handle exists yet, so the interrupt is deferred rather than lost or misdirected.
    expect(value.interrupts).toEqual([]);

    second.resolve();
    await value.driver.settled();
    expect(value.interrupts).toEqual([{ sessionId, runId: second.runId }]);
    const events = await value.history(sessionId);
    expect(texts(events)).toEqual([]);
    expect(messages(events)).not.toContain('excess');
    expect(messages(events)).toHaveLength(SESSION_OPERATION_LIMIT - 1);
  });

  it('257 run-sink events before activation mark O permanently instead of appending a warning tail', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const run = value.reserveRun(sessionId);
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1) run.sink.emit(delta(`staged-${String(index)}`));
    // Fail closed while the owner start is unresolved, but do not call it permanent: a rejected
    // start would roll this overflow back.
    const provisional = value.driver.fault(sessionId);
    expect(provisional).toMatchObject({
      kind: 'overflow',
      permanent: false,
      error: { code: 'store_unavailable', retryable: false, details: { fault: 'overflow', permanent: false } },
    });
    expect(provisional?.error.message).not.toMatch(/permanent/iu);

    run.resolve();
    await value.driver.settled();
    const permanent = value.driver.fault(sessionId);
    expect(permanent).toMatchObject({
      kind: 'overflow',
      permanent: true,
      error: { retryable: false, details: { fault: 'overflow', permanent: true } },
    });
    expect(permanent?.error.message).toMatch(/permanently incomplete/u);
    const events = await value.history(sessionId);
    expect(texts(events)).toEqual(
      Array.from({ length: PRE_ACTIVATION_LIMIT }, (_, index) => `staged-${String(index)}`),
    );
    expect(events.map((event) => event.payload.type).indexOf('run.started')).toBeLessThan(
      events.map((event) => event.payload.type).indexOf('run.message_delta'),
    );
    expect(messages(events)).toEqual([]);
    // The overflow happened before a handle existed; the interrupt ran once the start resolved.
    expect(value.interrupts).toEqual([{ sessionId, runId: run.runId }]);

    // Permanent: later output is refused even though capacity is free again.
    run.sink.emit(delta('after'));
    await value.driver.settled();
    expect(texts(await value.history(sessionId))).toHaveLength(PRE_ACTIVATION_LIMIT);
  });

  it('257 session-sink events before session.opened mark O permanently; a failed open leaves no ghost marker', async () => {
    const value = fixture();
    const kept = value.beginSession();
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1) kept.sink.emit(note(`opening-${String(index)}`));
    expect(value.driver.fault(kept.sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
    kept.activate();
    await value.driver.settled();
    const events = await value.history(kept.sessionId);
    expect(events[0]?.payload.type).toBe('session.opened');
    expect(messages(events)).toEqual(
      Array.from({ length: PRE_ACTIVATION_LIMIT }, (_, index) => `opening-${String(index)}`),
    );

    const failed = value.beginSession();
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1) failed.sink.emit(note(`doomed-${String(index)}`));
    failed.reject();
    await value.driver.settled();
    expect(value.driver.fault(failed.sessionId)).toBeUndefined();
    expect(value.driver.inspect(failed.sessionId)).toBeUndefined();
    expect(value.driver.faults().map((fault) => fault.sessionId)).toEqual([kept.sessionId]);
    expect(() => failed.sink.emit(note('after discard'))).not.toThrow();
    expect(await value.base.read(failed.sessionId)).toBeUndefined();
  });

  it('a request captured after completion was chosen persists as a contract diagnostic ahead of the terminal', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const run = value.reserveRun(sessionId);
    run.sink.emit(delta('before completion'));
    value.driver.chooseTerminal(sessionId, run.runId, 'succeeded', value.terminalPlan(sessionId, run));
    run.sink.emit({
      payload: {
        type: 'interaction.requested',
        providerRef: 'late-question',
        request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
      },
    });
    run.resolve();
    await value.driver.settled();

    const events = await value.history(sessionId);
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.message_delta',
      'diagnostic',
      'run.finished',
      'turn.settled',
    ]);
    expect(events[4]).toMatchObject({
      runId: run.runId,
      payload: { level: 'warning', detail: { code: 'provider_contract_violation' } },
    });
    expect(events[5]?.payload).toMatchObject({ termination: { outcome: 'succeeded' } });
    expect(value.driver.fault(sessionId)).toBeUndefined();
  });

  it('a rejected start discards only its own staging and rolls back an overflow caused solely by it', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const run = value.reserveRun(sessionId);
    sink.emit(note('independent session output'));
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1) run.sink.emit(delta(`staged-${String(index)}`));
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: false });

    run.reject();
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toBeUndefined();
    const events = await value.history(sessionId);
    expect(events.map((event) => event.payload.type)).toEqual(['session.opened', 'diagnostic']);
    expect(texts(events)).toEqual([]);
    expect(value.interrupts).toEqual([]);
    run.sink.emit(delta('late'));
    expect(counted(value, sessionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A7 (surface 2 parts): fault wake, query precedence, retry reporting, read guards
// ---------------------------------------------------------------------------

describe('S2-A7 fault wake and precedence', () => {
  it('an idle live subscriber after caught_up wakes and rejects on F', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    value.failing.add(sessionId);
    sink.emit(note('lost'));
    const woke = await rejection(idle);
    expect(woke.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure' });
  });

  it('an idle live subscriber after caught_up wakes and rejects on O', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    // Hold the head so nothing publishes: the subscriber stays idle until the overflow.
    value.hold();
    sink.emit(note('head'));
    await value.heldCount(1);
    fillSessionBudget(value, sessionId, sink);
    sink.emit(note('excess'));
    const woke = await rejection(idle);
    expect(woke.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow' });
    // The head is still held: the wake did not depend on any commit or publish.
    expect(value.held()).toHaveLength(1);
  });

  it('an idle live subscriber wakes and rejects on A before the reconciliation read resolves', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    const reads = value.gateReads();
    const snapshotReadsBefore = value.snapshotReads();
    value.applyThenRejectNext();
    sink.emit(note('applied then rejected'));
    await reads.entered;
    const woke = await rejection(idle);
    expect(woke.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: false });
    expect(() => value.driver.ensureReplayReady(sessionId)).toThrow(AgentRuntimeError);

    // Read-after-failure proves the transaction applied: publish it once, never append a copy.
    reads.release();
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toBeUndefined();
    const events = await value.history(sessionId);
    expect(messages(events)).toEqual(['applied then rejected']);
    // The certifying proof read the projection snapshot, not only the log page.
    expect(value.snapshotReads()).toBeGreaterThan(snapshotReadsBefore);
    // Published exactly once, by the reconciliation, and the head advanced exactly once.
    const applied = events.find((event) => event.payload.type === 'diagnostic');
    expect(value.published.filter((entry) => entry.eventId === applied?.eventId)).toHaveLength(1);
    expect(value.driver.inspect(sessionId)?.queue).toHaveLength(0);
    const replay = await value.liveSubscriber(sessionId);
    await replay.return?.();
    expect(value.commitCalls()).toBe(2);
  });

  it('an unverified store adapter fails closed: A is permanent and its head is never resubmitted', async () => {
    const value = fixture('unverified');
    const { sessionId, sink } = await value.open();
    value.failing.add(sessionId);
    sink.emit(note('unknown outcome'));
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({
      kind: 'ambiguous',
      permanent: true,
      error: { code: 'store_unavailable', retryable: false },
    });
    const calls = value.commitCalls();
    value.failing.delete(sessionId);
    const refused = await rejection(value.driver.retry(sessionId));
    expect(refused.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    await value.driver.settled();
    expect(value.commitCalls()).toBe(calls);
    expect(messages(await value.history(sessionId))).toEqual([]);
  });

  it('F+O reports O; retry reports F while the head fails, then O after the prefix drains', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    value.failing.add(sessionId);
    sink.emit(note('head'));
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure', error: { retryable: true } });

    fillSessionBudget(value, sessionId, sink);
    sink.emit(note('excess'));
    expect(value.driver.fault(sessionId)).toMatchObject({
      kind: 'overflow',
      error: { code: 'store_unavailable', retryable: false },
    });
    expect(value.driver.faults()).toHaveLength(1);

    const whileFailing = await rejection(value.driver.retry(sessionId));
    expect(whileFailing.error).toMatchObject({ code: 'store_unavailable', retryable: true });

    value.failing.delete(sessionId);
    const afterDrain = await rejection(value.driver.retry(sessionId));
    expect(afterDrain.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
    const drained = messages(await value.history(sessionId));
    expect(drained[0]).toBe('head');
    expect(drained).toHaveLength(SESSION_OPERATION_LIMIT);
    expect(drained).not.toContain('excess');
  });

  it('A+O+F reports A, and no retry resubmits the ambiguous head', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    value.failing.add(sessionId);
    sink.emit(note('head'));
    await value.driver.settled();
    fillSessionBudget(value, sessionId, sink);
    sink.emit(note('excess'));
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow' });

    // The retried head applies but its commit promise rejects; the reconciliation read is held.
    value.failing.delete(sessionId);
    const reads = value.gateReads();
    value.applyThenRejectNext();
    const firstRetry = value.driver.retry(sessionId);
    await reads.entered;
    const state = value.driver.inspect(sessionId);
    expect(state?.faults.ambiguous).toBeDefined();
    expect(state?.faults.overflow).toBeDefined();
    expect(state?.faults.failure).toBeDefined();
    expect(value.driver.fault(sessionId)).toMatchObject({
      kind: 'ambiguous',
      error: { code: 'store_unavailable', retryable: false },
    });
    const callsWhileAmbiguous = value.commitCalls();
    // A concurrent retry while A is set refuses at once; it neither resubmits nor waits for reconciliation.
    const concurrent = await rejection(value.driver.retry(sessionId));
    expect(concurrent.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.commitCalls()).toBe(callsWhileAmbiguous);

    // The read fails: the outcome cannot be established, so A becomes permanent.
    reads.fail();
    const first = await rejection(firstRetry);
    expect(first.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: true });
    const later = await rejection(value.driver.retry(sessionId));
    expect(later.error).toMatchObject({ retryable: false });
    await value.driver.settled();
    expect(value.commitCalls()).toBe(callsWhileAmbiguous);
  });

  it('reads, replay and quiesce reject while a fault remains, including a replay page held across the fault', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();

    // A replaying subscriber's page read is held while the fault arrives.
    const reads = value.gateReads();
    const held = value.hub.subscribe(SubscriptionRequestSchema.parse({ sessionId }));
    const firstPage = held[Symbol.asyncIterator]().next();
    await reads.entered;
    value.failing.add(sessionId);
    sink.emit(note('lost'));
    await value.driver.settled();
    reads.release();
    // The held page (containing `session.opened`) is never delivered as healthy history.
    const replayed = await rejection(firstPage);
    expect(replayed.error).toMatchObject({ code: 'store_unavailable' });
    await held.close();

    expect(() => value.driver.ensureReplayReady(sessionId)).toThrow(AgentRuntimeError);
    expect((await rejection(value.driver.quiesce())).error).toMatchObject({ code: 'store_unavailable' });
    expect((await rejection(hubReplay(value, sessionId))).error).toMatchObject({ code: 'store_unavailable' });

    value.failing.delete(sessionId);
    await value.driver.retry(sessionId);
    expect(() => value.driver.ensureReplayReady(sessionId)).not.toThrow();
    await value.driver.quiesce();
    await expect(hubReplay(value, sessionId)).resolves.toBe('caught_up');
  });
});

// ---------------------------------------------------------------------------
// Repair round 1: per-delivery replay guard, close race, projection-consistent proof
// ---------------------------------------------------------------------------

describe('S2R1 replay delivery and close race', () => {
  it('a replay suspended inside one page rejects on its next pull once a fault arrives', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    sink.emit(note('first'));
    sink.emit(note('second'));
    await value.driver.settled();

    const subscription = value.hub.subscribe(SubscriptionRequestSchema.parse({ sessionId }));
    const iterator = subscription[Symbol.asyncIterator]();
    const opened = await iterator.next();
    expect(opened.value).toMatchObject({ type: 'event', replay: true, event: { payload: { type: 'session.opened' } } });

    // Suspended after the first event of a page that already holds `first` and `second`.
    value.failing.add(sessionId);
    sink.emit(note('lost'));
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure' });
    const next = await rejection(iterator.next());
    expect(next.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    await subscription.close();
  });

  it('a fault notification followed synchronously by closeAll rejects instead of yielding closed', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    value.hold();
    sink.emit(note('head'));
    await value.heldCount(1);
    fillSessionBudget(value, sessionId, sink);
    // The overflow wakes the idle subscriber synchronously; a shutdown-style closeAll follows in the same tick.
    sink.emit(note('excess'));
    value.hub.closeAll();
    const woke = await rejection(idle);
    expect(woke.error).toMatchObject({ code: 'store_unavailable', retryable: false });
  });
});

describe('S2R1 reconciliation requires a projection-consistent proof', () => {
  /** Apply a run delta whose commit promise then rejects; settle the reconciliation. */
  async function appliedThenRejected(
    value: Fixture,
    tamper?: (snapshot: SessionSnapshot) => SessionSnapshot,
    failSnapshot = false,
  ) {
    const { sessionId } = await value.open();
    const run = await value.startRun(sessionId);
    const publishedBefore = value.published.length;
    const snapshotReadsBefore = value.snapshotReads();
    value.tamperSnapshots(tamper);
    value.failSnapshotReads(failSnapshot);
    value.applyThenRejectNext();
    run.sink.emit(delta('folded output'));
    await value.driver.settled();
    value.tamperSnapshots(undefined);
    value.failSnapshotReads(false);
    return {
      sessionId,
      published: value.published.slice(publishedBefore),
      snapshotReads: value.snapshotReads() - snapshotReadsBefore,
    };
  }

  async function expectRetainedPermanentA(value: Fixture, sessionId: SessionId, published: readonly unknown[]) {
    expect(value.driver.fault(sessionId)).toMatchObject({
      kind: 'ambiguous',
      permanent: true,
      error: { code: 'store_unavailable', retryable: false },
    });
    // Nothing published and the head was not removed: history is not certified.
    expect(published).toEqual([]);
    const state = value.driver.inspect(sessionId);
    expect(state?.queue).toHaveLength(1);
    expect(state?.queue[0]).toMatchObject({ kind: 'body' });
    expect(state?.head).toMatchObject({ status: 'ambiguous' });
    const calls = value.commitCalls();
    expect((await rejection(value.driver.retry(sessionId))).error).toMatchObject({ retryable: false });
    await value.driver.settled();
    expect(value.commitCalls()).toBe(calls);
  }

  it('a consistent log and snapshot certify application: the head advances once and publishes once', async () => {
    const value = fixture();
    const { sessionId, published, snapshotReads } = await appliedThenRejected(value);
    expect(snapshotReads).toBeGreaterThan(0);
    expect(value.driver.fault(sessionId)).toBeUndefined();
    const events = await value.history(sessionId);
    expect(texts(events)).toEqual(['folded output']);
    const applied = events.find((event) => event.payload.type === 'run.message_delta');
    expect(published).toEqual([{ sessionId, eventId: applied?.eventId, sequence: applied?.sequence }]);
    expect(value.driver.inspect(sessionId)?.queue).toHaveLength(0);
  });

  it('a snapshot sequence behind the log keeps A permanent, publishes nothing and keeps the head', async () => {
    const value = fixture();
    const { sessionId, published, snapshotReads } = await appliedThenRejected(value, (snapshot) => ({
      ...snapshot,
      session: { ...snapshot.session, sequence: (snapshot.session.sequence - 1) as Sequence },
    }));
    expect(snapshotReads).toBeGreaterThan(0);
    await expectRetainedPermanentA(value, sessionId, published);
  });

  it('a projection that disagrees with the log at the right sequence keeps A permanent', async () => {
    const value = fixture();
    const { sessionId, published, snapshotReads } = await appliedThenRejected(value, (snapshot) => ({
      ...snapshot,
      turns: snapshot.turns.map((turn) => ({ ...turn, output: 'not what the log folds to' })),
    }));
    expect(snapshotReads).toBeGreaterThan(0);
    await expectRetainedPermanentA(value, sessionId, published);
  });

  it('an unavailable snapshot read keeps A permanent', async () => {
    const value = fixture();
    const { sessionId, published } = await appliedThenRejected(value, undefined, true);
    await expectRetainedPermanentA(value, sessionId, published);
  });
});

describe('S2-A7 quiesce wake', () => {
  it('quiesce rejects as soon as a fault appears, without waiting for another session’s held commit', async () => {
    const value = fixture();
    const a = await value.open();
    const b = await value.open();
    value.hold();
    a.sink.emit(note('held in flight'));
    await value.heldCount(1);
    value.unhold();
    const waiting = value.driver.quiesce();

    value.failing.add(b.sessionId);
    b.sink.emit(note('lost'));
    const refused = await rejection(waiting);
    expect(refused.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    // Session A's commit is still held: quiesce neither waited for it nor certified it.
    expect(messages(await value.history(a.sessionId))).toEqual([]);
    expect(value.driver.fault(a.sessionId)).toBeUndefined();
  });
});

/** Start a replaying subscription and resolve with its first non-event message type. */
async function hubReplay(value: Fixture, sessionId: SessionId): Promise<string> {
  const subscription = value.hub.subscribe(SubscriptionRequestSchema.parse({ sessionId }));
  const iterator = subscription[Symbol.asyncIterator]();
  try {
    for (;;) {
      const message = await iterator.next();
      if (message.done === true) return 'done';
      if (message.value.type !== 'event') return message.value.type;
    }
  } finally {
    await subscription.close();
  }
}
