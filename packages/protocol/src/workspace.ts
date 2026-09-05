/**
 * Workspace specification and lease DTOs.
 *
 * The single most important distinction here is ownership, and it is fixed at
 * acquisition time:
 *
 *   existing → borrowed  the caller's directory. The runtime reads and lets the
 *                        provider write, but NEVER creates or destroys it.
 *   managed  → managed   the runtime created it under a base directory it
 *                        controls, and may remove exactly that root on release.
 *
 * There is no promotion path. A caller cannot opt a borrowed directory into
 * cleanup, because the accident that would cause is unrecoverable.
 */

import { z } from 'zod';
import { TimestampSchema, WorkspaceLeaseIdSchema } from './ids.ts';

export const WorkspaceOwnershipSchema = z.enum(['borrowed', 'managed']);
export type WorkspaceOwnership = z.infer<typeof WorkspaceOwnershipSchema>;

export const ExistingWorkspaceSpecSchema = z.strictObject({
  kind: z.literal('existing'),
  /** Absolute path supplied by the caller. */
  path: z.string().min(1),
});

export const ManagedWorkspaceSpecSchema = z.strictObject({
  kind: z.literal('managed'),
  /**
   * Optional stable name so a caller can find the directory. Constrained to a
   * single safe path segment: no separators, no traversal, no dotfiles.
   */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a workspace name must be a single safe path segment')
    .refine((value) => value !== '.' && value !== '..', 'a workspace name must not be a traversal segment')
    .optional(),
  /** Optional seed content, e.g. a git source. Interpreted by the provider. */
  source: z
    .strictObject({
      kind: z.literal('git'),
      remote: z.string().min(1),
      ref: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith('-'), 'a git ref must not begin with `-`')
        .optional(),
    })
    .optional(),
});

export const WorkspaceSpecSchema = z.discriminatedUnion('kind', [
  ExistingWorkspaceSpecSchema,
  ManagedWorkspaceSpecSchema,
]);

export type ExistingWorkspaceSpec = z.infer<typeof ExistingWorkspaceSpecSchema>;
export type ManagedWorkspaceSpec = z.infer<typeof ManagedWorkspaceSpecSchema>;
export type WorkspaceSpec = z.infer<typeof WorkspaceSpecSchema>;

/** Ownership is derived, never supplied by the caller. */
export function ownershipFor(spec: WorkspaceSpec): WorkspaceOwnership {
  return spec.kind === 'existing' ? 'borrowed' : 'managed';
}

export const WorkspaceLeaseDescriptorSchema = z.strictObject({
  leaseId: WorkspaceLeaseIdSchema,
  ownership: WorkspaceOwnershipSchema,
  /** Absolute, realpath-resolved root the provider may operate in. */
  root: z.string().min(1),
  acquiredAt: TimestampSchema,
  /** True once `release()` has completed. */
  released: z.boolean().default(false),
});

export type WorkspaceLeaseDescriptor = z.infer<typeof WorkspaceLeaseDescriptorSchema>;

/**
 * What a release actually did.
 *
 * `destructiveOperations` exists so the safety property is *observable* rather
 * than merely asserted in a comment: for a borrowed lease this array is empty,
 * and that is a tested invariant (WS-01).
 */
export const WorkspaceReleaseReportSchema = z.strictObject({
  leaseId: WorkspaceLeaseIdSchema,
  ownership: WorkspaceOwnershipSchema,
  /** True when the lease had already been released; nothing was done. */
  alreadyReleased: z.boolean().default(false),
  /** Human-readable record of every destructive action performed. */
  destructiveOperations: z.array(z.string()).default([]),
  releasedAt: TimestampSchema,
});

export type WorkspaceReleaseReport = z.infer<typeof WorkspaceReleaseReportSchema>;
