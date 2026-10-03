/**
 * Provider event ingress and command settlement through the per-session FIFO
 * (issue #43, design v2). Surface 2: capture, activation, operation caps,
 * permanent overflow, commit witness and reconciliation, fault query and fault
 * wake. Surface 3: start ownership, terminal submission, response and
 * interrupt reservations, interaction routing and immutable retries.
 *
 * PRIVATE SEAM. This module is not exported from the package entry point and
 * `createAgentRuntime` does not use it yet. Session close and shutdown
 * (surface 4) still commit directly in `runtime.ts`; routing commands and
 * provider ingress through the FIFO without them would let those commits
 * bypass it, so the live runtime switches over atomically once they land.
 *
 * Every ordering, capacity and fault decision is made by the surface 1 reducer
 * (`ingestion.ts`). This driver executes its decisions:
 *
 * - each sink `emit()` captures synchronously (ADR-0016) and is O(1): it
 *   routes interaction references, calls `acceptEvent` and schedules the head
 *   on a microtask, never calling the store or the provider re-entrantly;
 * - every command reserves its ordinal, slot and identity before the provider
 *   is called, and the provider's outcome fills that same slot: a start bundle
 *   or rejected receipt, a response settlement or rejected receipt, an
 *   interrupt receipt. An ambiguous outcome leaves the slot unresolved;
 * - every queued payload is plain data the reducer deep-freezes, and
 *   materialization is a deterministic function of that payload and the
 *   projection at its ordinal, so a retried head is the identical value;
 * - the terminal is the provider's completion, stamped once when observed,
 *   placed only after every earlier reservation of its run settled;
 * - one head per session is in flight; a blocked head stalls only its session;
 * - a commit's witness (every emitted envelope id/sequence, or its receipt) is
 *   captured inside the transaction callback; on rejection A is set before any
 *   await, subscribers are woken and command attempts return before
 *   reconciliation I/O;
 * - only a store declared `linearizable` is reconciled by reading back; any
 *   other adapter leaves A permanent and its head is never resubmitted;
 * - an overflow interrupts the current run once a provider handle exists.
 *
 * Process-local only; issue #6 owns crash-durable recovery.
 */

import {
  AgentErrorSchema,
  AgentRuntimeError,
  CommandReceiptSchema,
  RUN_STATE_TABLE,
  agentError,
  canTransition,
  canonicalCommandFingerprint,
  toAgentError,
  type AgentCommand,
  type AgentError,
  type AgentSession,
  type Clock,
  type CommandReceipt,
  type CommandResult,
  type EventEnvelope,
  type EventId,
  type IdFactory,
  type InteractionId,
  type InterruptRunCommand,
  type ProviderEventPayload,
  type RespondToInteractionCommand,
  type RunId,
  type RunTermination,
  type Sequence,
  type SessionId,
  type SessionSnapshot,
  type SubmitTurnCommand,
  type Timestamp,
  type TurnId,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRunTerminationSchema,
  isProviderRejection,
  type ProviderEventSink,
  type ProviderRun,
  type ProviderRunRequest,
} from '@relvo-labs/agent-provider';

import {
  SESSION_OPERATION_LIMIT,
  acceptEvent,
  advanceHead,
  chooseTerminal,
  createSessionIngestion,
  ingestionFault,
  reserveEffect,
  reserveStart,
  settleEffect,
  type BodyOperation,
  type CommandIdentity,
  type CommitWitness,
  type EffectOperation,
  type EffectOutcome,
  type IngestionFaultView,
  type InteractionRole,
  type Operation,
  type RefusalReason,
  type RunSinkFence,
  type SessionIngestion,
  type SettleResult,
  type TerminalOperation,
} from './ingestion.ts';
import { applyEvent } from './projection.ts';
import { captureProviderEvent, type CapturedProviderEvent } from './provider-capture.ts';
import type { RuntimeStore, SessionRecord, StoreTransaction } from './store.ts';
import { installIngestionFaultGuard, type SubscriptionHub } from './subscriptions.ts';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * A caller-owned bundle committed at an operation's ordinal. Only the session
 * open still uses one; its rollback and close path belong to surface 4.
 */
export type IngressPlan = Readonly<{
  kind: 'plan';
  apply: (tx: StoreTransaction, op: Operation<IngressPayload>) => void;
}>;

/**
 * How an accepted run-sink `interaction.requested`/`interaction.withdrawn` was
 * routed, decided once at acceptance and frozen with the body: the
 * interaction id a request receives, a provider reference already in use, the
 * interaction a withdrawal targets (stamped then), or an unknown reference.
 */
export type InteractionDecision =
  | Readonly<{ kind: 'request'; interactionId: InteractionId }>
  | Readonly<{ kind: 'reused-ref'; providerRef: string }>
  | Readonly<{ kind: 'withdrawal'; interactionId: InteractionId; settledAt: Timestamp }>
  | Readonly<{ kind: 'unrouted' }>;

/** One captured provider emission. */
export type IngressEvent = Readonly<{ kind: 'event'; event: CapturedProviderEvent; interaction?: InteractionDecision }>;

/** A resolved provider start: `turn.started` + `run.started` + the applied submit receipt. */
export type IngressStart = Readonly<{
  kind: 'start';
  command: SubmitTurnCommand;
  turnId: TurnId;
  runId: RunId;
  attempt: number;
}>;

/** A response the provider accepted: its settlement + the applied receipt. */
export type IngressResponse = Readonly<{
  kind: 'response';
  command: RespondToInteractionCommand;
  runId: RunId;
  settledAt: Timestamp;
}>;

/** An interrupt request: `interrupting` when this command delivered it, + the applied receipt. */
export type IngressInterrupt = Readonly<{ kind: 'interrupt'; command: InterruptRunCommand; delivered: boolean }>;

/** A receipt-only fill: the rejected receipt of a definitely rejected provider effect. */
export type IngressReceipt = Readonly<{ kind: 'receipt'; receipt: CommandReceipt }>;

/** The provider's completion, parsed and stamped once when it was observed. */
export type IngressTermination = Readonly<{ kind: 'termination'; termination: RunTermination }>;

export type IngressPayload =
  IngressEvent | IngressPlan | IngressStart | IngressResponse | IngressInterrupt | IngressReceipt | IngressTermination;

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
 * routing, matching the live runtime. Returns `false` for an accepted,
 * non-demoted run-sink `interaction.requested`/`interaction.withdrawn`, which
 * the routed materialization below handles.
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

/** How a rejected provider response/interrupt call is classified. */
export type EffectFailureClass = 'rejected' | 'unknown';

