/**
 * Session ingestion: one ordered FIFO per session and one ownership record per
 * run, shared by provider sinks, pre-effect command reservations, terminal
 * selection and session cleanup (issue #43, design v2, surface 1).
 *
 * SHADOW MODE. Nothing in `runtime.ts` consumes this module yet, and it is not
 * exported from the package entry point. Current runtime behavior is unchanged
 * until the reviewed integration surfaces switch ingress over atomically.
 *
 * Every transition is synchronous and effect-free: it performs no I/O, awaits
 * nothing and reads no clock or id factory. It updates the session record in
 * place and returns a decision; the caller performs the provider, workspace or
 * store effect and reports its outcome back through another transition. That
 * keeps a provider `emit()` O(1) and lets every interleaving be replayed
 * deterministically in tests.
 *
 * The mutating transitions are exactly `reserveStart`, `acceptEvent`,
 * `reserveEffect`, `settleEffect`, `chooseTerminal`, `advanceHead`,
 * `beginCleanup` and `retire`. `runPhase` and `ingestionFault` are queries.
 *
 * Ownership is deliberately single: the FIFO owns every accepted operation and
 * its ordinal; the run record owns only facts about the one active or starting
 * run; the close record owns session cleanup. There are no per-run or per-turn
 * maps, so a retired run leaves nothing behind except the small immutable
 * fence its sink captured. Accepted operations are frozen; a reservation is
 * filled by replacing its entry with a new frozen entry at the same ordinal.
 *
 * Process-local only: none of this is crash-durable. Issue #6 owns durable
 * claims and reconciliation beyond one runtime instance.
 */

import type { CommandId, EventId, RunId, Sequence, SessionId, Timestamp, TurnId } from '@relvo-labs/agent-protocol';

/** Nonterminal operations a session may retain, including its in-flight head and reservations. */
export const SESSION_OPERATION_LIMIT = 1023;
/** Per-sink guard before the owning open/start commits; counted inside the session budget. */
export const PRE_ACTIVATION_LIMIT = 256;
/** Recoverable failure counts saturate here instead of growing without bound. */
export const FAILURE_COUNT_CEILING = 0x7fff_ffff;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type CommandIdentity = Readonly<{
  commandId: CommandId;
  fingerprint: string;
  acceptedAt: Timestamp;
}>;

/** Immutable token captured by a run sink. A retired run keeps nothing else. */
export type RunSinkFence = Readonly<{ runId: RunId; epoch: number }>;

export type InteractionRole = 'none' | 'request' | 'withdrawal';

export type EffectKind = 'open' | 'start' | 'response' | 'interrupt';

/** `pending`/`unknown` are unresolved; `applied`/`rejected` are filled. */
export type EffectState = 'pending' | 'unknown' | 'applied' | 'rejected';

export type TerminalOutcome = 'succeeded' | 'failed' | 'interrupted';

export type TerminalIntent<T> = Readonly<{
  outcome: TerminalOutcome;
  /** `completion` is the provider's own outcome; `close` is the truthful cleanup fallback. */
  cause: 'completion' | 'close';
  /** Opaque caller payload, such as the parsed provider termination. */
  detail?: T;
  /** An overflow turned this unsubmitted success into a failure. */
  overflowed: boolean;
}>;

export type BodyOperation<T> = Readonly<{
  kind: 'body';
  ordinal: number;
  source: 'session' | 'run';
  runId?: RunId;
  role: InteractionRole;
  subject?: string;
  /** An interaction request accepted after its run was fenced: persist it as a diagnostic. */
  demoted: boolean;
  body: T;
}>;

export type EffectOperation<T> = Readonly<{
  kind: 'effect';
  ordinal: number;
  effect: EffectKind;
  identity: CommandIdentity;
  runId?: RunId;
  subject?: string;
  state: EffectState;
  /** Applied bundle or rejected receipt; absent while unresolved. */
  result?: T;
}>;

export type TerminalOperation<T> = Readonly<{
  kind: 'terminal';
  ordinal: number;
  runId: RunId;
  turnId: TurnId;
  intent: TerminalIntent<T>;
  /** Close selected this unsubmitted terminal: persist `closing` first in the same bundle. */
  closingFirst: boolean;
}>;

export type ClosingOperation = Readonly<{ kind: 'closing'; ordinal: number }>;

export type ClosedOperation = Readonly<{
  kind: 'closed';
  ordinal: number;
  /** Absent for shutdown's internal close, which records no caller receipt. */
  identity?: CommandIdentity;
  interruptedActiveRun: boolean;
}>;

export type Operation<T> =
  BodyOperation<T> | EffectOperation<T> | TerminalOperation<T> | ClosingOperation | ClosedOperation;

/** What a commit callback observed, kept for read-after-failure reconciliation. */
export type CommitWitness = Readonly<{
  sequenceBefore: Sequence;
  events: readonly Readonly<{ eventId: EventId; sequence: Sequence }>[];
  receipt?: Readonly<{ commandId: CommandId; fingerprint: string }>;
}>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type PhaseState = 'idle' | 'in-flight' | 'succeeded' | 'failed';

