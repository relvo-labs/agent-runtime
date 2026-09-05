/**
 * Workspace SPI.
 *
 * A lease, not a path, is the unit of ownership. Handing a provider a bare
 * string loses the one fact that matters — whether this directory is ours to
 * destroy — and that fact cannot be recovered later.
 */

import type {
  Timestamp,
  WorkspaceLeaseDescriptor,
  WorkspaceLeaseId,
  WorkspaceOwnership,
  WorkspaceReleaseReport,
  WorkspaceSpec,
} from '@relvo-labs/agent-protocol';

export type WorkspaceLease = {
  readonly leaseId: WorkspaceLeaseId;
  readonly ownership: WorkspaceOwnership;
  /** Absolute and `realpath`-resolved, so path comparisons are meaningful. */
  readonly root: string;
  readonly acquiredAt: Timestamp;

  /** JSON-safe view for events and projections. */
  describe(): WorkspaceLeaseDescriptor;

  /**
   * Release the lease.
   *
   * MUST be idempotent. For `borrowed` ownership this performs no destructive
   * operation, and the returned report proves it with an empty
   * `destructiveOperations` array.
   */
  release(): Promise<WorkspaceReleaseReport>;
};

export type WorkspaceProvider = {
  /** Ownership is derived from the spec kind, never supplied by the caller. */
  acquire(spec: WorkspaceSpec): Promise<WorkspaceLease>;

  /** Release everything this provider still holds. Idempotent. */
  releaseAll(): Promise<readonly WorkspaceReleaseReport[]>;
};
