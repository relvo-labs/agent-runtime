/**
 * Workspace SPI.
 *
 * A lease, not a path, is the unit of ownership. Handing a provider a bare
 * string loses the one fact that matters — whether this directory is ours to
 * destroy — and that fact cannot be recovered later.
 */

import type {
  Timestamp,
  ExistingWorkspaceSpec,
  ManagedWorkspaceSpec,
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

export type BorrowedWorkspaceLease = Omit<WorkspaceLease, 'ownership'> & { readonly ownership: 'borrowed' };
export type ManagedWorkspaceLease = Omit<WorkspaceLease, 'ownership'> & { readonly ownership: 'managed' };
export type WorkspaceLeaseFor<T extends WorkspaceSpec> = T extends ExistingWorkspaceSpec
  ? BorrowedWorkspaceLease
  : T extends ManagedWorkspaceSpec
    ? ManagedWorkspaceLease
    : WorkspaceLease;

export type WorkspaceProvider = {
  /**
   * Ownership is derived from the spec kind. Runtime still validates the
   * descriptor and cross-checks an out-of-tree implementation before exposure.
   */
  acquire(spec: ExistingWorkspaceSpec): Promise<BorrowedWorkspaceLease>;
  acquire(spec: ManagedWorkspaceSpec): Promise<ManagedWorkspaceLease>;
  acquire(spec: WorkspaceSpec): Promise<WorkspaceLease>;

  /** Release everything this provider still holds. Idempotent. */
  releaseAll(): Promise<readonly WorkspaceReleaseReport[]>;
};
