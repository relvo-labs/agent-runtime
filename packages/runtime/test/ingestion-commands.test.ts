/**
 * Issue #43 surface 3: start ownership, terminal submission, response and
 * interrupt settlement, interaction routing and immutable retries through the
 * private ingress seam (`src/ingress.ts`), against the real in-memory store,
 * the real subscription hub and fake provider handles.
 *
 * `createAgentRuntime` does not route through this seam yet: close and
 * shutdown (surface 4) still commit directly, so wiring these commands alone
 * would leave an observable FIFO bypass. These tests prove the seam the atomic
 * cutover will install, not live runtime behavior.
 *
 * Determinism: every provider call returns a deferred promise the test settles
 * explicitly; store commits, acknowledgements and reconciliation reads are held
 * or failed on demand. A helper that settles a provider promise awaits that
 * same promise afterwards, so the driver's own reaction (registered first) has
 * run before the test continues. No test sleeps or asserts elapsed time.
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
  canonicalCommandFingerprint,
  createCounterIdFactory,
  createFixedClock,
  type AgentSession,
  type CommandId,
  type EventEnvelope,
  type InteractionId,
  type InteractionResponse,
  type InterruptRunCommand,
  type ProviderEventInput,
  type RespondToInteractionCommand,
  type RunId,
  type Sequence,
  type SessionId,
  type SubmitTurnCommand,
  type SubscriptionMessage,
  type TurnId,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRejection,
  type ProviderEventSink,
  type ProviderRun,
  type ProviderRunRequest,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';

import { SESSION_OPERATION_LIMIT, runFenced, runPhase, type Operation } from '../src/ingestion.ts';
import {
  createIngressDriver,
  ingressPlan,
  type IngressCommandOutcome,
  type IngressPayload,
  type IngressStoreContract,
} from '../src/ingress.ts';
import { createInMemoryStore, type CommitResult, type RuntimeStore, type StoreTransaction } from '../src/store.ts';
import { createSubscriptionHub } from '../src/subscriptions.ts';

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Records every call and hands each one its own deferred result. */
function controllable<A extends unknown[], R>(observe: (...args: A) => unknown) {
  const calls: { readonly args: A; readonly observed: unknown; readonly result: Deferred<R> }[] = [];
  const waiters: (() => void)[] = [];
  return {
    calls,
    fn: (...args: A): Promise<R> => {
      const result = deferred<R>();
      calls.push({ args, observed: observe(...args), result });
      for (const waiter of waiters.splice(0)) waiter();
      return result.promise;
    },
    /** Resolves once at least `count` calls have been made. */
    entered(count = 1): Promise<void> {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (calls.length >= count) resolve();
          else waiters.push(check);
        };
        waiters.push(check);
      });
    },
    /** Settle call `index`; the driver's reaction has run when this resolves. */
    async resolve(index: number, value: R): Promise<void> {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call ${String(index)}`);
      call.result.resolve(value);
      await call.result.promise;
    },
    async reject(index: number, error: unknown): Promise<void> {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call ${String(index)}`);
      call.result.reject(error);
      await call.result.promise.catch(() => undefined);
    },
  };
}

type HeldCommit = { release(): void; fail(): void };
type ReadGate = { readonly entered: Promise<undefined>; release(): void; fail(): void };

const delta = (text: string): ProviderEventInput => ({ payload: { type: 'run.message_delta', text } });
const note = (message: string): ProviderEventInput => ({ payload: { type: 'diagnostic', level: 'info', message } });
const question = (providerRef: string): ProviderEventInput => ({
  payload: {
    type: 'interaction.requested',
    providerRef,
    request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
  },
});
const withdrawn = (providerRef: string): ProviderEventInput => ({
  payload: { type: 'interaction.withdrawn', providerRef },
});
const yes: InteractionResponse = { kind: 'question', answer: 'yes' };

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type FakeRun = {
  readonly handle: ProviderRun;
  /** Reasons passed to `interrupt()`, in call order. */
  readonly interrupts: (string | undefined)[];
  /** How the next `interrupt()` call settles. */
  interruptMode: 'resolve' | 'hold' | 'reject' | 'unknown';
  readonly heldInterrupts: Deferred<undefined>[];
  interruptEntered(count?: number): Promise<void>;
  complete(termination: ProviderRunTermination): Promise<void>;
  failCompletion(error: unknown): Promise<void>;
};

function fakeRun(): FakeRun {
  const completion = deferred<ProviderRunTermination>();
  const interrupts: (string | undefined)[] = [];
  const heldInterrupts: Deferred<undefined>[] = [];
  const waiters: (() => void)[] = [];
  const run: FakeRun = {
    interrupts,
    interruptMode: 'resolve',
    heldInterrupts,
    handle: {
      completion: completion.promise,
      interrupt: (reason?: string): Promise<void> => {
        interrupts.push(reason);
        for (const waiter of waiters.splice(0)) waiter();
        switch (run.interruptMode) {
          case 'resolve':
            return Promise.resolve();
          case 'hold': {
            const held = deferred<undefined>();
            heldInterrupts.push(held);
            return held.promise;
          }
          case 'reject':
            return Promise.reject(new ProviderRejection(agentError('provider_rejected', 'interrupt refused')));
          case 'unknown':
            return Promise.reject(new Error('interrupt transport reset'));
        }
      },
    },
    interruptEntered(count = 1): Promise<void> {
      if (interrupts.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (interrupts.length >= count) resolve();
          else waiters.push(check);
        };
        waiters.push(check);
      });
    },
    async complete(termination) {
      completion.resolve(termination);
      await completion.promise;
    },
    async failCompletion(error) {
      completion.reject(error);
      await completion.promise.catch(() => undefined);
    },
  };
  return run;
}

type FixtureOptions = {
  readonly contract?: IngressStoreContract;
  readonly classify?: (error: unknown) => 'rejected' | 'unknown';
};

