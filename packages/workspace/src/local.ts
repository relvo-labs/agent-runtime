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
  WorkspaceSpecSchema,
  WorkspaceLeaseDescriptorSchema,
  type Clock,
  type IdFactory,
  type Timestamp,
  type WorkspaceLeaseDescriptor,
  type WorkspaceLeaseId,
  type WorkspaceOwnership,
  type WorkspaceReleaseReport,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';

import { assertRemovable, isStrictlyInside, resolveRealPath } from './safety.ts';
import type { BorrowedWorkspaceLease, ManagedWorkspaceLease, WorkspaceLease, WorkspaceProvider } from './spi.ts';

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
  /**
   * Invoked exactly once, after a release has actually succeeded, so the
   * issuing provider can stop holding the lease. A failed release does not
   * fire it: the cleanup duty is still outstanding and must stay sweepable.
   */
  readonly onReleased?: (lease: WorkspaceLease) => void;
};

class LocalLease<O extends WorkspaceOwnership> implements WorkspaceLease {
  #released = false;
  #report: WorkspaceReleaseReport | undefined;
  #releasePromise: Promise<WorkspaceReleaseReport> | undefined;

  readonly #leaseId: WorkspaceLeaseId;
  readonly #ownership: O;
  readonly #root: string;
  readonly #acquiredAt: Timestamp;
  readonly #options: LeaseRuntime;

  constructor(leaseId: WorkspaceLeaseId, ownership: O, root: string, acquiredAt: Timestamp, options: LeaseRuntime) {
    this.#leaseId = leaseId;
    this.#ownership = ownership;
    this.#root = root;
    this.#acquiredAt = acquiredAt;
    this.#options = options;
    // Public fields are accessors over canonical private authority. Freezing
    // prevents callers from shadowing those accessors with forged own fields.
    Object.freeze(this);
  }

  get leaseId(): WorkspaceLeaseId {
    return this.#leaseId;
  }

  get ownership(): O {
    return this.#ownership;
  }

  get root(): string {
    return this.#root;
  }

  get acquiredAt(): Timestamp {
    return this.#acquiredAt;
  }

  describe(): WorkspaceLeaseDescriptor {
    return {
      leaseId: this.#leaseId,
      ownership: this.#ownership,
      root: this.#root,
      acquiredAt: this.#acquiredAt,
      released: this.#released,
    };
  }

  release(): Promise<WorkspaceReleaseReport> {
    if (this.#releasePromise !== undefined) {
      return this.#releasePromise.then((report) => structuredClone({ ...report, alreadyReleased: true }));
    }
    const operation = this.#releaseOnce();
    this.#releasePromise = operation;
    void operation.catch(() => {
      // A failed cleanup did not release the lease. Clear only this attempt so
      // a later caller can retry, while concurrent callers still share it.
      if (!this.#released && this.#releasePromise === operation) this.#releasePromise = undefined;
    });
    return operation.then((report) => structuredClone(report));
  }

  async #releaseOnce(): Promise<WorkspaceReleaseReport> {
    const destructiveOperations: string[] = [];

    if (this.#ownership === 'managed') {
      await assertRemovable({
        target: this.#root,
        baseDirectory: this.#options.baseDirectory,
        ownership: this.#ownership,
        alreadyReleased: this.#released,
      });
      await this.#options.removeDirectory(this.#root);
      destructiveOperations.push(`rm -rf ${this.#root}`);
    }
    // A borrowed lease falls through with an empty operation list. That empty
    // array is the observable form of WS-01.

    this.#released = true;
    this.#report = {
      leaseId: this.#leaseId,
      ownership: this.#ownership,
      alreadyReleased: false,
      destructiveOperations,
      releasedAt: this.#options.clock.now(),
    };
    // Report first, then hand the provider its release notice. The lease itself
    // remains fully usable (later calls still answer `alreadyReleased: true`);
    // it is only the provider's strong reference that is dropped.
    this.#options.onReleased?.(this);
    return this.#report;
  }
}

// The instance is frozen, and the shared accessor/method surface must be too:
// mutating a prototype is otherwise an indirect mutation of every lease view.
Object.freeze(LocalLease.prototype);

