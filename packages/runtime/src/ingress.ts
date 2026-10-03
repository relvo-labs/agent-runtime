/**
 * Provider event ingress through the per-session FIFO (issue #43, design v2,
 * surface 2): capture, activation, operation caps, permanent overflow, commit
 * witness and reconciliation, fault query and fault wake.
 *
 * PRIVATE SEAM. This module is not exported from the package entry point and
 * `createAgentRuntime` does not use it yet. Terminal submission (surface 3)
 * and session cleanup (surface 4) still commit directly in `runtime.ts`;
 * routing only provider bodies through the FIFO would let those commits bypass
 * it, so the live ingress path switches over atomically once they land.
 *
 * Every ordering, capacity and fault decision is made by the surface 1 reducer
 * (`ingestion.ts`). This driver executes its decisions:
 *
 * - each sink `emit()` captures synchronously (ADR-0016) and is O(1): it calls
 *   `acceptEvent` and schedules the head on a microtask, never calling the
 *   store or the provider re-entrantly;
 * - one head per session is in flight; a blocked head stalls only its session;
 * - a commit's witness (every emitted envelope id/sequence, or its receipt) is
 *   captured inside the transaction callback; on rejection A is set before any
 *   await and subscribers are woken before reconciliation I/O;
 * - only a store declared `linearizable` is reconciled by reading back; any
 *   other adapter leaves A permanent and its head is never resubmitted;
 * - an overflow interrupts the current run once a provider handle exists.
 *
 * Process-local only; issue #6 owns crash-durable recovery.
 */

import {
  AgentRuntimeError,
  agentError,
  type AgentError,
  type EventEnvelope,
  type EventId,
  type RunId,
  type Sequence,
  type SessionId,
  type TurnId,
} from '@relvo-labs/agent-protocol';
import type { ProviderEventSink } from '@relvo-labs/agent-provider';

import {
  SESSION_OPERATION_LIMIT,
  acceptEvent,
  advanceHead,
  chooseTerminal,
  createSessionIngestion,
  ingestionFault,
  reserveStart,
  settleEffect,
  type BodyOperation,
  type CommandIdentity,
  type CommitWitness,
  type IngestionFaultView,
  type InteractionRole,
  type Operation,
  type RefusalReason,
  type RunSinkFence,
  type SessionIngestion,
  type TerminalOutcome,
} from './ingestion.ts';
import { captureProviderEvent, type CapturedProviderEvent } from './provider-capture.ts';
import type { RuntimeStore, StoreTransaction } from './store.ts';
import { installIngestionFaultGuard, type SubscriptionHub } from './subscriptions.ts';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * A caller-owned bundle: the start/open/receipt or terminal materialization the
 * FIFO commits at that operation's ordinal. It receives the frozen operation,
 * so a terminal plan reads the (possibly overflow-failed) outcome from it.
 */
export type IngressPlan = Readonly<{
  kind: 'plan';
  apply: (tx: StoreTransaction, op: Operation<IngressPayload>) => void;
}>;

/** One captured provider emission. */
export type IngressEvent = Readonly<{ kind: 'event'; event: CapturedProviderEvent }>;

export type IngressPayload = IngressEvent | IngressPlan;

export function ingressPlan(apply: IngressPlan['apply']): IngressPlan {
  return Object.freeze({ kind: 'plan', apply });
}

/**
 * What the store adapter guarantees about a rejected commit.
 *
 * `linearizable`: a settled rejection is never applied later, a mutate that
 * throws discards its draft, and a read after the rejection observes every
 * commit applied before it. Only then can read-after-failure prove a head
 * applied or absent. `unverified`: none of this is known, so a rejected head
 * stays ambiguous (A) for the runtime lifetime and is never resubmitted.
 */
export type IngressStoreContract = 'linearizable' | 'unverified';

export type MaterializeEventInput = Readonly<{
  sessionId: SessionId;
  op: BodyOperation<IngressPayload>;
  event: CapturedProviderEvent;
}>;

/**
 * The provider-event materialization rules that do not involve interaction
 * routing, matching the live runtime. Returns `false` for an accepted
 * `interaction.requested`/`interaction.withdrawn`, whose routing and
 * settlement materialization belong to surface 3.
 *
 * The FIFO already guarantees that the owning `session.opened`/`run.started`
 * committed first and that no run body follows its terminal, so this does
 * not re-read the projection.
 */