export type CleanupPhase = 'interrupt' | 'dispose' | 'release';

export type RunTerminal<T> =
  | Readonly<{ state: 'intent'; intent: TerminalIntent<T> }>
  | Readonly<{ state: 'placed' | 'submitted'; ordinal: number }>;

/** The one active or starting run. Deleted when its terminal commits or its start rejects. */
export type RunLifecycle<T> = {
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly attempt: number;
  readonly epoch: number;
  readonly startOrdinal: number;
  /** `applied`: provider handle exists, start bundle not yet committed. */
  start: 'pending' | 'applied' | 'committed';
  /** Run-sink bodies accepted before the start committed. */
  staged: number;
  /** No fresh effects; interaction requests are demoted. */
  fenced: boolean;
  terminal: RunTerminal<T> | undefined;
  /** This run's effect reservations not yet filled. */
  unresolved: number;
  interrupt: PhaseState;
};

export type CloseState = {
  identity: CommandIdentity | undefined;
  closingQueued: boolean;
  closedQueued: boolean;
  dispose: PhaseState;
  release: PhaseState;
  interruptedActiveRun: boolean;
};

export type HeadState = {
  readonly ordinal: number;
  status: 'in-flight' | 'failed' | 'ambiguous';
  published: boolean;
};

export type Faults = {
  /** A: a commit outcome is unknown; the head is never resubmitted while this is set. */
  ambiguous: { readonly ordinal: number; permanent: boolean; readonly witness?: CommitWitness } | undefined;
  /** O: history is incomplete. `provisionalRun` means only that unowned run's staging overflowed. */
  overflow: { provisionalRun: RunId | undefined } | undefined;
  /** F: the head was proven unapplied and may be retried unchanged. */
  failure: { readonly ordinal: number; count: number } | undefined;
};

export type SessionIngestion<T> = {
  readonly sessionId: SessionId;
  state: 'opening' | 'open' | 'closed' | 'discarded';
  nextOrdinal: number;
  readonly queue: Operation<T>[];
  /** Body and effect operations in the queue; never exceeds the session limit. */
  counted: number;
  head: HeadState | undefined;
  /** Session-sink bodies accepted before `session.opened` committed. */
  staged: number;
  epoch: number;
  run: RunLifecycle<T> | undefined;
  faults: Faults;
  close: CloseState | undefined;
};

export type RunPhase = 'S' | 'R' | 'E' | 'T' | 'X';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type RefusalReason =
  | 'session-not-open'
  | 'session-ended'
  | 'closing'
  | 'busy'
  | 'run-active'
  | 'run-not-active'
  | 'head-blocked'
  | 'overflowed'
  | 'capacity'
  | 'command-conflict'
  | 'subject-busy'
  | 'not-reserved'
  | 'not-head';

export type Refusal = Readonly<{ kind: 'refused'; reason: RefusalReason }>;

export type CleanupStep =
  | Readonly<{ kind: 'attempt'; phase: CleanupPhase }>
  | Readonly<{ kind: 'stopped'; pending?: 'start' | 'effect' | 'in-flight'; failed: readonly CleanupPhase[] }>
  | Readonly<{ kind: 'complete'; closed: 'queued' | 'awaiting-history' }>;

/** An exact retry shares the reservation; a changed payload under the same ID conflicts. */
export type IdentityMatch<T> = Refusal | Readonly<{ kind: 'existing'; op: EffectOperation<T> }>;

export type ReserveResult<T> = IdentityMatch<T> | Readonly<{ kind: 'reserved'; ordinal: number }>;

export type StartResult<T> = IdentityMatch<T> | Readonly<{ kind: 'reserved'; ordinal: number; fence: RunSinkFence }>;

export type AcceptResult =
  | Readonly<{ kind: 'accepted'; ordinal: number; demoted: boolean }>
  | Readonly<{ kind: 'discarded'; reason: 'stale-sink' | 'post-terminal' | 'session-ended' }>
  | Readonly<{ kind: 'refused'; reason: 'overflow' | 'activation-overflow' | 'overflowed'; interrupt?: RunId }>;

/** `next`, when present, is the cleanup call an admitted close may make now. */
export type SettleResult =
  | Readonly<{ kind: 'refused'; reason: 'not-reserved'; next?: undefined }>
  | Readonly<{ kind: 'filled' | 'unresolved' | 'recorded' | 'ignored' | 'discarded'; next?: CleanupStep }>;

export type HeadResult<T> =
  | Refusal
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'blocked'; reason: 'in-flight' | 'ambiguous' | 'faulted' | 'awaiting-effect' }>
  | Readonly<{ kind: 'submit'; op: Operation<T> }>
  | Readonly<{ kind: 'advanced'; op: Operation<T>; publish: boolean }>
  | Readonly<{ kind: 'reconcile'; op: Operation<T>; witness?: CommitWitness }>
  | Readonly<{ kind: 'faulted'; op: Operation<T>; failureCount: number }>
  | Readonly<{ kind: 'fail-closed'; op: Operation<T> }>;