export type IngressDriverOptions = {
  readonly store: RuntimeStore;
  /** A hub created by `createSubscriptionHub`; the driver installs its fault guard on it. */
  readonly hub: SubscriptionHub;
  readonly storeContract: IngressStoreContract;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  /**
   * Classify a rejected `respondToInteraction`/`interrupt` call. `rejected`
   * fills the reserved slot with a rejected receipt. `unknown` leaves the slot
   * unresolved and the command retryable: an exact retry delivers again (the
   * SPI requires re-delivery to be a no-op). Absent, every rejection is
   * definite, as the provider SPI documents for a bare `Error`.
   */
  readonly classifyEffectFailure?: (error: unknown) => EffectFailureClass;
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

/** Why nothing was reserved. The caller maps it onto its own rejection policy. */
export type IngressRefusal = RefusalReason | 'interaction-unrouted' | 'interaction-withdrawn';

/**
 * A command's settled outcome: the receipt its slot committed (or the store's
 * answer for an already committed command, or a not-recorded conflict), or a
 * refusal before anything was reserved. A persistence fault or an ambiguous
 * provider outcome rejects with an `AgentRuntimeError` instead.
 */
export type IngressCommandOutcome =
  Readonly<{ kind: 'receipt'; receipt: CommandReceipt }> | Readonly<{ kind: 'refused'; reason: IngressRefusal }>;

export type SubmitTurnInput = Readonly<{
  command: SubmitTurnCommand;
  acceptedAt: Timestamp;
  turnId: TurnId;
  runId: RunId;
  attempt: number;
}>;

export type RunCompletion =
  Readonly<{ kind: 'resolved'; value: unknown }> | Readonly<{ kind: 'rejected'; error: unknown }>;

/** Driver-side bookkeeping for the current run, for retirement proofs. */
export type IngressBookkeeping = Readonly<{ run: boolean; routes: number; waiters: number; invocations: number }>;

export type IngressDriver = {
  /** Reserve the session-open effect at ordinal 0 and return the inactive session sink. */
  openSession(sessionId: SessionId, identity: CommandIdentity): ProviderEventSink;
  /** Fill the open reservation. A rejected open discards the session without a fault marker. */
  settleOpen(
    sessionId: SessionId,
    outcome: Readonly<{ kind: 'applied'; plan: IngressPlan }> | Readonly<{ kind: 'rejected' }>,
  ): void;
  /** Reserve the start ordinal and slot before provider `startRun()`; the run sink is ordered behind it. */
  reserveRun(sessionId: SessionId, input: SubmitTurnInput): ReserveRunResult;
  /**
   * Fill a reserved start with the provider's outcome: the start bundle and
   * supervision of its completion, or the rejected submit receipt.
   */
  settleStart(
    sessionId: SessionId,
    ordinal: number,
    outcome: Readonly<{ kind: 'applied'; run: ProviderRun }> | Readonly<{ kind: 'rejected'; error: unknown }>,
  ): void;
  /** `submit_turn`: reserve, call `startRun`, fill the same slot, resolve when it commits. */
  submitTurn(
    sessionId: SessionId,
    input: SubmitTurnInput & Readonly<{ startRun: (request: ProviderRunRequest) => Promise<ProviderRun> }>,
  ): Promise<IngressCommandOutcome>;
  /** Supervision entry: choose the run's terminal from its provider completion, once. */
  completeRun(sessionId: SessionId, runId: RunId, completion: RunCompletion): void;
  /** `respond_to_interaction` (validated by the caller): reserve, deliver, fill the same slot. */
  respondToInteraction(
    sessionId: SessionId,
    input: Readonly<{
      command: RespondToInteractionCommand;
      acceptedAt: Timestamp;
      deliver: (providerRef: string, response: RespondToInteractionCommand['response']) => Promise<void>;
    }>,
  ): Promise<IngressCommandOutcome>;
  /** `interrupt_run` (validated by the caller): reserve and fence, interrupt once, fill the same slot. */
  interruptRun(
    sessionId: SessionId,
    input: Readonly<{ command: InterruptRunCommand; acceptedAt: Timestamp }>,
  ): Promise<IngressCommandOutcome>;
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
  /** Driver-side per-run bookkeeping. Test-facing. */
  bookkeeping(sessionId: SessionId): IngressBookkeeping | undefined;
};

type Route = { readonly providerRef: string; withdrawn: boolean };

/**
 * Driver-side facts about the reducer's one active or starting run: the
 * provider handle and interaction routes. Dropped as soon as the reducer
 * retires the run (terminal commit or start rejection).
 */
type DriverRun = {
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly attempt: number;
  readonly command: SubmitTurnCommand;
  handle: ProviderRun | undefined;
  readonly routes: Map<InteractionId, Route>;
  /** Provider references that still route to an interaction. */
  readonly refs: Map<string, InteractionId>;
};

type Waiter = { resolve(receipt: CommandReceipt): void; reject(error: AgentRuntimeError): void };

type Invocation = 'filled' | 'unknown' | 'stale';

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
  /**
   * The session record the open bundle created (constant size). Read-back folds the
   * authoritative log from it to prove the snapshot projection is consistent.
   */
  initialSession: AgentSession | undefined;
  run: DriverRun | undefined;
  /** Command attempts waiting for their slot to commit, by ordinal. */
  readonly waiters: Map<number, Waiter[]>;
  /** Provider calls in flight for a reserved slot, shared by exact retries. */
  readonly invocations: Map<number, Promise<Invocation>>;
};

type CapturedEnvelope = Readonly<{ eventId: EventId; sequence: Sequence; payload: string }>;

type Witness = {
  ran: boolean;
  threw: boolean;
  readonly events: CapturedEnvelope[];
  receipt: Readonly<{ commandId: CommandIdentity['commandId']; fingerprint: string }> | undefined;
  /** The receipt this transaction recorded, handed to the command waiting for this slot. */
  receiptValue: CommandReceipt | undefined;
  /** The session record this transaction created, if it is the open bundle. */
  created: AgentSession | undefined;
};

/** JSON with object keys sorted, so equal projections compare equal across adapters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : item,
  );
}

function recordProjection(record: SessionRecord): string {
  return canonicalJson({
    session: record.session,
    turns: [...record.turns.values()],
    runs: [...record.runs.values()],
    interactions: [...record.interactions.values()],
  });
}

function snapshotProjection(snapshot: SessionSnapshot): string {
  return canonicalJson({
    session: snapshot.session,
    turns: snapshot.turns,
    runs: snapshot.runs,
    interactions: snapshot.interactions,
  });
}

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
          view.permanent
            ? `provider event history for session \`${sessionId}\` exceeded its ingestion capacity and is permanently incomplete`
            : // Provisional: only an unresolved start's own staging overflowed. A rejected
              // start withdraws it, so it must not be described as permanent.
              `provider event history for session \`${sessionId}\` exceeded its ingestion capacity while a run start is unresolved; history cannot be certified unless that start is rejected`,
          {
            details: {
              sessionId,
              fault: 'overflow',
              permanent: view.permanent,
              operationLimit: SESSION_OPERATION_LIMIT,
            },
          },
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

/** The reason passed to `ProviderRun.interrupt()` when history overflowed. */
const OVERFLOW_INTERRUPT_REASON = 'provider event history overflowed';

