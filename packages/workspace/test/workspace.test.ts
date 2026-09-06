import { mkdir, mkdtemp, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  WorkspaceLeaseIdSchema,
  createCounterIdFactory,
  createFixedClock,
} from '@relvo-labs/agent-protocol';
import {
  checkRemovable,
  createLocalWorkspaceProvider,
  validateWorkspaceLease,
  type WorkspaceLease,
} from '../src/index.ts';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Force a full mark-compact collection.
 *
 * Reachability is the property under test — a provider that keeps every lease
 * it ever issued is a leak no behavioural assertion can see — so the test needs
 * a real collection rather than a timer or a heuristic. `gc()` obtained this way
 * is a synchronous, complete collection; the macrotask yields around it only
 * retire the jobs that a `WeakRef` target is specified to survive, so this is
 * bounded and deterministic rather than a poll.
 */
async function collectGarbage(): Promise<void> {
  setFlagsFromString('--expose-gc');
  let gc: unknown;
  try {
    gc = runInNewContext('gc');
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
  if (typeof gc !== 'function') throw new TypeError('forced collection is unavailable');
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    (gc as () => void)();
  }
}

/**
 * Capture a rejection without letting a resolution pass silently.
 *
 * `releaseAll()` must reject after a partial sweep, and the *shape* of that
 * rejection is the contract under test, so the test needs the thrown value
 * itself rather than only the fact that it threw.
 */
async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject, but it resolved');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-test-'));
  roots.push(root);
  const baseDirectory = join(root, 'managed');
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const removed: string[] = [];
  const provider = createLocalWorkspaceProvider({
    baseDirectory,
    clock: createFixedClock(),
    idFactory: createCounterIdFactory(),
    removeDirectory: async (path) => {
      removed.push(path);
      const { rm } = await import('node:fs/promises');
      await rm(path, { recursive: true, force: true });
    },
  });
  return { root, baseDirectory, borrowed, removed, provider };
}