function fixture(options: FixtureOptions = {}) {
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });

  /** Sessions whose emits throw inside the transaction: a definite pre-apply rejection. */
  const failing = new Set<SessionId>();
  /** Commands whose receipt write throws inside the transaction: a definite pre-apply rejection. */
  const failingReceipts = new Set<CommandId>();
  const held: HeldCommit[] = [];
  const heldWaiters: (() => void)[] = [];
  let holding = false;
  /** Apply immediately, but hold the commit promise (the store's acknowledgement). */
  const heldAcks: (() => void)[] = [];
  const ackWaiters: (() => void)[] = [];
  let holdingAcks = false;
  let applyThenRejectNext = false;
  /** Reject the outer promise at once and apply the write only later: an unsupported adapter. */
  let delayWriteNext = false;
  const delayedWrites: (() => Promise<unknown>)[] = [];
  let gate: { entered: Deferred<undefined>; open: Deferred<undefined>; fail: boolean } | undefined;
  let commitCalls = 0;

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
        if (failingReceipts.has(commandId)) throw new Error(`injected pre-apply receipt failure for ${commandId}`);
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
      const run = () => base.commit((tx) => mutate(guarded(tx)));
      if (applyThenRejectNext) {
        applyThenRejectNext = false;
        return run().then((): never => {
          throw new Error('injected rejection after the transaction applied');
        });
      }
      if (delayWriteNext) {
        delayWriteNext = false;
        delayedWrites.push(run);
        return Promise.reject(new Error('injected adapter timeout before its delayed write'));
      }
      if (holdingAcks) {
        return run().then(
          (result) =>
            new Promise<{ value: T } & CommitResult>((resolve) => {
              heldAcks.push(() => {
                resolve(result);
              });
              for (const waiter of ackWaiters.splice(0)) waiter();
            }),
        );
      }
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
    read: (sessionId) => gated(() => base.read(sessionId)),
    readEvents: (sessionId, from, limit) => gated(() => base.readEvents(sessionId, from, limit)),
    readInteraction: (sessionId, interactionId) => base.readInteraction(sessionId, interactionId),
    findReceipt: (commandId) => gated(() => base.findReceipt(commandId)),
    listSessions: () => base.listSessions(),
  };

  const hub = createSubscriptionHub({ store, clock });
  const published: { sessionId: SessionId; eventId: string; type: string }[] = [];
  const publish = hub.publish.bind(hub);
  hub.publish = (sessionId, events) => {
    for (const event of events) published.push({ sessionId, eventId: event.eventId, type: event.payload.type });
    publish(sessionId, events);
  };

  const driver = createIngressDriver({
    store,
    hub,
    storeContract: options.contract ?? 'linearizable',
    clock,
    idFactory,
    ...(options.classify === undefined ? {} : { classifyEffectFailure: options.classify }),
  });

  // ---- sessions ----------------------------------------------------------------------
  let commands = 0;
  const commandId = (label: string): CommandId =>
    CommandIdSchema.parse(`s3-${String(++commands).padStart(6, '0')}-${label}`);

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

  async function open(): Promise<{ sessionId: SessionId; sink: ProviderEventSink }> {
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const session = sessionRecord(sessionId);
    const sink = driver.openSession(sessionId, {
      commandId: commandId('open'),
      fingerprint: 'open',
      acceptedAt: clock.now(),
    });
    driver.settleOpen(sessionId, {
      kind: 'applied',
      plan: ingressPlan((tx) => {
        tx.createSession(session);
        tx.emit({
          sessionId,
          payload: { type: 'session.opened', providerId: 'scripted', workspace: session.workspace },
        });
      }),
    });
    await driver.settled();
    return { sessionId, sink };
  }

  // ---- submit_turn -------------------------------------------------------------------
  function submitCommand(sessionId: SessionId): SubmitTurnCommand {
    return {
      commandId: commandId('submit'),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'go' }] },
    };
  }

  type Turn = {
    readonly command: SubmitTurnCommand;
    readonly turnId: TurnId;
    readonly runId: RunId;
    readonly provider: ReturnType<typeof controllable<[ProviderRunRequest], ProviderRun>>;
    readonly outcome: Promise<IngressCommandOutcome>;
    /** Exact retry of the same command (fresh acceptedAt, same identity). */
    retry(): Promise<IngressCommandOutcome>;
    sink(): ProviderEventSink;
    reservedAtCall(): Operation<IngressPayload> | undefined;
  };

  function submit(sessionId: SessionId): Turn {
    const command = submitCommand(sessionId);
    const turnId = TurnIdSchema.parse(idFactory.next('turn'));
    const runId = RunIdSchema.parse(idFactory.next('run'));
    const provider = controllable<[ProviderRunRequest], ProviderRun>(() =>
      driver
        .inspect(sessionId)
        ?.queue.find((op) => op.kind === 'effect' && op.effect === 'start' && op.state === 'pending'),
    );
    const call = () =>
      driver.submitTurn(sessionId, {
        command,
        acceptedAt: clock.now(),
        turnId,
        runId,
        attempt: 1,
        startRun: provider.fn,
      });
    return {
      command,
      turnId,
      runId,
      provider,
      outcome: call(),
      retry: call,
      sink: () => {
        const request = provider.calls[0]?.args[0];
        if (request === undefined) throw new Error('startRun was not called');
        return request.sink;
      },
      reservedAtCall: () => provider.calls[0]?.observed as Operation<IngressPayload> | undefined,
    };
  }

  type Started = Turn & { readonly run: FakeRun; readonly receipt: IngressCommandOutcome };

  async function started(sessionId: SessionId): Promise<Started> {
    const turn = submit(sessionId);
    await turn.provider.entered();
    const run = fakeRun();
    await turn.provider.resolve(0, run.handle);
    const receipt = await turn.outcome;
    await driver.settled();
    return { ...turn, run, receipt };
  }

  // ---- interactions ------------------------------------------------------------------
  /** Emit a request on the run sink, persist it, and return the interaction id it was given. */
  async function requested(sessionId: SessionId, sink: ProviderEventSink, providerRef: string): Promise<InteractionId> {
    sink.emit(question(providerRef));
    await driver.settled();
    const event = (await history(sessionId)).findLast((entry) => entry.payload.type === 'interaction.requested');
    if (event?.payload.type !== 'interaction.requested') throw new Error('no interaction was requested');
    return event.payload.interactionId;
  }

  function respondCommand(
    sessionId: SessionId,
    interactionId: InteractionId,
    response = yes,
  ): RespondToInteractionCommand {
    return { commandId: commandId('respond'), type: 'respond_to_interaction', sessionId, interactionId, response };
  }

  function respond(sessionId: SessionId, command: RespondToInteractionCommand) {
    const provider = controllable<[string, InteractionResponse], undefined>(() => {
      const state = driver.inspect(sessionId);
      return {
        reserved: state?.queue.find((op) => op.kind === 'effect' && op.identity.commandId === command.commandId),
        counted: state?.counted,
      };
    });
    const call = () =>
      driver.respondToInteraction(sessionId, { command, acceptedAt: clock.now(), deliver: provider.fn });
    return { command, provider, outcome: call(), retry: call };
  }

  function interruptCommand(sessionId: SessionId, runId: RunId, reason = 'stop'): InterruptRunCommand {
    return { commandId: commandId('interrupt'), type: 'interrupt_run', sessionId, runId, reason };
  }

  function interrupt(sessionId: SessionId, command: InterruptRunCommand): Promise<IngressCommandOutcome> {
    return driver.interruptRun(sessionId, { command, acceptedAt: clock.now() });
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
    failingReceipts,
    published,
    open,
    submit,
    started,
    requested,
    respondCommand,
    respond,
    interruptCommand,
    interrupt,
    history,
    liveSubscriber,
    commitCalls: () => commitCalls,
    hold(): void {
      holding = true;
    },
    unhold(): void {
      holding = false;
    },
    held: (): readonly HeldCommit[] => held,
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
    holdAcks(on: boolean): void {
      holdingAcks = on;
    },
    releaseAcks(): void {
      for (const release of heldAcks.splice(0)) release();
    },
    /** Resolves once a commit has applied and its acknowledgement is being held. */
    ackHeld(): Promise<void> {
      if (heldAcks.length > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        ackWaiters.push(resolve);
      });
    },
    applyThenRejectNext(): void {
      applyThenRejectNext = true;
    },
    delayWriteNext(): void {
      delayWriteNext = true;
    },
    async applyDelayedWrites(): Promise<void> {
      for (const write of delayedWrites.splice(0)) await write();
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

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.payload.type);
}