export function materializePlainProviderEvent(tx: StoreTransaction, input: MaterializeEventInput): boolean {
  const { sessionId, op, event } = input;
  if (!event.valid) {
    tx.emit({
      sessionId,
      payload: {
        type: 'diagnostic',
        level: 'warning',
        message: event.diagnostic,
        detail: { code: 'provider_contract_violation' },
      },
    });
    return true;
  }
  const payload = event.input.payload;
  if (op.source === 'session' && payload.type !== 'diagnostic') {
    tx.emit({
      sessionId,
      payload: {
        type: 'diagnostic',
        level: 'warning',
        message: `provider emitted run-scoped event \`${payload.type}\` on the session sink`,
      },
    });
    return true;
  }
  if (payload.type === 'interaction.requested' && op.demoted && op.runId !== undefined) {
    tx.emit({
      sessionId,
      runId: op.runId,
      payload: {
        type: 'diagnostic',
        level: 'warning',
        message: 'provider contract violation: emitted `interaction.requested` after its run was fenced',
        detail: { code: 'provider_contract_violation' },
      },
    });
    return true;
  }
  if (payload.type === 'interaction.requested' || payload.type === 'interaction.withdrawn') return false;
  tx.emit({ sessionId, ...(op.runId === undefined ? {} : { runId: op.runId }), payload });
  return true;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export type IngressDriverOptions = {
  readonly store: RuntimeStore;
  /** A hub created by `createSubscriptionHub`; the driver installs its fault guard on it. */
  readonly hub: SubscriptionHub;
  readonly storeContract: IngressStoreContract;
  readonly materializeEvent: (tx: StoreTransaction, input: MaterializeEventInput) => void;
  /** Interrupt the current run after an overflow. Called at most once per run, never re-entrantly. */
  readonly interruptRun: (sessionId: SessionId, runId: RunId) => Promise<void>;
};

/** Internal fault query entry: one per session, precedence A > O > F. */
export type IngressFault = Readonly<{
  sessionId: SessionId;
  kind: IngestionFaultView['kind'];
  permanent: boolean;
  failureCount?: number;
  error: AgentError;
}>;

export type ReserveRunResult =
  | Readonly<{ kind: 'reserved'; ordinal: number; sink: ProviderEventSink }>
  | Readonly<{ kind: 'existing'; ordinal: number }>
  | Readonly<{ kind: 'refused'; reason: RefusalReason }>;

export type IngressDriver = {
  /** Reserve the session-open effect at ordinal 0 and return the inactive session sink. */
  openSession(sessionId: SessionId, identity: CommandIdentity): ProviderEventSink;
  /** Fill the open reservation. A rejected open discards the session without a fault marker. */
  settleOpen(
    sessionId: SessionId,
    outcome: Readonly<{ kind: 'applied'; plan: IngressPlan }> | Readonly<{ kind: 'rejected' }>,
  ): void;
  /** Reserve the start ordinal and slot before provider `startRun()`; the run sink is ordered behind it. */
  reserveRun(
    sessionId: SessionId,
    input: Readonly<{ runId: RunId; turnId: TurnId; attempt: number; identity: CommandIdentity }>,
  ): ReserveRunResult;
  settleStart(
    sessionId: SessionId,
    ordinal: number,
    outcome: Readonly<{ kind: 'applied' | 'rejected'; plan: IngressPlan }>,
  ): void;
  /** Surface 3 owns terminal materialization; this places a caller plan in the reserved terminal slot. */
  chooseTerminal(sessionId: SessionId, runId: RunId, outcome: TerminalOutcome, plan: IngressPlan): void;
  fault(sessionId: SessionId): IngressFault | undefined;
  /** Every faulted session, sorted by session id. */
  faults(): readonly IngressFault[];
  /** Throws while the session has A, O or F. */
  ensureReplayReady(sessionId: SessionId): void;
  /**
   * Internal retry (the public API is surface 4). A: refuses without
   * resubmitting. Healthy: no-op. F: resubmits the same head, and reports F if
   * it fails again. O: drains the accepted prefix, then still reports O.
   * Concurrent retries share one drain.
   */
  retry(sessionId: SessionId): Promise<void>;
  /** Waits for in-flight ingress; rejects as soon as any session has a fault. */
  quiesce(): Promise<void>;
  /** Waits for every scheduled commit, reconciliation and overflow interrupt. Test-facing. */
  settled(): Promise<void>;
  /** Direct reducer state for deterministic inspection. */
  inspect(sessionId: SessionId): Readonly<SessionIngestion<IngressPayload>> | undefined;
};

type Entry = {
  readonly s: SessionIngestion<IngressPayload>;
  /** The running head chain, if any. */
  chain: Promise<void> | undefined;
  /** A pump is queued on a microtask. */
  scheduled: boolean;
  retrying: Promise<void> | undefined;
  /** Fault kind subscribers were last woken for, so each new A/O/F transition wakes once. */
  notified: IngestionFaultView['kind'] | undefined;
  /** Last committed session sequence observed through this driver. */
  lastSequence: number;
};

type CapturedEnvelope = Readonly<{ eventId: EventId; sequence: Sequence; payload: string }>;

type Witness = {
  ran: boolean;
  threw: boolean;
  readonly events: CapturedEnvelope[];
  receipt: Readonly<{ commandId: CommandIdentity['commandId']; fingerprint: string }> | undefined;
};

type Verdict = 'applied' | 'absent' | 'unknown';

function faultError(sessionId: SessionId, view: IngestionFaultView): AgentError {
  switch (view.kind) {
    case 'ambiguous':
      return {
        ...agentError(
          'store_unavailable',
          `provider ingestion for session \`${sessionId}\` has a store commit with an unknown outcome; its history cannot be certified`,
          { details: { sessionId, fault: 'ambiguous', permanent: view.permanent } },
        ),
        retryable: false,
      };
    case 'overflow':
      return {
        ...agentError(
          'store_unavailable',
          `provider event history for session \`${sessionId}\` exceeded its ingestion capacity and is permanently incomplete`,
          { details: { sessionId, fault: 'overflow', operationLimit: SESSION_OPERATION_LIMIT } },
        ),
        retryable: false,
      };
    case 'failure':
      return agentError(
        'store_unavailable',
        `provider ingestion for session \`${sessionId}\` could not persist an accepted operation; retry can resubmit it unchanged`,
        { details: { sessionId, fault: 'failure', failureCount: view.failureCount ?? 1 } },
      );
  }
}

/** Retry reporting: A first, then a still-failing head (F), then O. */
function retryView<T>(s: SessionIngestion<T>): IngestionFaultView | undefined {
  const { ambiguous, failure, overflow } = s.faults;
  if (ambiguous !== undefined) return ingestionFault(s);
  if (failure !== undefined) {
    return {
      kind: 'failure',
      retryable: true,
      permanent: false,
      ordinal: failure.ordinal,
      failureCount: failure.count,
    };
  }
  if (overflow !== undefined) return ingestionFault(s);
  return undefined;
}

/** Interaction role only: mapping a provider reference to an interaction subject is surface 3. */
function classify(event: CapturedProviderEvent): Readonly<{ role?: InteractionRole }> {
  if (!event.valid) return {};
  const type = event.input.payload.type;
  if (type === 'interaction.requested') return { role: 'request' };
  if (type === 'interaction.withdrawn') return { role: 'withdrawal' };
  return {};
}

export function createIngressDriver(options: IngressDriverOptions): IngressDriver {
  const { store, hub } = options;
  const sessions = new Map<SessionId, Entry>();
  const pending = new Set<Promise<unknown>>();
  let raiseFault: () => void = () => undefined;
  let faultSignal = new Promise<void>((resolve) => {
    raiseFault = resolve;
  });
  const wake = installIngestionFaultGuard(hub, ensureReplayReady);

  function track(work: Promise<unknown>): void {
    const wrapped = work.finally(() => pending.delete(wrapped));
    pending.add(wrapped);
  }

  function internal(message: string): AgentRuntimeError {
    return new AgentRuntimeError(agentError('internal', message));
  }

  function requireEntry(sessionId: SessionId): Entry {
    const entry = sessions.get(sessionId);
    if (entry === undefined) throw internal(`no provider ingress for session \`${sessionId}\``);
    return entry;
  }

  // ---- faults ---------------------------------------------------------------

  /** Wake subscribers and quiesce at each transition into A, O or F, before any reconciliation I/O. */
  function noteFault(entry: Entry): void {
    const kind = ingestionFault(entry.s)?.kind;
    if (kind === entry.notified) return;
    entry.notified = kind;
    if (kind === undefined) return;
    wake(entry.s.sessionId);
    const resolve = raiseFault;
    faultSignal = new Promise<void>((next) => {
      raiseFault = next;
    });
    resolve();
  }

  function fault(sessionId: SessionId): IngressFault | undefined {
    const entry = sessions.get(sessionId);
    const view = entry === undefined ? undefined : ingestionFault(entry.s);
    if (view === undefined) return undefined;
    return {
      sessionId,
      kind: view.kind,
      permanent: view.permanent,
      ...(view.failureCount === undefined ? {} : { failureCount: view.failureCount }),
      error: faultError(sessionId, view),
    };
  }

  function faults(): readonly IngressFault[] {
    return [...sessions.keys()]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap((sessionId) => {
        const found = fault(sessionId);
        return found === undefined ? [] : [found];
      });
  }

  function ensureReplayReady(sessionId: SessionId): void {
    const found = fault(sessionId);
    if (found !== undefined) throw new AgentRuntimeError(found.error);
  }

  // ---- ingress --------------------------------------------------------------

  function sinkFor(entry: Entry, source: 'session' | RunSinkFence): ProviderEventSink {
    return Object.freeze({
      emit(input: Parameters<ProviderEventSink['emit']>[0]): void {
        accept(entry, source, captureProviderEvent(input));
      },
    });
  }

  function accept(entry: Entry, source: 'session' | RunSinkFence, event: CapturedProviderEvent): void {
    const payload: IngressEvent = { kind: 'event', event };
    const result = acceptEvent(entry.s, source, payload, classify(event));
    if (result.kind === 'accepted') {
      schedule(entry);
    } else if (result.kind === 'refused') {
      if (result.interrupt !== undefined) interrupt(entry, result.interrupt);
      noteFault(entry);
    }
  }

  /** Execute the reducer's overflow interrupt off the provider's call stack, handling both outcomes. */
  function interrupt(entry: Entry, runId: RunId): void {
    const settle = (outcome: 'succeeded' | 'failed'): void => {
      settleEffect(entry.s, { cleanup: 'interrupt', outcome });
      schedule(entry);
    };
    track(
      Promise.resolve()
        .then(() => options.interruptRun(entry.s.sessionId, runId))
        .then(
          () => {
            settle('succeeded');
          },
          () => {
            settle('failed');
          },
        ),
    );
  }

  // ---- head ---------------------------------------------------------------

  function schedule(entry: Entry): void {
    if (entry.scheduled) return;
    entry.scheduled = true;
    track(
      Promise.resolve().then(() => {
        entry.scheduled = false;
        // The chain is tracked by `pump` and never rejects.
        void pump(entry);
      }),
    );
  }

  /** Start a head chain if the reducer allows a submission; idempotent while one is in flight. */
  function pump(entry: Entry, retry = false): Promise<void> | undefined {
    const chain = advance(entry, retry);
    if (chain === undefined) return undefined;
    entry.chain = chain;
    track(chain);
    const clear = (): void => {
      if (entry.chain === chain) entry.chain = undefined;
    };
    chain.then(clear, clear);
    return chain;
  }

  function advance(entry: Entry, retry: boolean): Promise<void> | undefined {
    const step = advanceHead(entry.s, retry ? { kind: 'submit', retry: true } : { kind: 'submit' });
    if (step.kind !== 'submit') return undefined;
    return submit(entry, step.op).then((continued) => (continued ? advance(entry, false) : undefined));
  }

  function materialize(tx: StoreTransaction, sessionId: SessionId, op: Operation<IngressPayload>): void {
    switch (op.kind) {
      case 'body':
        if (op.body.kind !== 'event') throw internal('a provider body must carry a captured event');
        options.materializeEvent(tx, { sessionId, op, event: op.body.event });
        return;
      case 'effect':
        if (op.result?.kind === 'plan') op.result.apply(tx, op);
        return;
      case 'terminal':
        if (op.intent.detail?.kind === 'plan') op.intent.detail.apply(tx, op);
        return;
      case 'closing':
      case 'closed':
        throw internal('session close is not integrated with provider ingress yet (surface 4)');
    }
  }

  function recording(tx: StoreTransaction, witness: Witness): StoreTransaction {
    return {
      session: (sessionId) => tx.session(sessionId),
      hasSession: (sessionId) => tx.hasSession(sessionId),
      createSession: (session) => {
        tx.createSession(session);
      },
      emit: (input) => {
        const envelope = tx.emit(input);
        witness.events.push({
          eventId: envelope.eventId,
          sequence: envelope.sequence,
          payload: JSON.stringify(envelope.payload),
        });
        return envelope;
      },
      recordReceipt: (commandId, record) => {
        tx.recordReceipt(commandId, record);
        witness.receipt = { commandId, fingerprint: record.fingerprint };
      },
      findReceipt: (commandId) => tx.findReceipt(commandId),
    };
  }

  /** Commit one head. Resolves `true` when the chain may continue; never rejects. */
  async function submit(entry: Entry, op: Operation<IngressPayload>): Promise<boolean> {
    const sessionId = entry.s.sessionId;
    const witness: Witness = { ran: false, threw: false, events: [], receipt: undefined };
    let events: readonly EventEnvelope[];
    try {
      ({ events } = await store.commit((tx) => {
        witness.ran = true;
        try {
          materialize(recording(tx, witness), sessionId, op);
        } catch (error) {
          witness.threw = true;
          throw error;
        }
      }));
    } catch {
      return rejected(entry, op, witness);
    }
    const advanced = advanceHead(entry.s, { kind: 'committed', ordinal: op.ordinal });
    if (advanced.kind !== 'advanced') return false;
    const last = events.at(-1);
    if (last !== undefined) entry.lastSequence = last.sequence;
    if (advanced.publish && events.length > 0) hub.publish(sessionId, events);
    noteFault(entry);
    return true;
  }

  async function rejected(entry: Entry, op: Operation<IngressPayload>, witness: Witness): Promise<boolean> {
    const first = witness.events[0];
    const sequenceBefore = (first === undefined ? entry.lastSequence : first.sequence - 1) as Sequence;
    const commitWitness: CommitWitness = {
      sequenceBefore,
      events: witness.events.map(({ eventId, sequence }) => ({ eventId, sequence })),
      ...(witness.receipt === undefined ? {} : { receipt: witness.receipt }),
    };
    // A is recorded synchronously, before any reconciliation await.
    advanceHead(entry.s, { kind: 'rejected', ordinal: op.ordinal, witness: commitWitness });

    if (options.storeContract !== 'linearizable') return reconciled(entry, op, 'unknown', []);
    // The transaction never ran, or its mutate threw: the contract guarantees nothing applied.
    if (!witness.ran || witness.threw) return reconciled(entry, op, 'absent', []);

    noteFault(entry);
    const { verdict, envelopes } = await readBack(entry.s.sessionId, sequenceBefore, witness);
    return reconciled(entry, op, verdict, envelopes);
  }

  function reconciled(
    entry: Entry,
    op: Operation<IngressPayload>,
    verdict: Verdict,
    envelopes: readonly EventEnvelope[],
  ): boolean {
    const result = advanceHead(entry.s, { kind: 'reconciled', ordinal: op.ordinal, verdict });
    if (result.kind === 'advanced') {
      const last = envelopes.at(-1);
      if (last !== undefined) entry.lastSequence = last.sequence;
      // Publish the read-back envelopes once; never append another copy.
      if (result.publish && envelopes.length > 0) hub.publish(entry.s.sessionId, envelopes);
      noteFault(entry);
      return true;
    }
    noteFault(entry);
    return false;
  }

  /** Read-after-failure at the captured position: full match, provable absence, or unknown. */
  async function readBack(
    sessionId: SessionId,
    sequenceBefore: Sequence,
    witness: Witness,
  ): Promise<{ verdict: Verdict; envelopes: readonly EventEnvelope[] }> {
    const unknown = { verdict: 'unknown' as const, envelopes: [] };
    try {
      const verdicts: Verdict[] = [];
      let envelopes: readonly EventEnvelope[] = [];
      if (witness.events.length > 0) {
        const page = await store.readEvents(sessionId, sequenceBefore, witness.events.length);
        const matches =
          page.events.length === witness.events.length &&
          page.events.every((event, index) => {
            const expected = witness.events[index];
            return (
              expected?.eventId === event.eventId &&
              event.sequence === expected.sequence &&
              JSON.stringify(event.payload) === expected.payload
            );
          });
        if (matches) {
          verdicts.push('applied');
          envelopes = page.events;
        } else if (page.events.length === 0) {
          const snapshot = await store.read(sessionId);
          if ((snapshot?.session.sequence ?? 0) !== sequenceBefore) return unknown;
          verdicts.push('absent');
        } else {
          return unknown;
        }
      }
      if (witness.receipt !== undefined) {
        const found = await store.findReceipt(witness.receipt.commandId);
        if (found === undefined) verdicts.push('absent');
        else if (found.fingerprint === witness.receipt.fingerprint) verdicts.push('applied');
        else return unknown;
      }
      // An empty bundle wrote nothing either way.
      if (verdicts.every((verdict) => verdict === 'applied')) return { verdict: 'applied', envelopes };
      if (verdicts.every((verdict) => verdict === 'absent')) return { verdict: 'absent', envelopes: [] };
      return unknown;
    } catch {
      return unknown;
    }
  }

  // ---- retry ----------------------------------------------------------------

  function reportAfterRetry(entry: Entry): void {
    const view = retryView(entry.s);
    if (view !== undefined) throw new AgentRuntimeError(faultError(entry.s.sessionId, view));
  }

  function retry(sessionId: SessionId): Promise<void> {
    const entry = sessions.get(sessionId);
    if (entry === undefined) {
      return Promise.reject(new AgentRuntimeError(agentError('unknown_session', `unknown session \`${sessionId}\``)));
    }
    const s = entry.s;
    const ambiguous = ingestionFault(s);
    // A: never resubmit and never wait for reconciliation.
    if (ambiguous?.kind === 'ambiguous') return Promise.reject(new AgentRuntimeError(faultError(sessionId, ambiguous)));
    if (ambiguous === undefined) return Promise.resolve();
    if (entry.retrying !== undefined) return entry.retrying;

    const attempt = (async () => {
      if (entry.chain !== undefined) await entry.chain;
      if (s.faults.ambiguous === undefined) {
        const chain = pump(entry, s.faults.failure !== undefined);
        if (chain !== undefined) await chain;
      }
      reportAfterRetry(entry);
    })();
    entry.retrying = attempt;
    const clear = (): void => {
      if (entry.retrying === attempt) entry.retrying = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  // ---- quiesce --------------------------------------------------------------

  function throwIfFaulted(): void {
    const first = faults()[0];
    if (first !== undefined) throw new AgentRuntimeError(first.error);
  }

  async function quiesce(): Promise<void> {
    throwIfFaulted();
    for (let pass = 0; pass < 100 && pending.size > 0; pass += 1) {
      await Promise.race([Promise.allSettled([...pending]), faultSignal]);
      throwIfFaulted();
    }
    throwIfFaulted();
  }

  // ---- surface ----------------------------------------------------------------

  return {
    openSession(sessionId, identity) {
      if (sessions.has(sessionId)) throw internal(`provider ingress for session \`${sessionId}\` already exists`);
      const entry: Entry = {
        s: createSessionIngestion<IngressPayload>(sessionId, identity),
        chain: undefined,
        scheduled: false,
        retrying: undefined,
        notified: undefined,
        lastSequence: 0,
      };
      sessions.set(sessionId, entry);
      return sinkFor(entry, 'session');
    },

    settleOpen(sessionId, outcome) {
      const entry = requireEntry(sessionId);
      const result = settleEffect(entry.s, {
        ordinal: 0,
        outcome:
          outcome.kind === 'applied'
            ? { kind: 'applied', result: outcome.plan }
            : { kind: 'rejected', result: ingressPlan(() => undefined) },
      });
      if (result.kind === 'refused') throw internal(`session \`${sessionId}\` has no pending open reservation`);
      if (result.kind === 'discarded') {
        // No owner ever existed: drop the unowned sink and any marker it set.
        sessions.delete(sessionId);
        return;
      }
      schedule(entry);
    },

    reserveRun(sessionId, input) {
      const entry = requireEntry(sessionId);
      const result = reserveStart(entry.s, input);
      if (result.kind === 'reserved') {
        return { kind: 'reserved', ordinal: result.ordinal, sink: sinkFor(entry, result.fence) };
      }
      if (result.kind === 'existing') return { kind: 'existing', ordinal: result.op.ordinal };
      // Command admission at capacity is the caller's retryable `capacity`, never O.
      return result;
    },

    settleStart(sessionId, ordinal, outcome) {
      const entry = requireEntry(sessionId);
      const runId = entry.s.run?.runId;
      const result = settleEffect(entry.s, { ordinal, outcome: { kind: outcome.kind, result: outcome.plan } });
      if (result.kind === 'refused') throw internal(`ordinal ${String(ordinal)} is not a pending start`);
      // Without an admitted close the only follow-up is an overflow's deferred interrupt.
      if (result.next?.kind === 'attempt' && result.next.phase === 'interrupt' && runId !== undefined) {
        interrupt(entry, runId);
      }
      noteFault(entry);
      schedule(entry);
    },

    chooseTerminal(sessionId, runId, outcome, plan) {
      const entry = requireEntry(sessionId);
      chooseTerminal(entry.s, { runId, outcome, cause: 'completion', detail: plan });
      schedule(entry);
    },

    fault,
    faults,
    ensureReplayReady,
    retry,
    quiesce,

    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    inspect: (sessionId) => sessions.get(sessionId)?.s,
  };
}
