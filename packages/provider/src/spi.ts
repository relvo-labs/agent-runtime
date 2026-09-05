/**
 * The provider SPI.
 *
 * Three deliberate shapes here:
 *
 *  1. `ProviderSession` and `ProviderRun` are ordinary objects, NOT DTOs. They
 *     hold sockets, child processes and native conversation handles. They are
 *     never serialised and never cross the public boundary. See
 *     docs/adr/ADR-0006.
 *  2. A provider emits through an `EventSink` that accepts only
 *     `ProviderEventInput` — semantic payload. Identity, ordering and time are
 *     the runtime's job.
 *  3. Persistence of provider state, when supported at all, goes through
 *     `exportRecoveryRecord()`, whose `opaque` field is JSON-safe but is
 *     documented as opaque. That keeps the door open for recovery without
 *     making a provider's internals part of the contract.
 */

import type {
  AgentError,
  InteractionResponse,
  JsonObject,
  ProviderDescriptor,
  ProviderEventInput,
  ProviderRecoveryRecord,
  RunTermination,
  TurnInput,
} from '@relvo-labs/agent-protocol';

export type { ProviderRecoveryRecord } from '@relvo-labs/agent-protocol';

/**
 * Where a provider writes its semantic output.
 *
 * `emit` is synchronous and must not throw: a provider losing an event because
 * the sink rejected is worse than the runtime absorbing a malformed one and
 * recording a diagnostic.
 */
export type ProviderEventSink = {
  emit(input: ProviderEventInput): void;
};

/** What the runtime tells a provider about the workspace it may operate in. */
export type ProviderWorkspaceView = {
  /** Absolute, realpath-resolved. */
  readonly root: string;
  /**
   * `borrowed` means the caller owns this directory. A provider may write to it
   * if the caller asked for work that requires writing, but must never treat it
   * as disposable scratch space.
   */
  readonly ownership: 'borrowed' | 'managed';
};

export type ProviderSessionInit = {
  /** Opaque, provider-defined configuration, already JSON-validated as safe. */
  readonly options: JsonObject;
  readonly workspace: ProviderWorkspaceView;
  /**
   * Session-scoped output. Only `diagnostic` payloads belong here; anything
   * about a run goes to that run's own sink, so the runtime never has to guess
   * which run an event came from.
   */
  readonly sink: ProviderEventSink;
};

export type ProviderRunRequest = {
  readonly input: TurnInput;
  /**
   * Run-scoped output. The runtime already knows which run this sink belongs
   * to, which is why a provider never supplies a run id.
   */
  readonly sink: ProviderEventSink;
  /**
   * Opaque runtime-side correlation token for this run. A provider echoes it
   * when raising an interaction so responses can be routed back.
   */
  readonly runRef: string;
};

/**
 * A single provider execution.
 *
 * Not serialisable, not a DTO, and never exposed to a consumer. The runtime
 * holds it for exactly as long as the run is non-terminal.
 */
export type ProviderRun = {
  /**
   * Resolves when the run reaches its terminal outcome. The runtime awaits this
   * to stamp `run.finished`; a provider must settle it exactly once.
   */
  readonly completion: Promise<RunTermination>;

  /**
   * End this run without ending the session.
   *
   * Must be idempotent, and must be safe to call after the run has already
   * terminated (in which case it does nothing). A provider whose descriptor
   * says `interrupt.mode === 'unsupported'` may reject here.
   */
  interrupt(reason?: string): Promise<void>;
};

/** A provider-side conversation. Holds native handles; never serialised. */
export type ProviderSession = {
  /** Begin a run. The provider must not start more than the descriptor allows. */
  startRun(request: ProviderRunRequest): Promise<ProviderRun>;

  /**
   * Deliver a settled interaction. `providerRef` is the token the provider
   * supplied on the corresponding `interaction.requested` payload.
   *
   * Re-delivery of an already-applied response must be a no-op, not a second
   * application.
   */
  respondToInteraction(providerRef: string, response: InteractionResponse): Promise<void>;

  /**
   * Release provider resources. Idempotent.
   *
   * This is NOT a way to cancel a run — use `ProviderRun.interrupt`. Disposing
   * with a run in flight is legal, but the runtime will have interrupted it
   * first.
   */
  dispose(): Promise<void>;

  /**
   * Serialisable state sufficient to reconstruct this session later.
   *
   * Only meaningful when `descriptor.recovery.exportsRecoveryRecord` is true.
   * `opaque` is JSON-safe so it can be persisted, but its internal shape is NOT
   * public API and consumers must not depend on it.
   */
  exportRecoveryRecord?(): Promise<ProviderRecoveryRecord>;
};

/**
 * A provider adapter.
 *
 * Registered with the runtime by id. The runtime depends on this type and never
 * on a concrete implementation — that is what `pnpm dag:check` enforces.
 */
export type AgentProvider = {
  /** Structured capabilities. Read before every capability-gated operation. */
  describe(): ProviderDescriptor;

  createSession(init: ProviderSessionInit): Promise<ProviderSession>;

  /** Optional: reconstruct from a previously exported record. */
  resumeSession?(record: ProviderRecoveryRecord, init: ProviderSessionInit): Promise<ProviderSession>;
};

/**
 * Thrown by a provider to reject an operation with a typed reason.
 *
 * A provider that throws a bare `Error` still works — the runtime maps it to
 * `provider_rejected` — but loses the ability to say *why* in a way a consumer
 * can branch on.
 */
export class ProviderRejection extends Error {
  readonly agentError: AgentError;

  constructor(agentError: AgentError) {
    super(agentError.message);
    this.name = 'ProviderRejection';
    this.agentError = agentError;
  }
}

export function isProviderRejection(value: unknown): value is ProviderRejection {
  return value instanceof ProviderRejection;
}
