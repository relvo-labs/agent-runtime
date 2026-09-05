/**
 * Capability descriptors.
 *
 * The anti-pattern this replaces is the growing required-boolean bag
 * (`supportsInterrupt`, `supportsResume`, `supportsImages`, …). Booleans cannot
 * express *how* a provider supports something, force every existing adapter to
 * change whenever a new question is asked, and push callers into guessing.
 *
 * A descriptor is a closed, nested structure with defaults, so:
 *   - adding a new dimension is a compatible change (existing adapters get the
 *     conservative default),
 *   - a provider can state a degree of support rather than yes/no,
 *   - `extensions` gives provider-specific facts a home without polluting the
 *     shared shape.
 */

import { z } from 'zod';
import { JsonValueSchema } from './json.ts';

/** How a provider ends a single run without ending the session. */
export const InterruptModeSchema = z.enum([
  /** The run stops promptly; no further semantic output is produced. */
  'immediate',
  /** The provider is asked to stop; output may continue briefly until a safe point. */
  'cooperative',
  /** The provider cannot end a run independently of the session. */
  'unsupported',
]);

export const InterruptCapabilitySchema = z.strictObject({
  mode: InterruptModeSchema,
  /** Whether output already produced before the interrupt is still delivered. */
  deliversPartialOutput: z.boolean().default(true),
  /**
   * Whether the session remains usable for a further run after an interrupt.
   * `false` means the caller must close and reopen — an important limitation
   * that a boolean `supportsInterrupt: true` would have hidden.
   */
  sessionRemainsUsable: z.boolean().default(true),
});

export const StreamingCapabilitySchema = z.strictObject({
  /** Incremental assistant text as the run proceeds. */
  messageDeltas: z.boolean().default(false),
  /** Tool invocations surfaced as they happen rather than only in a summary. */
  toolActivity: z.boolean().default(false),
  /** Token accounting emitted during, not only at the end of, a run. */
  incrementalUsage: z.boolean().default(false),
});

export const RunCapabilitySchema = z.strictObject({
  interrupt: InterruptCapabilitySchema,
  streaming: StreamingCapabilitySchema,
  /** Maximum runs the provider will execute concurrently in one session. */
  maxConcurrentRunsPerSession: z.int().positive().default(1),
});

export const ApprovalModeSchema = z.enum([
  /** Applies to this one request only. */
  'once',
  /** Applies to equivalent requests for the remainder of the session. */
  'session',
  /** Applies to equivalent requests until explicitly revoked. */
  'persistent',
]);

export const ApprovalCapabilitySchema = z.strictObject({
  supported: z.boolean().default(false),
  modes: z.array(ApprovalModeSchema).default([]),
  /**
   * Whether the provider blocks on the approval. If `false`, an approval is
   * advisory after the fact and MUST NOT be presented to a user as a gate.
   */
  blocking: z.boolean().default(true),
});

export const QuestionCapabilitySchema = z.strictObject({
  supported: z.boolean().default(false),
  /** Provider can offer a fixed choice list rather than free text. */
  choices: z.boolean().default(false),
  /** Provider accepts more than one selected choice. */
  multiSelect: z.boolean().default(false),
});

export const InteractionCapabilitySchema = z.strictObject({
  approval: ApprovalCapabilitySchema,
  question: QuestionCapabilitySchema,
  /**
   * Server-side settlement deadline in milliseconds, if the provider imposes
   * one. `null` means the provider waits indefinitely.
   */
  settlementTimeoutMs: z.int().positive().nullable().default(null),
});

export const WorkspaceRequirementSchema = z.enum([
  /** The provider needs a filesystem root to operate on. */
  'directory',
  /** The provider works without any workspace. */
  'none',
]);

export const WorkspaceCapabilitySchema = z.strictObject({
  requires: WorkspaceRequirementSchema,
  /** Ownership kinds this provider is willing to operate against. */
  acceptsOwnership: z.array(z.enum(['borrowed', 'managed'])).default(['borrowed', 'managed']),
  /** Whether the provider writes to the workspace at all. */
  writes: z.boolean().default(true),
});

export const RecoveryCapabilitySchema = z.strictObject({
  /** Provider can export a serialisable record that reconstructs a session. */
  exportsRecoveryRecord: z.boolean().default(false),
  /** Provider can resume from a previously exported record. */
  resumesFromRecoveryRecord: z.boolean().default(false),
});

/** Serializable provider state. Only the named provider interprets `opaque`. */
export const ProviderRecoveryRecordSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  providerVersion: z.string().min(1).max(64),
  wireVersion: z.string().min(1).max(16),
  opaque: JsonValueSchema,
});

export const ProviderDescriptorSchema = z.strictObject({
  /** Stable registry key, e.g. `scripted`, `codex`, `claude-code`. */
  providerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'provider ids are lowercase kebab-case'),
  /** The adapter's own version, for diagnostics. Not the wire version. */
  providerVersion: z.string().min(1).max(64),
  /** The wire version the adapter was built against. */
  wireVersion: z.string().min(1).max(16),
  /** Human-facing label. Never parsed. */
  displayName: z.string().min(1).max(128),

  run: RunCapabilitySchema,
  interaction: InteractionCapabilitySchema,
  workspace: WorkspaceCapabilitySchema,
  recovery: RecoveryCapabilitySchema,

  /**
   * Provider-specific facts that do not belong in the shared shape. Consumers
   * must treat unknown keys as absent, never as an error.
   */
  extensions: z.record(z.string(), JsonValueSchema).default({}),
});

export type InterruptMode = z.infer<typeof InterruptModeSchema>;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type RunCapability = z.infer<typeof RunCapabilitySchema>;
export type InteractionCapability = z.infer<typeof InteractionCapabilitySchema>;
export type WorkspaceCapability = z.infer<typeof WorkspaceCapabilitySchema>;
export type RecoveryCapability = z.infer<typeof RecoveryCapabilitySchema>;
export type ProviderRecoveryRecord = z.infer<typeof ProviderRecoveryRecordSchema>;
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;
export type ProviderDescriptorInput = z.input<typeof ProviderDescriptorSchema>;