export type IngestionFaultView = Readonly<{
  kind: 'ambiguous' | 'overflow' | 'failure';
  retryable: boolean;
  permanent: boolean;
  ordinal?: number;
  failureCount?: number;
}>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isCounted<T>(op: Operation<T>): boolean {
  return op.kind === 'body' || op.kind === 'effect';
}

function enqueue<T>(s: SessionIngestion<T>, build: (ordinal: number) => Operation<T>): Operation<T> {
  const op = Object.freeze(build(s.nextOrdinal));
  s.nextOrdinal += 1;
  s.queue.push(op);
  if (isCounted(op)) s.counted += 1;
  return op;
}

function indexOf<T>(s: SessionIngestion<T>, ordinal: number): number {
  return s.queue.findIndex((op) => op.ordinal === ordinal);
}

/** Replace an unsubmitted entry with a new frozen entry at the same ordinal. */
function replace<T>(s: SessionIngestion<T>, index: number, op: Operation<T>): Operation<T> {
  const frozen = Object.freeze(op);
  s.queue[index] = frozen;
  return frozen;
}

function findCommand<T>(s: SessionIngestion<T>, commandId: CommandId): EffectOperation<T> | undefined {
  for (const op of s.queue) if (op.kind === 'effect' && op.identity.commandId === commandId) return op;
  return undefined;
}

function matchIdentity<T>(s: SessionIngestion<T>, identity: CommandIdentity): IdentityMatch<T> | undefined {
  const existing = findCommand(s, identity.commandId);
  if (existing === undefined) return undefined;
  return existing.identity.fingerprint === identity.fingerprint
    ? { kind: 'existing', op: existing }
    : { kind: 'refused', reason: 'command-conflict' };
}

function isUnresolved(state: EffectState): boolean {
  return state === 'pending' || state === 'unknown';
}

function isCurrent<T>(s: SessionIngestion<T>, fence: RunSinkFence): RunLifecycle<T> | undefined {
  const run = s.run;
  return run?.runId === fence.runId && run.epoch === fence.epoch ? run : undefined;
}

function hasPlacedTerminal<T>(run: RunLifecycle<T>): boolean {
  return run.terminal !== undefined && run.terminal.state !== 'intent';
}

/** Record an overflow. Only a pending start's own sink can make it provisional. */
function noteOverflow<T>(s: SessionIngestion<T>, source: 'session' | RunLifecycle<T>): void {
  const provisional = source !== 'session' && source.start === 'pending' ? source.runId : undefined;
  const current = s.faults.overflow;
  if (current === undefined) {
    s.faults.overflow = { provisionalRun: provisional };
  } else if (current.provisionalRun !== provisional) {
    current.provisionalRun = undefined;
  }
}

/** Fail an unsubmitted success intent: overflow made its history incomplete. */
function overflowIntent<T>(intent: TerminalIntent<T>): TerminalIntent<T> {
  return intent.outcome === 'succeeded' ? { ...intent, outcome: 'failed', overflowed: true } : intent;
}

function refuseOverflow<T>(
  s: SessionIngestion<T>,
  source: 'session' | RunLifecycle<T>,
  reason: 'overflow' | 'activation-overflow' | 'overflowed',
): AcceptResult {
  noteOverflow(s, source);
  const run = s.run;
  if (run === undefined) return { kind: 'refused', reason };
  run.fenced = true;
  const terminal = run.terminal;
  if (terminal?.state === 'intent') {
    run.terminal = { state: 'intent', intent: overflowIntent(terminal.intent) };
  } else if (terminal?.state === 'placed') {
    const index = indexOf(s, terminal.ordinal);
    const op = s.queue[index];
    if (op?.kind === 'terminal') replace(s, index, { ...op, intent: overflowIntent(op.intent) });
  }
  // Interrupt once, and only a run whose provider handle exists and has not completed.
  if (terminal === undefined && run.start !== 'pending' && run.interrupt === 'idle') {
    run.interrupt = 'in-flight';
    return { kind: 'refused', reason, interrupt: run.runId };
  }
  return { kind: 'refused', reason };
}

function placeTerminal<T>(s: SessionIngestion<T>): void {
  const run = s.run;
  if (run?.terminal?.state !== 'intent' || run.start === 'pending' || run.unresolved > 0) return;
  const { intent } = run.terminal;
  const placed = enqueue(s, (ordinal) => ({
    kind: 'terminal',
    ordinal,
    runId: run.runId,
    turnId: run.turnId,
    intent,
    closingFirst: false,
  }));
  run.terminal = { state: 'placed', ordinal: placed.ordinal };
  queueClosed(s);
}

function selectTerminal<T>(s: SessionIngestion<T>, run: RunLifecycle<T>, intent: TerminalIntent<T>): void {
  run.terminal = {
    state: 'intent',
    intent: s.faults.overflow === undefined ? intent : overflowIntent(intent),
  };
  run.fenced = true;
  placeTerminal(s);
}

/** Close proved the provider run ended: choose the interrupted fallback once. */
function closeFallback<T>(s: SessionIngestion<T>): void {
  const run = s.run;
  const close = s.close;
  if (run === undefined || close === undefined || run.terminal !== undefined || run.start === 'pending') return;
  close.interruptedActiveRun = true;
  selectTerminal(s, run, { outcome: 'interrupted', cause: 'close', overflowed: false });
}