/** Why an unsubmitted success became a failure: history overflowed (design: "if truth permits"). */
function overflowError(): AgentError {
  return agentError(
    'provider_contract_violation',
    'provider event history exceeded the session ingestion capacity; the run cannot be reported as succeeded',
  );
}

function turnState(outcome: RunTermination['outcome']): 'completed' | 'failed' | 'cancelled' {
  return outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'cancelled' : 'failed';
}

function identityOf(command: AgentCommand, acceptedAt: Timestamp): CommandIdentity {
  return { commandId: command.commandId, fingerprint: canonicalCommandFingerprint(command), acceptedAt };
}

function appliedReceipt(
  command: AgentCommand,
  result: CommandResult,
  sequence: Sequence,
  acceptedAt: Timestamp,
): CommandReceipt {
  return CommandReceiptSchema.parse({
    commandId: command.commandId,
    commandType: command.type,
    disposition: 'applied',
    result,
    sequence,
    acceptedAt,
  });
}

function rejectedReceipt(command: AgentCommand, error: AgentError, acceptedAt: Timestamp): CommandReceipt {
  return CommandReceiptSchema.parse({
    commandId: command.commandId,
    commandType: command.type,
    disposition: 'rejected',
    error,
    acceptedAt,
  });
}

/**
 * The live runtime's mapping of a rejected provider call onto a receipt error,
 * validated so a malformed provider error can never leave a reserved slot
 * unfillable (the live runtime would throw out of the command instead).
 */
function providerError(error: unknown): AgentError {
  try {
    const candidate: unknown = isProviderRejection(error) ? error.agentError : toAgentError(error, 'provider_rejected');
    const parsed = AgentErrorSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the fixed classification below.
  }
  return agentError('provider_rejected', 'provider rejected the operation with a malformed error');
}

/** Same id, different payload: the live runtime's `command_id_conflict` receipt (not recorded). */
function conflictReceipt(command: AgentCommand, acceptedAt: Timestamp): CommandReceipt {
  return rejectedReceipt(
    command,
    agentError('command_id_conflict', `command id \`${command.commandId}\` was already used with a different payload`, {
      details: { commandId: command.commandId, commandType: command.type },
    }),
    acceptedAt,
  );
}

/** The store's answer for a command whose receipt already committed. */
function dedupe(
  command: AgentCommand,
  existing: Readonly<{ fingerprint: string; receipt: CommandReceipt }>,
): CommandReceipt {
  if (existing.fingerprint !== canonicalCommandFingerprint(command)) {
    return conflictReceipt(command, existing.receipt.acceptedAt);
  }
  return existing.receipt.disposition === 'rejected'
    ? existing.receipt
    : CommandReceiptSchema.parse({ ...existing.receipt, disposition: 'duplicate' });
}

