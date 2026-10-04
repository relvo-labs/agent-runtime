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

import { z } from 'zod';
import {
  AgentErrorSchema,
  type AgentError,
  type InteractionResponse,
  type JsonObject,
  type ProviderDescriptor,
  type ProviderEventInput,
  type ProviderRecoveryRecord,
  type TurnInput,
} from '@relvo-labs/agent-protocol';

export type { ProviderRecoveryRecord } from '@relvo-labs/agent-protocol';

/**
 * Where a provider writes its semantic output.
 *
 * `emit` is synchronous and must not throw. Providers may emit before
 * `createSession()` or `startRun()` returns. Runtime parses, clones, and freezes
 * each value during this call, then stages the first 256 captured results in
 * order. It commits them only after the owning `session.opened` or `run.started`
 * event. Emissions beyond that bound, or beyond the session's 1,023 unpersisted
 * operations, are refused and mark the session's history permanently incomplete
 * (and the run is interrupted); nothing past the bound is retained. Mutating or
 * reusing `input` after `emit` cannot rewrite an emission or change whether it
 * was valid. Cyclic/non-plain JavaScript input becomes a typed provider-contract
 * diagnostic; it is never staged as an event value, and `emit` remains
 * non-throwing. A sink whose run has finished, or whose session has closed, is
 * stale: its emissions are discarded.
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
 * Provider-owned terminal input. Runtime validates it and adds the terminal
 * timestamp; adapters never manufacture runtime time.
 */
export const ProviderRunTerminationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('succeeded') }),
  z.strictObject({ outcome: z.literal('failed'), error: AgentErrorSchema }),
  z.strictObject({ outcome: z.literal('interrupted'), reason: z.string().max(2000).optional() }),
]);
export type ProviderRunTermination = z.infer<typeof ProviderRunTerminationSchema>;

/**
 * A single provider execution.
 *
 * Not serialisable, not a DTO, and never exposed to a consumer. The runtime
 * holds it for exactly as long as the run is non-terminal.
 */
export type ProviderRun = {
  /**
   * Resolves with a schema-valid, timestamp-free terminal outcome. Runtime
   * parses it, owns the timestamp, and maps rejection or malformed data to one
   * typed failed outcome. A provider must settle it exactly once.
   */
  readonly completion: Promise<ProviderRunTermination>;

  /**
   * End this run without ending the session.
   *
   * Must be idempotent, and must be safe to call after the run has already
   * terminated (in which case it does nothing). A provider whose descriptor
   * says `interrupt.mode === 'unsupported'` should reject with a
   * `ProviderRejection`. If this call fails with anything other than a
   * `ProviderRejection`, the outcome is unknown: the owning `interrupt_run`
   * command's exact retry calls `interrupt()` again for the same run, and the
   * runtime's session close may also call it (`'session closing'`), so a
   * repeated call must not have a second effect.
   */
  interrupt(reason?: string): Promise<void>;
};

/** A provider-side conversation. Holds native handles; never serialised. */
export type ProviderSession = {
  /**
   * Begin a run. The provider must not start more than the descriptor allows.
   * Emitting synchronously through `request.sink` is valid; Runtime preserves
   * those emissions behind the owning run-start event.
   *
   * Idempotency (hard obligation). If this call fails with anything other than
   * a `ProviderRejection`, Runtime treats the outcome as unknown: the provider
   * may already have started the run. Only an exact retry of the same
   * `submit_turn` calls `startRun` again, with the same `runRef`, the same input
   * and the same sink. An adapter must recognize a `runRef` it may already have
   * started and return (or resume) that run rather than start a second one;
   * output emitted during either attempt stays staged, in order, behind the one
   * run start.
   */
  startRun(request: ProviderRunRequest): Promise<ProviderRun>;

  /**
   * Deliver a settled interaction. `providerRef` is the token the provider
   * supplied on the corresponding `interaction.requested` payload.
   *
   * Re-delivery of an already-applied response must be a no-op, not a second
   * application. This includes the exact command retry that follows a failure
   * other than a `ProviderRejection`, whose outcome Runtime treats as unknown.
   */
  respondToInteraction(providerRef: string, response: InteractionResponse): Promise<void>;

  /**
   * Release provider resources. Idempotent, including after a rejected attempt:
   * callers may retry until disposal succeeds.
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

  /**
   * Create a session. Emitting synchronously through `init.sink` is valid;
   * Runtime preserves those emissions behind the owning session-open event.
   */
  createSession(init: ProviderSessionInit): Promise<ProviderSession>;

  /** Optional: reconstruct from a previously exported record. */
  resumeSession?(record: ProviderRecoveryRecord, init: ProviderSessionInit): Promise<ProviderSession>;
};

/**
 * Thrown by a provider to reject an operation with a typed reason.
 *
 * Only a `ProviderRejection` is a definite rejection: Runtime records a
 * rejected receipt carrying this `agentError`, the effect is considered not
 * applied, and a later command with a new ID may try again (an exact retry of
 * the rejected command replays its receipt). Any other failure from `startRun`,
 * `respondToInteraction` or `ProviderRun.interrupt` (a bare `Error`, a
 * transport or native failure, any thrown value) is an unknown outcome: nothing
 * is recorded, the command fails with a retryable `provider_unavailable` and a
 * fixed message (upstream text is never persisted or returned), the run's
 * terminal waits behind it, and only an exact retry of that command delivers
 * the same effect again. Throw a `ProviderRejection` whenever the provider
 * knows the operation did not take effect.
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