function messages(events: readonly EventEnvelope[]): string[] {
  return events.flatMap((event) => (event.payload.type === 'diagnostic' ? [event.payload.message] : []));
}

function counted(value: Fixture, sessionId: SessionId): number {
  const state = value.driver.inspect(sessionId);
  if (state === undefined) throw new Error('no ingestion state');
  return state.counted;
}

function fillSessionBudget(value: Fixture, sessionId: SessionId, sink: ProviderEventSink): void {
  let emitted = 0;
  while (counted(value, sessionId) < SESSION_OPERATION_LIMIT) {
    sink.emit(note(`fill-${String(emitted)}`));
    emitted += 1;
  }
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

function receiptOf(outcome: IngressCommandOutcome) {
  if (outcome.kind !== 'receipt') throw new Error(`expected a receipt, got ${JSON.stringify(outcome)}`);
  return outcome.receipt;
}

function isDeeplyFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}

// ---------------------------------------------------------------------------
// A1: start ownership, terminal materialization, immutable retries
// ---------------------------------------------------------------------------

describe('S3-A1 start ownership and terminal submission', () => {
  it('reserves the start slot before calling the provider and fills it with turn.started, run.started and the applied receipt', async () => {
    const value = fixture();
    const { sessionId, sink: sessionSink } = await value.open();
    const turn = value.submit(sessionId);
    await turn.provider.entered();

    // At the provider call the start ordinal, slot and command identity are already reserved.
    const reserved = turn.reservedAtCall();
    expect(reserved).toMatchObject({
      kind: 'effect',
      effect: 'start',
      state: 'pending',
      runId: turn.runId,
      identity: { commandId: turn.command.commandId, fingerprint: canonicalCommandFingerprint(turn.command) },
    });
    expect(turn.provider.calls[0]?.args[0].runRef).toBe(turn.runId);
    turn.sink().emit(delta('early'));
    sessionSink.emit(note('session-early'));
    await value.driver.settled();
    // The pending start owns the head: nothing captured behind it has persisted.
    expect(types(await value.history(sessionId))).toEqual(['session.opened']);

    await turn.provider.resolve(0, fakeRun().handle);
    const receipt = receiptOf(await turn.outcome);
    expect(receipt).toMatchObject({
      commandId: turn.command.commandId,
      commandType: 'submit_turn',
      disposition: 'applied',
      result: { type: 'turn_accepted', sessionId, turnId: turn.turnId, runId: turn.runId },
      sequence: 3,
    });
    await value.driver.settled();
    const events = await value.history(sessionId);
    expect(types(events)).toEqual(['session.opened', 'turn.started', 'run.started', 'run.message_delta', 'diagnostic']);
    expect(events[1]?.payload).toEqual({ type: 'turn.started', turnId: turn.turnId, input: turn.command.input });
    expect(events[2]).toMatchObject({
      runId: turn.runId,
      payload: { type: 'run.started', turnId: turn.turnId, attempt: 1 },
    });
    expect(await value.base.findReceipt(turn.command.commandId)).toEqual({
      fingerprint: canonicalCommandFingerprint(turn.command),
      receipt,
    });
    expect(turn.provider.calls).toHaveLength(1);
  });

  it('a definite provider start rejection fills the same slot with a rejected receipt and leaves no start, run body or terminal', async () => {
    const value = fixture();
    const { sessionId, sink: sessionSink } = await value.open();
    const turn = value.submit(sessionId);
    await turn.provider.entered();
    const ordinal = turn.reservedAtCall()?.ordinal;
    sessionSink.emit(note('independent session output'));
    turn.sink().emit(delta('staged run output'));
    turn.sink().emit(question('staged-question'));

    value.hold();
    await turn.provider.reject(0, new ProviderRejection(agentError('provider_rejected', 'quota exhausted')));
    // The rejected receipt fills the reserved ordinal; only the run's own staging was discarded.
    const state = value.driver.inspect(sessionId);
    expect(state?.queue[0]).toMatchObject({ kind: 'effect', effect: 'start', ordinal, state: 'rejected' });
    expect(state?.queue.map((op) => op.kind)).toEqual(['effect', 'body']);
    expect(state?.run).toBeUndefined();
    expect(value.driver.bookkeeping(sessionId)).toMatchObject({ run: false, routes: 0 });
    value.unhold();
    for (const commit of value.held()) commit.release();

    const receipt = receiptOf(await turn.outcome);
    expect(receipt).toMatchObject({
      commandId: turn.command.commandId,
      disposition: 'rejected',
      error: { code: 'provider_rejected', message: 'quota exhausted' },
    });
    await value.driver.settled();
    const events = await value.history(sessionId);
    expect(types(events)).toEqual(['session.opened', 'diagnostic']);
    expect(messages(events)).toEqual(['independent session output']);
    expect((await value.base.findReceipt(turn.command.commandId))?.receipt).toEqual(receipt);

    // The rejected run's sink and completion are stale; the session accepts a new run.
    turn.sink().emit(delta('late'));
    expect(counted(value, sessionId)).toBe(0);
    const next = await value.started(sessionId);
    expect(receiptOf(next.receipt).disposition).toBe('applied');
  });

  it('materializes the provider completion: run.finished then turn.settled carrying the turn output', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.sink().emit(delta('hello '));
    turn.sink().emit(delta('world'));
    await turn.run.complete({ outcome: 'succeeded' });
    await value.driver.settled();

    const events = await value.history(sessionId);
    expect(types(events).slice(-2)).toEqual(['run.finished', 'turn.settled']);
    expect(events.at(-2)).toMatchObject({
      runId: turn.runId,
      payload: { type: 'run.finished', turnId: turn.turnId, termination: { outcome: 'succeeded' } },
    });
    expect(events.at(-1)?.payload).toEqual({
      type: 'turn.settled',
      turnId: turn.turnId,
      state: 'completed',
      output: 'hello world',
    });
    expect(value.driver.inspect(sessionId)?.run).toBeUndefined();
    expect(value.driver.bookkeeping(sessionId)).toEqual({ run: false, routes: 0, waiters: 0, invocations: 0 });
  });

  it('an illegal success cancels pending interactions and fails the run instead of throwing', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.sink().emit(delta('partial'));
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    // Hold the terminal commit to read the timestamp frozen when the completion was observed.
    value.hold();
    await turn.run.complete({ outcome: 'succeeded' });
    await value.heldCount(1);
    const queued = value.driver.inspect(sessionId)?.queue[0];
    if (queued?.kind !== 'terminal' || queued.intent.detail?.kind !== 'termination')
      throw new Error('no terminal head');
    const frozenAt = queued.intent.detail.termination.at;
    value.unhold();
    value.held()[0]?.release();
    await value.driver.settled();

    const events = await value.history(sessionId);
    expect(types(events).slice(-3)).toEqual(['interaction.settled', 'run.finished', 'turn.settled']);
    const finished = events.at(-2);
    expect(finished?.payload).toMatchObject({
      type: 'run.finished',
      termination: {
        outcome: 'failed',
        error: {
          code: 'provider_contract_violation',
          message: 'provider completed with succeeded while run was awaiting_interaction',
        },
      },
    });
    // The terminal and its cancellation carry the timestamp frozen at completion, not a commit-time clock read.
    expect(finished?.payload).toMatchObject({ termination: { at: frozenAt } });
    expect(events.at(-3)?.payload).toEqual({
      type: 'interaction.settled',
      interactionId,
      turnId: turn.turnId,
      settlement: { outcome: 'cancelled', settledAt: frozenAt },
    });
    expect(events.at(-1)?.payload).toMatchObject({
      type: 'turn.settled',
      state: 'failed',
      output: 'partial',
      error: { code: 'provider_contract_violation' },
    });
    expect(value.driver.fault(sessionId)).toBeUndefined();
  });

  it('an invalid or rejected completion becomes one failed terminal with the live runtime wording', async () => {
    const value = fixture();
    const first = await value.open();
    const invalid = await value.started(first.sessionId);
    value.driver.completeRun(first.sessionId, invalid.runId, { kind: 'resolved', value: { outcome: 'exploded' } });
    // A second completion for the same run is ignored: exactly one terminal.
    value.driver.completeRun(first.sessionId, invalid.runId, { kind: 'resolved', value: { outcome: 'succeeded' } });
    await value.driver.settled();
    const invalidEvents = await value.history(first.sessionId);
    expect(types(invalidEvents).filter((type) => type === 'run.finished')).toHaveLength(1);
    expect(invalidEvents.at(-2)?.payload).toMatchObject({
      termination: {
        outcome: 'failed',
        error: { message: expect.stringMatching(/^provider returned an invalid completion: /u) },
      },
    });

    const second = await value.open();
    const rejected = await value.started(second.sessionId);
    await rejected.run.failCompletion(new Error('boom'));
    await value.driver.settled();
    expect((await value.history(second.sessionId)).at(-2)?.payload).toMatchObject({
      termination: {
        outcome: 'failed',
        error: { message: 'provider completion promise rejected instead of returning a terminal outcome' },
      },
    });
  });

  it('A1: a failed start commit is retried as the identical frozen bundle without calling the provider again; start precedes finish exactly once', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    value.failing.add(sessionId);
    const turn = value.submit(sessionId);
    await turn.provider.entered();
    const run = fakeRun();
    await turn.provider.resolve(0, run.handle);

    // The failed attempt returns promptly with retryable F; nothing persisted.
    const first = await rejection(turn.outcome);
    expect(first.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure', failureCount: 1 });
    const head = value.driver.inspect(sessionId)?.queue[0];
    expect(head).toMatchObject({ kind: 'effect', effect: 'start', state: 'applied' });
    expect(isDeeplyFrozen(head)).toBe(true);
    const acceptedAt = head?.kind === 'effect' ? head.identity.acceptedAt : undefined;

    // The provider keeps running and completes while its start bundle is still unpersisted.
    turn.sink().emit(delta('output'));
    await run.complete({ outcome: 'succeeded' });
    expect(value.driver.inspect(sessionId)?.queue.map((op) => op.kind)).toEqual(['effect', 'body', 'terminal']);

    // An exact retry while the store still fails resubmits the same frozen head and reports F again.
    const again = await rejection(turn.retry());
    expect(again.error).toMatchObject({ code: 'store_unavailable', retryable: true });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure', failureCount: 2 });
    expect(value.driver.inspect(sessionId)?.queue[0]).toBe(head);

    value.failing.delete(sessionId);
    const receipt = receiptOf(await turn.retry());
    expect(receipt).toMatchObject({ disposition: 'applied', acceptedAt });
    await value.driver.settled();

    const events = await value.history(sessionId);
    expect(types(events)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.message_delta',
      'run.finished',
      'turn.settled',
    ]);
    // The provider effect was never reissued.
    expect(turn.provider.calls).toHaveLength(1);
    expect(value.published.filter((entry) => entry.type === 'run.finished')).toHaveLength(1);
    expect(value.driver.fault(sessionId)).toBeUndefined();
    expect(value.driver.bookkeeping(sessionId)).toEqual({ run: false, routes: 0, waiters: 0, invocations: 0 });
  });

  it('A1: a failed terminal commit retries the identical frozen terminal; its outcome and timestamp are never rebuilt', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.sink().emit(delta('body'));
    await value.driver.settled();

    value.failing.add(sessionId);
    await turn.run.complete({ outcome: 'succeeded' });
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure' });
    const head = value.driver.inspect(sessionId)?.queue[0];
    if (head?.kind !== 'terminal' || head.intent.detail?.kind !== 'termination')
      throw new Error('expected a terminal head');
    expect(isDeeplyFrozen(head)).toBe(true);
    const frozenAt = head.intent.detail.termination.at;

    expect((await rejection(value.driver.retry(sessionId))).error).toMatchObject({ retryable: true });
    expect(value.driver.inspect(sessionId)?.queue[0]).toBe(head);

    value.failing.delete(sessionId);
    await value.driver.retry(sessionId);
    await value.driver.settled();
    const finished = (await value.history(sessionId)).filter((event) => event.payload.type === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ termination: { outcome: 'succeeded', at: frozenAt } });
    expect(value.published.filter((entry) => entry.type === 'run.finished')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A3: response and withdrawal settlement
// ---------------------------------------------------------------------------

describe('S3-A3 response reservation and settlement', () => {
  it('reserves ordinal, slot and identity before delivering, and fills the same slot with the settlement and applied receipt', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const countedBefore = counted(value, sessionId);

    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    const call = reply.provider.calls[0];
    expect(call?.args).toEqual(['q-1', yes]);
    expect(call?.observed).toMatchObject({
      reserved: { kind: 'effect', effect: 'response', state: 'pending', subject: interactionId },
      counted: countedBefore + 1,
    });

    await reply.provider.resolve(0, undefined);
    const receipt = receiptOf(await reply.outcome);
    expect(receipt).toMatchObject({
      disposition: 'applied',
      result: { type: 'interaction_settled', sessionId, interactionId },
    });
    const events = await value.history(sessionId);
    expect(events.at(-1)?.payload).toMatchObject({
      type: 'interaction.settled',
      interactionId,
      settlement: { outcome: 'responded', response: yes },
    });
    expect(receipt.sequence).toBe(events.at(-1)?.sequence);
    expect(counted(value, sessionId)).toBe(countedBefore);
  });

  it('a completion observed while a response is in flight waits for that reservation; the delivered response commits first', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();

    await turn.run.complete({ outcome: 'succeeded' });
    await value.driver.settled();
    const state = value.driver.inspect(sessionId);
    // The terminal is chosen but cannot be placed ahead of the unresolved reservation.
    expect(state?.run?.terminal).toMatchObject({ state: 'intent' });
    expect(state?.queue.some((op) => op.kind === 'terminal')).toBe(false);
    expect(state === undefined ? undefined : runPhase(state)).toBe('E');
    expect(types(await value.history(sessionId)).at(-1)).toBe('interaction.requested');

    await reply.provider.resolve(0, undefined);
    expect(receiptOf(await reply.outcome).disposition).toBe('applied');
    await value.driver.settled();
    const events = await value.history(sessionId);
    expect(types(events).slice(-3)).toEqual(['interaction.settled', 'run.finished', 'turn.settled']);
    expect(events.at(-3)?.payload).toMatchObject({ settlement: { outcome: 'responded' } });
    expect(events.at(-2)?.payload).toMatchObject({ termination: { outcome: 'succeeded' } });
  });

  it('a definite provider rejection fills the reserved slot with a rejected receipt and no settlement', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    const reserved = (reply.provider.calls[0]?.observed as { reserved: Operation<IngressPayload> }).reserved;
    const countedWhileReserved = counted(value, sessionId);

    value.hold();
    await reply.provider.reject(0, new ProviderRejection(agentError('provider_rejected', 'stale question')));
    const filled = value.driver.inspect(sessionId)?.queue[0];
    expect(filled).toMatchObject({ kind: 'effect', effect: 'response', ordinal: reserved.ordinal, state: 'rejected' });
    expect(counted(value, sessionId)).toBe(countedWhileReserved);
    value.unhold();
    for (const commit of value.held()) commit.release();

    expect(receiptOf(await reply.outcome)).toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected', message: 'stale question' },
    });
    expect(types(await value.history(sessionId)).at(-1)).toBe('interaction.requested');
    expect(await value.base.readInteraction(sessionId, interactionId)).toMatchObject({ status: 'pending' });

    // A definitely rejected response does not own the interaction: a new response may be reserved.
    const second = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await second.provider.entered();
    await second.provider.resolve(0, undefined);
    expect(receiptOf(await second.outcome).disposition).toBe('applied');
  });

  it('a withdrawal accepted before a response refuses that response without calling the provider', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');

    value.hold();
    turn.sink().emit(withdrawn('q-1'));
    await value.heldCount(1);
    // The withdrawal is not persisted yet; routing alone refuses the response.
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    expect(await reply.outcome).toEqual({ kind: 'refused', reason: 'interaction-withdrawn' });
    expect(reply.provider.calls).toHaveLength(0);
    value.unhold();
    for (const commit of value.held()) commit.release();
    await value.driver.settled();
    expect((await value.history(sessionId)).at(-1)?.payload).toMatchObject({
      type: 'interaction.settled',
      interactionId,
      settlement: { outcome: 'withdrawn' },
    });
  });

  it('a withdrawal emitted while a response is in flight cannot displace the delivered response', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();

    turn.sink().emit(withdrawn('q-1'));
    await reply.provider.resolve(0, undefined);
    expect(receiptOf(await reply.outcome).disposition).toBe('applied');
    await value.driver.settled();
    const events = await value.history(sessionId);
    const settlements = events.filter((event) => event.payload.type === 'interaction.settled');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.payload).toMatchObject({ settlement: { outcome: 'responded' } });
    expect(await value.base.readInteraction(sessionId, interactionId)).toMatchObject({
      status: 'settled',
      settlement: { outcome: 'responded' },
    });
    // The later withdrawal committed as a no-op: it neither failed the head nor stayed queued.
    expect(value.driver.fault(sessionId)).toBeUndefined();
    expect(value.driver.inspect(sessionId)?.queue).toHaveLength(0);
  });

  it('overflow while a response is in flight preserves its reservation; the delivered response commits before the overflow-failed terminal', async () => {
    const value = fixture();
    const { sessionId, sink: sessionSink } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();

    // The unresolved reservation holds the head, so session output piles up behind it until the cap.
    fillSessionBudget(value, sessionId, sessionSink);
    sessionSink.emit(note('excess'));
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
    await turn.run.interruptEntered();
    expect(turn.run.interrupts).toEqual(['provider event history overflowed']);
    const state = value.driver.inspect(sessionId);
    expect(state?.queue[0]).toMatchObject({ kind: 'effect', effect: 'response', state: 'pending' });

    await reply.provider.resolve(0, undefined);
    expect(receiptOf(await reply.outcome).disposition).toBe('applied');
    await turn.run.complete({ outcome: 'succeeded' });
    await value.driver.settled();
    const events = await value.history(sessionId);
    const settledIndex = events.findIndex((event) => event.payload.type === 'interaction.settled');
    const finishedIndex = events.findIndex((event) => event.payload.type === 'run.finished');
    expect(settledIndex).toBeGreaterThan(0);
    expect(events[settledIndex]?.payload).toMatchObject({ settlement: { outcome: 'responded' } });
    expect(finishedIndex).toBeGreaterThan(settledIndex);
    expect(events[finishedIndex]?.payload).toMatchObject({
      termination: { outcome: 'failed', error: { code: 'provider_contract_violation' } },
    });
    expect(messages(events)).not.toContain('excess');
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
  });

  it('an exact retry shares the reservation, a changed payload conflicts and a competing response is refused', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const command = value.respondCommand(sessionId, interactionId);
    const reply = value.respond(sessionId, command);
    await reply.provider.entered();

    const exact = reply.retry();
    const changed = value.respond(sessionId, { ...command, response: { kind: 'question', answer: 'no' } });
    expect(receiptOf(await changed.outcome)).toMatchObject({
      commandId: command.commandId,
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    const competing = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    expect(await competing.outcome).toEqual({ kind: 'refused', reason: 'subject-busy' });
    expect(changed.provider.calls).toHaveLength(0);
    expect(competing.provider.calls).toHaveLength(0);

    await reply.provider.resolve(0, undefined);
    const receipt = receiptOf(await reply.outcome);
    expect(receiptOf(await exact)).toEqual(receipt);
    expect(reply.provider.calls).toHaveLength(1);

    // After the receipt commits the store answers: duplicate for the same payload, conflict otherwise.
    expect(receiptOf(await reply.retry())).toEqual({ ...receipt, disposition: 'duplicate' });
    expect(
      receiptOf(await value.respond(sessionId, { ...command, response: { kind: 'question', answer: 'no' } }).outcome),
    ).toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    expect(
      (await value.history(sessionId)).filter((event) => event.payload.type === 'interaction.settled'),
    ).toHaveLength(1);
  });

  it('an ambiguous provider outcome stays unresolved and retryable; an exact retry re-delivers into the same slot', async () => {
    const value = fixture({ classify: (error) => (error instanceof ProviderRejection ? 'rejected' : 'unknown') });
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    const ordinal = (reply.provider.calls[0]?.observed as { reserved: Operation<IngressPayload> }).reserved.ordinal;
    await turn.run.complete({ outcome: 'succeeded' });

    await reply.provider.reject(0, new Error('connection reset'));
    const unknown = await rejection(reply.outcome);
    expect(unknown.error).toMatchObject({ code: 'provider_unavailable', retryable: true });
    const state = value.driver.inspect(sessionId);
    expect(state?.queue.find((op) => op.ordinal === ordinal)).toMatchObject({ kind: 'effect', state: 'unknown' });
    // Unresolved: the terminal still waits behind it, and nothing is certified.
    expect(state?.run?.terminal).toMatchObject({ state: 'intent' });

    const retried = reply.retry();
    await reply.provider.entered(2);
    expect(reply.provider.calls[1]?.args).toEqual(['q-1', yes]);
    await reply.provider.resolve(1, undefined);
    expect(receiptOf(await retried).disposition).toBe('applied');
    await value.driver.settled();
    expect(types(await value.history(sessionId)).slice(-3)).toEqual([
      'interaction.settled',
      'run.finished',
      'turn.settled',
    ]);
  });

  it('a malformed provider rejection still fills the reserved slot with a valid rejected receipt', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = value.submit(sessionId);
    await turn.provider.entered();
    // A trusted-but-buggy provider: its typed error violates the AgentError schema.
    await turn.provider.reject(0, new ProviderRejection({ code: 'provider_rejected', message: '', retryable: false }));
    expect(receiptOf(await turn.outcome)).toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected', message: 'provider rejected the operation with a malformed error' },
    });

    const started = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, started.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    await reply.provider.reject(0, new Error('x'.repeat(3000)));
    expect(receiptOf(await reply.outcome)).toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected' },
    });
    expect(value.driver.bookkeeping(sessionId)).toMatchObject({ waiters: 0, invocations: 0 });
  });

  it('without a classifier every provider rejection is definite, as the SPI documents', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const interactionId = await value.requested(sessionId, turn.sink(), 'q-1');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    await reply.provider.reject(0, new Error('connection reset'));
    expect(receiptOf(await reply.outcome)).toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected', message: 'connection reset' },
    });
  });
});