function queueClosing<T>(s: SessionIngestion<T>, close: CloseState): void {
  if (close.closingQueued) return;
  close.closingQueued = true;
  const terminal = s.run?.terminal;
  if (terminal?.state === 'placed') {
    const index = indexOf(s, terminal.ordinal);
    const op = s.queue[index];
    if (op?.kind === 'terminal') {
      replace(s, index, { ...op, closingFirst: true });
      return;
    }
  }
  enqueue(s, (ordinal) => ({ kind: 'closing', ordinal }));
}

/** `session.closed` follows real cleanup and the run's terminal, never precedes them. */
function queueClosed<T>(s: SessionIngestion<T>): void {
  const close = s.close;
  if (close === undefined || close.closedQueued || close.dispose !== 'succeeded' || close.release !== 'succeeded') {
    return;
  }
  if (s.run !== undefined && !hasPlacedTerminal(s.run)) return;
  close.closedQueued = true;
  const { identity, interruptedActiveRun } = close;
  enqueue(s, (ordinal) => ({
    kind: 'closed',
    ordinal,
    ...(identity === undefined ? {} : { identity }),
    interruptedActiveRun,
  }));
}

function pendingProviderUse<T>(s: SessionIngestion<T>): 'start' | 'effect' | undefined {
  if (s.run?.start === 'pending') return 'start';
  for (const op of s.queue) {
    if (op.kind === 'effect' && op.effect === 'response' && isUnresolved(op.state)) return 'effect';
  }
  return undefined;
}

function interruptNeeded<T>(s: SessionIngestion<T>, close: CloseState): RunLifecycle<T> | undefined {
  const run = s.run;
  if (run === undefined || run.start === 'pending' || run.terminal !== undefined) return undefined;
  if (run.interrupt === 'succeeded' || close.dispose === 'succeeded') return undefined;
  return run;
}

const CLEANUP_ORDER: readonly CleanupPhase[] = ['interrupt', 'dispose', 'release'];

/**
 * Next cleanup call for this attempt, in order, after `after`. Marks the
 * returned phase in flight. Only an `idle` phase is attempted: succeeded and
 * in-flight calls are never reissued, and a failed call waits for an explicit
 * close retry (`beginCleanup` re-arms it). Independent phases continue after a
 * failure; release is attempted only after confirmed disposal.
 */
function nextCleanup<T>(s: SessionIngestion<T>, close: CloseState, after?: CleanupPhase): CleanupStep {
  const start = after === undefined ? 0 : CLEANUP_ORDER.indexOf(after) + 1;
  for (const phase of CLEANUP_ORDER.slice(start)) {
    if (phase === 'interrupt') {
      const run = interruptNeeded(s, close);
      if (run?.interrupt !== 'idle') continue;
      run.interrupt = 'in-flight';
      return { kind: 'attempt', phase };
    }
    if (phase === 'dispose') {
      if (close.dispose === 'succeeded') continue;
      if (close.dispose === 'in-flight') return stopped(s, close, 'in-flight');
      if (close.dispose === 'failed') return stopped(s, close);
      const pending = pendingProviderUse(s);
      if (pending !== undefined) return stopped(s, close, pending);
      close.dispose = 'in-flight';
      return { kind: 'attempt', phase };
    }
    if (close.release === 'succeeded') continue;
    if (close.release === 'in-flight') return stopped(s, close, 'in-flight');
    if (close.release === 'failed' || close.dispose !== 'succeeded') return stopped(s, close);
    close.release = 'in-flight';
    return { kind: 'attempt', phase };
  }
  if (close.dispose === 'succeeded' && close.release === 'succeeded') {
    return { kind: 'complete', closed: close.closedQueued ? 'queued' : 'awaiting-history' };
  }
  return stopped(s, close);
}

function stopped<T>(
  s: SessionIngestion<T>,
  close: CloseState,
  pending?: 'start' | 'effect' | 'in-flight',
): CleanupStep {
  const failed: CleanupPhase[] = [];
  if (s.run?.interrupt === 'failed' && interruptNeeded(s, close) !== undefined) failed.push('interrupt');
  if (close.dispose === 'failed') failed.push('dispose');
  if (close.release === 'failed') failed.push('release');
  return pending === undefined ? { kind: 'stopped', failed } : { kind: 'stopped', pending, failed };
}

/** Continue an admitted close after an effect it was waiting on settled. */
function continueCleanup<T>(s: SessionIngestion<T>): CleanupStep | undefined {
  const close = s.close;
  if (close === undefined) return undefined;
  const step = nextCleanup(s, close);
  return step.kind === 'attempt' ? step : undefined;
}

/** Delete the run record. Its sinks keep only their immutable fence. */
function retireRun<T>(s: SessionIngestion<T>): void {
  s.run = undefined;
}