/** Call a provider function, turning a synchronous throw into a rejection. */
function invoke<T>(call: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createIngressDriver(options: IngressDriverOptions): IngressDriver {
  const { store, hub, clock, idFactory } = options;
  const classifyEffectFailure = options.classifyEffectFailure ?? ((): EffectFailureClass => 'rejected');
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

  // ---- command waiters ------------------------------------------------------------

  /**
   * Register a command attempt waiting for its slot. The returned promise is
   * marked handled at once: it may reject (a fault) while the caller is still
   * waiting on the provider, and the caller observes it afterwards.
   */
  function addWaiter(entry: Entry, ordinal: number): { promise: Promise<CommandReceipt>; cancel(): void } {
    let waiter!: Waiter;
    const promise = new Promise<CommandReceipt>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    promise.catch(() => undefined);
    const list = entry.waiters.get(ordinal) ?? [];
    list.push(waiter);
    entry.waiters.set(ordinal, list);
    return {
      promise,
      cancel: () => {
        const current = entry.waiters.get(ordinal);
        if (current === undefined) return;
        const remaining = current.filter((candidate) => candidate !== waiter);
        if (remaining.length > 0) entry.waiters.set(ordinal, remaining);
        else entry.waiters.delete(ordinal);
      },
    };
  }

  /** The head blocking every waiter failed (F) or is ambiguous (A): each attempt returns now. */
  function failWaiters(entry: Entry): void {
    const view = retryView(entry.s);
    if (view === undefined || view.kind === 'overflow' || entry.waiters.size === 0) return;
    const error = new AgentRuntimeError(faultError(entry.s.sessionId, view));
    const all = [...entry.waiters.values()].flat();
    entry.waiters.clear();
    for (const waiter of all) waiter.reject(error);
  }

  /** A committed command slot hands its receipt to every attempt waiting for it. */
  function settleWaiters(entry: Entry, op: Operation<IngressPayload>, receipt: CommandReceipt | undefined): void {
    const list = entry.waiters.get(op.ordinal);
    if (list === undefined) return;
    entry.waiters.delete(op.ordinal);
    for (const waiter of list) {
      if (receipt === undefined) waiter.reject(internal(`slot ${String(op.ordinal)} committed without a receipt`));
      else waiter.resolve(receipt);
    }
  }

  /**
   * Fail fast or resume while the session head is blocked. Under A an attempt
   * never resubmits. Under F only an exact retry (`resume`) resubmits the
   * same frozen head; a fresh attempt returns the retryable fault at once.
   */
  function checkBlocked(entry: Entry, resume: boolean): void {
    const view = retryView(entry.s);
    if (view?.kind === 'ambiguous') {
      failWaiters(entry);
      return;
    }
    if (view?.kind !== 'failure' || entry.chain !== undefined) return;
    if (!resume || pump(entry, true) === undefined) failWaiters(entry);
  }

  /** The outcome of a command whose slot is reserved: its committed receipt, a fault, or an ambiguous provider call. */
  function slotOutcome(
    entry: Entry,
    ordinal: number,
    invocation: Promise<Invocation> | undefined,
    resume: boolean,
  ): Promise<IngressCommandOutcome> {
    const waiter = addWaiter(entry, ordinal);
    return new Promise<IngressCommandOutcome>((resolve, reject) => {
      waiter.promise.then((receipt) => {
        resolve({ kind: 'receipt', receipt });
      }, reject);
      invocation?.then(
        (result) => {
          if (result !== 'unknown') return;
          waiter.cancel();
          reject(
            new AgentRuntimeError(
              agentError(
                'provider_unavailable',
                'the provider outcome of this command is unknown; retry the same command to deliver it again',
                { details: { sessionId: entry.s.sessionId } },
              ),
            ),
          );
        },
        (error: unknown) => {
          // Unreachable by construction (fills cannot throw); surface it rather than hang.
          waiter.cancel();
          reject(error instanceof Error ? error : internal('a provider call could not be settled'));
        },
      );
      checkBlocked(entry, resume);
    });
  }

  // ---- runs and routing -------------------------------------------------------------

  /** Drop the driver-side run once the reducer has retired it. */
  function syncRun(entry: Entry): void {
    if (entry.run !== undefined && entry.s.run?.runId !== entry.run.runId) entry.run = undefined;
  }

  function currentRun(entry: Entry, fence: RunSinkFence): DriverRun | undefined {
    const run = entry.run;
    return run?.runId === fence.runId && entry.s.run?.epoch === fence.epoch ? run : undefined;
  }

  type Classified = {
    readonly options: Readonly<{ role?: InteractionRole; subject?: string }>;
    readonly decision?: InteractionDecision;
    readonly run?: DriverRun;
  };

  /**
   * Interaction role and routing, decided once at acceptance. A request gets
   * its interaction id now, so a retried head carries the same id; a
   * withdrawal is stamped now and targets the interaction its reference
   * routes to. Stale sinks get no id: the reducer discards them.
   */
  function classify(entry: Entry, source: 'session' | RunSinkFence, event: CapturedProviderEvent): Classified {
    if (!event.valid) return { options: {} };
    const payload = event.input.payload;
    if (payload.type !== 'interaction.requested' && payload.type !== 'interaction.withdrawn') return { options: {} };
    const role: InteractionRole = payload.type === 'interaction.requested' ? 'request' : 'withdrawal';
    const run = source === 'session' ? undefined : currentRun(entry, source);
    if (run === undefined) return { options: { role } };
    if (payload.type === 'interaction.requested') {
      if (run.refs.has(payload.providerRef)) {
        return { options: { role }, decision: { kind: 'reused-ref', providerRef: payload.providerRef }, run };
      }
      const interactionId = idFactory.next('interaction') as InteractionId;
      return { options: { role, subject: interactionId }, decision: { kind: 'request', interactionId }, run };
    }
    const interactionId = run.refs.get(payload.providerRef);
    if (interactionId === undefined) return { options: { role }, decision: { kind: 'unrouted' }, run };
    return {
      options: { role, subject: interactionId },
      decision: { kind: 'withdrawal', interactionId, settledAt: clock.now() },
      run,
    };
  }

  /** Install routing only for what the reducer actually accepted. */
  function route(run: DriverRun, event: CapturedProviderEvent, decision: InteractionDecision, demoted: boolean): void {
    if (!event.valid) return;
    const payload = event.input.payload;
    if (decision.kind === 'request' && !demoted && payload.type === 'interaction.requested') {
      run.routes.set(decision.interactionId, { providerRef: payload.providerRef, withdrawn: false });
      run.refs.set(payload.providerRef, decision.interactionId);
    } else if (decision.kind === 'withdrawal') {
      const target = run.routes.get(decision.interactionId);
      if (target === undefined) return;
      // No new response may reach the provider; the reference is free for a new request.
      target.withdrawn = true;
      run.refs.delete(target.providerRef);
    }
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
    const classified = classify(entry, source, event);
    const decision = classified.decision;
    const payload: IngressEvent =
      decision === undefined ? { kind: 'event', event } : { kind: 'event', event, interaction: decision };
    const result = acceptEvent(entry.s, source, payload, classified.options);
    if (result.kind === 'accepted') {
      if (classified.run !== undefined && decision !== undefined) {
        route(classified.run, event, decision, result.demoted);
      }
      schedule(entry);
    } else if (result.kind === 'refused') {
      if (result.interrupt !== undefined) cleanupInterrupt(entry, result.interrupt);
      noteFault(entry);
    }
  }

  /** Execute the reducer's overflow interrupt off the provider's call stack, handling both outcomes. */
  function cleanupInterrupt(entry: Entry, runId: RunId): void {
    const handle = entry.run?.runId === runId ? entry.run.handle : undefined;
    const settle = (outcome: 'succeeded' | 'failed'): void => {
      settleEffect(entry.s, { cleanup: 'interrupt', outcome });
      schedule(entry);
    };
    track(
      Promise.resolve()
        .then(() => {
          if (handle === undefined) throw internal(`run \`${runId}\` has no provider handle to interrupt`);
          return handle.interrupt(OVERFLOW_INTERRUPT_REASON);
        })
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

  /** Follow-up of a fill: without an admitted close the only one is an overflow's deferred interrupt. */
  function afterFill(entry: Entry, result: SettleResult, runId: RunId | undefined): void {
    syncRun(entry);
    if (result.next?.kind === 'attempt' && result.next.phase === 'interrupt' && runId !== undefined) {
      cleanupInterrupt(entry, runId);
    }
    noteFault(entry);
    schedule(entry);
  }

  // ---- start and supervision ------------------------------------------------------------

  function reserveRun(entry: Entry, input: SubmitTurnInput): ReserveRunResult {
    syncRun(entry);
    const result = reserveStart(entry.s, {
      runId: input.runId,
      turnId: input.turnId,
      attempt: input.attempt,
      identity: identityOf(input.command, input.acceptedAt),
    });
    if (result.kind === 'existing') return { kind: 'existing', ordinal: result.op.ordinal };
    // Command admission at capacity is the caller's retryable `capacity`, never O.
    if (result.kind === 'refused') return result;
    entry.run = {
      runId: input.runId,
      turnId: input.turnId,
      attempt: input.attempt,
      command: structuredClone(input.command),
      handle: undefined,
      routes: new Map(),
      refs: new Map(),
    };
    return { kind: 'reserved', ordinal: result.ordinal, sink: sinkFor(entry, result.fence) };
  }

  function settleStart(
    entry: Entry,
    ordinal: number,
    outcome: Readonly<{ kind: 'applied'; run: ProviderRun }> | Readonly<{ kind: 'rejected'; error: unknown }>,
  ): Invocation {
    const run = entry.run;
    const op = entry.s.queue.find((candidate) => candidate.ordinal === ordinal);
    if (run === undefined || entry.s.run?.startOrdinal !== ordinal || op?.kind !== 'effect') return 'stale';
    let result: SettleResult;
    if (outcome.kind === 'applied') {
      run.handle = outcome.run;
      const start: IngressStart = {
        kind: 'start',
        command: run.command,
        turnId: run.turnId,
        runId: run.runId,
        attempt: run.attempt,
      };
      result = settleEffect(entry.s, { ordinal, outcome: { kind: 'applied', result: start } });
      supervise(entry, run.runId, outcome.run);
    } else {
      // A definite rejection: the same slot carries the rejected receipt; the run's staging goes.
      const receipt = rejectedReceipt(run.command, providerError(outcome.error), op.identity.acceptedAt);
      result = settleEffect(entry.s, { ordinal, outcome: { kind: 'rejected', result: { kind: 'receipt', receipt } } });
    }
    if (result.kind === 'refused') return 'stale';
    afterFill(entry, result, run.runId);
    return 'filled';
  }

  /** Observe the provider completion with fulfilment and rejection handlers. */
  function supervise(entry: Entry, runId: RunId, handle: ProviderRun): void {
    const sessionId = entry.s.sessionId;
    let completion: Promise<unknown>;
    try {
      completion = Promise.resolve(handle.completion);
    } catch (error) {
      completeRun(sessionId, runId, { kind: 'rejected', error });
      return;
    }
    completion.then(
      (value) => {
        completeRun(sessionId, runId, { kind: 'resolved', value });
      },
      (error: unknown) => {
        completeRun(sessionId, runId, { kind: 'rejected', error });
      },
    );
  }

  /** Parse and stamp the provider's terminal input once, exactly as the live runtime words it. */
  function stamp(completion: RunCompletion): RunTermination {
    let parsed: ReturnType<typeof ProviderRunTerminationSchema.safeParse> | undefined;
    let inspectionFailed = false;
    if (completion.kind === 'resolved') {
      try {
        parsed = ProviderRunTerminationSchema.safeParse(completion.value);
      } catch {
        inspectionFailed = true;
      }
    }
    const at = clock.now();
    if (parsed?.success === true) return { ...parsed.data, at };
    return {
      outcome: 'failed',
      at,
      error: agentError(
        'provider_contract_violation',
        completion.kind === 'rejected'
          ? 'provider completion promise rejected instead of returning a terminal outcome'
          : inspectionFailed
            ? 'provider completion could not be inspected safely'
            : `provider returned an invalid completion: ${parsed?.error.issues[0]?.message ?? 'schema mismatch'}`,
      ),
    };
  }

  function completeRun(sessionId: SessionId, runId: RunId, completion: RunCompletion): void {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    const termination = stamp(completion);
    // A stale or duplicate completion is ignored by the reducer: exactly one terminal per run.
    chooseTerminal(entry.s, {
      runId,
      outcome: termination.outcome,
      cause: 'completion',
      detail: { kind: 'termination', termination },
    });
    schedule(entry);
  }

  // ---- command admission and effect calls ---------------------------------------------

  function pendingCommand(
    entry: Entry,
    commandId: AgentCommand['commandId'],
  ): EffectOperation<IngressPayload> | undefined {
    for (const op of entry.s.queue) if (op.kind === 'effect' && op.identity.commandId === commandId) return op;
    return undefined;
  }

  type Admission =
    | Readonly<{ kind: 'done'; outcome: IngressCommandOutcome }>
    | Readonly<{ kind: 'pending'; op: EffectOperation<IngressPayload> }>
    | Readonly<{ kind: 'fresh' }>;

  function matchPending(command: AgentCommand, op: EffectOperation<IngressPayload>): Admission {
    if (op.identity.fingerprint !== canonicalCommandFingerprint(command)) {
      return { kind: 'done', outcome: { kind: 'receipt', receipt: conflictReceipt(command, op.identity.acceptedAt) } };
    }
    return { kind: 'pending', op };
  }

  /**
   * The queue is checked before the store: a slot leaves the queue only after
   * its commit applied, so a command absent from the queue is either already
   * answerable from the store or was never reserved.
   */
  async function admit(entry: Entry, command: AgentCommand): Promise<Admission> {
    const queued = pendingCommand(entry, command.commandId);
    if (queued !== undefined) return matchPending(command, queued);
    const stored = await store.findReceipt(command.commandId);
    if (stored !== undefined) return { kind: 'done', outcome: { kind: 'receipt', receipt: dedupe(command, stored) } };
    const reserved = pendingCommand(entry, command.commandId);
    return reserved === undefined ? { kind: 'fresh' } : matchPending(command, reserved);
  }

  function refusal(entry: Entry, command: AgentCommand, reason: RefusalReason): IngressCommandOutcome {
    if (reason === 'command-conflict') {
      const existing = pendingCommand(entry, command.commandId);
      return { kind: 'receipt', receipt: conflictReceipt(command, existing?.identity.acceptedAt ?? clock.now()) };
    }
    return { kind: 'refused', reason };
  }

  type EffectCall = Readonly<{
    deliver: () => Promise<void>;
    applied: () => IngressPayload;
    rejected: (error: unknown) => IngressPayload;
  }>;

  /** Fill a reserved effect slot with the provider's outcome. */
  function fillEffect(entry: Entry, ordinal: number, outcome: EffectOutcome<IngressPayload>): Invocation {
    const runId = entry.s.run?.runId;
    const result = settleEffect(entry.s, { ordinal, outcome });
    if (result.kind === 'refused') return 'stale';
    afterFill(entry, result, runId);
    return outcome.kind === 'unknown' ? 'unknown' : 'filled';
  }

  /** Call the provider for a reserved slot, once at a time; exact retries share the call. */
  function startEffect(entry: Entry, ordinal: number, call: EffectCall): Promise<Invocation> {
    const existing = entry.invocations.get(ordinal);
    if (existing !== undefined) return existing;
    const invocation = invoke(call.deliver).then(
      () => fillEffect(entry, ordinal, { kind: 'applied', result: call.applied() }),
      (error: unknown) =>
        classifyEffectFailure(error) === 'unknown'
          ? fillEffect(entry, ordinal, { kind: 'unknown' })
          : fillEffect(entry, ordinal, { kind: 'rejected', result: call.rejected(error) }),
    );
    entry.invocations.set(ordinal, invocation);
    const clear = (): void => {
      if (entry.invocations.get(ordinal) === invocation) entry.invocations.delete(ordinal);
    };
    invocation.then(clear, clear);
    return invocation;
  }

  /**
   * An exact retry of a reserved command: share an in-flight provider call,
   * deliver an unresolved (ambiguous) one again, or wait for the filled slot.
   */
  function retryCommand(
    entry: Entry,
    op: EffectOperation<IngressPayload>,
    call: EffectCall | undefined,
  ): Promise<IngressCommandOutcome> {
    let invocation = entry.invocations.get(op.ordinal);
    if (invocation === undefined && op.state === 'unknown' && call !== undefined) {
      invocation = startEffect(entry, op.ordinal, call);
    }
    return slotOutcome(entry, op.ordinal, invocation, true);
  }

  function responseCall(
    entry: Entry,
    command: RespondToInteractionCommand,
    acceptedAt: Timestamp,
    deliver: (providerRef: string, response: RespondToInteractionCommand['response']) => Promise<void>,
  ): EffectCall | undefined {
    const run = entry.run;
    const target = run?.routes.get(command.interactionId);
    if (run === undefined || target === undefined) return undefined;
    const owned = structuredClone(command);
    return {
      deliver: () => deliver(target.providerRef, command.response),
      applied: () => ({ kind: 'response', command: owned, runId: run.runId, settledAt: clock.now() }),
      rejected: (error) => ({ kind: 'receipt', receipt: rejectedReceipt(owned, providerError(error), acceptedAt) }),
    };
  }

  function interruptCall(entry: Entry, command: InterruptRunCommand, acceptedAt: Timestamp): EffectCall {
    const handle = entry.run?.runId === command.runId ? entry.run.handle : undefined;
    const owned = structuredClone(command);
    return {
      deliver: () => {
        if (handle === undefined) {
          return Promise.reject(
            new AgentRuntimeError(
              agentError('provider_contract_violation', `live run \`${command.runId}\` has no provider handle`),
            ),
          );
        }
        return handle.interrupt(command.reason);
      },
      applied: () => ({ kind: 'interrupt', command: owned, delivered: true }),
      rejected: (error) => ({ kind: 'receipt', receipt: rejectedReceipt(owned, providerError(error), acceptedAt) }),
    };
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

  // ---- materialization ------------------------------------------------------------------
  //
  // Each materializer is a deterministic function of the frozen operation and the
  // projection at its ordinal. It checks legality against the transaction view and
  // emits a diagnostic (or nothing) instead of throwing on provider-shaped input, so a
  // provider can never turn its own output into a permanently failing head.

  function record(tx: StoreTransaction, op: EffectOperation<IngressPayload>, receipt: CommandReceipt): void {
    tx.recordReceipt(receipt.commandId, { fingerprint: op.identity.fingerprint, receipt });
  }

  function materializeRequest(
    tx: StoreTransaction,
    sessionId: SessionId,
    runId: RunId,
    payload: Extract<ProviderEventPayload, { type: 'interaction.requested' }>,
    decision: InteractionDecision | undefined,
  ): void {
    if (decision?.kind !== 'request') {
      tx.emit({
        sessionId,
        runId,
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message:
            decision?.kind === 'reused-ref'
              ? `provider reused active interaction reference \`${payload.providerRef}\``
              : `provider interaction reference \`${payload.providerRef}\` could not be routed`,
        },
      });
      return;
    }
    const run = tx.session(sessionId).runs.get(runId);
    if (run === undefined || (run.state !== 'running' && run.state !== 'awaiting_interaction')) {
      tx.emit({
        sessionId,
        runId,
        payload: {
          type: 'diagnostic',
          level: 'warning',
          message: `provider contract violation: emitted \`interaction.requested\` while run was ${run?.state ?? 'unknown'}; the request was rejected`,
        },
      });
      return;
    }
    tx.emit({
      sessionId,
      runId,
      payload: {
        type: 'interaction.requested',
        interactionId: decision.interactionId,
        turnId: run.turnId,
        request: payload.request,
      },
    });
  }

  function materializeWithdrawal(
    tx: StoreTransaction,
    sessionId: SessionId,
    runId: RunId,
    decision: InteractionDecision | undefined,
  ): void {
    // An unknown reference persists nothing, as in the live runtime.
    if (decision?.kind !== 'withdrawal') return;
    const view = tx.session(sessionId);
    const target = view.interactions.get(decision.interactionId);
    const run = view.runs.get(runId);
    // Already settled (by a response ordered ahead of it): the withdrawal cannot displace it.
    if (target?.status !== 'pending' || target.runId !== runId || run === undefined || run.termination !== undefined) {
      return;
    }
    tx.emit({
      sessionId,
      runId,
      payload: {
        type: 'interaction.settled',
        interactionId: decision.interactionId,
        turnId: target.turnId,
        settlement: { outcome: 'withdrawn', settledAt: decision.settledAt },
      },
    });
  }

  function materializeBody(tx: StoreTransaction, sessionId: SessionId, op: BodyOperation<IngressPayload>): void {
    if (op.body.kind !== 'event') throw internal('a provider body must carry a captured event');
    const { event, interaction } = op.body;
    if (materializePlainProviderEvent(tx, { sessionId, op, event })) return;
    if (!event.valid || op.runId === undefined) return;
    const payload = event.input.payload;
    if (payload.type === 'interaction.requested') materializeRequest(tx, sessionId, op.runId, payload, interaction);
    else if (payload.type === 'interaction.withdrawn') materializeWithdrawal(tx, sessionId, op.runId, interaction);
  }

  function materializeStart(
    tx: StoreTransaction,
    sessionId: SessionId,
    op: EffectOperation<IngressPayload>,
    start: IngressStart,
  ): void {
    const { command, turnId, runId, attempt } = start;
    tx.emit({ sessionId, payload: { type: 'turn.started', turnId, input: command.input } });
    const started = tx.emit({ sessionId, runId, payload: { type: 'run.started', turnId, attempt } });
    record(
      tx,
      op,
      appliedReceipt(
        command,
        { type: 'turn_accepted', sessionId, turnId, runId },
        started.sequence,
        op.identity.acceptedAt,
      ),
    );
  }

  function materializeResponse(
    tx: StoreTransaction,
    sessionId: SessionId,
    op: EffectOperation<IngressPayload>,
    response: IngressResponse,
  ): void {
    const { command, runId, settledAt } = response;
    const { interactionId } = command;
    const view = tx.session(sessionId);
    const interaction = view.interactions.get(interactionId);
    const run = view.runs.get(runId);
    if (interaction?.status === 'pending' && interaction.runId === runId && run?.state === 'awaiting_interaction') {
      const settled = tx.emit({
        sessionId,
        runId,
        payload: {
          type: 'interaction.settled',
          interactionId,
          turnId: interaction.turnId,
          settlement: { outcome: 'responded', settledAt, response: command.response },
        },
      });
      record(
        tx,
        op,
        appliedReceipt(
          command,
          { type: 'interaction_settled', sessionId, interactionId },
          settled.sequence,
          op.identity.acceptedAt,
        ),
      );
      return;
    }
    // Unreachable through the FIFO: a reserved response commits ahead of any withdrawal,
    // terminal or later response for its interaction. Record the truth instead of throwing.
    tx.emit({
      sessionId,
      payload: {
        type: 'diagnostic',
        level: 'warning',
        message: `a response delivered to the provider for interaction \`${interactionId}\` could not be recorded: the interaction is ${interaction?.status ?? 'unknown'}`,
      },
    });
    record(
      tx,
      op,
      rejectedReceipt(
        command,
        agentError('interaction_already_settled', `interaction \`${interactionId}\` is settled`),
        op.identity.acceptedAt,
      ),
    );
  }

  function materializeInterrupt(
    tx: StoreTransaction,
    sessionId: SessionId,
    op: EffectOperation<IngressPayload>,
    interrupt: IngressInterrupt,
  ): void {
    const { command, delivered } = interrupt;
    let sequence: Sequence | undefined;
    if (delivered) {
      const run = tx.session(sessionId).runs.get(command.runId);
      if (
        run !== undefined &&
        run.termination === undefined &&
        run.state !== 'interrupting' &&
        canTransition(RUN_STATE_TABLE, run.state, 'interrupting')
      ) {
        sequence = tx.emit({
          sessionId,
          runId: command.runId,
          payload: { type: 'run.state_changed', from: run.state, to: 'interrupting' },
        }).sequence;
      }
    }
    sequence ??= tx.session(sessionId).session.sequence;
    record(
      tx,
      op,
      appliedReceipt(
        command,
        { type: 'run_interrupt_requested', sessionId, runId: command.runId, delivered },
        sequence,
        op.identity.acceptedAt,
      ),
    );
  }

  function materializeEffect(tx: StoreTransaction, sessionId: SessionId, op: EffectOperation<IngressPayload>): void {
    const result = op.result;
    switch (result?.kind) {
      case 'plan':
        result.apply(tx, op);
        return;
      case 'receipt':
        record(tx, op, result.receipt);
        return;
      case 'start':
        materializeStart(tx, sessionId, op, result);
        return;
      case 'response':
        materializeResponse(tx, sessionId, op, result);
        return;
      case 'interrupt':
        materializeInterrupt(tx, sessionId, op, result);
        return;
      default:
        throw internal(`effect slot ${String(op.ordinal)} has no committable result`);
    }
  }

  /**
   * The run's terminal bundle: cancellations of still-pending interactions,
   * `run.finished`, then `turn.settled`, validated against the run state at
   * this ordinal. The frozen intent decides the outcome (an overflow may have
   * failed an unsubmitted success); the frozen timestamp stamps every event.
   */
  function materializeTerminal(
    tx: StoreTransaction,
    sessionId: SessionId,
    op: TerminalOperation<IngressPayload>,
  ): void {
    if (op.closingFirst || op.intent.cause !== 'completion') {
      throw internal('session close is not integrated with provider ingress yet (surface 4)');
    }
    const detail = op.intent.detail;
    if (detail?.kind !== 'termination') throw internal('a completion terminal must carry its termination');
    const { runId, turnId } = op;
    const view = tx.session(sessionId);
    const run = view.runs.get(runId);
    // Exactly one terminal outcome per run.
    if (run === undefined || run.termination !== undefined) return;
    const chosen = detail.termination;
    const intended: RunTermination = op.intent.overflowed
      ? { outcome: 'failed', at: chosen.at, error: overflowError() }
      : chosen;
    const termination: RunTermination = canTransition(RUN_STATE_TABLE, run.state, intended.outcome)
      ? intended
      : {
          outcome: 'failed',
          at: chosen.at,
          error: agentError(
            'provider_contract_violation',
            `provider completed with ${intended.outcome} while run was ${run.state}`,
          ),
        };
    for (const interactionId of run.pendingInteractionIds) {
      const interaction = view.interactions.get(interactionId);
      if (interaction === undefined || interaction.status === 'settled') continue;
      tx.emit({
        sessionId,
        runId,
        payload: {
          type: 'interaction.settled',
          interactionId,
          turnId: interaction.turnId,
          settlement: { outcome: 'cancelled', settledAt: chosen.at },
        },
      });
    }
    tx.emit({ sessionId, runId, payload: { type: 'run.finished', turnId, termination } });
    const output = view.turns.get(turnId)?.output;
    tx.emit({
      sessionId,
      payload: {
        type: 'turn.settled',
        turnId,
        state: turnState(termination.outcome),
        ...(output === undefined ? {} : { output }),
        ...(termination.outcome === 'failed' && termination.error !== undefined ? { error: termination.error } : {}),
      },
    });
  }

  function materialize(tx: StoreTransaction, sessionId: SessionId, op: Operation<IngressPayload>): void {
    switch (op.kind) {
      case 'body':
        materializeBody(tx, sessionId, op);
        return;
      case 'effect':
        materializeEffect(tx, sessionId, op);
        return;
      case 'terminal':
        materializeTerminal(tx, sessionId, op);
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
        witness.created = Object.freeze(structuredClone(session));
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
        witness.receiptValue = record.receipt;
      },
      findReceipt: (commandId) => tx.findReceipt(commandId),
    };
  }

  /** Commit one head. Resolves `true` when the chain may continue; never rejects. */
  async function submit(entry: Entry, op: Operation<IngressPayload>): Promise<boolean> {
    const sessionId = entry.s.sessionId;
    const witness: Witness = {
      ran: false,
      threw: false,
      events: [],
      receipt: undefined,
      receiptValue: undefined,
      created: undefined,
    };
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
    if (witness.created !== undefined) entry.initialSession = witness.created;
    const last = events.at(-1);
    if (last !== undefined) entry.lastSequence = last.sequence;
    if (advanced.publish && events.length > 0) hub.publish(sessionId, events);
    syncRun(entry);
    settleWaiters(entry, op, witness.receiptValue);
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

    if (options.storeContract !== 'linearizable') return reconciled(entry, op, 'unknown', [], witness);
    // The transaction never ran, or its mutate threw: the contract guarantees nothing applied.
    if (!witness.ran || witness.threw) return reconciled(entry, op, 'absent', [], witness);

    // Wake subscribers and return waiting command attempts at A, before reconciliation I/O.
    noteFault(entry);
    failWaiters(entry);
    const { verdict, envelopes } = await readBack(entry, sequenceBefore, witness);
    if (verdict === 'applied' && witness.created !== undefined) entry.initialSession = witness.created;
    return reconciled(entry, op, verdict, envelopes, witness);
  }

  function reconciled(
    entry: Entry,
    op: Operation<IngressPayload>,
    verdict: Verdict,
    envelopes: readonly EventEnvelope[],
    witness: Witness,
  ): boolean {
    const result = advanceHead(entry.s, { kind: 'reconciled', ordinal: op.ordinal, verdict });
    if (result.kind === 'advanced') {
      const last = envelopes.at(-1);
      if (last !== undefined) entry.lastSequence = last.sequence;
      // Publish the read-back envelopes once; never append another copy.
      if (result.publish && envelopes.length > 0) hub.publish(entry.s.sessionId, envelopes);
      syncRun(entry);
      settleWaiters(entry, op, witness.receiptValue);
      noteFault(entry);
      return true;
    }
    noteFault(entry);
    failWaiters(entry);
    return false;
  }

  /**
   * Replay the authoritative log through `through` onto the created session record,
   * exactly as the store folds it (sequence stamped, then `applyEvent`). Returns the
   * canonical projection digest, or `undefined` if the log is gapped, short or rejected
   * by the fold. Only reached on the rare reconciliation path.
   */
  async function foldLog(sessionId: SessionId, initial: AgentSession, through: Sequence): Promise<string | undefined> {
    const record: SessionRecord = {
      session: structuredClone(initial),
      turns: new Map(),
      runs: new Map(),
      interactions: new Map(),
      events: [],
    };
    let cursor = 0;
    while (cursor < through) {
      const page = await store.readEvents(sessionId, cursor as Sequence, through - cursor);
      if (page.events.length === 0) return undefined;
      for (const event of page.events) {
        if (event.sequence !== cursor + 1 || event.sequence > through) return undefined;
        record.session = { ...record.session, sequence: event.sequence };
        applyEvent(record, event);
        cursor = event.sequence;
      }
    }
    return recordProjection(record);
  }

  /**
   * Read-after-failure at the captured position. Applied only when every witnessed
   * envelope matches by id, sequence and payload AND the snapshot stands at exactly the
   * last witnessed sequence AND its projection equals the fold of the authoritative log
   * (from the session's created record) through that sequence (ADR-0004). Absent only
   * when no envelope is present and the snapshot sequence is unchanged. Anything else,
   * including any failed read, is unknown (permanent A).
   */
  async function readBack(
    entry: Entry,
    sequenceBefore: Sequence,
    witness: Witness,
  ): Promise<{ verdict: Verdict; envelopes: readonly EventEnvelope[] }> {
    const sessionId = entry.s.sessionId;
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
          // Matching envelopes alone do not certify application. The authoritative snapshot
          // must stand at exactly the witnessed sequence (this session's head is blocked, so
          // nothing else can have applied) and equal the projection its log folds to.
          const last = witness.events.at(-1);
          const initial = witness.created ?? entry.initialSession;
          const snapshot = await store.read(sessionId);
          if (last === undefined || initial === undefined || snapshot?.session.sequence !== last.sequence) {
            return unknown;
          }
          const folded = await foldLog(sessionId, initial, last.sequence);
          if (folded === undefined || folded !== snapshotProjection(snapshot)) return unknown;
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
        initialSession: undefined,
        run: undefined,
        waiters: new Map(),
        invocations: new Map(),
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

    reserveRun: (sessionId, input) => reserveRun(requireEntry(sessionId), input),

    settleStart(sessionId, ordinal, outcome) {
      if (settleStart(requireEntry(sessionId), ordinal, outcome) === 'stale') {
        throw internal(`ordinal ${String(ordinal)} is not a pending start`);
      }
    },

    async submitTurn(sessionId, input) {
      const entry = requireEntry(sessionId);
      const admission = await admit(entry, input.command);
      if (admission.kind === 'done') return admission.outcome;
      if (admission.kind === 'pending') return retryCommand(entry, admission.op, undefined);
      const reserved = reserveRun(entry, input);
      if (reserved.kind === 'refused') return refusal(entry, input.command, reserved.reason);
      if (reserved.kind === 'existing') {
        const op = pendingCommand(entry, input.command.commandId);
        if (op === undefined) throw internal(`start ${String(reserved.ordinal)} vanished`);
        return retryCommand(entry, op, undefined);
      }
      // Reserved: the provider is called only now, and its outcome fills this same slot.
      const { ordinal } = reserved;
      const request: ProviderRunRequest = { input: input.command.input, sink: reserved.sink, runRef: input.runId };
      const invocation = invoke(() => input.startRun(request)).then(
        (handle) => settleStart(entry, ordinal, { kind: 'applied', run: handle }),
        (error: unknown) => settleStart(entry, ordinal, { kind: 'rejected', error }),
      );
      entry.invocations.set(ordinal, invocation);
      const clear = (): void => {
        if (entry.invocations.get(ordinal) === invocation) entry.invocations.delete(ordinal);
      };
      invocation.then(clear, clear);
      return slotOutcome(entry, ordinal, invocation, false);
    },

    completeRun,

    async respondToInteraction(sessionId, input) {
      const entry = requireEntry(sessionId);
      const { command, acceptedAt, deliver } = input;
      const admission = await admit(entry, command);
      if (admission.kind === 'done') return admission.outcome;
      if (admission.kind === 'pending') {
        return retryCommand(
          entry,
          admission.op,
          responseCall(entry, command, admission.op.identity.acceptedAt, deliver),
        );
      }
      const run = entry.run;
      const target = run?.routes.get(command.interactionId);
      if (run === undefined || target === undefined) return { kind: 'refused', reason: 'interaction-unrouted' };
      // The provider withdrew it: no response may reach the provider after that.
      if (target.withdrawn) return { kind: 'refused', reason: 'interaction-withdrawn' };
      const reserved = reserveEffect(entry.s, {
        effect: 'response',
        identity: identityOf(command, acceptedAt),
        runId: run.runId,
        subject: command.interactionId,
      });
      if (reserved.kind === 'refused') return refusal(entry, command, reserved.reason);
      const call = responseCall(entry, command, acceptedAt, deliver);
      if (reserved.kind === 'existing') return retryCommand(entry, reserved.op, call);
      if (call === undefined) throw internal(`interaction \`${command.interactionId}\` lost its route`);
      return slotOutcome(entry, reserved.ordinal, startEffect(entry, reserved.ordinal, call), false);
    },

    async interruptRun(sessionId, input) {
      const entry = requireEntry(sessionId);
      const { command, acceptedAt } = input;
      const admission = await admit(entry, command);
      if (admission.kind === 'done') return admission.outcome;
      if (admission.kind === 'pending') {
        return retryCommand(entry, admission.op, interruptCall(entry, command, admission.op.identity.acceptedAt));
      }
      const reserved = reserveEffect(entry.s, {
        effect: 'interrupt',
        identity: identityOf(command, acceptedAt),
        runId: command.runId,
      });
      if (reserved.kind === 'refused') return refusal(entry, command, reserved.reason);
      if (reserved.kind === 'existing') {
        return retryCommand(entry, reserved.op, interruptCall(entry, command, reserved.op.identity.acceptedAt));
      }
      if (!reserved.deliver) {
        // The run's one interrupt is already in flight or observed: never call the provider again.
        const owned = structuredClone(command);
        fillEffect(entry, reserved.ordinal, {
          kind: 'applied',
          result: { kind: 'interrupt', command: owned, delivered: false },
        });
        return slotOutcome(entry, reserved.ordinal, undefined, false);
      }
      return slotOutcome(
        entry,
        reserved.ordinal,
        startEffect(entry, reserved.ordinal, interruptCall(entry, command, acceptedAt)),
        false,
      );
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

    bookkeeping(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return undefined;
      let waiters = 0;
      for (const list of entry.waiters.values()) waiters += list.length;
      return {
        run: entry.run !== undefined,
        routes: entry.run?.routes.size ?? 0,
        waiters,
        invocations: entry.invocations.size,
      };
    },
  };
}