/** Validate an out-of-tree provider's lease before Runtime exposes it. */
export async function validateWorkspaceLease(
  spec: WorkspaceSpec,
  lease: WorkspaceLease,
): Promise<WorkspaceLeaseDescriptor> {
  let parsedSpec;
  try {
    parsedSpec = WorkspaceSpecSchema.safeParse(spec);
  } catch (error) {
    throw new AgentRuntimeError(agentError('invalid_request', 'workspace spec could not be inspected safely'), {
      cause: error,
    });
  }
  if (!parsedSpec.success) {
    throw new AgentRuntimeError(
      agentError('invalid_request', parsedSpec.error.issues[0]?.message ?? 'invalid workspace spec'),
    );
  }
  const validatedSpec = parsedSpec.data;
  let raw: unknown;
  try {
    raw = lease.describe();
  } catch (error) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', 'workspace lease describe() threw during acquisition'),
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = WorkspaceLeaseDescriptorSchema.safeParse(raw);
  } catch (error) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', 'workspace lease descriptor could not be inspected safely'),
      { cause: error },
    );
  }
  if (!parsed.success) {
    throw new AgentRuntimeError(
      agentError(
        'workspace_ownership_violation',
        `workspace lease descriptor is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      ),
    );
  }
  const descriptor = parsed.data;
  const expectedOwnership = ownershipFor(validatedSpec);
  const expectedRoot = validatedSpec.kind === 'existing' ? await resolveRealPath(validatedSpec.path) : undefined;
  let handleOwnership: WorkspaceOwnership;
  let handleLeaseId: WorkspaceLeaseId;
  let handleRoot: string;
  let handleAcquiredAt: Timestamp;
  try {
    handleOwnership = lease.ownership;
    handleLeaseId = lease.leaseId;
    handleRoot = lease.root;
    handleAcquiredAt = lease.acquiredAt;
  } catch (error) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', 'workspace lease fields threw during acquisition'),
      { cause: error },
    );
  }
  if (
    handleOwnership !== expectedOwnership ||
    descriptor.ownership !== expectedOwnership ||
    descriptor.leaseId !== handleLeaseId ||
    descriptor.root !== handleRoot ||
    descriptor.acquiredAt !== handleAcquiredAt ||
    (expectedRoot !== undefined &&
      (descriptor.root !== expectedRoot || (await resolveRealPath(handleRoot)) !== expectedRoot)) ||
    descriptor.released
  ) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', 'workspace lease does not match the requested spec or live handle', {
        details: {
          specKind: validatedSpec.kind,
          expectedOwnership,
          handleOwnership,
          descriptorOwnership: descriptor.ownership,
        },
      }),
    );
  }
  return Object.freeze(descriptor);
}

export function createLocalWorkspaceProvider(options: LocalWorkspaceProviderOptions): WorkspaceProvider {
  const baseDirectory = resolve(options.baseDirectory);
  const removeDirectory = options.removeDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }));
  /**
   * Leases whose cleanup duty is still outstanding.
   *
   * A set, not an array, and entries are removed once a release has succeeded.
   * A long-lived provider — the delegate inside `createGitWorkspaceProvider` is
   * one — would otherwise pin every lease it ever issued for the lifetime of
   * the process, and `releaseAll()` would re-walk a growing history of leases
   * that have nothing left to release.
   */
  const outstanding = new Set<WorkspaceLease>();

  const leaseOptions: LeaseRuntime = {
    baseDirectory,
    clock: options.clock,
    removeDirectory,
    onReleased: (lease) => {
      outstanding.delete(lease);
    },
  };

  async function acquireExisting(path: string): Promise<LocalLease<'borrowed'>> {
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

  async function acquireManaged(name: string | undefined): Promise<LocalLease<'managed'>> {
    await mkdir(baseDirectory, { recursive: true });
    const realBase = await resolveRealPath(baseDirectory);
    // A caller-supplied name is already constrained to one safe segment by the
    // schema; `mkdtemp` covers the unnamed case without a collision risk.
    const created = name === undefined ? await mkdtemp(join(realBase, 'ws-')) : join(realBase, name);
    // A named managed directory must be newly created by this provider. Reusing
    // an existing path would falsely claim ownership and later delete data that
    // predates the lease.
    if (name !== undefined) await mkdir(created, { recursive: false });

    const root = await resolveRealPath(created);
    if (!isStrictlyInside(realBase, root)) {
      throw new AgentRuntimeError(
        agentError('workspace_ownership_violation', 'managed workspace resolved outside its configured base'),
      );
    }
    return new LocalLease(
      options.idFactory.next('workspaceLease') as WorkspaceLeaseId,
      'managed',
      root,
      options.clock.now(),
      leaseOptions,
    );
  }

  function acquire(spec: Extract<WorkspaceSpec, { kind: 'existing' }>): Promise<BorrowedWorkspaceLease>;
  function acquire(spec: Extract<WorkspaceSpec, { kind: 'managed' }>): Promise<ManagedWorkspaceLease>;
  function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease>;
  async function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
    let parsed;
    try {
      parsed = WorkspaceSpecSchema.safeParse(spec);
    } catch (error) {
      throw new AgentRuntimeError(agentError('invalid_request', 'workspace spec could not be inspected safely'), {
        cause: error,
      });
    }
    if (!parsed.success) {
      throw new AgentRuntimeError(
        agentError('invalid_request', parsed.error.issues[0]?.message ?? 'invalid workspace spec'),
      );
    }
    const validated = parsed.data;
    const lease =
      validated.kind === 'existing' ? await acquireExisting(validated.path) : await acquireManaged(validated.name);

    // Cross-check the derived ownership against the spec so a future edit
    // cannot quietly make an `existing` workspace managed.
    if (lease.ownership !== ownershipFor(validated)) {
      throw new AgentRuntimeError(
        agentError('workspace_ownership_violation', 'derived lease ownership does not match the spec kind', {
          details: { specKind: validated.kind, ownership: lease.ownership },
        }),
      );
    }

    outstanding.add(lease);
    return lease;
  }

  return {
    acquire,

    async releaseAll(): Promise<readonly WorkspaceReleaseReport[]> {
      const reports: WorkspaceReleaseReport[] = [];
      // Snapshot the live set: a successful release removes its own entry, and
      // a release already in flight is coalesced by the lease itself.
      for (const lease of [...outstanding]) reports.push(await lease.release());
      return reports;
    },
  };
}