function removeRunStaging<T>(s: SessionIngestion<T>, runId: RunId): void {
  for (let index = s.queue.length - 1; index >= 0; index -= 1) {
    const op = s.queue[index];
    if (op?.kind === 'body' && op.source === 'run' && op.runId === runId) {
      s.queue.splice(index, 1);
      s.counted -= 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Construction and queries
// ---------------------------------------------------------------------------

/** A session's FIFO starts with the reservation for its own open effect at ordinal 0. */
export function createSessionIngestion<T>(sessionId: SessionId, open: CommandIdentity): SessionIngestion<T> {
  const s: SessionIngestion<T> = {
    sessionId,
    state: 'opening',
    nextOrdinal: 0,
    queue: [],
    counted: 0,
    head: undefined,
    staged: 0,
    epoch: 0,
    run: undefined,
    faults: { ambiguous: undefined, overflow: undefined, failure: undefined },
    close: undefined,
  };
  enqueue(s, (ordinal) => ({ kind: 'effect', ordinal, effect: 'open', identity: open, state: 'pending' }));
  return s;
}

/** S until the start bundle commits, then T once a terminal is placed, E while fenced, else R. */
export function runPhase<T>(s: SessionIngestion<T>): RunPhase {
  const run = s.run;
  if (run === undefined) return 'X';
  if (run.start !== 'committed') return 'S';
  if (hasPlacedTerminal(run)) return 'T';
  if (run.fenced || run.terminal !== undefined) return 'E';
  return 'R';
}

/** One entry per session with precedence A > O > F. Only F alone is retryable. */
export function ingestionFault<T>(s: SessionIngestion<T>): IngestionFaultView | undefined {
  const { ambiguous, overflow, failure } = s.faults;
  if (ambiguous !== undefined) {
    return { kind: 'ambiguous', retryable: false, permanent: ambiguous.permanent, ordinal: ambiguous.ordinal };
  }
  if (overflow !== undefined) {
    return { kind: 'overflow', retryable: false, permanent: overflow.provisionalRun === undefined };
  }
  if (failure !== undefined) {
    return {
      kind: 'failure',
      retryable: true,
      permanent: false,
      ordinal: failure.ordinal,
      failureCount: failure.count,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Allocate the run record and reserve the start bundle's ordinal and slot
 * before the provider `startRun()` is called. Every run-sink emission is
 * therefore ordered after its owning start.
 */
export function reserveStart<T>(
  s: SessionIngestion<T>,
  input: Readonly<{ runId: RunId; turnId: TurnId; attempt: number; identity: CommandIdentity }>,
): StartResult<T> {
  const matched = matchIdentity(s, input.identity);
  if (matched !== undefined) return matched;
  if (s.state !== 'open')
    return { kind: 'refused', reason: s.state === 'opening' ? 'session-not-open' : 'session-ended' };
  if (s.close !== undefined) return { kind: 'refused', reason: 'closing' };
  if (s.run !== undefined) return { kind: 'refused', reason: 'run-active' };
  if (s.faults.overflow !== undefined) return { kind: 'refused', reason: 'overflowed' };
  if (s.faults.ambiguous !== undefined || s.faults.failure !== undefined) {
    return { kind: 'refused', reason: 'head-blocked' };
  }
  if (s.counted >= SESSION_OPERATION_LIMIT) return { kind: 'refused', reason: 'capacity' };

  const reserved = enqueue(s, (ordinal) => ({
    kind: 'effect',
    ordinal,
    effect: 'start',
    identity: input.identity,
    runId: input.runId,
    state: 'pending',
  }));
  s.epoch += 1;
  s.run = {
    runId: input.runId,
    turnId: input.turnId,
    attempt: input.attempt,
    epoch: s.epoch,
    startOrdinal: reserved.ordinal,
    start: 'pending',
    staged: 0,
    fenced: false,
    terminal: undefined,
    unresolved: 0,
    interrupt: 'idle',
  };
  const fence: RunSinkFence = Object.freeze({ runId: input.runId, epoch: s.epoch });
  return { kind: 'reserved', ordinal: reserved.ordinal, fence };
}

/**
 * Accept one captured provider emission. A stale or post-terminal run sink is
 * discarded before counting; excess is refused before acceptance and marks O.
 */
export function acceptEvent<T>(
  s: SessionIngestion<T>,
  source: 'session' | RunSinkFence,
  body: T,
  options: Readonly<{ role?: InteractionRole; subject?: string }> = {},
): AcceptResult {
  if (s.state === 'closed' || s.state === 'discarded' || s.close?.closedQueued === true) {
    return { kind: 'discarded', reason: 'session-ended' };
  }
  let run: RunLifecycle<T> | undefined;
  if (source !== 'session') {
    run = isCurrent(s, source);
    if (run === undefined) return { kind: 'discarded', reason: 'stale-sink' };
    if (hasPlacedTerminal(run)) return { kind: 'discarded', reason: 'post-terminal' };
  }
  const origin = run ?? 'session';
  if (s.faults.overflow !== undefined) return refuseOverflow(s, origin, 'overflowed');
  const preActivation = run === undefined ? s.state === 'opening' : run.start !== 'committed';
  const staged = run === undefined ? s.staged : run.staged;
  if (preActivation && staged >= PRE_ACTIVATION_LIMIT) return refuseOverflow(s, origin, 'activation-overflow');
  if (s.counted >= SESSION_OPERATION_LIMIT) return refuseOverflow(s, origin, 'overflow');

  const role = options.role ?? 'none';
  const demoted = role === 'request' && run !== undefined && (run.fenced || run.terminal !== undefined);
  const subject = options.subject;
  const op = enqueue(s, (ordinal) => ({
    kind: 'body',
    ordinal,
    source: run === undefined ? 'session' : 'run',
    ...(run === undefined ? {} : { runId: run.runId }),
    role,
    ...(subject === undefined ? {} : { subject }),
    demoted,
    body,
  }));
  if (preActivation) {
    if (run === undefined) s.staged += 1;
    else run.staged += 1;
  }
  return { kind: 'accepted', ordinal: op.ordinal, demoted };
}

/**
 * Reserve command identity, ordinal and one slot before a provider response or
 * interrupt call. Filling it later never takes a second slot.
 */
export function reserveEffect<T>(
  s: SessionIngestion<T>,
  input: Readonly<{ effect: 'response' | 'interrupt'; identity: CommandIdentity; runId: RunId; subject?: string }>,
): ReserveResult<T> {
  const matched = matchIdentity(s, input.identity);
  if (matched !== undefined) return matched;
  if (s.state !== 'open')
    return { kind: 'refused', reason: s.state === 'opening' ? 'session-not-open' : 'session-ended' };
  if (s.close !== undefined) return { kind: 'refused', reason: 'closing' };
  if (s.faults.overflow !== undefined) return { kind: 'refused', reason: 'overflowed' };
  const run = s.run;
  if (run?.runId !== input.runId || run.start !== 'committed' || hasPlacedTerminal(run)) {
    return { kind: 'refused', reason: 'run-not-active' };
  }
  if (input.effect === 'response' && (run.fenced || run.terminal !== undefined)) {
    return { kind: 'refused', reason: 'run-not-active' };
  }
  const subject = input.subject;
  if (subject !== undefined) {
    // A withdrawal ordered ahead, or a response not definitely rejected, already owns this interaction.
    const busy = s.queue.some(
      (op) =>
        (op.kind === 'body' && op.subject === subject && op.role === 'withdrawal') ||
        (op.kind === 'effect' && op.subject === subject && op.state !== 'rejected'),
    );
    if (busy) return { kind: 'refused', reason: 'subject-busy' };
  }
  if (s.counted >= SESSION_OPERATION_LIMIT) return { kind: 'refused', reason: 'capacity' };

  const reserved = enqueue(s, (ordinal) => ({
    kind: 'effect',
    ordinal,
    effect: input.effect,
    identity: input.identity,
    runId: input.runId,
    ...(subject === undefined ? {} : { subject }),
    state: 'pending',
  }));
  run.unresolved += 1;
  return { kind: 'reserved', ordinal: reserved.ordinal };
}

export type EffectOutcome<T> =
  Readonly<{ kind: 'applied'; result: T }> | Readonly<{ kind: 'rejected'; result: T }> | Readonly<{ kind: 'unknown' }>;

/**
 * Report a provider/workspace effect outcome: either fill a reserved FIFO slot
 * or record one cleanup phase. A result for an ordinal that was never reserved
 * is refused, so no effect can be admitted only after it happened.
 */
export function settleEffect<T>(
  s: SessionIngestion<T>,
  input:
    | Readonly<{ ordinal: number; outcome: EffectOutcome<T> }>
    | Readonly<{ cleanup: CleanupPhase; outcome: 'succeeded' | 'failed' }>,
): SettleResult {
  if ('cleanup' in input) return settleCleanup(s, input.cleanup, input.outcome);

  const index = indexOf(s, input.ordinal);
  const op = s.queue[index];
  if (op?.kind !== 'effect' || !isUnresolved(op.state)) return { kind: 'refused', reason: 'not-reserved' };
  const outcome = input.outcome;
  if (outcome.kind === 'unknown') {
    replace(s, index, { ...op, state: 'unknown' });
    return { kind: 'unresolved' };
  }
  const state = outcome.kind;

  if (op.effect === 'open') {
    if (state === 'applied') {
      replace(s, index, { ...op, state, result: outcome.result });
      return { kind: 'filled' };
    }
    // No owner ever existed: discard everything, including any provisional fault.
    s.state = 'discarded';
    s.queue.length = 0;
    s.counted = 0;
    s.faults = { ambiguous: undefined, overflow: undefined, failure: undefined };
    return { kind: 'discarded' };
  }

  const run = s.run;
  if (op.effect === 'start') {
    if (run?.startOrdinal !== op.ordinal) return { kind: 'refused', reason: 'not-reserved' };
    if (state === 'rejected') {
      // The tombstone keeps identity, ordinal and receipt; staged bodies and the run record go.
      replace(s, index, {
        kind: 'effect',
        ordinal: op.ordinal,
        effect: op.effect,
        identity: op.identity,
        state,
        result: outcome.result,
      });
      removeRunStaging(s, run.runId);
      if (s.faults.overflow?.provisionalRun === run.runId) s.faults.overflow = undefined;
      retireRun(s);
      queueClosed(s);
      return withNext({ kind: 'filled' }, continueCleanup(s));
    }
    replace(s, index, { ...op, state, result: outcome.result });
    run.start = 'applied';
    if (s.close !== undefined) return withNext({ kind: 'filled' }, continueCleanup(s));
    if (run.fenced && run.terminal === undefined && run.interrupt === 'idle') {
      // An overflow fenced this start before a handle existed: interrupt it now, once.
      run.interrupt = 'in-flight';
      return { kind: 'filled', next: { kind: 'attempt', phase: 'interrupt' } };
    }
    return { kind: 'filled' };
  }

  replace(s, index, { ...op, state, result: outcome.result });
  if (run !== undefined && run.runId === op.runId) {
    run.unresolved -= 1;
    // A delivered interrupt_run must never be redelivered by close.
    if (op.effect === 'interrupt' && state === 'applied') run.interrupt = 'succeeded';
    placeTerminal(s);
  }
  return withNext({ kind: 'filled' }, continueCleanup(s));
}

function withNext(result: Readonly<{ kind: 'filled' }>, next: CleanupStep | undefined): SettleResult {
  return next === undefined ? result : { ...result, next };
}

function settleCleanup<T>(s: SessionIngestion<T>, phase: CleanupPhase, outcome: 'succeeded' | 'failed'): SettleResult {
  const close = s.close;
  if (phase === 'interrupt') {
    const run = s.run;
    if (run?.interrupt !== 'in-flight') return { kind: 'ignored' };
    run.interrupt = outcome;
    if (outcome === 'succeeded') closeFallback(s);
  } else {
    if (close?.[phase] !== 'in-flight') return { kind: 'ignored' };
    close[phase] = outcome;
    if (phase === 'dispose' && outcome === 'succeeded') closeFallback(s);
    queueClosed(s);
  }
  return close === undefined ? { kind: 'recorded' } : { kind: 'recorded', next: nextCleanup(s, close, phase) };
}

/**
 * Select the run's terminal exactly once. The intent is placed in the FIFO as
 * soon as the start has a handle and every earlier reservation of this run has
 * settled; until it is submitted, only an overflow may turn success into failure.
 */
export function chooseTerminal<T>(
  s: SessionIngestion<T>,
  input: Readonly<{ runId: RunId; outcome: TerminalOutcome; cause: 'completion'; detail?: T }>,
): Readonly<{ kind: 'chosen'; placed: boolean }> | Readonly<{ kind: 'ignored'; reason: 'stale' | 'duplicate' }> {
  const run = s.run;
  if (run?.runId !== input.runId) return { kind: 'ignored', reason: 'stale' };
  if (run.terminal !== undefined) return { kind: 'ignored', reason: 'duplicate' };
  const detail = input.detail;
  selectTerminal(s, run, {
    outcome: input.outcome,
    cause: input.cause,
    ...(detail === undefined ? {} : { detail }),
    overflowed: false,
  });
  return { kind: 'chosen', placed: hasPlacedTerminal(run) };
}

export type HeadStep =
  | Readonly<{ kind: 'submit'; retry?: boolean }>
  | Readonly<{ kind: 'committed'; ordinal: number }>
  | Readonly<{ kind: 'rejected'; ordinal: number; witness?: CommitWitness }>
  | Readonly<{ kind: 'reconciled'; ordinal: number; verdict: 'applied' | 'absent' | 'unknown' }>;

/**
 * Drive the single in-flight head. A rejected commit sets A synchronously,
 * before the caller awaits any reconciliation read; A's head is never
 * resubmitted. Only proven absence turns it into retryable F.
 */
export function advanceHead<T>(s: SessionIngestion<T>, step: HeadStep): HeadResult<T> {
  const op = s.queue[0];
  if (step.kind === 'submit') {
    if (op === undefined || s.state === 'closed' || s.state === 'discarded') return { kind: 'idle' };
    if (s.faults.ambiguous !== undefined) return { kind: 'blocked', reason: 'ambiguous' };
    if (s.head?.status === 'in-flight') return { kind: 'blocked', reason: 'in-flight' };
    if (s.head?.status === 'failed' && step.retry !== true) return { kind: 'blocked', reason: 'faulted' };
    if (op.kind === 'effect' && isUnresolved(op.state)) return { kind: 'blocked', reason: 'awaiting-effect' };
    if (op.kind === 'terminal' && s.run?.terminal?.state === 'placed') {
      s.run.terminal = { state: 'submitted', ordinal: op.ordinal };
    }
    s.head = { ordinal: op.ordinal, status: 'in-flight', published: s.head?.published ?? false };
    return { kind: 'submit', op };
  }

  const head = s.head;
  if (op === undefined || head?.ordinal !== step.ordinal || op.ordinal !== step.ordinal) {
    return { kind: 'refused', reason: 'not-head' };
  }

  if (step.kind === 'committed') {
    if (head.status !== 'in-flight') return { kind: 'refused', reason: 'not-head' };
    return commitHead(s, op, head);
  }

  if (step.kind === 'rejected') {
    if (head.status !== 'in-flight') return { kind: 'refused', reason: 'not-head' };
    head.status = 'ambiguous';
    const witness = step.witness;
    s.faults.ambiguous = { ordinal: op.ordinal, permanent: false, ...(witness === undefined ? {} : { witness }) };
    return witness === undefined ? { kind: 'reconcile', op } : { kind: 'reconcile', op, witness };
  }

  const ambiguous = s.faults.ambiguous;
  if (head.status !== 'ambiguous' || ambiguous?.ordinal !== op.ordinal || ambiguous.permanent) {
    return { kind: 'refused', reason: 'not-head' };
  }
  if (step.verdict === 'unknown') {
    ambiguous.permanent = true;
    return { kind: 'fail-closed', op };
  }
  s.faults.ambiguous = undefined;
  if (step.verdict === 'applied') return commitHead(s, op, head);
  head.status = 'failed';
  const failure = s.faults.failure;
  const count = failure?.ordinal === op.ordinal ? Math.min(failure.count + 1, FAILURE_COUNT_CEILING) : 1;
  s.faults.failure = { ordinal: op.ordinal, count };
  return { kind: 'faulted', op, failureCount: count };
}

function commitHead<T>(s: SessionIngestion<T>, op: Operation<T>, head: HeadState): HeadResult<T> {
  const publish = !head.published;
  head.published = true;
  s.queue.shift();
  if (isCounted(op)) s.counted -= 1;
  s.head = undefined;
  if (s.faults.failure?.ordinal === op.ordinal) s.faults.failure = undefined;

  if (op.kind === 'effect' && op.effect === 'open') {
    s.state = 'open';
    s.staged = 0;
  } else if (op.kind === 'effect' && op.effect === 'start' && op.state === 'applied') {
    const run = s.run;
    if (run?.startOrdinal === op.ordinal) {
      run.start = 'committed';
      run.staged = 0;
      // The owner now exists: any overflow of its staging is real history loss.
      if (s.faults.overflow?.provisionalRun === run.runId) s.faults.overflow.provisionalRun = undefined;
    }
  } else if (op.kind === 'terminal') {
    retireRun(s);
  } else if (op.kind === 'closed') {
    s.state = 'closed';
  }
  return { kind: 'advanced', op, publish };
}

/**
 * Admit a close or shutdown. Fences the run and orders `closing` without
 * waiting on any provider promise, then returns the next safe cleanup call.
 * A different close ID while one is unresolved is refused; the same ID with a
 * changed payload conflicts.
 */
export function beginCleanup<T>(
  s: SessionIngestion<T>,
  input: Readonly<{ identity?: CommandIdentity; ifRunActive: 'interrupt' | 'reject' }>,
): Refusal | Readonly<{ kind: 'reject-active'; runId: RunId }> | Readonly<{ kind: 'cleanup'; step: CleanupStep }> {
  if (s.state === 'opening') return { kind: 'refused', reason: 'session-not-open' };
  if (s.state !== 'open') return { kind: 'refused', reason: 'session-ended' };
  const identity = input.identity;
  let close = s.close;
  if (close !== undefined) {
    if (identity !== undefined && close.identity !== undefined) {
      if (identity.commandId !== close.identity.commandId) return { kind: 'refused', reason: 'busy' };
      if (identity.fingerprint !== close.identity.fingerprint) return { kind: 'refused', reason: 'command-conflict' };
    } else if (identity !== undefined) {
      // A caller close may adopt shutdown's internal close only before its receipt bundle exists.
      if (close.closedQueued) return { kind: 'refused', reason: 'busy' };
      close.identity = identity;
    }
  } else {
    if (input.ifRunActive === 'reject' && s.run !== undefined) return { kind: 'reject-active', runId: s.run.runId };
    close = {
      identity,
      closingQueued: false,
      closedQueued: false,
      dispose: 'idle',
      release: 'idle',
      interruptedActiveRun: false,
    };
    s.close = close;
    if (s.run !== undefined) s.run.fenced = true;
    queueClosing(s, close);
  }
  // Each explicit attempt re-arms only the calls that failed; successes stay observed
  // and in-flight calls are never reissued.
  if (s.run?.interrupt === 'failed') s.run.interrupt = 'idle';
  if (close.dispose === 'failed') close.dispose = 'idle';
  if (close.release === 'failed') close.release = 'idle';
  return { kind: 'cleanup', step: nextCleanup(s, close) };
}

/**
 * Drop a closed (or discarded) session. Only a permanent overflow marker
 * survives, so replay is never falsely certified for that session.
 */
export function retire<T>(s: SessionIngestion<T>): Readonly<{ overflow: true }> | undefined {
  if (s.state !== 'closed' && s.state !== 'discarded') return undefined;
  const overflow = s.state === 'closed' && s.faults.overflow !== undefined;
  s.queue.length = 0;
  s.counted = 0;
  s.run = undefined;
  s.head = undefined;
  return overflow ? { overflow: true } : undefined;
}
