/**
 * The composition root.
 *
 * Depends on protocol + executor + provider SPI + workspace SPI, and on no
 * concrete adapter. Everything non-deterministic — time, ids, providers,
 * workspaces, storage — arrives by injection, which is what lets the contract
 * tests assert exact values instead of matching patterns.
 */

import {
  AgentRuntimeError,
  RUN_STATE_TABLE,
  CommandIdSchema,
  CommandReceiptSchema,
  CloseSessionCommandSchema,
  InterruptRunCommandSchema,
  OpenSessionCommandSchema,
  RespondToInteractionCommandSchema,
  SubmitTurnCommandSchema,
  ProviderEventInputSchema,
  agentError,
  canonicalCommandFingerprint,
  canTransition,
  isCommandAdmissible,
  isJsonValue,
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
  type InteractionId,
  type InterruptRunCommandInput,
  type OpenSessionCommandInput,
  type ProviderDescriptor,
  type ProviderEventInput,
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
  ProviderRunTerminationSchema,
  type AgentProvider,
  type ProviderRun,
  type ProviderSession,
} from '@relvo-labs/agent-provider';
import { validateWorkspaceLease, type WorkspaceLease, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

import { createProviderRegistry, type ProviderRegistry } from './registry.ts';
import { createSubscriptionHub, type SubscriptionHub } from './subscriptions.ts';
import { createInMemoryStore, type RuntimeStore } from './store.ts';

export type AgentRuntimeOptions = {
  readonly workspaces: WorkspaceProvider;
  readonly providers?: readonly AgentProvider[];
  readonly store?: RuntimeStore;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
};

/**
 * The runtime adds two capabilities beyond `AgentExecutor`: registering
 * providers, and waiting for internal work to settle. `quiesce` exists because
 * a run completes on the provider's schedule, and a deterministic test needs a
 * defined point at which "everything that was going to happen, happened".
 */
export type AgentRuntime = AgentExecutor & {
  registerProvider(provider: AgentProvider): void;
  quiesce(): Promise<void>;
};

const coordinationStates = new WeakMap<
  AgentRuntime,
  {
    readonly commandQueues: ReadonlyMap<string, Promise<void>>;
    readonly sessionQueues: ReadonlyMap<string, Promise<void>>;
  }
>();

/** @internal Deterministic keyed-coordination cleanup diagnostic for tests. */
export function coordinationEntryCountForTesting(runtime: AgentRuntime): {
  readonly commands: number;
  readonly sessions: number;
} {
  const state = coordinationStates.get(runtime);
  if (state === undefined) throw new Error('runtime was not created by createAgentRuntime');
  return { commands: state.commandQueues.size, sessions: state.sessionQueues.size };
}

/** Live, non-serialisable state. Deliberately never touches the store. */
type LiveSession = {
  readonly sessionId: SessionId;
  readonly provider: AgentProvider;
  readonly descriptor: ProviderDescriptor;
  readonly providerSession: ProviderSession;
  readonly lease: WorkspaceLease;
  /** Non-terminal runs, by our RunId. */
  readonly runs: Map<RunId, ProviderRun>;
  /** Resolve tracked supervision once close has supplied the terminal fallback. */
  readonly stopSupervision: Map<RunId, () => void>;
  /** InteractionId → the provider's own correlation token. */
  readonly interactionRefs: Map<InteractionId, string>;
  /** Provider ref → InteractionId, for the reverse lookup on emit. */
  readonly refToInteraction: Map<string, InteractionId>;
  /** Which run raised an interaction. */
  readonly interactionRuns: Map<InteractionId, RunId>;
  turnAttempts: Map<TurnId, number>;
  startingRun: boolean;
  closing: boolean;
};

type CommandAttempt = {
  readonly fingerprint: string;
  readonly acceptedAt: Timestamp;
  readonly command: AgentCommand;
};

type OpenRollback = {
  readonly command: Extract<AgentCommand, { type: 'open_session' }>;
  readonly acceptedAt: Timestamp;
  readonly sessionId: SessionId;
  readonly failure: CommandReceipt;
  readonly providerSession?: ProviderSession;
  readonly lease?: WorkspaceLease;
};

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? createSystemClock();
  const idFactory = options.idFactory ?? createCounterIdFactory();
  const store: RuntimeStore = options.store ?? createInMemoryStore({ clock, idFactory });
  const registry: ProviderRegistry = createProviderRegistry(options.providers ?? []);
  const hub: SubscriptionHub = createSubscriptionHub({ store, clock });

  const live = new Map<SessionId, LiveSession>();
  /** In-flight internal work, awaited by `quiesce`. */
  const pending = new Set<Promise<unknown>>();
  const commandQueues = new Map<string, Promise<void>>();
  const sessionQueues = new Map<string, Promise<void>>();
  const commandAttempts = new Map<CommandId, CommandAttempt>();
  const openRollbacks = new Map<CommandId, OpenRollback>();
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

  function coordinateCommand<T>(input: unknown, operation: () => Promise<T>): Promise<T> {
    const candidate =
      typeof input === 'object' && input !== null ? (input as { commandId?: unknown; sessionId?: unknown }) : {};
    const withinSession = (): Promise<T> =>
      typeof candidate.sessionId === 'string'
        ? serializeByKey(sessionQueues, candidate.sessionId, operation)
        : operation();
    return typeof candidate.commandId === 'string'
      ? serializeByKey(commandQueues, candidate.commandId, withinSession)
      : withinSession();
  }

  function coordinateMutation<T>(input: unknown, operation: () => Promise<T>): Promise<T> {
    if (lifecycle !== 'accepting') {
      return Promise.reject(
        new AgentRuntimeError(agentError('session_closed', `runtime is ${lifecycle.replace('_', ' ')}`)),
      );
    }
    return coordinateCommand(input, operation);
  }

  function track(work: Promise<unknown>): void {
    const wrapped = work.finally(() => pending.delete(wrapped));
    pending.add(wrapped);
  }

  async function quiesce(): Promise<void> {
    for (let pass = 0; pass < 100 && pending.size > 0; pass += 1) {
      await Promise.allSettled([...pending]);
    }
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

  function reserveCommandAttempt(command: AgentCommand, acceptedAt: Timestamp): void {
    if (!commandAttempts.has(command.commandId)) {
      commandAttempts.set(command.commandId, {
        fingerprint: canonicalCommandFingerprint(command),
        acceptedAt,
        command,
      });
    }
  }

  function attemptConflict(command: AgentCommand, attempt: CommandAttempt): CommandReceipt | undefined {
    if (attempt.fingerprint === canonicalCommandFingerprint(command)) return undefined;
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
      attempt.acceptedAt,
    );
  }

  async function existingCommandOutcome(command: AgentCommand): Promise<CommandReceipt | undefined> {
    const existing = await store.findReceipt(command.commandId);
    if (existing !== undefined) return dedupe(command, existing);
    const attempt = commandAttempts.get(command.commandId);
    return attempt === undefined ? undefined : attemptConflict(command, attempt);
  }

  type CleanupFailure = {
    readonly phase: 'run_interrupt' | 'provider_dispose' | 'workspace_release';
    readonly error: AgentError;
    readonly cause: unknown;
  };

  function sessionCleanupError(sessionId: SessionId, failures: readonly CleanupFailure[]): AgentRuntimeError {
    const code = failures.some((failure) => failure.phase === 'provider_dispose')
      ? 'provider_unavailable'
      : 'workspace_unavailable';
    return new AgentRuntimeError(
      agentError(code, `session \`${sessionId}\` cleanup did not complete`, {
        details: {
          sessionId,
          failures: failures.map(({ phase, error }) => ({ phase, error })),
        },
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
    const code = failures.some((failure) => failure.error.code === 'provider_unavailable')
      ? 'provider_unavailable'
      : 'workspace_unavailable';
    return new AgentRuntimeError(
      agentError(code, `runtime shutdown could not close ${String(failures.length)} session(s)`, {
        details: {
          failures: failures.map(({ sessionId, error }) => ({ sessionId, error })),
        },
      }),
      {
        cause: new AggregateError(
          failures.map((failure) => failure.cause),
          'runtime shutdown cleanup failed',
        ),
      },
    );
  }

  async function finishOpenRollback(rollback: OpenRollback): Promise<CommandReceipt> {
    const failures: CleanupFailure[] = [];
    if (rollback.providerSession !== undefined) {
      try {
        await rollback.providerSession.dispose();
      } catch (error) {
        failures.push({
          phase: 'provider_dispose',
          error: toAgentError(error, 'provider_unavailable'),
          cause: error,
        });
      }
    }
    if (rollback.lease !== undefined) {
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
    if (failures.length > 0) throw sessionCleanupError(rollback.sessionId, failures);

    await store.commit((tx) => {
      tx.recordReceipt(rollback.command.commandId, {
        fingerprint: canonicalCommandFingerprint(rollback.command),
        receipt: rollback.failure,
      });
    });
    openRollbacks.delete(rollback.command.commandId);
    commandAttempts.delete(rollback.command.commandId);
    return rollback.failure;
  }

  /**
   * Parse caller input into a validated command.
   *
   * Returns a rejection receipt instead of throwing so an invalid command is
   * answered the same way as any other refusal — with a receipt the caller can
   * inspect — rather than as an exception they have to catch.
   */
  type SafeParser<T> = {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } };
  };

  function parseCommand<T extends AgentCommand>(
    schema: SafeParser<T>,
    raw: unknown,
    commandType: T['type'],
  ): { ok: true; command: T } | { ok: false; receipt: CommandReceipt } {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { ok: true, command: parsed.data };

    const partial = (raw ?? {}) as { commandId?: unknown };
    const commandId = CommandIdSchema.safeParse(partial.commandId);
    if (!commandId.success) {
      throw new AgentRuntimeError(agentError('invalid_request', parsed.error.issues[0]?.message ?? 'invalid command'));
    }
    return {
      ok: false,
      receipt: CommandReceiptSchema.parse({
        commandId: commandId.data,
        commandType,
        disposition: 'rejected',
        error: agentError('invalid_request', parsed.error.issues[0]?.message ?? 'invalid command'),
        acceptedAt: clock.now(),
      }),
    };
  }

  async function commitAndPublish<T>(
    mutate: (tx: Parameters<Parameters<RuntimeStore['commit']>[0]>[0]) => T,
  ): Promise<T> {
    const { value, events } = await store.commit(mutate);
    const first = events[0];
    if (first) hub.publish(first.sessionId, events);
    return value;
  }

  // -------------------------------------------------------------------------
  // Provider event ingestion
  // -------------------------------------------------------------------------

  const PRE_ACTIVATION_EVENT_LIMIT = 256;

  type CapturedProviderEvent =
    | { readonly valid: true; readonly input: ProviderEventInput }
    | { readonly valid: false; readonly diagnostic: string };

  function freezeProviderValue<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeProviderValue(child, seen);
    return Object.freeze(value);
  }

  /** Capture validity and values before control returns to provider code. */
  function captureProviderEvent(input: ProviderEventInput): CapturedProviderEvent {
    try {
      if (!isJsonValue(input)) {
        return { valid: false, diagnostic: 'provider emitted an invalid event: input is not acyclic plain JSON data' };
      }
      const parsed = ProviderEventInputSchema.safeParse(input);
      return parsed.success
        ? { valid: true, input: freezeProviderValue(parsed.data) }
        : {
            valid: false,
            diagnostic: `provider emitted an invalid event: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
          };
    } catch {
      return { valid: false, diagnostic: 'provider emitted an invalid event: input could not be inspected safely' };
    }
  }

  async function ingestProviderEvent(
    sessionId: SessionId,
    runId: RunId | undefined,
    captured: CapturedProviderEvent,
  ): Promise<void> {
    // A provider must never be able to break the runtime by emitting
    // something malformed; the worst outcome is a recorded diagnostic.
    await commitAndPublish((tx) => {
      if (!tx.hasSession(sessionId)) return;
      const state = tx.session(sessionId).session.state;
      if (state === 'closed' || state === 'failed') return;

      if (!captured.valid) {
        tx.emit({
          sessionId,
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: captured.diagnostic,
            detail: { code: 'provider_contract_violation' },
          },
        });
        return;
      }

      const payload = captured.input.payload;

      if (runId === undefined && payload.type !== 'diagnostic') {
        tx.emit({
          sessionId,
          payload: {
            type: 'diagnostic',
            level: 'warning',
            message: `provider emitted run-scoped event \`${payload.type}\` on the session sink`,
          },
        });
        return;
      }

      if (runId !== undefined) {
        const run = tx.session(sessionId).runs.get(runId);
        if (!run || (run.termination !== undefined && payload.type !== 'interaction.requested')) return;
      }

      if (payload.type === 'interaction.requested') {
        if (runId === undefined) return;
        const interactionId = idFactory.next('interaction') as InteractionId;
        const providerRef = payload.providerRef;
        const session = live.get(sessionId);
        const run = tx.session(sessionId).runs.get(runId);
        if (!session || !run) return;
        if (run.state !== 'running' && run.state !== 'awaiting_interaction') {
          tx.emit({
            sessionId,
            runId,
            payload: {
              type: 'diagnostic',
              level: 'warning',
              message: `provider contract violation: emitted \`interaction.requested\` while run was ${run.state}; the request was rejected`,
            },
          });
          return;
        }
        if (session.refToInteraction.has(providerRef)) {
          tx.emit({
            sessionId,
            runId,
            payload: {
              type: 'diagnostic',
              level: 'warning',
              message: `provider reused active interaction reference \`${providerRef}\``,
            },
          });
          return;
        }
        session.interactionRefs.set(interactionId, providerRef);
        session.refToInteraction.set(providerRef, interactionId);
        session.interactionRuns.set(interactionId, runId);
        tx.emit({
          sessionId,
          runId,
          payload: {
            type: 'interaction.requested',
            interactionId,
            turnId: run.turnId,
            request: payload.request,
          },
        });
        return;
      }

      tx.emit({
        sessionId,
        ...(runId === undefined ? {} : { runId }),
        payload,
      });
    }).catch(() => {
      // Losing one provider event must not take down the session.
    });
  }

  function stagedSinkFor(sessionId: SessionId, runId: RunId | undefined, owner: 'session' | 'run') {
    let phase: 'staging' | 'draining' | 'active' | 'discarded' = 'staging';
    let accepted = 0;
    let dropped = 0;
    let staged: CapturedProviderEvent[] = [];

    return {
      sink: {
        emit(input: ProviderEventInput): void {
          if (phase === 'discarded') return;
          const captured = captureProviderEvent(input);
          if (phase === 'active') {
            track(ingestProviderEvent(sessionId, runId, captured));
            return;
          }
          if (accepted >= PRE_ACTIVATION_EVENT_LIMIT) {
            dropped += 1;
            return;
          }
          accepted += 1;
          staged.push(captured);
        },
      },
      async activate(): Promise<void> {
        if (phase !== 'staging') return;
        phase = 'draining';
        while (staged.length > 0) {
          const batch = staged;
          staged = [];
          for (const captured of batch) await ingestProviderEvent(sessionId, runId, captured);
        }
        phase = 'active';
        if (dropped > 0) {
          await ingestProviderEvent(
            sessionId,
            runId,
            captureProviderEvent({
              payload: {
                type: 'diagnostic',
                level: 'warning',
                message: `${String(dropped)} provider events exceeded the ${String(PRE_ACTIVATION_EVENT_LIMIT)}-event pre-activation buffer for ${owner}; the deterministic tail was not accepted`,
              },
            }),
          );
        }
      },
      discard(): void {
        phase = 'discarded';
        staged = [];
      },
    };
  }

  // -------------------------------------------------------------------------
  // Run supervision
  // -------------------------------------------------------------------------

  function superviseRun(sessionId: SessionId, turnId: TurnId, runId: RunId, providerRun: ProviderRun): void {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const sessionAtStart = live.get(sessionId);
    sessionAtStart?.stopSupervision.set(runId, stop);

    const settle = async (completion: unknown, rejected: boolean): Promise<void> => {
      await serializeByKey(sessionQueues, sessionId, async () => {
        const parsed = rejected ? undefined : ProviderRunTerminationSchema.safeParse(completion);
        const stamped =
          parsed?.success === true
            ? { ...parsed.data, at: clock.now() }
            : {
                outcome: 'failed' as const,
                at: clock.now(),
                error: agentError(
                  'provider_contract_violation',
                  rejected
                    ? 'provider completion promise rejected instead of returning a terminal outcome'
                    : `provider returned an invalid completion: ${parsed?.error.issues[0]?.message ?? 'schema mismatch'}`,
                ),
              };
        try {
          await commitAndPublish((tx) => {
            if (!tx.hasSession(sessionId)) return;
            const run = tx.session(sessionId).runs.get(runId);
            // Exactly one terminal outcome: if the run is already terminal, the
            // second completion is dropped rather than double-counted.
            if (!run || run.termination !== undefined) return;

            // Validate against the state in which the provider completed. The
            // cancellation events below may resume an awaiting run to running,
            // but that bookkeeping must not make an impossible success valid.
            const termination = canTransition(RUN_STATE_TABLE, run.state, stamped.outcome)
              ? stamped
              : {
                  outcome: 'failed' as const,
                  at: clock.now(),
                  error: agentError(
                    'provider_contract_violation',
                    `provider completed with ${stamped.outcome} while run was ${run.state}`,
                  ),
                };

            for (const interactionId of run.pendingInteractionIds) {
              const interaction = tx.session(sessionId).interactions.get(interactionId);
              if (!interaction || interaction.status === 'settled') continue;
              tx.emit({
                sessionId,
                runId,
                payload: {
                  type: 'interaction.settled',
                  interactionId,
                  turnId: interaction.turnId,
                  settlement: { outcome: 'cancelled', settledAt: clock.now() },
                },
              });
            }

            const current = tx.session(sessionId).runs.get(runId);
            if (current === undefined || current.termination !== undefined) return;

            tx.emit({ sessionId, runId, payload: { type: 'run.finished', turnId, termination } });

            const turnState =
              termination.outcome === 'succeeded'
                ? 'completed'
                : termination.outcome === 'interrupted'
                  ? 'cancelled'
                  : 'failed';
            const output = tx.session(sessionId).turns.get(turnId)?.output;
            tx.emit({
              sessionId,
              payload: {
                type: 'turn.settled',
                turnId,
                state: turnState,
                ...(output === undefined ? {} : { output }),
                ...(termination.outcome === 'failed' ? { error: termination.error } : {}),
              },
            });
          });
        } finally {
          const session = live.get(sessionId);
          if (session) {
            session.runs.delete(runId);
            for (const [interactionId, interactionRunId] of session.interactionRuns) {
              if (interactionRunId !== runId) continue;
              const providerRef = session.interactionRefs.get(interactionId);
              session.interactionRuns.delete(interactionId);
              session.interactionRefs.delete(interactionId);
              if (providerRef !== undefined) session.refToInteraction.delete(providerRef);
            }
          }
        }
      });
    };
    const completion = providerRun.completion.then(
      (completion) => settle(completion, false),
      (error: unknown) => settle(error, true),
    );
    track(
      Promise.race([completion, stopped]).finally(() => {
        const session = live.get(sessionId);
        if (session?.stopSupervision.get(runId) === stop) session.stopSupervision.delete(runId);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async function openSession(input: OpenSessionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(OpenSessionCommandSchema, input, 'open_session');
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;
    const rollback = openRollbacks.get(command.commandId);
    if (rollback !== undefined) return await finishOpenRollback(rollback);

    const acceptedAt = clock.now();
    const sessionId = idFactory.next('session') as SessionId;
    reserveCommandAttempt(command, acceptedAt);

    // Acquiring a workspace and a provider session are effects that cannot live
    // inside a store transaction, so they happen first and are rolled back by
    // hand if the commit is impossible.
    let lease: WorkspaceLease | undefined;
    let leaseSafeToRelease = false;
    let providerSession: ProviderSession | undefined;
    const sessionEvents = stagedSinkFor(sessionId, undefined, 'session');
    try {
      const provider = registry.get(command.providerId);
      const descriptor = registry.descriptor(command.providerId);
      lease = await options.workspaces.acquire(command.workspace);
      leaseSafeToRelease = command.workspace.kind === 'managed' && lease.ownership === 'managed';
      const leaseDescriptor = validateWorkspaceLease(command.workspace, lease);
      leaseSafeToRelease = true;
      const workspaceCapability = canAcceptWorkspace(descriptor, lease.ownership);
      if (!workspaceCapability.ok) throw new AgentRuntimeError(workspaceCapability.error);

      providerSession = await provider.createSession({
        options: command.providerOptions ?? {},
        workspace: { root: lease.root, ownership: lease.ownership },
        sink: sessionEvents.sink,
      });

      const session: AgentSession = {
        sessionId,
        state: 'opening',
        providerId: descriptor.providerId,
        wireVersion: WIRE_VERSION,
        workspace: leaseDescriptor,
        createdAt: acceptedAt,
        sequence: 0 as Sequence,
        turnIds: [],
      };
      live.set(sessionId, {
        sessionId,
        provider,
        descriptor,
        providerSession,
        lease,
        runs: new Map(),
        stopSupervision: new Map(),
        interactionRefs: new Map(),
        refToInteraction: new Map(),
        interactionRuns: new Map(),
        turnAttempts: new Map(),
        startingRun: false,
        closing: false,
      });

      const result: CommandResult = { type: 'session_opened', sessionId };
      const produced = await commitAndPublish((tx) => {
        tx.createSession(session);
        tx.emit({
          sessionId,
          payload: {
            type: 'session.opened',
            providerId: descriptor.providerId,
            workspace: leaseDescriptor,
          },
        });
        const produced = receipt(
          command,
          'applied',
          { result, sequence: tx.session(sessionId).session.sequence },
          acceptedAt,
        );
        tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: produced });
        return produced;
      });
      await sessionEvents.activate();
      commandAttempts.delete(command.commandId);
      return produced;
    } catch (error) {
      sessionEvents.discard();
      live.delete(sessionId);
      const failure = receipt(
        command,
        'rejected',
        { error: isProviderRejection(error) ? error.agentError : toAgentError(error, 'internal') },
        acceptedAt,
      );
      const rollback: OpenRollback = {
        command,
        acceptedAt,
        sessionId,
        failure,
        ...(providerSession === undefined ? {} : { providerSession }),
        ...(!leaseSafeToRelease || lease === undefined ? {} : { lease }),
      };
      openRollbacks.set(command.commandId, rollback);
      return await finishOpenRollback(rollback);
    }
  }

  function requireOpenSession(sessionId: SessionId): LiveSession {
    const session = live.get(sessionId);
    if (!session) {
      throw new AgentRuntimeError(agentError('unknown_session', `unknown session \`${sessionId}\``));
    }
    return session;
  }

  async function submitTurn(input: SubmitTurnCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(SubmitTurnCommandSchema, input, 'submit_turn');
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;

    const snapshot = await store.read(command.sessionId);
    const guard = guardCommand(command, snapshot, 'submit_turn', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);

    const session = requireOpenSession(command.sessionId);
    const activeRun = snapshot?.runs.find(
      (run) => run.state !== 'succeeded' && run.state !== 'failed' && run.state !== 'interrupted',
    );
    if (session.startingRun || session.runs.size > 0 || activeRun !== undefined) {
      return await rejectAndRecord(
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
    }
    const turnId = idFactory.next('turn') as TurnId;
    const runId = idFactory.next('run') as RunId;
    const attempt = (session.turnAttempts.get(turnId) ?? 0) + 1;
    session.turnAttempts.set(turnId, attempt);

    let providerRun: ProviderRun;
    const runEvents = stagedSinkFor(command.sessionId, runId, 'run');
    session.startingRun = true;
    try {
      providerRun = await session.providerSession.startRun({
        input: command.input,
        sink: runEvents.sink,
        runRef: runId,
      });
    } catch (error) {
      runEvents.discard();
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: isProviderRejection(error) ? error.agentError : toAgentError(error, 'provider_rejected') },
          acceptedAt,
        ),
      );
    } finally {
      session.startingRun = false;
    }

    session.runs.set(runId, providerRun);

    const produced = await commitAndPublish((tx) => {
      tx.emit({ sessionId: command.sessionId, payload: { type: 'turn.started', turnId, input: command.input } });
      tx.emit({ sessionId: command.sessionId, runId, payload: { type: 'run.started', turnId, attempt } });
      const value = receipt(
        command,
        'applied',
        {
          result: { type: 'turn_accepted', sessionId: command.sessionId, turnId, runId },
          sequence: tx.session(command.sessionId).session.sequence,
        },
        acceptedAt,
      );
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
      return value;
    });

    await runEvents.activate();
    superviseRun(command.sessionId, turnId, runId, providerRun);
    return produced;
  }

  async function interruptRun(input: InterruptRunCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(InterruptRunCommandSchema, input, 'interrupt_run');
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;

    const snapshot = await store.read(command.sessionId);
    const guard = guardCommand(command, snapshot, 'interrupt_run', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);

    const session = requireOpenSession(command.sessionId);
    const capability = canInterruptRun(session.descriptor);
    if (!capability.ok) {
      return await rejectAndRecord(command, receipt(command, 'rejected', { error: capability.error }, acceptedAt));
    }

    const providerRun = session.runs.get(command.runId);
    // An already-terminal run is not an error: the caller's intent ("this run
    // must not continue") is satisfied. `delivered` reports what happened.
    let delivered = false;
    if (providerRun) {
      try {
        await providerRun.interrupt(command.reason);
        delivered = true;
      } catch (error) {
        return await rejectAndRecord(
          command,
          receipt(
            command,
            'rejected',
            { error: isProviderRejection(error) ? error.agentError : toAgentError(error, 'provider_rejected') },
            acceptedAt,
          ),
        );
      }
    }

    return await commitAndPublish((tx) => {
      const run = tx.session(command.sessionId).runs.get(command.runId);
      if (run && run.termination === undefined && run.state !== 'interrupting') {
        tx.emit({
          sessionId: command.sessionId,
          runId: command.runId,
          payload: { type: 'run.state_changed', from: run.state, to: 'interrupting' },
        });
      }
      const value = receipt(
        command,
        'applied',
        {
          result: { type: 'run_interrupt_requested', sessionId: command.sessionId, runId: command.runId, delivered },
          sequence: tx.session(command.sessionId).session.sequence,
        },
        acceptedAt,
      );
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
      return value;
    });
  }

  async function respondToInteraction(input: RespondToInteractionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(RespondToInteractionCommandSchema, input, 'respond_to_interaction');
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await existingCommandOutcome(command);
    if (existing !== undefined) return existing;

    const snapshot = await store.read(command.sessionId);
    const guard = guardCommand(command, snapshot, 'respond_to_interaction', acceptedAt);
    if (guard) return await rejectAndRecord(command, guard);

    const session = requireOpenSession(command.sessionId);
    const interaction = await store.readInteraction(command.sessionId, command.interactionId);

    if (!interaction) {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('unknown_interaction', `unknown interaction \`${command.interactionId}\``) },
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
            error: agentError(
              'interaction_already_settled',
              `interaction \`${command.interactionId}\` is already settled`,
            ),
          },
          acceptedAt,
        ),
      );
    }

    const interactionRun = snapshot?.runs.find((run) => run.runId === interaction.runId);
    if (
      interactionRun === undefined ||
      interactionRun.state === 'succeeded' ||
      interactionRun.state === 'failed' ||
      interactionRun.state === 'interrupted'
    ) {
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

    const providerRef = session.interactionRefs.get(command.interactionId);
    const runId = session.interactionRuns.get(command.interactionId);
    if (providerRef === undefined || runId === undefined) {
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

    const mismatch = checkResponseAgainstRequest(interaction.request, command.response);
    if (mismatch) {
      return await rejectAndRecord(
        command,
        receipt(command, 'rejected', { error: agentError('invalid_request', mismatch) }, acceptedAt),
      );
    }

    try {
      await session.providerSession.respondToInteraction(providerRef, command.response);
    } catch (error) {
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: isProviderRejection(error) ? error.agentError : toAgentError(error, 'provider_rejected') },
          acceptedAt,
        ),
      );
    }

    return await commitAndPublish((tx) => {
      const current = tx.session(command.sessionId).interactions.get(command.interactionId);
      if (current === undefined || current.status === 'settled') {
        const value = receipt(
          command,
          'rejected',
          { error: agentError('interaction_already_settled', `interaction \`${command.interactionId}\` is settled`) },
          acceptedAt,
        );
        tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
        return value;
      }
      tx.emit({
        sessionId: command.sessionId,
        runId,
        payload: {
          type: 'interaction.settled',
          interactionId: command.interactionId,
          turnId: interaction.turnId,
          settlement: { outcome: 'responded', settledAt: clock.now(), response: command.response },
        },
      });
      const value = receipt(
        command,
        'applied',
        {
          result: { type: 'interaction_settled', sessionId: command.sessionId, interactionId: command.interactionId },
          sequence: tx.session(command.sessionId).session.sequence,
        },
        acceptedAt,
      );
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
      return value;
    });
  }

  async function closeSession(input: CloseSessionCommandInput, internal = false): Promise<CommandReceipt> {
    const parsed = parseCommand(CloseSessionCommandSchema, input, 'close_session');
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    let acceptedAt: Timestamp;
    if (!internal) {
      const existing = await existingCommandOutcome(command);
      if (existing !== undefined) return existing;
      acceptedAt = commandAttempts.get(command.commandId)?.acceptedAt ?? clock.now();
    } else {
      acceptedAt = clock.now();
    }

    const snapshot = await store.read(command.sessionId);
    if (!snapshot) {
      if (internal) {
        throw new AgentRuntimeError(agentError('unknown_session', `unknown session \`${command.sessionId}\``));
      }
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          { error: agentError('unknown_session', `unknown session \`${command.sessionId}\``) },
          acceptedAt,
        ),
      );
    }
    if (snapshot.session.state === 'closed' || snapshot.session.state === 'failed') {
      const result = { type: 'session_closed' as const, sessionId: command.sessionId, interruptedActiveRun: false };
      return internal
        ? receipt(command, 'applied', { result }, acceptedAt)
        : await recordApplied(command, result, acceptedAt);
    }

    const session = requireOpenSession(command.sessionId);
    session.closing = true;

    const activeRuns = [...session.runs.entries()];
    if (activeRuns.length > 0 && command.ifRunActive === 'reject') {
      session.closing = false;
      return await rejectAndRecord(
        command,
        receipt(
          command,
          'rejected',
          {
            error: agentError('invalid_request', 'the session has an active run and `ifRunActive` is `reject`', {
              details: { runIds: activeRuns.map(([runId]) => runId) },
            }),
          },
          acceptedAt,
        ),
      );
    }

    if (!internal) reserveCommandAttempt(command, acceptedAt);

    await commitAndPublish((tx) => {
      const current = tx.session(command.sessionId).session.state;
      if (current !== 'closing') {
        tx.emit({
          sessionId: command.sessionId,
          payload: { type: 'session.state_changed', from: current, to: 'closing' },
        });
      }
    });

    // Interrupt, THEN dispose. Interrupting is what ends the run; disposing is
    // what releases the provider. Using dispose to cancel would lose the run's
    // terminal event.
    let interruptedActiveRun = false;
    const interruptFailures: CleanupFailure[] = [];
    for (const [, providerRun] of activeRuns) {
      try {
        await providerRun.interrupt('session closing');
        interruptedActiveRun = true;
      } catch (error) {
        // Successful provider disposal is still a truthful terminal fallback.
        // Keep the interrupt error in case disposal also fails.
        interruptFailures.push({
          phase: 'run_interrupt',
          error: toAgentError(error, 'provider_unavailable'),
          cause: error,
        });
      }
    }

    const cleanupFailures: CleanupFailure[] = [];
    let providerDisposed = false;
    try {
      await session.providerSession.dispose();
      providerDisposed = true;
    } catch (error) {
      cleanupFailures.push({
        phase: 'provider_dispose',
        error: toAgentError(error, 'provider_unavailable'),
        cause: error,
      });
    }

    let release: Awaited<ReturnType<WorkspaceLease['release']>> | undefined;
    try {
      release = await session.lease.release();
    } catch (error) {
      cleanupFailures.push({
        phase: 'workspace_release',
        error: toAgentError(error, 'workspace_unavailable'),
        cause: error,
      });
    }

    const providerRunsEnded = providerDisposed || interruptFailures.length === 0;
    if (!providerRunsEnded) cleanupFailures.unshift(...interruptFailures);

    // Closing the session is the terminal fallback when interrupt or successful
    // disposal proves the provider-side run has ended. A late provider
    // completion sees the existing termination and is ignored by `superviseRun`.
    if (providerRunsEnded) {
      await commitAndPublish((tx) => {
        const record = tx.session(command.sessionId);
        for (const [runId, run] of record.runs) {
          if (run.termination !== undefined) continue;
          if (run.state !== 'interrupting') {
            tx.emit({
              sessionId: command.sessionId,
              runId,
              payload: { type: 'run.state_changed', from: run.state, to: 'interrupting' },
            });
          }
          for (const interactionId of run.pendingInteractionIds) {
            const interaction = record.interactions.get(interactionId);
            if (!interaction || interaction.status === 'settled') continue;
            tx.emit({
              sessionId: command.sessionId,
              runId,
              payload: {
                type: 'interaction.settled',
                interactionId,
                turnId: interaction.turnId,
                settlement: { outcome: 'cancelled', settledAt: clock.now() },
              },
            });
          }
          const termination = { outcome: 'interrupted' as const, at: clock.now(), reason: 'session closing' };
          tx.emit({
            sessionId: command.sessionId,
            runId,
            payload: { type: 'run.finished', turnId: run.turnId, termination },
          });
          tx.emit({
            sessionId: command.sessionId,
            payload: { type: 'turn.settled', turnId: run.turnId, state: 'cancelled' },
          });
        }
      });
      session.runs.clear();
      for (const stop of session.stopSupervision.values()) stop();
      session.stopSupervision.clear();
      session.interactionRefs.clear();
      session.refToInteraction.clear();
      session.interactionRuns.clear();
    }

    if (cleanupFailures.length > 0) throw sessionCleanupError(command.sessionId, cleanupFailures);
    if (release === undefined) {
      throw new AgentRuntimeError(agentError('workspace_unavailable', 'workspace release produced no report'));
    }

    const produced = await commitAndPublish((tx) => {
      tx.emit({
        sessionId: command.sessionId,
        payload: { type: 'session.closed', reason: 'requested', workspaceRelease: release },
      });
      const value = receipt(
        command,
        'applied',
        {
          result: { type: 'session_closed', sessionId: command.sessionId, interruptedActiveRun },
          sequence: tx.session(command.sessionId).session.sequence,
        },
        acceptedAt,
      );
      if (!internal) {
        tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
      }
      return value;
    });
    live.delete(command.sessionId);
    if (internal) {
      for (const [commandId, attempt] of commandAttempts) {
        if ('sessionId' in attempt.command && attempt.command.sessionId === command.sessionId) {
          commandAttempts.delete(commandId);
        }
      }
    } else {
      commandAttempts.delete(command.commandId);
    }
    return produced;
  }

  // -------------------------------------------------------------------------
  // Shared command plumbing
  // -------------------------------------------------------------------------

  function dedupe(command: AgentCommand, existing: { fingerprint: string; receipt: CommandReceipt }): CommandReceipt {
    if (existing.fingerprint !== canonicalCommandFingerprint(command)) {
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
        existing.receipt.acceptedAt,
      );
    }
    return existing.receipt.disposition === 'rejected'
      ? existing.receipt
      : CommandReceiptSchema.parse({ ...existing.receipt, disposition: 'duplicate' });
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

  async function rejectAndRecord(command: AgentCommand, rejection: CommandReceipt): Promise<CommandReceipt> {
    await store.commit((tx) => {
      tx.recordReceipt(command.commandId, {
        fingerprint: canonicalCommandFingerprint(command),
        receipt: rejection,
      });
    });
    return rejection;
  }

  async function recordApplied(
    command: AgentCommand,
    result: CommandResult,
    acceptedAt: Timestamp,
  ): Promise<CommandReceipt> {
    const value = receipt(command, 'applied', { result }, acceptedAt);
    await store.commit((tx) => {
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
    });
    return value;
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
    quiesce,

    openSession: (command) => coordinateMutation(command, () => openSession(command)),
    submitTurn: (command) => coordinateMutation(command, () => submitTurn(command)),
    interruptRun: (command) => coordinateMutation(command, () => interruptRun(command)),
    respondToInteraction: (command) => coordinateMutation(command, () => respondToInteraction(command)),
    closeSession: (command) => coordinateMutation(command, () => closeSession(command)),

    dispatch(rawCommand: AgentCommandInput): Promise<CommandReceipt> {
      const commandType = (rawCommand as { readonly type?: unknown }).type;
      switch (commandType) {
        case 'open_session':
          return coordinateMutation(rawCommand, () => openSession(rawCommand as OpenSessionCommandInput));
        case 'submit_turn':
          return coordinateMutation(rawCommand, () => submitTurn(rawCommand as SubmitTurnCommandInput));
        case 'interrupt_run':
          return coordinateMutation(rawCommand, () => interruptRun(rawCommand as InterruptRunCommandInput));
        case 'respond_to_interaction':
          return coordinateMutation(rawCommand, () =>
            respondToInteraction(rawCommand as RespondToInteractionCommandInput),
          );
        case 'close_session':
          return coordinateMutation(rawCommand, () => closeSession(rawCommand as CloseSessionCommandInput));
        default:
          return Promise.reject(
            new AgentRuntimeError(agentError('invalid_request', 'command type is missing or unknown')),
          );
      }
    },

    getSession: (sessionId) => store.read(sessionId),

    readEvents(sessionId: SessionId, fromSequence: Sequence, limit?: number): Promise<EventPage> {
      return store.readEvents(sessionId, fromSequence, limit);
    },

    listProviders: () => registry.descriptors(),

    subscribe(request: SubscriptionRequestInput): EventSubscription {
      return hub.subscribe(SubscriptionRequestSchema.parse(request));
    },

    shutdown(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      lifecycle = 'shutting_down';
      const attempt = (async () => {
        while (commandQueues.size > 0 || sessionQueues.size > 0) {
          await Promise.allSettled([...commandQueues.values(), ...sessionQueues.values()]);
        }
        const failures: { sessionId: SessionId; error: AgentError; cause: unknown }[] = [];
        for (const rollback of [...openRollbacks.values()]) {
          try {
            await finishOpenRollback(rollback);
          } catch (error) {
            failures.push({ sessionId: rollback.sessionId, error: toAgentError(error, 'internal'), cause: error });
          }
        }
        for (const sessionId of [...live.keys()]) {
          const command = {
            commandId: `shutdown-${sessionId}` as CommandId,
            type: 'close_session' as const,
            sessionId,
            ifRunActive: 'interrupt' as const,
          };
          try {
            await serializeByKey(sessionQueues, sessionId, () => closeSession(command, true));
          } catch (error) {
            failures.push({ sessionId, error: toAgentError(error, 'internal'), cause: error });
          }
        }
        while (commandQueues.size > 0 || sessionQueues.size > 0) {
          await Promise.allSettled([...commandQueues.values(), ...sessionQueues.values()]);
        }
        if (failures.length > 0) throw shutdownCleanupError(failures);
        if (live.size > 0 || openRollbacks.size > 0) {
          throw new AgentRuntimeError(
            agentError(
              'internal',
              `runtime shutdown left ${String(live.size)} live session(s) and ${String(openRollbacks.size)} rollback cleanup(s)`,
            ),
          );
        }
        await quiesce();
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

  coordinationStates.set(runtime, { commandQueues, sessionQueues });
  return runtime;
}
