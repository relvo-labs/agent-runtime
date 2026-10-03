/**
 * The composition root.
 *
 * Depends on protocol + executor + provider SPI + workspace SPI, and on no
 * concrete adapter. Everything non-deterministic — time, ids, providers,
 * workspaces, storage — arrives by injection, which is what lets the contract
 * tests assert exact values instead of matching patterns.
 *
 * Every session open, command effect, provider callback, run terminal, close
 * and shutdown goes through the per-session ingestion driver (`ingress.ts`,
 * issue #43): one ordered FIFO per session owns every history commit and every
 * provider or workspace effect's slot, and cleanup never waits on an
 * unresolved provider promise. This file keeps only validation, receipt policy
 * for refusals and the process-local provider/workspace references a session
 * needs.
 */

import {
  AgentRuntimeError,
  CommandIdSchema,
  CommandReceiptSchema,
  CloseSessionCommandSchema,
  InterruptRunCommandSchema,
  OpenSessionCommandSchema,
  RespondToInteractionCommandSchema,
  RunIdSchema,
  SessionIdSchema,
  SubmitTurnCommandSchema,
  agentError,
  canonicalCommandFingerprint,
  isCommandAdmissible,
  JsonValueSchema,
  SubscriptionRequestSchema,
  toAgentError,
  WIRE_VERSION,
  type AgentCommand,
  type AgentCommandInput,
  type AgentError,
  type AgentSession,
  type Clock,
  type CloseSessionCommandInput,
  type CommandId,
  type CommandReceipt,
  type CommandResult,
  type EventPage,
  type IdFactory,
  type InterruptRunCommandInput,
  type OpenSessionCommandInput,
  type ProviderDescriptor,
  type RespondToInteractionCommandInput,
  type RunId,
  type Sequence,
  type SessionId,
  type SessionSnapshot,
  type SubmitTurnCommandInput,
  type SubscriptionRequestInput,
  type Timestamp,
  type TurnId,
  checkResponseAgainstRequest,
  createCounterIdFactory,
  createSystemClock,
} from '@relvo-labs/agent-protocol';
import type { AgentExecutor, EventSubscription } from '@relvo-labs/agent-executor';
import {
  canAcceptWorkspace,
  canInterruptRun,
  isProviderRejection,
  type AgentProvider,
  type ProviderSession,
} from '@relvo-labs/agent-provider';
import { validateWorkspaceLease, type WorkspaceLease, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

import { SESSION_OPERATION_LIMIT, type RefusalReason } from './ingestion.ts';
import {
  createIngressDriver,
  ingressPlan,
  type AdmissionWitness,
  type HeldIdentity,
  type IngressCommandOutcome,
  type IngressDriver,
  type IngressRefusal,
} from './ingress.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';
import { createSubscriptionHub, type SubscriptionHub } from './subscriptions.ts';
import { createInMemoryStore, type RuntimeStore, type StoreTransaction } from './store.ts';

export type AgentRuntimeOptions = {
  readonly workspaces: WorkspaceProvider;
  readonly providers?: readonly AgentProvider[];
  readonly store?: RuntimeStore;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
};

/**
 * The runtime adds capabilities beyond `AgentExecutor`: registering providers,
 * waiting for internal work to settle, and inspecting and retrying provider
 * ingestion. `quiesce` exists because a run completes on the provider's
 * schedule, and a deterministic test needs a defined point at which
 * "everything that was going to happen, happened".
 */
export type AgentRuntime = AgentExecutor & {
  registerProvider(provider: AgentProvider): void;
  quiesce(): Promise<void>;
  /**
   * Process-local faults that prevent complete provider-event replay: at most
   * one entry per session, the most severe first (A: an unknown store-commit
   * outcome, O: history permanently incomplete after an ingestion overflow,
   * F: a proven-unapplied commit that `retryProviderIngestion` can resubmit).
   * Only an F-only entry has `error.retryable: true`; `error.details.fault`
   * names the kind. An overflow marker outlives a successful close.
   */
  getProviderIngestionFaults(): readonly ProviderIngestionFault[];
  /**
   * Resubmit a session's failed ingestion head (F) unchanged and drain the
   * accepted operations behind it. Without a session ID, every faulted session
   * is attempted in session-ID order, continuing past individual failures.
   * Resolves when the session (or every session) is healthy; a healthy session
   * is a no-op and an unknown session rejects with `unknown_session`. Rejects
   * with a non-retryable `store_unavailable` while A (never resubmitted) or O
   * (permanent) remains, and with the retryable F error while the head still
   * fails. Never calls a provider or workspace effect again.
   */
  retryProviderIngestion(sessionId?: SessionId): Promise<void>;
};

export type ProviderIngestionFault = {
  readonly sessionId: SessionId;
  /** The run the blocking operation belongs to, when it belongs to one. */
  readonly runId?: RunId;
  /** `completion` when the blocking operation is a run terminal, else `event`. */
  readonly stage: 'event' | 'completion';
  readonly error: AgentError;
  /** Consecutive failures of the current F head (saturating); `1` for A and O. */
  readonly failureCount: number;
};

/** Live, non-serialisable references a session needs. Deliberately never touches the store. */
type LiveSession = {
  readonly sessionId: SessionId;
  readonly descriptor: ProviderDescriptor;
  readonly providerSession: ProviderSession;
  readonly lease: WorkspaceLease;
};

type InvalidCommand = {
  readonly commandId: CommandId;
  readonly commandType: AgentCommand['type'];
  readonly acceptedAt: Timestamp;
  readonly fingerprint: string;
  readonly receipt: CommandReceipt;
};

type OpenRollback = {
  readonly command: Extract<AgentCommand, { type: 'open_session' }>;
  readonly acceptedAt: Timestamp;
  readonly sessionId: SessionId;
  readonly failure: CommandReceipt;
  readonly providerSession?: ProviderSession;
  readonly lease?: WorkspaceLease;
};

/** An open whose session is reserved in the driver until its `session.opened` bundle commits. */
type PendingOpen = { readonly sessionId: SessionId; readonly fingerprint: string; readonly acceptedAt: Timestamp };

const coordinationStates = new WeakMap<
  AgentRuntime,
  {
    readonly commandQueues: ReadonlyMap<string, Promise<void>>;
    readonly sessionQueues: ReadonlyMap<string, Promise<void>>;
    readonly invalidAttempts: ReadonlyMap<CommandId, unknown>;
    readonly pendingOpens: ReadonlyMap<CommandId, PendingOpen>;
    readonly driver: IngressDriver;
  }
>();

function stateOf(runtime: AgentRuntime) {
  const state = coordinationStates.get(runtime);
  if (state === undefined) throw new Error('runtime was not created by createAgentRuntime');
  return state;
}

/** @internal Deterministic keyed-coordination and retirement diagnostic for tests. */
export function coordinationEntryCountForTesting(runtime: AgentRuntime): {
  readonly commands: number;
  readonly sessions: number;
  readonly pendingSubmits: number;
  readonly commandAttempts: number;
  readonly interactionRoutes: number;
  readonly withdrawals: number;
  readonly runs: number;
  readonly waiters: number;
  readonly invocations: number;
  readonly lifecycleClaims: number;
  readonly retiredMarkers: number;
  readonly liveSessions: number;
} {
  const state = stateOf(runtime);
  const totals = state.driver.totals();
  return {
    commands: state.commandQueues.size,
    sessions: state.sessionQueues.size,
    pendingSubmits: totals.startingRuns,
    commandAttempts: state.invalidAttempts.size + state.pendingOpens.size + totals.claims,
    interactionRoutes: totals.routes,
    withdrawals: totals.withdrawals,
    runs: totals.runs,
    waiters: totals.waiters,
    invocations: totals.invocations,
    lifecycleClaims: totals.lifecycleClaims,
    retiredMarkers: totals.retiredMarkers,
    liveSessions: totals.sessions,
  };
}

/** @internal Sessions with an admitted close whose `session.closed` has not committed. */
export function retainedCloseCountForTesting(runtime: AgentRuntime): number {
  return stateOf(runtime).driver.totals().closing;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? createSystemClock();
  const idFactory = options.idFactory ?? createCounterIdFactory();
  const store: RuntimeStore = options.store ?? createInMemoryStore({ clock, idFactory });
  const registry: ProviderRegistry = createProviderRegistry(options.providers ?? []);
  const hub: SubscriptionHub = createSubscriptionHub({ store, clock });

  const live = new Map<SessionId, LiveSession>();
  // The driver installs its module-internal fault guard on the hub, so replay,
  // buffered and idle live subscribers all reject while a session has A, O or F.
  const driver = createIngressDriver({
    store,
    hub,
    clock,
    idFactory,
    retired: (sessionId) => live.delete(sessionId),
  });
  const commandQueues = new Map<string, Promise<void>>();
  const sessionQueues = new Map<string, Promise<void>>();
  /** Validation rejections whose receipt is not yet recorded: same-ID conflict detection only. */
  const invalidAttempts = new Map<CommandId, InvalidCommand>();
  const openRollbacks = new Map<CommandId, OpenRollback>();
  const pendingOpens = new Map<CommandId, PendingOpen>();
  /** Open commands between admission and their driver reservation, so shutdown never certifies around them. */
  let opensInFlight = 0;
  let lifecycle: 'accepting' | 'shutting_down' | 'shut_down' = 'accepting';
  let shutdownPromise: Promise<void> | undefined;

  function serializeByKey<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    return result.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
  }

  /**
   * Same-ID commands run one at a time. `submit_turn`, `interrupt_run` and
   * `respond_to_interaction` also run one at a time per session (competing
   * settlements, one active run). `close_session` deliberately does not join
   * the session queue: its admission fences the session ahead of queued work,
   * so it never waits on a pending provider start or response.
   */
  function coordinateCommand<T>(input: unknown, sessionScoped: boolean, operation: () => Promise<T>): Promise<T> {
    const commandId = ownDataString(input, 'commandId');
    const sessionId = sessionScoped ? ownDataString(input, 'sessionId') : undefined;
    const withinSession = (): Promise<T> =>
      sessionId !== undefined ? serializeByKey(sessionQueues, sessionId, operation) : operation();
    return commandId !== undefined ? serializeByKey(commandQueues, commandId, withinSession) : withinSession();
  }

  /**
   * Once shutdown starts, new work is fenced. A command ID that still holds an
   * unresolved identity (a reserved command slot whose outcome is unknown or
   * not yet committed, an open or its rollback, an admitted close, an
   * unrecorded validation rejection) is still admitted: only its owner's exact
   * retry can resolve it, and shutdown cannot settle until it is resolved. A
   * changed payload under such an ID is answered with the usual conflict.
   */
  function coordinateMutation<T>(input: unknown, sessionScoped: boolean, operation: () => Promise<T>): Promise<T> {
    if (lifecycle !== 'accepting' && !holdsUnresolvedIdentity(input)) {
      return Promise.reject(
        new AgentRuntimeError(agentError('session_closed', `runtime is ${lifecycle.replace('_', ' ')}`)),
      );
    }
    return coordinateCommand(input, sessionScoped, operation);
  }

  function holdsUnresolvedIdentity(input: unknown): boolean {
    const commandId = CommandIdSchema.safeParse(ownDataString(input, 'commandId'));
    return commandId.success && heldIdentity(commandId.data) !== undefined;
  }

  /**
   * What the command saw at invocation, before any queue: its own provider
   * call in flight (a concurrent exact retry shares it instead of delivering
   * again) and, for `interrupt_run`, the run's interrupt in flight or unknown
   * (a concurrent new-ID interrupt mirrors its outcome). Synchronous.
   */
  function witnessAtInvocation(input: unknown, interrupt: boolean): AdmissionWitness | undefined {
    const commandId = CommandIdSchema.safeParse(ownDataString(input, 'commandId'));
    if (!commandId.success) return undefined;
    if (!interrupt) return driver.witness(commandId.data);
    const sessionId = SessionIdSchema.safeParse(ownDataString(input, 'sessionId'));
    const runId = RunIdSchema.safeParse(ownDataString(input, 'runId'));
    return sessionId.success && runId.success
      ? driver.witness(commandId.data, { sessionId: sessionId.data, runId: runId.data })
      : driver.witness(commandId.data);
  }

  // -------------------------------------------------------------------------
  // Receipts and idempotency
  // -------------------------------------------------------------------------

  function receipt(
    command: AgentCommand,
    disposition: 'applied' | 'rejected',
    payload: { result?: CommandResult; error?: AgentError; sequence?: Sequence },
    acceptedAt: Timestamp,
  ): CommandReceipt {
    return CommandReceiptSchema.parse({
      commandId: command.commandId,
      commandType: command.type,
      disposition,
      ...(payload.result === undefined ? {} : { result: payload.result }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
      ...(payload.sequence === undefined ? {} : { sequence: payload.sequence }),
      acceptedAt,
    });
  }

  function conflictReceipt(command: AgentCommand, acceptedAt: Timestamp): CommandReceipt {
    return receipt(
      command,
      'rejected',
      {
        error: agentError(
          'command_id_conflict',
          `command id \`${command.commandId}\` was already used with a different payload`,
          { details: { commandId: command.commandId, commandType: command.type } },
        ),
      },
      acceptedAt,
    );
  }

  function dedupe(command: AgentCommand, existing: { fingerprint: string; receipt: CommandReceipt }): CommandReceipt {
    if (existing.fingerprint !== canonicalCommandFingerprint(command)) {
      return conflictReceipt(command, existing.receipt.acceptedAt);
    }
    return existing.receipt.disposition === 'rejected'
      ? existing.receipt
      : CommandReceiptSchema.parse({ ...existing.receipt, disposition: 'duplicate' });
  }

  /**
   * The identity a command ID currently holds anywhere in this runtime: an
   * unrecorded validation rejection, an open awaiting its commit or rollback,
   * a claimed driver slot, or an admitted close.
   */
  function heldIdentity(commandId: CommandId): Omit<HeldIdentity, 'sessionId'> | undefined {
    const invalid = invalidAttempts.get(commandId);
    if (invalid !== undefined) return { fingerprint: invalid.fingerprint, acceptedAt: invalid.acceptedAt };
    const open = pendingOpens.get(commandId);
    if (open !== undefined) return open;
    const rollback = openRollbacks.get(commandId);
    if (rollback !== undefined) {
      return { fingerprint: canonicalCommandFingerprint(rollback.command), acceptedAt: rollback.acceptedAt };
    }
    return driver.commandIdentity(commandId);
  }

  /**
   * The answer for a command ID that is already held or recorded: a
   * not-recorded conflict for a changed payload, or the store's receipt.
   * `undefined`: unrecorded, and either fresh or the exact retry of a held
   * identity (the caller resumes it).
   */
  async function existingCommandOutcome(command: AgentCommand): Promise<CommandReceipt | undefined> {
    const held = heldIdentity(command.commandId);
    if (held !== undefined && held.fingerprint !== canonicalCommandFingerprint(command)) {
      return conflictReceipt(command, held.acceptedAt);
    }
    const existing = await store.findReceipt(command.commandId);
    return existing === undefined ? undefined : dedupe(command, existing);
  }

  /**
   * Record a receipt-only outcome (a refusal before any effect, or an
   * idempotent no-op) unless the command ID already has a receipt, which then
   * answers instead: a receipt is never overwritten. These commits carry no
   * session history, so they do not pass through the ingestion FIFO.
   */
  async function recordOnce(
    command: AgentCommand,
    build: (tx: StoreTransaction) => CommandReceipt,
  ): Promise<CommandReceipt> {
    const { value } = await store.commit((tx) => {
      const found = tx.findReceipt(command.commandId);
      if (found !== undefined) return dedupe(command, found);
      const produced = build(tx);
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: produced });
      return produced;
    });
    return value;
  }

  function rejectAndRecord(command: AgentCommand, rejection: CommandReceipt): Promise<CommandReceipt> {
    return recordOnce(command, () => rejection);
  }

  /** A refusal that may succeed later unchanged: returned, never recorded. */
  function transient(code: 'illegal_state_transition' | 'store_unavailable', message: string, details: object) {
    return new AgentRuntimeError({ ...agentError(code, message, { details: { ...details } }), retryable: true });
  }

  function capacityError(sessionId: SessionId): AgentRuntimeError {
    return new AgentRuntimeError(
      agentError(
        'store_unavailable',
        `session \`${sessionId}\` already holds ${String(SESSION_OPERATION_LIMIT)} unpersisted operations; retry after earlier operations persist`,
        { details: { sessionId, reason: 'capacity', operationLimit: SESSION_OPERATION_LIMIT } },
      ),
    );
  }

  /** The session's current ingestion fault as an error (A/O non-retryable, F retryable). */
  function faultFor(sessionId: SessionId): AgentRuntimeError {
    const found = driver.fault(sessionId);
    return found === undefined
      ? new AgentRuntimeError(agentError('store_unavailable', `session \`${sessionId}\` ingestion is blocked`))
      : new AgentRuntimeError(found.error);
  }

  type SessionCleanupFailure = {
    readonly phase: 'provider_dispose' | 'workspace_release';
    readonly error: AgentError;
    readonly cause: unknown;
  };

  function rollbackCleanupError(sessionId: SessionId, failures: readonly SessionCleanupFailure[]): AgentRuntimeError {
    const code = failures.some((failure) => failure.phase === 'provider_dispose')
      ? 'provider_unavailable'
      : 'workspace_unavailable';
    return new AgentRuntimeError(
      agentError(code, `session \`${sessionId}\` cleanup did not complete`, {
        details: { sessionId, failures: failures.map(({ phase, error }) => ({ phase, error })) },
      }),
      {
        cause: new AggregateError(
          failures.map((failure) => failure.cause),
          'session cleanup failed',
        ),
      },
    );
  }

  function shutdownCleanupError(
    failures: readonly { readonly sessionId: SessionId; readonly error: AgentError; readonly cause: unknown }[],
  ): AgentRuntimeError {
    const sorted = [...failures].sort((left, right) =>
      left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
    );
    const code = sorted.some((failure) => failure.error.code === 'provider_unavailable')
      ? 'provider_unavailable'
      : sorted.some((failure) => failure.error.code === 'store_unavailable')
        ? 'store_unavailable'
        : sorted.some((failure) => failure.error.code === 'workspace_unavailable')
          ? 'workspace_unavailable'
          : 'internal';
    const error = agentError(code, `runtime shutdown could not close ${String(sorted.length)} session(s)`, {
      details: { failures: sorted.map(({ sessionId, error: failure }) => ({ sessionId, error: failure })) },
    });
    return new AgentRuntimeError(
      { ...error, retryable: sorted.every((failure) => failure.error.retryable) },
      {
        cause: new AggregateError(
          sorted.map((failure) => failure.cause),
          'runtime shutdown cleanup failed',
        ),
      },
    );
  }

  /**
   * Roll back an open whose provider session or lease exists but whose open
   * was never filled. Disposal first; the lease is released only after a
   * confirmed disposal, so a provider can never use a released workspace.
   */
  async function finishOpenRollback(rollback: OpenRollback): Promise<CommandReceipt> {
    const failures: SessionCleanupFailure[] = [];
    let disposed = rollback.providerSession === undefined;
    if (rollback.providerSession !== undefined) {
      try {
        await rollback.providerSession.dispose();
        disposed = true;
      } catch (error) {
        failures.push({ phase: 'provider_dispose', error: toAgentError(error, 'provider_unavailable'), cause: error });
      }
    }
    if (rollback.lease !== undefined && disposed) {
      try {
        await rollback.lease.release();
      } catch (error) {
        failures.push({
          phase: 'workspace_release',
          error: toAgentError(error, 'workspace_unavailable'),
          cause: error,
        });
      }
    }
    if (failures.length > 0) throw rollbackCleanupError(rollback.sessionId, failures);
    const recorded = await rejectAndRecord(rollback.command, rollback.failure);
    openRollbacks.delete(rollback.command.commandId);
    return recorded;
  }

  // -------------------------------------------------------------------------
  // Command parsing
  // -------------------------------------------------------------------------

  type SafeParser<T> = {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  };

  function ownDataString(value: unknown, key: string): string | undefined {
    try {
      if (typeof value !== 'object' || value === null) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  }

  function invalidFingerprint(raw: unknown): string {
    try {
      const parsed = JsonValueSchema.safeParse(raw);
      if (!parsed.success) return 'invalid:unsafe-input';
      const canonicalize = (value: typeof parsed.data): typeof parsed.data => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value === null || typeof value !== 'object') return value;
        return Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)]),
        );
      };
      return `invalid:${JSON.stringify(canonicalize(parsed.data))}`;
    } catch {
      return 'invalid:unsafe-input';
    }
  }

  /**
   * Parse caller input into a validated command. An invalid command with an
   * inspectable ID is answered with a recorded rejection receipt instead of a
   * throw, the same way as any other refusal.
   */
  function parseCommand<T extends AgentCommand>(
    schema: SafeParser<T>,
    raw: unknown,
    commandType: T['type'],
  ): { ok: true; command: T } | { ok: false; invalid: InvalidCommand } {
    let parsed: ReturnType<SafeParser<T>['safeParse']>;
    try {
      parsed = schema.safeParse(raw);
    } catch {
      parsed = { success: false };
    }
    if (parsed.success) return { ok: true, command: parsed.data };

    const commandId = CommandIdSchema.safeParse(ownDataString(raw, 'commandId'));
    if (!commandId.success) {
      throw new AgentRuntimeError(agentError('invalid_request', 'command does not match the required schema'));
    }
    const acceptedAt = clock.now();
    return {
      ok: false,
      invalid: {
        commandId: commandId.data,
        commandType,
        acceptedAt,
        fingerprint: invalidFingerprint(raw),
        receipt: CommandReceiptSchema.parse({
          commandId: commandId.data,
          commandType,
          disposition: 'rejected',
          error: agentError('invalid_request', 'command does not match the required schema'),
          acceptedAt,
        }),
      },
    };
  }

  function invalidConflict(invalid: InvalidCommand, acceptedAt: Timestamp): CommandReceipt {
    return CommandReceiptSchema.parse({
      commandId: invalid.commandId,
      commandType: invalid.commandType,
      disposition: 'rejected',
      error: agentError(
        'command_id_conflict',
        `command id \`${invalid.commandId}\` was already used with a different payload`,
      ),
      acceptedAt,
    });
  }

  async function invalidCommandOutcome(invalid: InvalidCommand): Promise<CommandReceipt> {
    const existing = await store.findReceipt(invalid.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint === invalid.fingerprint) return existing.receipt;
      return invalidConflict(invalid, existing.receipt.acceptedAt);
    }
    const retained = invalidAttempts.get(invalid.commandId);
    if (retained !== undefined && retained.fingerprint !== invalid.fingerprint) {
      return invalidConflict(invalid, retained.acceptedAt);
    }
    // A valid command holding this ID (a driver slot, an open or a close) is never overwritten.
    const held = retained === undefined ? heldIdentity(invalid.commandId) : undefined;
    if (held !== undefined) return invalidConflict(invalid, held.acceptedAt);
    const canonical = retained ?? invalid;
    invalidAttempts.set(canonical.commandId, canonical);
    const { value } = await store.commit((tx) => {
      const found = tx.findReceipt(canonical.commandId);
      if (found !== undefined) {
        return found.fingerprint === canonical.fingerprint
          ? found.receipt
          : invalidConflict(canonical, found.receipt.acceptedAt);
      }
      tx.recordReceipt(canonical.commandId, { fingerprint: canonical.fingerprint, receipt: canonical.receipt });
      return canonical.receipt;
    });
    invalidAttempts.delete(canonical.commandId);
    return value;
  }

  // -------------------------------------------------------------------------
  // Refusal policy
  // -------------------------------------------------------------------------

  /**
   * Map a driver refusal (nothing reserved, no provider call) onto the
   * runtime's receipt policy. Permanent facts are recorded; conditions that
   * may change without any change to the command (a close in progress, a run
   * ending, ingestion capacity, a blocked head) are returned as typed errors
   * and never recorded, so an exact retry later gets the truthful answer.
   */
  async function refuse(
    command: AgentCommand & { readonly sessionId: SessionId },
    reason: IngressRefusal,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    const { sessionId } = command;
    switch (reason) {
      case 'session-ended':
        return rejectAndRecord(
          command,
          receipt(
            command,
            'rejected',
            {
              error: agentError('session_closed', `session \`${sessionId}\` is closed`, {
                details: { sessionId, state: 'closed' },
              }),
            },
            acceptedAt,
          ),
        );
      case 'overflowed':
      case 'head-blocked':
        throw faultFor(sessionId);
      case 'capacity':
        throw capacityError(sessionId);
      case 'closing':
        if (command.type === 'submit_turn') {
          return rejectAndRecord(
            command,
            receipt(
              command,
              'rejected',
              {
                error: agentError(
                  'illegal_state_transition',
                  '`submit_turn` is not admissible while the session is `closing`',
                  { details: { sessionId, state: 'closing', command: 'submit_turn' } },
                ),
              },
              acceptedAt,
            ),
          );
        }
        throw transient(
          'illegal_state_transition',
          `session \`${sessionId}\` is closing: its close interrupts the run; retry to observe the outcome`,
          { sessionId, reason },
        );
      case 'run-not-active':
        throw transient(
          'illegal_state_transition',
          'the run is ending or being interrupted and accepts no new effect; retry to observe its outcome',
          { sessionId, reason },
        );
      case 'subject-busy':
        throw transient(
          'illegal_state_transition',
          'another response to this interaction is unresolved; retry after it settles',
          { sessionId, reason },
        );
      default:
        throw transient('illegal_state_transition', `the command could not be admitted now (${reason})`, {
          sessionId,
          reason,
        });
    }
  }

  async function settleOutcome(
    command: AgentCommand & { readonly sessionId: SessionId },
    outcome: IngressCommandOutcome,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    if (outcome.kind !== 'receipt') return await refuse(command, outcome.reason, acceptedAt);
    // An applied start returns once the run output staged behind it is persisted
    // (or a fault is queryable), as before the cutover.
    if (command.type === 'submit_turn' && outcome.receipt.disposition === 'applied') {
      await driver.drained(command.sessionId);
    }
    return outcome.receipt;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  function requireOpenSession(sessionId: SessionId): LiveSession {
    const session = live.get(sessionId);
    if (!session) {
      throw new AgentRuntimeError(agentError('unknown_session', `unknown session \`${sessionId}\``));
    }
    return session;
  }

  function guardCommand(
    command: AgentCommand & { sessionId: SessionId },
    snapshot: SessionSnapshot | undefined,
    kind: 'submit_turn' | 'interrupt_run' | 'respond_to_interaction' | 'close_session',
    acceptedAt: Timestamp,
  ): CommandReceipt | undefined {
    if (!snapshot) {
      return receipt(
        command,
        'rejected',
        { error: agentError('unknown_session', `unknown session \`${command.sessionId}\``) },
        acceptedAt,
      );
    }
    const state = snapshot.session.state;
    if (state === 'closed' || state === 'failed') {
      return receipt(
        command,
        'rejected',
        {
          error: agentError('session_closed', `session \`${command.sessionId}\` is ${state}`, {
            details: { sessionId: command.sessionId, state },
          }),
        },
        acceptedAt,
      );
    }
    if (!isCommandAdmissible(state, kind)) {
      return receipt(
        command,
        'rejected',
        {
          error: agentError(
            'illegal_state_transition',
            `\`${kind}\` is not admissible while the session is \`${state}\``,
            { details: { sessionId: command.sessionId, state, command: kind } },
          ),
        },
        acceptedAt,
      );
    }
    return undefined;
  }

  async function openSession(input: OpenSessionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(OpenSessionCommandSchema, input, 'open_session');
    if (!parsed.ok) return await invalidCommandOutcome(parsed.invalid);
    const command = parsed.command;

    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;
    const pending = pendingOpens.get(command.commandId);
    if (pending !== undefined) return await finishOpen(command, pending, true);
    const rollback = openRollbacks.get(command.commandId);
    if (rollback !== undefined) return await finishOpenRollback(rollback);
    if (lifecycle !== 'accepting') {
      throw new AgentRuntimeError(agentError('session_closed', `runtime is ${lifecycle.replace('_', ' ')}`));
    }

    const acceptedAt = clock.now();
    const sessionId = idFactory.next('session') as SessionId;
    const fingerprint = canonicalCommandFingerprint(command);
    // The open slot (ordinal 0) is reserved before any effect: session-sink output
    // emitted during `createSession()` is staged behind `session.opened`.
    const sessionSink = driver.openSession(sessionId, { commandId: command.commandId, fingerprint, acceptedAt });
    const reservation: PendingOpen = { sessionId, fingerprint, acceptedAt };
    pendingOpens.set(command.commandId, reservation);

    // Acquiring a workspace and a provider session are effects that cannot live
    // inside a store transaction, so they happen first and are rolled back by
    // hand if the open cannot be filled.
    let lease: WorkspaceLease | undefined;
    let leaseSafeToRelease = false;
    let providerSession: ProviderSession | undefined;
    let plan: { session: AgentSession; descriptor: ProviderDescriptor } | undefined;
    opensInFlight += 1;
    try {
      const provider = registry.get(command.providerId);
      const descriptor = registry.descriptor(command.providerId);
      lease = await options.workspaces.acquire(command.workspace);
      leaseSafeToRelease = command.workspace.kind === 'managed' && lease.ownership === 'managed';
      const leaseDescriptor = await validateWorkspaceLease(command.workspace, lease);
      leaseSafeToRelease = true;
      const workspaceCapability = canAcceptWorkspace(descriptor, leaseDescriptor.ownership);
      if (!workspaceCapability.ok) throw new AgentRuntimeError(workspaceCapability.error);

      providerSession = await provider.createSession({
        options: command.providerOptions ?? {},
        workspace: { root: leaseDescriptor.root, ownership: leaseDescriptor.ownership },
        sink: sessionSink,
      });
      plan = {
        descriptor,
        session: {
          sessionId,
          state: 'opening',
          providerId: descriptor.providerId,
          wireVersion: WIRE_VERSION,
          workspace: leaseDescriptor,
          createdAt: acceptedAt,
          sequence: 0 as Sequence,
          turnIds: [],
        },
      };
    } catch (error) {
      pendingOpens.delete(command.commandId);
      // No owner ever existed: the driver discards the slot and the inactive sink.
      driver.settleOpen(sessionId, { kind: 'rejected' });
      const failure = receipt(
        command,
        'rejected',
        { error: isProviderRejection(error) ? error.agentError : toAgentError(error, 'internal') },
        acceptedAt,
      );
      const retained: OpenRollback = {
        command,
        acceptedAt,
        sessionId,
        failure,
        ...(providerSession === undefined ? {} : { providerSession }),
        ...(!leaseSafeToRelease || lease === undefined ? {} : { lease }),
      };
      openRollbacks.set(command.commandId, retained);
      return await finishOpenRollback(retained);
    } finally {
      opensInFlight -= 1;
    }

    const { session, descriptor } = plan;
    const ownedSession = providerSession;
    const ownedLease = lease;
    live.set(sessionId, { sessionId, descriptor, providerSession: ownedSession, lease: ownedLease });
    driver.settleOpen(sessionId, {
      kind: 'applied',
      plan: ingressPlan((tx) => {
        tx.createSession(session);
        tx.emit({
          sessionId,
          payload: { type: 'session.opened', providerId: descriptor.providerId, workspace: session.workspace },
        });
        const produced = receipt(
          command,
          'applied',
          { result: { type: 'session_opened', sessionId }, sequence: tx.session(sessionId).session.sequence },
          acceptedAt,
        );
        tx.recordReceipt(command.commandId, { fingerprint, receipt: produced });
      }),
      cleanup: { dispose: () => ownedSession.dispose(), release: () => ownedLease.release() },
    });
    return await finishOpen(command, reservation, false);
  }

  /** Wait for the open bundle; an exact retry resubmits a proven-absent (F) head. */
  async function finishOpen(
    command: Extract<AgentCommand, { type: 'open_session' }>,
    reservation: PendingOpen,
    resume: boolean,
  ): Promise<CommandReceipt> {
    const committed = await driver.openOutcome(reservation.sessionId, resume);
    if (pendingOpens.get(command.commandId) === reservation) pendingOpens.delete(command.commandId);
    if (committed !== undefined) {
      // Session output the provider emitted during `createSession()` is persisted before the receipt returns.
      await driver.drained(reservation.sessionId);
      return committed;
    }
    // The bundle committed before this attempt waited: the store answers.
    const stored = await store.findReceipt(command.commandId);
    if (stored !== undefined) return dedupe(command, stored);
    throw new AgentRuntimeError(agentError('internal', `open \`${command.commandId}\` has no recorded outcome`));
  }

  async function submitTurn(input: SubmitTurnCommandInput, witness?: AdmissionWitness): Promise<CommandReceipt> {
    const parsed = parseCommand(SubmitTurnCommandSchema, input, 'submit_turn');
    if (!parsed.ok) return await invalidCommandOutcome(parsed.invalid);
    const command = parsed.command;
    const { sessionId } = command;

    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;
    const held = driver.commandIdentity(command.commandId);
    if (held !== undefined) {
      // The exact retry of a reserved start: the driver shares or re-delivers it.
      const session = requireOpenSession(held.sessionId);
      const run = driver.inspect(held.sessionId)?.run;
      const outcome = await driver.submitTurn(held.sessionId, {
        command,
        acceptedAt: held.acceptedAt,
        turnId: run?.turnId ?? (idFactory.next('turn') as TurnId),
        runId: run?.runId ?? (idFactory.next('run') as RunId),
        attempt: 1,
        startRun: (request) => session.providerSession.startRun(request),
        ...(witness === undefined ? {} : { witness }),
      });
      return await settleOutcome(command, outcome, held.acceptedAt);
    }

    const acceptedAt = clock.now();
    const snapshot = await store.read(sessionId);
    const guard = guardCommand(command, snapshot, 'submit_turn', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);
    const session = requireOpenSession(sessionId);
    const activeRun = snapshot?.runs.find(
      (run) => run.state !== 'succeeded' && run.state !== 'failed' && run.state !== 'interrupted',
    );
    const runActive = (): Promise<CommandReceipt> =>
      rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          {
            error: agentError('illegal_state_transition', 'a session may have only one active run', {
              details: { activeRunId: activeRun?.runId ?? null },
            }),
          },
          acceptedAt,
        ),
      );
    if (activeRun !== undefined) return await runActive();

    const outcome = await driver.submitTurn(sessionId, {
      command,
      acceptedAt,
      turnId: idFactory.next('turn') as TurnId,
      runId: idFactory.next('run') as RunId,
      attempt: 1,
      startRun: (request) => session.providerSession.startRun(request),
      ...(witness === undefined ? {} : { witness }),
    });
    if (outcome.kind === 'refused' && outcome.reason === 'run-active') return await runActive();
    return await settleOutcome(command, outcome, acceptedAt);
  }

  async function interruptRun(input: InterruptRunCommandInput, witness?: AdmissionWitness): Promise<CommandReceipt> {
    const parsed = parseCommand(InterruptRunCommandSchema, input, 'interrupt_run');
    if (!parsed.ok) return await invalidCommandOutcome(parsed.invalid);
    const command = parsed.command;
    const { sessionId } = command;

    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;
    const held = driver.commandIdentity(command.commandId);
    if (held !== undefined) {
      const outcome = await driver.interruptRun(held.sessionId, {
        command,
        acceptedAt: held.acceptedAt,
        ...(witness === undefined ? {} : { witness }),
      });
      return await interruptOutcome(command, outcome, held.acceptedAt);
    }

    const acceptedAt = clock.now();
    const snapshot = await store.read(sessionId);
    const guard = guardCommand(command, snapshot, 'interrupt_run', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);

    const knownRun = snapshot?.runs.find((run) => run.runId === command.runId);
    if (knownRun === undefined) {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('unknown_run', `unknown run \`${command.runId}\` in session \`${sessionId}\``) },
          acceptedAt,
        ),
      );
    }
    if (knownRun.termination !== undefined) return await alreadyTerminal(command, acceptedAt);

    const session = requireOpenSession(sessionId);
    const capability = canInterruptRun(session.descriptor);
    if (!capability.ok) {
      return await rejectAndRecord(command, receipt(command, 'rejected', { error: capability.error }, acceptedAt));
    }
    const outcome = await driver.interruptRun(sessionId, {
      command,
      acceptedAt,
      ...(witness === undefined ? {} : { witness }),
    });
    return await interruptOutcome(command, outcome, acceptedAt);
  }

  /** An applied no-op: the run was already terminal, so nothing was delivered. */
  function alreadyTerminal(
    command: Extract<AgentCommand, { type: 'interrupt_run' }>,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    return recordOnce(command, (tx) =>
      receipt(
        command,
        'applied',
        {
          result: {
            type: 'run_interrupt_requested',
            sessionId: command.sessionId,
            runId: command.runId,
            delivered: false,
          },
          sequence: tx.session(command.sessionId).session.sequence,
        },
        acceptedAt,
      ),
    );
  }

  async function interruptOutcome(
    command: Extract<AgentCommand, { type: 'interrupt_run' }>,
    outcome: IngressCommandOutcome,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    if (outcome.kind === 'refused' && outcome.reason === 'run-not-active') {
      // The run's terminal may have committed meanwhile: then this is the documented no-op.
      const snapshot = await store.read(command.sessionId);
      const run = snapshot?.runs.find((candidate) => candidate.runId === command.runId);
      if (run?.termination !== undefined) return await alreadyTerminal(command, acceptedAt);
    }
    return await settleOutcome(command, outcome, acceptedAt);
  }

  async function respondToInteraction(
    input: RespondToInteractionCommandInput,
    witness?: AdmissionWitness,
  ): Promise<CommandReceipt> {
    const parsed = parseCommand(RespondToInteractionCommandSchema, input, 'respond_to_interaction');
    if (!parsed.ok) return await invalidCommandOutcome(parsed.invalid);
    const command = parsed.command;
    const { sessionId } = command;

    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;
    const held = driver.commandIdentity(command.commandId);
    if (held !== undefined) {
      const session = requireOpenSession(held.sessionId);
      const outcome = await driver.respondToInteraction(held.sessionId, {
        command,
        acceptedAt: held.acceptedAt,
        deliver: (providerRef, response) => session.providerSession.respondToInteraction(providerRef, response),
        ...(witness === undefined ? {} : { witness }),
      });
      return await responseOutcome(command, outcome, held.acceptedAt);
    }

    const acceptedAt = clock.now();
    const snapshot = await store.read(sessionId);
    const guard = guardCommand(command, snapshot, 'respond_to_interaction', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);
    const session = requireOpenSession(sessionId);

    const settledByStore = await interactionRefusal(command, acceptedAt);
    if (settledByStore !== undefined) return settledByStore;
    const interaction = await store.readInteraction(sessionId, command.interactionId);
    if (interaction === undefined) throw new AgentRuntimeError(agentError('internal', 'interaction disappeared'));
    const mismatch = checkResponseAgainstRequest(interaction.request, command.response);
    if (mismatch) {
      return await rejectAndRecord(
        command,
        receipt(command, 'rejected', { error: agentError('invalid_request', mismatch) }, acceptedAt),
      );
    }
    const outcome = await driver.respondToInteraction(sessionId, {
      command,
      acceptedAt,
      deliver: (providerRef, response) => session.providerSession.respondToInteraction(providerRef, response),
      ...(witness === undefined ? {} : { witness }),
    });
    return await responseOutcome(command, outcome, acceptedAt);
  }

  /**
   * The authoritative store's answer for an interaction that cannot take a
   * response: unknown, already settled, or owned by a terminal run. Recorded.
   */
  async function interactionRefusal(
    command: Extract<AgentCommand, { type: 'respond_to_interaction' }>,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt | undefined> {
    const { sessionId, interactionId } = command;
    const interaction = await store.readInteraction(sessionId, interactionId);
    if (!interaction) {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('unknown_interaction', `unknown interaction \`${interactionId}\``) },
          acceptedAt,
        ),
      );
    }
    if (interaction.status === 'settled') {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          {
            error: agentError('interaction_already_settled', `interaction \`${interactionId}\` is already settled`),
          },
          acceptedAt,
        ),
      );
    }
    const snapshot = await store.read(sessionId);
    const run = snapshot?.runs.find((candidate) => candidate.runId === interaction.runId);
    if (run === undefined || run.state === 'succeeded' || run.state === 'failed' || run.state === 'interrupted') {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('run_already_terminal', 'the interaction belongs to a terminal run') },
          acceptedAt,
        ),
      );
    }
    return undefined;
  }

  async function responseOutcome(
    command: Extract<AgentCommand, { type: 'respond_to_interaction' }>,
    outcome: IngressCommandOutcome,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    if (outcome.kind === 'receipt') return outcome.receipt;
    switch (outcome.reason) {
      case 'interaction-withdrawn':
        return await rejectAndRecord(
          command,
          receipt(
            command,
            'rejected',
            { error: agentError('interaction_already_settled', 'the interaction was withdrawn') },
            acceptedAt,
          ),
        );
      case 'interaction-unrouted': {
        // A settled interaction keeps no route: the store says why.
        const fromStore = await interactionRefusal(command, acceptedAt);
        if (fromStore !== undefined) return fromStore;
        return await rejectAndRecord(
          command,
          receipt(
            command,
            'rejected',
            { error: agentError('provider_contract_violation', 'interaction routing state is unavailable') },
            acceptedAt,
          ),
        );
      }
      default:
        return await refuse(command, outcome.reason, acceptedAt);
    }
  }

  async function closeSession(input: CloseSessionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(CloseSessionCommandSchema, input, 'close_session');
    if (!parsed.ok) return await invalidCommandOutcome(parsed.invalid);
    const command = parsed.command;
    const { sessionId } = command;
    const fingerprint = canonicalCommandFingerprint(command);

    // Retained close ownership comes first. While the driver still owns this session, its
    // `session.closed` bundle has not been confirmed committed: the store's receipt or
    // closed state may be the unconfirmed result of an ambiguous commit (A), so neither
    // shortcut may answer for the driver. An exact retry goes to the driver, which fails
    // closed under A, resumes a proven-absent (F) head, and never repeats a cleanup effect.
    const retained = driver.inspect(sessionId) !== undefined;
    const ownedClose = driver.commandIdentity(command.commandId);
    const resumesOwnedClose = retained && ownedClose?.sessionId === sessionId && ownedClose.fingerprint === fingerprint;
    if (!resumesOwnedClose) {
      const existing = await existingCommandOutcome(command);
      if (existing !== undefined) return existing;
    }
    const held = driver.commandIdentity(command.commandId);
    // An exact retry keeps the first acceptance and resumes a proven-absent head.
    const acceptedAt = held?.acceptedAt ?? clock.now();

    const snapshot = await store.read(sessionId);
    if (!snapshot) {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('unknown_session', `unknown session \`${sessionId}\``) },
          acceptedAt,
        ),
      );
    }
    if (!retained && (snapshot.session.state === 'closed' || snapshot.session.state === 'failed')) {
      return await alreadyClosed(command, acceptedAt);
    }

    const outcome = await driver.closeSession(sessionId, {
      identity: { commandId: command.commandId, fingerprint, acceptedAt },
      ifRunActive: command.ifRunActive === 'reject' ? 'reject' : 'interrupt',
      resume: held !== undefined,
    });
    switch (outcome.kind) {
      case 'closed':
        if (outcome.receipt !== undefined) return outcome.receipt;
        return await alreadyClosed(command, acceptedAt);
      case 'reject-active':
        return await rejectAndRecord(
          command,
          receipt(
            command,
            'rejected',
            {
              error: agentError('invalid_request', 'the session has an active run and `ifRunActive` is `reject`', {
                details: { runIds: [outcome.runId] },
              }),
            },
            acceptedAt,
          ),
        );
      case 'refused':
        return await closeRefusal(command, outcome.reason, acceptedAt);
    }
  }

  /**
   * A close of a session that is already closed. Its own close receipt (if the
   * session closed under this command ID) answers first; another ID records an
   * applied no-op that interrupted nothing.
   */
  async function alreadyClosed(
    command: Extract<AgentCommand, { type: 'close_session' }>,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    return recordOnce(command, () =>
      receipt(
        command,
        'applied',
        { result: { type: 'session_closed', sessionId: command.sessionId, interruptedActiveRun: false } },
        acceptedAt,
      ),
    );
  }

  async function closeRefusal(
    command: Extract<AgentCommand, { type: 'close_session' }>,
    reason: RefusalReason,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    const { sessionId } = command;
    switch (reason) {
      case 'command-conflict':
        return conflictReceipt(command, driver.commandIdentity(command.commandId)?.acceptedAt ?? acceptedAt);
      case 'busy': {
        // The admitted close's bundle has an unknown commit outcome: no other close can
        // answer for it, and waiting cannot help.
        const blocked = driver.fault(sessionId);
        if (blocked?.kind === 'ambiguous') throw new AgentRuntimeError(blocked.error);
        throw transient(
          'illegal_state_transition',
          `session \`${sessionId}\` is already being closed by another close command; retry after it completes`,
          { sessionId, reason: 'close-in-progress' },
        );
      }
      case 'session-ended': {
        const stored = await store.findReceipt(command.commandId);
        if (stored !== undefined) return dedupe(command, stored);
        return await alreadyClosed(command, acceptedAt);
      }
      default:
        throw transient('illegal_state_transition', `session \`${sessionId}\` cannot be closed now (${reason})`, {
          sessionId,
          reason,
        });
    }
  }

  // -------------------------------------------------------------------------
  // Ingestion faults and retry
  // -------------------------------------------------------------------------

  function ingestionFaults(): readonly ProviderIngestionFault[] {
    return driver.faults().map((fault) => ({
      sessionId: fault.sessionId,
      ...(fault.runId === undefined ? {} : { runId: fault.runId }),
      stage: fault.stage,
      error: structuredClone(fault.error),
      failureCount: fault.failureCount ?? 1,
    }));
  }

  async function retryProviderIngestion(sessionId?: SessionId): Promise<void> {
    if (sessionId !== undefined) {
      const parsed = SessionIdSchema.safeParse(sessionId);
      if (!parsed.success) {
        throw new AgentRuntimeError(agentError('invalid_request', 'session id does not match the required schema'));
      }
      if (driver.knows(parsed.data)) {
        await driver.retry(parsed.data);
        return;
      }
      // A closed, retired session with complete history is healthy.
      if ((await store.read(parsed.data)) !== undefined) return;
      throw new AgentRuntimeError(agentError('unknown_session', `unknown session \`${parsed.data}\``));
    }
    // Every affected session, in session-ID order, each independently; one failure
    // never stops the others. Concurrent retries of one session share its drain.
    const targets = driver.faults().map((fault) => fault.sessionId);
    const attempts = targets.map((target) => driver.retry(target));
    const settled = await Promise.allSettled(attempts);
    const failures = settled.flatMap((result, index) => {
      const target = targets[index];
      if (result.status === 'fulfilled' || target === undefined) return [];
      const cause: unknown = result.reason;
      return [{ sessionId: target, error: toAgentError(cause, 'store_unavailable'), cause }];
    });
    if (failures.length === 0) return;
    const error = agentError(
      'store_unavailable',
      `provider ingestion is still faulted for ${String(failures.length)} session(s)`,
      {
        details: { failures: failures.map(({ sessionId: id, error: failure }) => ({ sessionId: id, error: failure })) },
      },
    );
    throw new AgentRuntimeError(
      { ...error, retryable: failures.every((failure) => failure.error.retryable) },
      {
        cause: new AggregateError(
          failures.map((failure) => failure.cause),
          'provider ingestion retry failed',
        ),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /**
   * Shutdown's internal close of one session. It records no caller receipt
   * (a caller cannot reserve a synthetic ID to suppress it) and resumes a
   * proven-absent head. A session still opening (an open admitted before
   * shutdown, or one whose open bundle is blocked) cannot be closed yet: a
   * blocked open is retried once; an open whose commit outcome is
   * permanently unknown gets its safe cleanup (dispose, then release).
   */
  async function closeForShutdown(sessionId: SessionId): Promise<void> {
    if (driver.inspect(sessionId)?.state === 'opening') {
      const fault = driver.fault(sessionId);
      if (fault?.kind === 'failure') await driver.retry(sessionId).catch(() => undefined);
      if (driver.inspect(sessionId)?.state === 'opening') {
        const blocked = driver.fault(sessionId);
        if (blocked?.kind === 'ambiguous' && blocked.permanent) {
          await abandonOpen(sessionId);
          throw new AgentRuntimeError(blocked.error);
        }
        throw transient('store_unavailable', `session \`${sessionId}\` is still opening`, { sessionId });
      }
    }
    const outcome = await driver.closeSession(sessionId, { ifRunActive: 'interrupt', resume: true });
    if (outcome.kind === 'closed' || (outcome.kind === 'refused' && outcome.reason === 'session-ended')) return;
    throw transient('illegal_state_transition', `session \`${sessionId}\` could not be closed`, { sessionId });
  }

  /** Abandoned opens whose cleanup succeeded, so a later shutdown never repeats it. */
  const abandoned = new Map<SessionId, { disposed: boolean; released: boolean }>();

  /**
   * Safe cleanup of a session whose open commit outcome can never be
   * established: disposal, then release only after a confirmed disposal. Only
   * a failed phase is ever attempted again.
   */
  async function abandonOpen(sessionId: SessionId): Promise<void> {
    const session = live.get(sessionId);
    if (session === undefined) return;
    const state = abandoned.get(sessionId) ?? { disposed: false, released: false };
    abandoned.set(sessionId, state);
    if (!state.disposed) {
      try {
        await session.providerSession.dispose();
        state.disposed = true;
      } catch (error) {
        throw rollbackCleanupError(sessionId, [
          { phase: 'provider_dispose', error: toAgentError(error, 'provider_unavailable'), cause: error },
        ]);
      }
    }
    if (!state.released) {
      try {
        await session.lease.release();
        state.released = true;
      } catch (error) {
        throw rollbackCleanupError(sessionId, [
          { phase: 'workspace_release', error: toAgentError(error, 'workspace_unavailable'), cause: error },
        ]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const runtime: AgentRuntime = {
    registerProvider: (provider) => {
      if (lifecycle !== 'accepting') {
        throw new AgentRuntimeError(agentError('session_closed', `runtime is ${lifecycle.replace('_', ' ')}`));
      }
      registry.register(provider);
    },
    quiesce: () => driver.quiesce(),
    getProviderIngestionFaults: ingestionFaults,
    retryProviderIngestion,

    openSession: (command) => coordinateMutation(command, false, () => openSession(command)),
    submitTurn: (command) => {
      const witness = witnessAtInvocation(command, false);
      return coordinateMutation(command, true, () => submitTurn(command, witness));
    },
    interruptRun: (command) => {
      const witness = witnessAtInvocation(command, true);
      return coordinateMutation(command, true, () => interruptRun(command, witness));
    },
    respondToInteraction: (command) => {
      const witness = witnessAtInvocation(command, false);
      return coordinateMutation(command, true, () => respondToInteraction(command, witness));
    },
    closeSession: (command) => coordinateMutation(command, false, () => closeSession(command)),

    dispatch(rawCommand: AgentCommandInput): Promise<CommandReceipt> {
      const commandType = ownDataString(rawCommand, 'type');
      switch (commandType) {
        case 'open_session':
          return coordinateMutation(rawCommand, false, () => openSession(rawCommand as OpenSessionCommandInput));
        case 'submit_turn': {
          const witness = witnessAtInvocation(rawCommand, false);
          return coordinateMutation(rawCommand, true, () => submitTurn(rawCommand as SubmitTurnCommandInput, witness));
        }
        case 'interrupt_run': {
          const witness = witnessAtInvocation(rawCommand, true);
          return coordinateMutation(rawCommand, true, () =>
            interruptRun(rawCommand as InterruptRunCommandInput, witness),
          );
        }
        case 'respond_to_interaction': {
          const witness = witnessAtInvocation(rawCommand, false);
          return coordinateMutation(rawCommand, true, () =>
            respondToInteraction(rawCommand as RespondToInteractionCommandInput, witness),
          );
        }
        case 'close_session':
          return coordinateMutation(rawCommand, false, () => closeSession(rawCommand as CloseSessionCommandInput));
        default:
          return Promise.reject(
            new AgentRuntimeError(agentError('invalid_request', 'command type is missing or unknown')),
          );
      }
    },

    getSession: (sessionId) => store.read(sessionId),

    async readEvents(sessionId: SessionId, fromSequence: Sequence, limit?: number): Promise<EventPage> {
      // Compare only this session's monotonic event sequence. Receipt commits
      // and other sessions cannot make its page stale.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        driver.ensureReplayReady(sessionId);
        const sequenceBeforeRead = (await store.read(sessionId))?.session.sequence;
        driver.ensureReplayReady(sessionId);
        const page = await store.readEvents(sessionId, fromSequence, limit);
        driver.ensureReplayReady(sessionId);
        const sequenceAfterRead = (await store.read(sessionId))?.session.sequence;
        driver.ensureReplayReady(sessionId);
        if (sequenceBeforeRead === sequenceAfterRead) return page;
      }
      throw new AgentRuntimeError(
        agentError(
          'store_unavailable',
          `session \`${sessionId}\` changed during three history reads; retry the same cursor`,
        ),
      );
    },

    listProviders: () => registry.descriptors(),

    subscribe(request: SubscriptionRequestInput): EventSubscription {
      return hub.subscribe(SubscriptionRequestSchema.parse(request));
    },

    shutdown(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      // Admission closes synchronously; every live session is fenced in this same
      // step, before any await, and no attempt waits on an unresolved provider promise.
      lifecycle = 'shutting_down';
      const sessions = driver.liveSessions();
      const closes = sessions.map((sessionId) =>
        closeForShutdown(sessionId).then(
          () => undefined,
          (error: unknown) => ({ sessionId, error: toAgentError(error, 'internal'), cause: error }),
        ),
      );
      const attempt = (async () => {
        const failures: { sessionId: SessionId; error: AgentError; cause: unknown }[] = [];
        for (const rollback of [...openRollbacks.values()]) {
          try {
            await finishOpenRollback(rollback);
          } catch (error) {
            failures.push({ sessionId: rollback.sessionId, error: toAgentError(error, 'internal'), cause: error });
          }
        }
        for (const failure of await Promise.all(closes)) if (failure !== undefined) failures.push(failure);
        if (failures.length > 0) throw shutdownCleanupError(failures);
        const remaining = driver.liveSessions().length;
        if (remaining > 0 || openRollbacks.size > 0 || opensInFlight > 0) {
          throw new AgentRuntimeError({
            ...agentError(
              'internal',
              `runtime shutdown left ${String(remaining)} live session(s), ${String(openRollbacks.size)} rollback cleanup(s) and ${String(opensInFlight)} open(s) in flight`,
            ),
            retryable: true,
          });
        }
        // Runtime releases only leases it independently validated and tracked;
        // a provider-wide sweep could invoke a suspect mismatched lease.
        hub.closeAll();
        lifecycle = 'shut_down';
      })();
      shutdownPromise = attempt;
      void attempt.catch(() => {
        // Admission stays closed, but the next shutdown call gets a new cleanup
        // attempt after every concurrent observer has received this rejection.
        if (shutdownPromise === attempt) shutdownPromise = undefined;
      });
      return attempt;
    },
  };

  coordinationStates.set(runtime, {
    commandQueues,
    sessionQueues,
    invalidAttempts,
    pendingOpens,
    driver,
  });
  return runtime;
}