describe('workspace ownership', () => {
  it('never deletes a borrowed workspace and reports no destructive operations', async () => {
    const { borrowed, removed, provider } = await fixture();
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });
    const report = await lease.release();
    expect(report.ownership).toBe('borrowed');
    expect(report.destructiveOperations).toEqual([]);
    expect(removed).toEqual([]);
    expect((await stat(borrowed)).isDirectory()).toBe(true);
  });

  it('does not trust caller-mutable lease fields for destructive authorization', async () => {
    const { baseDirectory, borrowed, removed, provider } = await fixture();
    await mkdir(baseDirectory, { recursive: true });
    const callerData = join(baseDirectory, 'caller-data');
    await mkdir(callerData);
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });

    expect(Reflect.set(lease, 'ownership', 'managed')).toBe(false);
    expect(Reflect.set(lease, 'root', callerData)).toBe(false);
    const report = await lease.release();

    expect(report).toMatchObject({ ownership: 'borrowed', destructiveOperations: [] });
    expect(removed).toEqual([]);
    expect((await stat(callerData)).isDirectory()).toBe(true);
    expect((await stat(borrowed)).isDirectory()).toBe(true);
  });

  it('removes only a newly created managed root and is idempotent', async () => {
    const { removed, provider } = await fixture();
    const lease = await provider.acquire({ kind: 'managed', name: 'owned' });
    const first = await lease.release();
    const second = await lease.release();
    expect(first.destructiveOperations).toHaveLength(1);
    expect(second.alreadyReleased).toBe(true);
    expect(removed).toEqual([lease.root]);
  });

  it('performs one destructive operation for concurrent release callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-test-'));
    roots.push(root);
    let removalCount = 0;
    let releaseRemoval!: () => void;
    let removalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      removalEntered = resolve;
    });
    const removalHeld = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async () => {
        removalCount += 1;
        removalEntered();
        await removalHeld;
      },
    });
    const lease = await provider.acquire({ kind: 'managed', name: 'concurrent' });
    const first = lease.release();
    const second = lease.release();
    await entered;
    expect(removalCount).toBe(1);
    releaseRemoval();
    const reports = await Promise.all([first, second]);
    expect(reports.map((report) => report.alreadyReleased)).toEqual([false, true]);
    expect(removalCount).toBe(1);
  });

  it('coalesces a failed concurrent release and permits one later retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-test-'));
    roots.push(root);
    let removalCount = 0;
    let continueFirst!: () => void;
    let removalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      removalEntered = resolve;
    });
    const firstHeld = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async (path) => {
        removalCount += 1;
        if (removalCount === 1) {
          removalEntered();
          await firstHeld;
          throw new Error('first removal failed');
        }
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed', name: 'retryable' });

    const first = lease.release();
    const concurrent = lease.release();
    await entered;
    expect(removalCount).toBe(1);
    continueFirst();
    expect((await Promise.allSettled([first, concurrent])).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);

    const retried = await lease.release();
    const afterSuccess = await lease.release();
    expect(retried.alreadyReleased).toBe(false);
    expect(afterSuccess.alreadyReleased).toBe(true);
    expect(removalCount).toBe(2);
  });

  it('releaseAll visits only leases it still holds and forgets successful ones', async () => {
    const { borrowed, removed, provider } = await fixture();
    const releasedDirectly = await provider.acquire({ kind: 'existing', path: borrowed });
    const managed = await provider.acquire({ kind: 'managed', name: 'still-live' });

    await releasedDirectly.release();

    const reports = await provider.releaseAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.leaseId).toBe(managed.leaseId);
    expect(reports[0]?.alreadyReleased).toBe(false);
    // The forgotten lease must not be swept a second time.
    expect(removed).toEqual([managed.root]);
    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(removed).toEqual([managed.root]);
  });

  it('keeps a failed release tracked for retry and drops it only once it succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-retention-test-'));
    roots.push(root);
    let removalCount = 0;
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async (path) => {
        removalCount += 1;
        if (removalCount === 1) throw new Error('transient removal failure');
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed', name: 'retryable' });

    await expect(lease.release()).rejects.toThrow('transient removal failure');
    // A failed release did not discharge the cleanup duty, so the provider must
    // still hold the lease and releaseAll must retry it.
    const retried = await provider.releaseAll();
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ leaseId: lease.leaseId, alreadyReleased: false });
    expect(removalCount).toBe(2);

    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(removalCount).toBe(2);
  });

  it('sweeps every tracked lease despite failures and aggregates them truthfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-sweep-isolation-test-'));
    roots.push(root);
    const attempts: string[] = [];
    const failing = new Set(['first', 'third']);
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async (path) => {
        const name = basename(path);
        attempts.push(name);
        if (failing.has(name)) throw new Error(`${name} removal failed`);
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const names = ['first', 'second', 'third', 'fourth'] as const;
    const leases = [];
    for (const name of names) leases.push(await provider.acquire({ kind: 'managed', name }));

    const failure = await captureRejection(provider.releaseAll());

    // One unreleasable lease must not starve the cleanup of every later lease.
    expect(attempts).toEqual(['first', 'second', 'third', 'fourth']);
    expect(leases.map((lease) => lease.describe().released)).toEqual([false, true, false, true]);

    expect(failure).toBeInstanceOf(AgentRuntimeError);
    const runtimeError = failure as AgentRuntimeError;
    expect(runtimeError.error.code).toBe('workspace_unavailable');
    expect(runtimeError.error.details).toMatchObject({
      attempted: 4,
      released: 2,
      failed: [leases[0]?.leaseId, leases[2]?.leaseId],
    });
    expect(runtimeError.cause).toBeInstanceOf(AggregateError);
    expect((runtimeError.cause as AggregateError).errors.map((error: unknown) => (error as Error).message)).toEqual([
      'first removal failed',
      'third removal failed',
    ]);

    // Successful leases are forgotten; failed ones stay tracked and retryable.
    failing.clear();
    const retried = await provider.releaseAll();
    expect(attempts).toEqual(['first', 'second', 'third', 'fourth', 'first', 'third']);
    expect(retried.map((report) => report.leaseId)).toEqual([leases[0]?.leaseId, leases[2]?.leaseId]);
    expect(retried.map((report) => report.alreadyReleased)).toEqual([false, false]);

    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(attempts).toHaveLength(6);
  });

  it('coalesces an in-flight release during a failing sweep without duplicating cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-sweep-overlap-test-'));
    roots.push(root);
    const attempts: string[] = [];
    let heldRemovals = 0;
    let releaseRemoval!: () => void;
    let removalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      removalEntered = resolve;
    });
    const removalHeld = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async (path) => {
        const name = basename(path);
        attempts.push(name);
        if (name === 'broken') throw new Error('broken removal failed');
        heldRemovals += 1;
        removalEntered();
        await removalHeld;
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    // `broken` is acquired first so the sweep meets the failure *before* it
    // reaches the lease whose direct release is already in flight.
    const broken = await provider.acquire({ kind: 'managed', name: 'broken' });
    const held = await provider.acquire({ kind: 'managed', name: 'held' });

    const direct = held.release();
    await entered;
    const sweeping = captureRejection(provider.releaseAll());
    releaseRemoval();
    const [directReport, failure] = await Promise.all([direct, sweeping]);

    expect(directReport.alreadyReleased).toBe(false);
    expect(heldRemovals).toBe(1);
    expect(attempts).toEqual(['held', 'broken']);
    expect(failure).toBeInstanceOf(AgentRuntimeError);
    const runtimeError = failure as AgentRuntimeError;
    expect(runtimeError.error.code).toBe('workspace_unavailable');
    expect(runtimeError.error.details).toMatchObject({ attempted: 2, released: 1, failed: [broken.leaseId] });
    expect(held.describe().released).toBe(true);
    expect(broken.describe().released).toBe(false);

    // The coalesced lease is forgotten; only the failure is swept again.
    const second = await captureRejection(provider.releaseAll());
    expect(second).toBeInstanceOf(AgentRuntimeError);
    expect(attempts).toEqual(['held', 'broken', 'broken']);
    expect(heldRemovals).toBe(1);
  });

  it('coalesces a direct release with releaseAll without releasing twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-coalesce-test-'));
    roots.push(root);
    let removalCount = 0;
    let releaseRemoval!: () => void;
    let removalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      removalEntered = resolve;
    });
    const removalHeld = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const provider = createLocalWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      removeDirectory: async () => {
        removalCount += 1;
        removalEntered();
        await removalHeld;
      },
    });
    const lease = await provider.acquire({ kind: 'managed', name: 'coalesced' });

    const direct = lease.release();
    await entered;
    const sweeping = provider.releaseAll();
    releaseRemoval();
    const [directReport, sweepReports] = await Promise.all([direct, sweeping]);
    expect(directReport.alreadyReleased).toBe(false);
    expect(sweepReports).toHaveLength(1);
    expect(sweepReports[0]).toMatchObject({ leaseId: lease.leaseId, alreadyReleased: true });
    expect(removalCount).toBe(1);
    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(removalCount).toBe(1);
  });

  it('makes a successfully released lease collectible while an active one stays held', async () => {
    const { borrowed, provider } = await fixture();
    const active = await provider.acquire({ kind: 'existing', path: borrowed });

    // Acquire, release and drop the only caller-side reference inside a scope
    // the assertion cannot keep alive.
    const released = await (async (): Promise<WeakRef<WorkspaceLease>> => {
      const lease = await provider.acquire({ kind: 'existing', path: borrowed });
      const ref = new WeakRef<WorkspaceLease>(lease);
      const report = await lease.release();
      expect(report.alreadyReleased).toBe(false);
      return ref;
    })();
    const stillHeld = new WeakRef<WorkspaceLease>(active);

    await collectGarbage();
    expect(released.deref(), 'a released lease must not be retained by its provider').toBeUndefined();
    expect(stillHeld.deref(), 'an unreleased lease must stay tracked for releaseAll').toBe(active);
  });

  it('validates and cross-checks third-party lease descriptors', async () => {
    const clock = createFixedClock();
    const leaseId = WorkspaceLeaseIdSchema.parse(createCounterIdFactory().next('workspaceLease'));
    const acquiredAt = clock.now();
    const valid: WorkspaceLease = {
      leaseId,
      ownership: 'borrowed',
      root: '/borrowed',
      acquiredAt,
      describe: () => ({
        leaseId,
        ownership: 'borrowed',
        root: '/borrowed',
        acquiredAt,
        released: false,
      }),
      release: () => Promise.reject(new Error('not called')),
    };
    await expect(validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, valid)).resolves.toMatchObject({
      ownership: 'borrowed',
      root: '/borrowed',
    });

    const mismatched: WorkspaceLease = {
      ...valid,
      ownership: 'managed',
      describe: () => ({ ...valid.describe(), ownership: 'managed' }),
    };
    await expect(validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, mismatched)).rejects.toThrow();
    const malformed: WorkspaceLease = {
      ...valid,
      describe: () => ({ ...valid.describe(), root: 42 }) as never,
    };
    await expect(validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, malformed)).rejects.toThrow();
  });

  it.each(['../escaped', '..', '.', '/absolute', 'nested/name', 'nested\\name'])(
    'runtime-validates hostile managed workspace name %j before filesystem effects',
    async (name) => {
      const { baseDirectory, provider } = await fixture();
      await expect(provider.acquire({ kind: 'managed', name } as never)).rejects.toMatchObject({
        error: { code: 'invalid_request' },
      });
      await expect(stat(baseDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('binds an existing lease root to the requested path realpath', async () => {
    const { root, borrowed } = await fixture();
    const redirected = join(root, 'redirected');
    await mkdir(redirected);
    const clock = createFixedClock();
    const leaseId = WorkspaceLeaseIdSchema.parse(createCounterIdFactory().next('workspaceLease'));
    const acquiredAt = clock.now();
    const lease: WorkspaceLease = {
      leaseId,
      ownership: 'borrowed',
      root: redirected,
      acquiredAt,
      describe: () => ({ leaseId, ownership: 'borrowed', root: redirected, acquiredAt, released: false }),
      release: () => Promise.reject(new Error('must not release redirected borrowed lease')),
    };
    await expect(validateWorkspaceLease({ kind: 'existing', path: borrowed }, lease)).rejects.toMatchObject({
      error: { code: 'workspace_ownership_violation' },
    });
  });

  it('does not claim a pre-existing named directory as managed', async () => {
    const { baseDirectory, provider } = await fixture();
    await mkdir(join(baseDirectory, 'already-there'), { recursive: true });
    await expect(provider.acquire({ kind: 'managed', name: 'already-there' })).rejects.toThrow();
  });

  it('refuses a symlink escape and a shallow target', async () => {
    const { root, baseDirectory } = await fixture();
    await mkdir(baseDirectory, { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    const escape = join(baseDirectory, 'escape');
    await symlink(outside, escape, 'dir');
    expect(
      await checkRemovable({ target: escape, baseDirectory, ownership: 'managed', alreadyReleased: false }),
    ).toMatchObject({ reason: 'the target resolves outside the managed base directory' });
    expect(
      await checkRemovable({ target: '/tmp', baseDirectory: '/', ownership: 'managed', alreadyReleased: false }),
    ).toMatchObject({ reason: 'the target path is too shallow to remove safely' });
  });
});
