/**
 * The local-filesystem workspace provider.
 *
 * `existing` specs produce a borrowed lease that this module will never modify.
 * `managed` specs produce a directory created under a base this provider owns,
 * and only that directory may be removed on release.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AgentRuntimeError,
  agentError,
  ownershipFor,
  type Clock,
  type IdFactory,
  type Timestamp,
  type WorkspaceLeaseDescriptor,
  type WorkspaceLeaseId,
  type WorkspaceOwnership,
  type WorkspaceReleaseReport,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';

import { assertRemovable, resolveRealPath } from './safety.ts';
import type { WorkspaceLease, WorkspaceProvider } from './spi.ts';

export type LocalWorkspaceProviderOptions = {
  /** Directory that `managed` workspaces are created under. Must be absolute. */
  readonly baseDirectory: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  /**
   * Injected for tests. Defaults to `fs.rm`. Every call is recorded in the
   * release report regardless of implementation.
   */
  readonly removeDirectory?: (path: string) => Promise<void>;
};

type LeaseRuntime = {
  readonly baseDirectory: string;
  readonly clock: Clock;
  readonly removeDirectory: (path: string) => Promise<void>;
};

class LocalLease implements WorkspaceLease {
  #released = false;
  #report: WorkspaceReleaseReport | undefined;

  // Written out rather than declared as constructor parameter properties:
  // `erasableSyntaxOnly` forbids them, because they are not type-only syntax.
  readonly leaseId: WorkspaceLeaseId;
  readonly ownership: WorkspaceOwnership;
  readonly root: string;
  readonly acquiredAt: Timestamp;
  readonly #options: LeaseRuntime;

  constructor(
    leaseId: WorkspaceLeaseId,
    ownership: WorkspaceOwnership,
    root: string,
    acquiredAt: Timestamp,
    options: LeaseRuntime,
  ) {
    this.leaseId = leaseId;
    this.ownership = ownership;
    this.root = root;
    this.acquiredAt = acquiredAt;
    this.#options = options;
  }

  describe(): WorkspaceLeaseDescriptor {
    return {
      leaseId: this.leaseId,
      ownership: this.ownership,
      root: this.root,
      acquiredAt: this.acquiredAt,
      released: this.#released,
    };
  }

  async release(): Promise<WorkspaceReleaseReport> {
    // Idempotent: a second release replays the first report rather than
    // attempting a second removal.
    if (this.#released && this.#report) {
      return { ...this.#report, alreadyReleased: true };
    }

    const destructiveOperations: string[] = [];

    if (this.ownership === 'managed') {
      await assertRemovable({
        target: this.root,
        baseDirectory: this.#options.baseDirectory,
        ownership: this.ownership,
        alreadyReleased: this.#released,
      });
      await this.#options.removeDirectory(this.root);
      destructiveOperations.push(`rm -rf ${this.root}`);
    }
    // A borrowed lease falls through with an empty operation list. That empty
    // array is the observable form of WS-01.

    this.#released = true;
    this.#report = {
      leaseId: this.leaseId,
      ownership: this.ownership,
      alreadyReleased: false,
      destructiveOperations,
      releasedAt: this.#options.clock.now(),
    };
    return this.#report;
  }
}

export function createLocalWorkspaceProvider(options: LocalWorkspaceProviderOptions): WorkspaceProvider {
  const baseDirectory = resolve(options.baseDirectory);
  const removeDirectory = options.removeDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const leases: LocalLease[] = [];

  const leaseOptions = { baseDirectory, clock: options.clock, removeDirectory };

  async function acquireExisting(path: string): Promise<LocalLease> {
    const root = await resolveRealPath(path);
    let info;
    try {
      info = await stat(root);
    } catch {
      throw new AgentRuntimeError(
        agentError('workspace_unavailable', `existing workspace \`${path}\` does not exist`, { details: { path } }),
      );
    }
    if (!info.isDirectory()) {
      throw new AgentRuntimeError(
        agentError('workspace_unavailable', `existing workspace \`${path}\` is not a directory`, { details: { path } }),
      );
    }
    return new LocalLease(
      options.idFactory.next('workspaceLease') as WorkspaceLeaseId,
      'borrowed',
      root,
      options.clock.now(),
      leaseOptions,
    );
  }

  async function acquireManaged(name: string | undefined): Promise<LocalLease> {
    await mkdir(baseDirectory, { recursive: true });
    // A caller-supplied name is already constrained to one safe segment by the
    // schema; `mkdtemp` covers the unnamed case without a collision risk.
    const created = name === undefined ? await mkdtemp(join(baseDirectory, 'ws-')) : join(baseDirectory, name);
    // A named managed directory must be newly created by this provider. Reusing
    // an existing path would falsely claim ownership and later delete data that
    // predates the lease.
    if (name !== undefined) await mkdir(created, { recursive: false });

    const root = await resolveRealPath(created);
    return new LocalLease(
      options.idFactory.next('workspaceLease') as WorkspaceLeaseId,
      'managed',
      root,
      options.clock.now(),
      leaseOptions,
    );
  }

  return {
    async acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
      const lease = spec.kind === 'existing' ? await acquireExisting(spec.path) : await acquireManaged(spec.name);

      // Cross-check the derived ownership against the spec so a future edit
      // cannot quietly make an `existing` workspace managed.
      if (lease.ownership !== ownershipFor(spec)) {
        throw new AgentRuntimeError(
          agentError('workspace_ownership_violation', 'derived lease ownership does not match the spec kind', {
            details: { specKind: spec.kind, ownership: lease.ownership },
          }),
        );
      }

      leases.push(lease);
      return lease;
    },

    async releaseAll(): Promise<readonly WorkspaceReleaseReport[]> {
      const reports: WorkspaceReleaseReport[] = [];
      for (const lease of leases) reports.push(await lease.release());
      return reports;
    },
  };
}
