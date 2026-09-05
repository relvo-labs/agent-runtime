import { mkdir, mkdtemp, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceLeaseIdSchema, createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
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

  it('validates and cross-checks third-party lease descriptors', () => {
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
    expect(validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, valid)).toMatchObject({
      ownership: 'borrowed',
      root: '/borrowed',
    });

    const mismatched: WorkspaceLease = {
      ...valid,
      ownership: 'managed',
      describe: () => ({ ...valid.describe(), ownership: 'managed' }),
    };
    expect(() => validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, mismatched)).toThrow();
    const malformed: WorkspaceLease = {
      ...valid,
      describe: () => ({ ...valid.describe(), root: 42 }) as never,
    };
    expect(() => validateWorkspaceLease({ kind: 'existing', path: '/borrowed' }, malformed)).toThrow();
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
