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
  AgentCommandSchema,
  CloseSessionCommandSchema,
  InterruptRunCommandSchema,
  OpenSessionCommandSchema,
  RespondToInteractionCommandSchema,
  SubmitTurnCommandSchema,
  ProviderEventInputSchema,
  agentError,
  canonicalCommandFingerprint,
  isCommandAdmissible,
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
  type AgentProvider,
  type ProviderRun,
  type ProviderSession,
} from '@relvo-labs/agent-provider';
import type { WorkspaceLease, WorkspaceProvider } from '@relvo-labs/agent-workspace';

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

/** Live, non-serialisable state. Deliberately never touches the store. */
type LiveSession = {
  readonly sessionId: SessionId;
  readonly provider: AgentProvider;
  readonly descriptor: ProviderDescriptor;
  readonly providerSession: ProviderSession;
  readonly lease: WorkspaceLease;
  /** Non-terminal runs, by our RunId. */
  readonly runs: Map<RunId, ProviderRun>;
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

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? createSystemClock();
  const idFactory = options.idFactory ?? createCounterIdFactory();
  const store: RuntimeStore = options.store ?? createInMemoryStore({ clock, idFactory });
  const registry: ProviderRegistry = createProviderRegistry(options.providers ?? []);
  const hub: SubscriptionHub = createSubscriptionHub({ store, clock });

  const live = new Map<SessionId, LiveSession>();
  /** In-flight internal work, awaited by `quiesce`. */
  const pending = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let commandQueue: Promise<void> = Promise.resolve();

  function serializeCommand<T>(operation: () => Promise<T>): Promise<T> {
    const result = commandQueue.then(operation, operation);
    commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    return {
      commandId: command.commandId,
      commandType: command.type,
      disposition,
      ...(payload.result === undefined ? {} : { result: payload.result }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
      ...(payload.sequence === undefined ? {} : { sequence: payload.sequence }),
      acceptedAt,
    };
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
  ): { ok: true; command: T } | { ok: false; receipt: CommandReceipt } {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { ok: true, command: parsed.data };

    const partial = (raw ?? {}) as { commandId?: string; type?: string };
    return {
      ok: false,
      receipt: {
        commandId: (partial.commandId ?? 'unknown-command') as CommandId,
        commandType: (partial.type ?? 'submit_turn') as CommandReceipt['commandType'],
        disposition: 'rejected',
        error: agentError('invalid_request', parsed.error.issues[0]?.message ?? 'invalid command'),
        acceptedAt: clock.now(),
      },
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

  function sinkFor(sessionId: SessionId, runId: RunId | undefined) {
    return {
      emit(input: ProviderEventInput): void {
        // A provider must never be able to break the runtime by emitting
        // something malformed; the worst outcome is a recorded diagnostic.
        const parsed = ProviderEventInputSchema.safeParse(input);
        track(
          commitAndPublish((tx) => {
            if (!tx.hasSession(sessionId)) return;
            const state = tx.session(sessionId).session.state;
            if (state === 'closed' || state === 'failed') return;

            if (!parsed.success) {
              tx.emit({
                sessionId,
                payload: {
                  type: 'diagnostic',
                  level: 'warning',
                  message: `provider emitted an invalid event: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
                },
              });
              return;
            }

            const payload = parsed.data.payload;

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
              if (!run || run.termination !== undefined) return;
            }

            if (payload.type === 'interaction.requested') {
              if (runId === undefined) return;
              const interactionId = idFactory.next('interaction') as InteractionId;
              const providerRef = payload.providerRef;
              const session = live.get(sessionId);
              const run = tx.session(sessionId).runs.get(runId);
              if (!session || !run) return;
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
          }),
        );
      },
    };
  }

  // -------------------------------------------------------------------------
  // Run supervision
  // -------------------------------------------------------------------------

  function superviseRun(sessionId: SessionId, turnId: TurnId, runId: RunId, providerRun: ProviderRun): void {
    track(
      providerRun.completion
        .then(async (termination) => {
          const stamped = { ...termination, at: clock.now() };
          await commitAndPublish((tx) => {
            if (!tx.hasSession(sessionId)) return;
            const run = tx.session(sessionId).runs.get(runId);
            // Exactly one terminal outcome: if the run is already terminal, the
            // second completion is dropped rather than double-counted.
            if (!run || run.termination !== undefined) return;

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

            tx.emit({ sessionId, runId, payload: { type: 'run.finished', turnId, termination: stamped } });

            const turnState =
              stamped.outcome === 'succeeded'
                ? 'completed'
                : stamped.outcome === 'interrupted'
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
                ...(stamped.error === undefined ? {} : { error: stamped.error }),
              },
            });
          });
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
        })
        .catch(() => {
          live.get(sessionId)?.runs.delete(runId);
        }),
    );
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async function openSession(input: OpenSessionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(OpenSessionCommandSchema, input);
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const duplicate = await store.findReceipt(command.commandId);
    if (duplicate) {
      const fingerprint = canonicalCommandFingerprint(command);
      if (duplicate.fingerprint !== fingerprint) {
        return receipt(
          command,
          'rejected',
          {
            error: agentError(
              'command_id_conflict',
              `command id \`${command.commandId}\` was already used with a different payload`,
            ),
          },
          duplicate.receipt.acceptedAt,
        );
      }
      return { ...duplicate.receipt, disposition: 'duplicate' };
    }

    const acceptedAt = clock.now();
    const sessionId = idFactory.next('session') as SessionId;

    // Acquiring a workspace and a provider session are effects that cannot live
    // inside a store transaction, so they happen first and are rolled back by
    // hand if the commit is impossible.
    let lease: WorkspaceLease | undefined;
    let providerSession: ProviderSession | undefined;
    try {
      const provider = registry.get(command.providerId);
      const descriptor = provider.describe();
      lease = await options.workspaces.acquire(command.workspace);
      const workspaceCapability = canAcceptWorkspace(descriptor, lease.ownership);
      if (!workspaceCapability.ok) throw new AgentRuntimeError(workspaceCapability.error);

      providerSession = await provider.createSession({
        options: command.providerOptions ?? {},
        workspace: { root: lease.root, ownership: lease.ownership },
        sink: sinkFor(sessionId, undefined),
      });

      const session: AgentSession = {
        sessionId,
        state: 'opening',
        providerId: descriptor.providerId,
        wireVersion: WIRE_VERSION,
        workspace: lease.describe(),
        createdAt: acceptedAt,
        sequence: 0 as Sequence,
        turnIds: [],
      };
      const acquiredLease = lease;

      live.set(sessionId, {
        sessionId,
        provider,
        descriptor,
        providerSession,
        lease,
        runs: new Map(),
        interactionRefs: new Map(),
        refToInteraction: new Map(),
        interactionRuns: new Map(),
        turnAttempts: new Map(),
        startingRun: false,
        closing: false,
      });

      const result: CommandResult = { type: 'session_opened', sessionId };
      return await commitAndPublish((tx) => {
        tx.createSession(session);
        tx.emit({
          sessionId,
          payload: {
            type: 'session.opened',
            providerId: descriptor.providerId,
            workspace: acquiredLease.describe(),
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
    } catch (error) {
      live.delete(sessionId);
      await providerSession?.dispose().catch(() => undefined);
      await lease?.release().catch(() => undefined);
      const failure = receipt(command, 'rejected', { error: toAgentError(error, 'internal') }, acceptedAt);
      await store.commit((tx) => {
        tx.recordReceipt(command.commandId, {
          fingerprint: canonicalCommandFingerprint(command),
          receipt: failure,
        });
      });
      return failure;
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
    const parsed = parseCommand(SubmitTurnCommandSchema, input);
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await store.findReceipt(command.commandId);
    if (existing) return dedupe(command, existing);

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
    session.startingRun = true;
    try {
      providerRun = await session.providerSession.startRun({
        input: command.input,
        sink: sinkFor(command.sessionId, runId),
        runRef: runId,
      });
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

    superviseRun(command.sessionId, turnId, runId, providerRun);
    return produced;
  }

  async function interruptRun(input: InterruptRunCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(InterruptRunCommandSchema, input);
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await store.findReceipt(command.commandId);
    if (existing) return dedupe(command, existing);

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
    const parsed = parseCommand(RespondToInteractionCommandSchema, input);
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await store.findReceipt(command.commandId);
    if (existing) return dedupe(command, existing);

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

  async function closeSession(input: CloseSessionCommandInput): Promise<CommandReceipt> {
    const parsed = parseCommand(CloseSessionCommandSchema, input);
    if (!parsed.ok) return parsed.receipt;
    const command = parsed.command;

    const acceptedAt = clock.now();
    const existing = await store.findReceipt(command.commandId);
    if (existing) return dedupe(command, existing);

    const snapshot = await store.read(command.sessionId);
    if (!snapshot) {
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
      return await recordApplied(
        command,
        { type: 'session_closed', sessionId: command.sessionId, interruptedActiveRun: false },
        acceptedAt,
      );
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
    for (const [, providerRun] of activeRuns) {
      try {
        await providerRun.interrupt('session closing');
        interruptedActiveRun = true;
      } catch {
        // A provider that cannot interrupt still gets disposed below.
      }
    }
    await session.providerSession.dispose().catch(() => undefined);

    // Closing the session is the terminal fallback when an adapter cannot
    // interrupt a run independently. Persist the cancellation before releasing
    // the workspace; a late provider completion sees the existing termination
    // and is ignored by `superviseRun`.
    await commitAndPublish((tx) => {
      const record = tx.session(command.sessionId);
      for (const [runId, run] of record.runs) {
        if (run.termination !== undefined) continue;
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
    session.interactionRefs.clear();
    session.refToInteraction.clear();
    session.interactionRuns.clear();

    const release = await session.lease.release();
    live.delete(command.sessionId);

    return await commitAndPublish((tx) => {
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
      tx.recordReceipt(command.commandId, { fingerprint: canonicalCommandFingerprint(command), receipt: value });
      return value;
    });
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
    return { ...existing.receipt, disposition: 'duplicate' };
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
      registry.register(provider);
    },
    quiesce,

    openSession: (command) => serializeCommand(() => openSession(command)),
    submitTurn: (command) => serializeCommand(() => submitTurn(command)),
    interruptRun: (command) => serializeCommand(() => interruptRun(command)),
    respondToInteraction: (command) => serializeCommand(() => respondToInteraction(command)),
    closeSession: (command) => serializeCommand(() => closeSession(command)),

    dispatch(rawCommand: AgentCommandInput): Promise<CommandReceipt> {
      const parsed = parseCommand(AgentCommandSchema, rawCommand);
      if (!parsed.ok) return Promise.resolve(parsed.receipt);
      const command = parsed.command;
      switch (command.type) {
        case 'open_session':
          return serializeCommand(() => openSession(command));
        case 'submit_turn':
          return serializeCommand(() => submitTurn(command));
        case 'interrupt_run':
          return serializeCommand(() => interruptRun(command));
        case 'respond_to_interaction':
          return serializeCommand(() => respondToInteraction(command));
        case 'close_session':
          return serializeCommand(() => closeSession(command));
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

    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const sessionId of [...live.keys()]) {
        await serializeCommand(() =>
          closeSession({
            commandId: `shutdown-${sessionId}` as CommandId,
            type: 'close_session',
            sessionId,
            ifRunActive: 'interrupt',
          }),
        ).catch(() => undefined);
      }
      await quiesce();
      await options.workspaces.releaseAll();
      hub.closeAll();
    },
  };

  return runtime;
}