// ---------------------------------------------------------------------------
// interrupt_run reservation
// ---------------------------------------------------------------------------

describe('S3 interrupt_run reservation', () => {
  it('reserves and fences before calling the provider; a delivered interrupt records interrupting and an applied receipt', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.run.interruptMode = 'hold';
    const command = value.interruptCommand(sessionId, turn.runId);
    const outcome = value.interrupt(sessionId, command);
    await turn.run.interruptEntered();
    const state = value.driver.inspect(sessionId);
    expect(state?.queue.at(-1)).toMatchObject({ kind: 'effect', effect: 'interrupt', state: 'pending' });
    expect(state === undefined ? undefined : runFenced(state)).toBe(true);
    expect(turn.run.interrupts).toEqual(['stop']);

    // A request emitted while the interrupt is in flight cannot reverse it.
    turn.sink().emit(question('late'));
    turn.run.heldInterrupts[0]?.resolve(undefined);
    expect(receiptOf(await outcome)).toMatchObject({
      disposition: 'applied',
      result: { type: 'run_interrupt_requested', runId: turn.runId, delivered: true },
    });
    await turn.run.complete({ outcome: 'interrupted', reason: 'stop' });
    await value.driver.settled();
    const events = await value.history(sessionId);
    expect(types(events).slice(-4)).toEqual(['run.state_changed', 'diagnostic', 'run.finished', 'turn.settled']);
    expect(events.at(-4)?.payload).toEqual({ type: 'run.state_changed', from: 'running', to: 'interrupting' });
    expect(events.at(-3)?.payload).toMatchObject({ detail: { code: 'provider_contract_violation' } });
    expect(events.at(-2)?.payload).toMatchObject({ termination: { outcome: 'interrupted', reason: 'stop' } });
    expect(events.at(-1)?.payload).toMatchObject({ state: 'cancelled' });
  });

  it('a definite interrupt rejection fills its slot with a rejected receipt and rolls back only its own fence', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.run.interruptMode = 'reject';
    const receipt = receiptOf(await value.interrupt(sessionId, value.interruptCommand(sessionId, turn.runId)));
    expect(receipt).toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected', message: 'interrupt refused' },
    });
    const state = value.driver.inspect(sessionId);
    expect(state === undefined ? undefined : runFenced(state)).toBe(false);
    // Not fenced any more: a new request is a real interaction, not a diagnostic.
    await value.requested(sessionId, turn.sink(), 'q-after');
    expect(types(await value.history(sessionId))).not.toContain('run.state_changed');
  });

  it('a second interrupt while one is in flight never reaches the provider again', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    turn.run.interruptMode = 'hold';
    const first = value.interrupt(sessionId, value.interruptCommand(sessionId, turn.runId));
    await turn.run.interruptEntered();
    const second = value.interrupt(sessionId, value.interruptCommand(sessionId, turn.runId, 'again'));
    turn.run.heldInterrupts[0]?.resolve(undefined);
    expect(receiptOf(await first)).toMatchObject({ result: { delivered: true } });
    expect(receiptOf(await second)).toMatchObject({ disposition: 'applied', result: { delivered: false } });
    expect(turn.run.interrupts).toEqual(['stop']);
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.state_changed')).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Interaction routing
// ---------------------------------------------------------------------------

describe('S3 interaction routing', () => {
  it('maps provider references to interactions; reuse, unknown references and session-sink requests become diagnostics or nothing, never a throw', async () => {
    const value = fixture();
    const { sessionId, sink: sessionSink } = await value.open();
    const turn = await value.started(sessionId);
    const first = await value.requested(sessionId, turn.sink(), 'r');
    turn.sink().emit(question('r'));
    turn.sink().emit(withdrawn('r'));
    const reused = await value.requested(sessionId, turn.sink(), 'r');
    turn.sink().emit(withdrawn('never-requested'));
    sessionSink.emit(question('on-session-sink'));
    await value.driver.settled();

    expect(reused).not.toBe(first);
    const events = await value.history(sessionId);
    expect(types(events).slice(3)).toEqual([
      'interaction.requested',
      'diagnostic',
      'interaction.settled',
      'interaction.requested',
      'diagnostic',
    ]);
    expect(messages(events)).toEqual([
      'provider reused active interaction reference `r`',
      'provider emitted run-scoped event `interaction.requested` on the session sink',
    ]);
    expect(events[5]?.payload).toMatchObject({ interactionId: first, settlement: { outcome: 'withdrawn' } });
    expect(value.driver.fault(sessionId)).toBeUndefined();

    // A retired run's interactions are no longer routable.
    await turn.run.complete({ outcome: 'failed', error: agentError('provider_rejected', 'done') });
    await value.driver.settled();
    const late = value.respond(sessionId, value.respondCommand(sessionId, reused));
    expect(await late.outcome).toEqual({ kind: 'refused', reason: 'interaction-unrouted' });
    expect(late.provider.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A4: reconciliation for interaction request, terminal and receipt-only heads
// ---------------------------------------------------------------------------

describe('S3-A4 reconciliation of request, terminal and receipt-only heads', () => {
  it('interaction request head: apply-then-reject reconciles to one stored interaction, published once', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    const reads = value.gateReads();
    value.applyThenRejectNext();
    turn.sink().emit(question('q-1'));
    await reads.entered;
    // A and the wake are visible before the reconciliation read resolves.
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: false });
    expect((await rejection(idle)).error).toMatchObject({ code: 'store_unavailable', retryable: false });
    reads.release();
    await value.driver.settled();

    expect(value.driver.fault(sessionId)).toBeUndefined();
    const requests = (await value.history(sessionId)).filter((event) => event.payload.type === 'interaction.requested');
    expect(requests).toHaveLength(1);
    expect(value.published.filter((entry) => entry.type === 'interaction.requested')).toHaveLength(1);
    expect((await value.base.read(sessionId))?.interactions).toHaveLength(1);
    // The route installed at acceptance is still the one the stored interaction uses.
    const interactionId =
      requests[0]?.payload.type === 'interaction.requested' ? requests[0].payload.interactionId : undefined;
    if (interactionId === undefined) throw new Error('no interaction');
    const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
    await reply.provider.entered();
    expect(reply.provider.calls[0]?.args[0]).toBe('q-1');
  });

  it('interaction request head: a pre-apply rejection retries the identical frozen body with the same interaction id', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    value.failing.add(sessionId);
    turn.sink().emit(question('q-1'));
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'failure' });
    const head = value.driver.inspect(sessionId)?.queue[0];
    if (head?.kind !== 'body' || head.body.kind !== 'event' || head.body.interaction?.kind !== 'request') {
      throw new Error('expected a routed request head');
    }
    expect(isDeeplyFrozen(head)).toBe(true);
    const frozenId = head.body.interaction.interactionId;

    expect((await rejection(value.driver.retry(sessionId))).error).toMatchObject({ retryable: true });
    expect(value.driver.inspect(sessionId)?.queue[0]).toBe(head);
    value.failing.delete(sessionId);
    await value.driver.retry(sessionId);
    const requests = (await value.history(sessionId)).filter((event) => event.payload.type === 'interaction.requested');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toMatchObject({ interactionId: frozenId });
    expect(value.published.filter((entry) => entry.type === 'interaction.requested')).toHaveLength(1);
  });

  it('terminal head: apply-then-reject with a held read shows A and the wake first, then publishes one run.finished and retires the run', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    const reads = value.gateReads();
    value.applyThenRejectNext();
    await turn.run.complete({ outcome: 'succeeded' });
    await reads.entered;
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: false });
    expect((await rejection(idle)).error).toMatchObject({ retryable: false });
    expect(() => value.driver.ensureReplayReady(sessionId)).toThrow(AgentRuntimeError);
    const calls = value.commitCalls();
    reads.release();
    await value.driver.settled();

    expect(value.driver.fault(sessionId)).toBeUndefined();
    expect(value.commitCalls()).toBe(calls);
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
    expect(value.published.filter((entry) => entry.type === 'run.finished')).toHaveLength(1);
    expect(value.published.filter((entry) => entry.type === 'turn.settled')).toHaveLength(1);
    expect(value.driver.inspect(sessionId)?.run).toBeUndefined();
    expect(value.driver.bookkeeping(sessionId)).toEqual({ run: false, routes: 0, waiters: 0, invocations: 0 });
  });

  it('receipt-only head: apply-then-reject rejects the waiting submit promptly with A, then reconciles once without a second write', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = value.submit(sessionId);
    await turn.provider.entered();

    const reads = value.gateReads();
    value.applyThenRejectNext();
    await turn.provider.reject(0, new ProviderRejection(agentError('provider_rejected', 'busy')));
    await reads.entered;
    // The command attempt returns before the reconciliation read resolves.
    expect((await rejection(turn.outcome)).error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous' });
    const calls = value.commitCalls();
    reads.release();
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toBeUndefined();
    expect(value.commitCalls()).toBe(calls);

    // The store now answers the exact retry; the provider is never called again.
    expect(receiptOf(await turn.retry())).toMatchObject({ disposition: 'rejected', error: { message: 'busy' } });
    expect(turn.provider.calls).toHaveLength(1);
    expect(types(await value.history(sessionId))).toEqual(['session.opened']);
  });

  it('A9: a failed submit receipt does not revive the provider start on retry', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const turn = value.submit(sessionId);
    value.failingReceipts.add(turn.command.commandId);
    await turn.provider.entered();
    await turn.provider.reject(0, new ProviderRejection(agentError('provider_rejected', 'busy')));

    expect((await rejection(turn.outcome)).error).toMatchObject({ code: 'store_unavailable', retryable: true });
    const head = value.driver.inspect(sessionId)?.queue[0];
    expect(head).toMatchObject({ kind: 'effect', effect: 'start', state: 'rejected' });
    expect((await rejection(turn.retry())).error).toMatchObject({ retryable: true });
    expect(value.driver.inspect(sessionId)?.queue[0]).toBe(head);

    value.failingReceipts.delete(turn.command.commandId);
    expect(receiptOf(await turn.retry())).toMatchObject({ disposition: 'rejected', error: { message: 'busy' } });
    expect(turn.provider.calls).toHaveLength(1);
    expect(types(await value.history(sessionId))).toEqual(['session.opened']);
    expect(value.driver.fault(sessionId)).toBeUndefined();
  });

  it('an unsupported adapter whose promise rejects before its delayed write keeps A, rejects replay and live reads, and never resubmits when the write lands', async () => {
    const value = fixture({ contract: 'unverified' });
    const { sessionId } = await value.open();
    const turn = await value.started(sessionId);
    const subscriber = await value.liveSubscriber(sessionId);
    const idle = subscriber.next();

    value.delayWriteNext();
    await turn.run.complete({ outcome: 'succeeded' });
    await value.driver.settled();
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: true });
    expect((await rejection(idle)).error).toMatchObject({ code: 'store_unavailable', retryable: false });
    // An immediate read sees nothing: absence cannot be trusted from this adapter.
    expect(types(await value.history(sessionId))).not.toContain('run.finished');
    const calls = value.commitCalls();
    expect((await rejection(value.driver.retry(sessionId))).error).toMatchObject({ retryable: false });
    expect((await rejection(replayFirst(value, sessionId))).error).toMatchObject({ code: 'store_unavailable' });

    // The delayed write lands later: still nothing is resubmitted or published.
    await value.applyDelayedWrites();
    await value.driver.settled();
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
    expect(value.commitCalls()).toBe(calls);
    expect((await rejection(value.driver.retry(sessionId))).error).toMatchObject({ retryable: false });
    await value.driver.settled();
    expect(value.commitCalls()).toBe(calls);
    expect(value.published.filter((entry) => entry.type === 'run.finished')).toHaveLength(0);
    expect(value.driver.inspect(sessionId)?.queue[0]).toMatchObject({ kind: 'terminal' });
    expect(value.driver.fault(sessionId)).toMatchObject({ kind: 'ambiguous', permanent: true });
  });

  it('overflow before terminal submission fails the success intent; after submission it cannot rewrite the outcome', async () => {
    const value = fixture();
    // Before submission: the terminal waits behind an unresolved response when the overflow arrives.
    const before = await value.open();
    const unsubmitted = await value.started(before.sessionId);
    const interactionId = await value.requested(before.sessionId, unsubmitted.sink(), 'q-1');
    const reply = value.respond(before.sessionId, value.respondCommand(before.sessionId, interactionId));
    await reply.provider.entered();
    await unsubmitted.run.complete({ outcome: 'succeeded' });
    fillSessionBudget(value, before.sessionId, before.sink);
    before.sink.emit(note('excess'));
    await reply.provider.resolve(0, undefined);
    await reply.outcome;
    await value.driver.settled();
    expect((await value.history(before.sessionId)).at(-2)?.payload).toMatchObject({
      termination: { outcome: 'failed', error: { code: 'provider_contract_violation' } },
    });

    // After submission: the terminal commit is held in flight when the overflow arrives.
    const after = await value.open();
    const submitted = await value.started(after.sessionId);
    value.hold();
    await submitted.run.complete({ outcome: 'succeeded' });
    await value.heldCount(1);
    const terminal = value.driver.inspect(after.sessionId)?.queue[0];
    expect(terminal).toMatchObject({ kind: 'terminal', intent: { outcome: 'succeeded' } });
    fillSessionBudget(value, after.sessionId, after.sink);
    after.sink.emit(note('excess'));
    expect(value.driver.fault(after.sessionId)).toMatchObject({ kind: 'overflow' });
    expect(value.driver.inspect(after.sessionId)?.queue[0]).toBe(terminal);
    value.unhold();
    value.held().at(-1)?.release();
    await value.driver.settled();
    const finished = (await value.history(after.sessionId)).filter((event) => event.payload.type === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ termination: { outcome: 'succeeded' } });
    expect(value.driver.fault(after.sessionId)).toMatchObject({ kind: 'overflow', permanent: true });
  });

  it('after the terminal transaction applies but its acknowledgement is held, overflow cannot rewrite it', async () => {
    const value = fixture();
    const { sessionId, sink } = await value.open();
    const turn = await value.started(sessionId);
    value.holdAcks(true);
    await turn.run.complete({ outcome: 'succeeded' });
    // The terminal has applied in the store while its commit promise is still pending.
    await value.ackHeld();
    expect(types(await value.history(sessionId))).toContain('run.finished');
    value.holdAcks(false);
    const terminal = value.driver.inspect(sessionId)?.queue[0];
    fillSessionBudget(value, sessionId, sink);
    sink.emit(note('excess'));
    expect(value.driver.inspect(sessionId)?.queue[0]).toBe(terminal);
    expect(terminal).toMatchObject({ kind: 'terminal', intent: { outcome: 'succeeded', overflowed: false } });
    value.releaseAcks();
    await value.driver.settled();
    const finished = (await value.history(sessionId)).filter((event) => event.payload.type === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ termination: { outcome: 'succeeded' } });
    expect(value.published.filter((entry) => entry.type === 'run.finished')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A9: retirement
// ---------------------------------------------------------------------------

describe('S3-A9 retirement inside the seam', () => {
  it('many successful turns with interactions leave no per-run bookkeeping behind', async () => {
    const value = fixture();
    const { sessionId } = await value.open();
    const shape = Object.keys(value.driver.inspect(sessionId) ?? {}).sort();
    for (let index = 0; index < 60; index += 1) {
      const turn = await value.started(sessionId);
      const interactionId = await value.requested(sessionId, turn.sink(), `q-${String(index)}`);
      const reply = value.respond(sessionId, value.respondCommand(sessionId, interactionId));
      await reply.provider.entered();
      await reply.provider.resolve(0, undefined);
      await reply.outcome;
      await turn.run.complete({ outcome: 'succeeded' });
      await value.driver.settled();
      expect(value.driver.inspect(sessionId)?.run).toBeUndefined();
    }
    const state = value.driver.inspect(sessionId);
    expect(state?.queue).toHaveLength(0);
    expect(state?.counted).toBe(0);
    expect(Object.keys(state ?? {}).sort()).toEqual(shape);
    expect(value.driver.bookkeeping(sessionId)).toEqual({ run: false, routes: 0, waiters: 0, invocations: 0 });
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'turn.settled')).toHaveLength(60);
  });
});

/** Start a replaying subscription and resolve with its first non-event message type. */
async function replayFirst(value: Fixture, sessionId: SessionId): Promise<string> {
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
