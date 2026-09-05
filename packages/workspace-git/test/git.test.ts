import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import { createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
import type { WorkspaceLease } from '@relvo-labs/agent-workspace';
import {
  READ_ONLY_GIT_COMMANDS,
  READ_ONLY_GIT_SUBCOMMANDS,
  assertReadOnly,
  createGitWorkspaceProvider,
  type GitCommand,
} from '../src/index.ts';

/**
 * Force a full mark-compact collection.
 *
 * A provider that keeps every lease it ever issued leaks in a way no
 * behavioural assertion can observe, so reachability has to be tested directly.
 * `gc()` obtained this way is a synchronous, complete collection; the macrotask
 * yields only retire the jobs a `WeakRef` target is specified to survive.
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

const roots: string[] = [];

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('git workspace boundary', () => {
  it('rejects mutating commands against borrowed workspaces', () => {
    expect(() => assertReadOnly(['checkout', 'main'])).toThrow();
    expect(() => assertReadOnly(['config', 'user.name', 'Mallory'])).toThrow();
    expect(() => assertReadOnly(['remote', 'add', 'origin', 'https://example.invalid/repo'])).toThrow();
    expect(() => assertReadOnly(['branch', '--delete', 'main'])).toThrow();
    for (const argv of [
      ['diff', '--output=/tmp/outside'],
      ['show', '--output', '/tmp/outside'],
      ['log', '--ext-diff'],
      ['diff', '--textconv'],
      ['-c', 'core.pager=/tmp/evil', 'status'],
      ['--paginate', 'status'],
      ['status', '--porcelain=v2'],
      ['config', '--get', 'user.name'],
    ]) {
      expect(() => assertReadOnly(argv), argv.join(' ')).toThrow();
    }
    expect(() => assertReadOnly(['status', '--short'])).not.toThrow();
    expect(() => assertReadOnly(['rev-parse', '--verify', 'HEAD'])).not.toThrow();
    expect(() => assertReadOnly(['ls-files', '--cached', '--'])).not.toThrow();
  });

  it('uses only the injected runner and leaves borrowed cleanup empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    await mkdir(borrowed);
    const commands: GitCommand[] = [];
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'unchanged', 'utf8');
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    });
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });
    await expect(provider.git(lease, ['diff', `--output=${outside}`])).rejects.toThrow();
    await expect(provider.git(lease, ['-c', `core.pager=${outside}`, 'status'])).rejects.toThrow();
    expect(commands).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('unchanged');
    await provider.git(lease, ['status', '--short']);
    const report = await lease.release();
    expect(commands).toEqual([{ argv: ['--no-pager', '--no-optional-locks', 'status', '--short'], cwd: lease.root }]);
    expect(report.destructiveOperations).toEqual([]);
  });

  it('keeps public command catalogs deeply frozen and detached from enforcement', async () => {
    expect(Object.isFrozen(READ_ONLY_GIT_COMMANDS)).toBe(true);
    expect(READ_ONLY_GIT_COMMANDS.every((argv) => Object.isFrozen(argv))).toBe(true);
    expect(Object.isFrozen(READ_ONLY_GIT_SUBCOMMANDS)).toBe(true);
    expect(Reflect.set(READ_ONLY_GIT_COMMANDS, '3', ['diff', '--output=/tmp/outside'])).toBe(false);
    expect(Reflect.set(READ_ONLY_GIT_COMMANDS[0] ?? [], '0', 'diff')).toBe(false);
    expect(Reflect.set(READ_ONLY_GIT_SUBCOMMANDS, '0', 'diff')).toBe(false);

    const root = await mkdtemp(join(tmpdir(), 'relvo-git-catalog-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    await mkdir(borrowed);
    const commands: GitCommand[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    });
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });
    await expect(provider.git(lease, ['diff', '--output=/tmp/outside'])).rejects.toThrow();
    expect(commands).toEqual([]);
  });

  it('rejects serialization and prototype tricks and never executes caller-owned argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-argv-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    await mkdir(borrowed);
    const commands: GitCommand[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    });
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });

    const ownToJson = ['diff', '--output=/tmp/outside'];
    Object.defineProperty(ownToJson, 'toJSON', { value: () => ['status', '--short'] });
    const inheritedToJson = ['checkout', 'main'];
    const maliciousPrototype = Object.create(Array.prototype) as object;
    Object.defineProperty(maliciousPrototype, 'toJSON', {
      value: () => ['rev-parse', '--verify', 'HEAD'],
    });
    Object.setPrototypeOf(inheritedToJson, maliciousPrototype);

    await expect(provider.git(lease, ownToJson)).rejects.toThrow();
    await expect(provider.git(lease, inheritedToJson)).rejects.toThrow();
    expect(commands).toEqual([]);
  });

  it('accepts only leases nominally issued by this provider and ignores prototype tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-authority-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    const callerData = join(root, 'caller-data');
    await Promise.all([mkdir(borrowed), mkdir(callerData)]);
    const commands: GitCommand[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    });
    const lease = await provider.acquire({ kind: 'existing', path: borrowed });
    const prototype = Object.getPrototypeOf(lease) as object;
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Reflect.defineProperty(prototype, 'ownership', { get: () => 'managed' })).toBe(false);
    expect(Reflect.defineProperty(prototype, 'root', { get: () => callerData })).toBe(false);
    await expect(provider.git(lease, ['diff', '--output=/tmp/outside'])).rejects.toThrow();
    const forged = {
      leaseId: lease.leaseId,
      ownership: 'borrowed' as const,
      root: borrowed,
      acquiredAt: lease.acquiredAt,
      describe: () => lease.describe(),
      release: () => lease.release(),
    };
    await expect(provider.git(forged, ['status', '--short'])).rejects.toThrow();
    expect(commands).toEqual([]);
  });

  it('revokes Git authority after concurrent release while active leases remain usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-release-authority-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    await mkdir(borrowed);
    const commands: GitCommand[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    });
    const borrowedLease = await provider.acquire({ kind: 'existing', path: borrowed });
    const managedLease = await provider.acquire({ kind: 'managed' });

    await provider.git(borrowedLease, ['status', '--short']);
    await provider.git(managedLease, ['status', '--short']);
    const [first, concurrent] = await Promise.all([borrowedLease.release(), borrowedLease.release()]);
    expect([first.alreadyReleased, concurrent.alreadyReleased].sort()).toEqual([false, true]);
    await expect(provider.git(borrowedLease, ['status', '--short'])).rejects.toThrow();
    expect(commands).toHaveLength(2);

    await provider.git(managedLease, ['status', '--short']);
    await managedLease.release();
    await expect(provider.git(managedLease, ['status', '--short'])).rejects.toThrow();
    expect(commands).toHaveLength(3);
  });

  it('rejects Git while managed release is in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-releasing-authority-test-'));
    roots.push(root);
    const releaseGate = deferred<undefined>();
    const commands: GitCommand[] = [];
    let removals = 0;
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      removeDirectory: async (path) => {
        removals += 1;
        await releaseGate.promise;
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed' });

    const releasing = lease.release();
    const gitDuringRelease = provider.git(lease, ['status', '--short']);
    releaseGate.resolve(undefined);
    await expect(gitDuringRelease).rejects.toThrow();
    await expect(releasing).resolves.toMatchObject({ alreadyReleased: false });
    expect(commands).toEqual([]);
    expect(removals).toBe(1);
  });

  it('restores Git admission and tracking after failed release so a later attempt can succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-release-retry-test-'));
    roots.push(root);
    const commands: GitCommand[] = [];
    let removals = 0;
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      removeDirectory: async (path) => {
        removals += 1;
        if (removals === 1) throw new Error('transient removal failure');
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed' });

    await expect(lease.release()).rejects.toThrow('transient removal failure');
    expect(lease.describe().released).toBe(false);
    await expect(provider.git(lease, ['status', '--short'])).resolves.toMatchObject({ exitCode: 0 });
    await expect(lease.release()).resolves.toMatchObject({ alreadyReleased: false });
    await expect(provider.git(lease, ['status', '--short'])).rejects.toThrow();
    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(removals).toBe(2);
    expect(commands).toHaveLength(1);
  });

  it('releaseAll visits only currently live authorities and forgets successful history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-live-authorities-test-'));
    roots.push(root);
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const released = await provider.acquire({ kind: 'existing', path: firstRoot });
    const live = await provider.acquire({ kind: 'existing', path: secondRoot });

    await released.release();
    const reports = await provider.releaseAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.leaseId).toBe(live.leaseId);
    await expect(provider.releaseAll()).resolves.toEqual([]);
  });

  it('coalesces direct release with releaseAll without double destruction or re-granting authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-release-all-race-test-'));
    roots.push(root);
    const releaseGate = deferred<undefined>();
    let removals = 0;
    const commands: GitCommand[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: (command) => {
        commands.push(command);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      removeDirectory: async (path) => {
        removals += 1;
        await releaseGate.promise;
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed' });

    const direct = lease.release();
    const sweeping = provider.releaseAll();
    await expect(provider.git(lease, ['status', '--short'])).rejects.toThrow();
    releaseGate.resolve(undefined);
    const [directReport, sweepReports] = await Promise.all([direct, sweeping]);
    expect(directReport.alreadyReleased).toBe(false);
    expect(sweepReports).toHaveLength(1);
    expect(sweepReports[0]).toMatchObject({ leaseId: lease.leaseId, alreadyReleased: true });
    expect(removals).toBe(1);
    expect(commands).toEqual([]);
    await expect(provider.git(lease, ['status', '--short'])).rejects.toThrow();
    await expect(provider.releaseAll()).resolves.toEqual([]);
  });

  it('retries a failed release through releaseAll, proving both layers still track it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-sweep-retry-test-'));
    roots.push(root);
    let removals = 0;
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      removeDirectory: async (path) => {
        removals += 1;
        if (removals === 1) throw new Error('transient removal failure');
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const lease = await provider.acquire({ kind: 'managed', name: 'sweep-retry' });

    await expect(lease.release()).rejects.toThrow('transient removal failure');

    // The Git authority and the delegated local lease must both survive the
    // failure, or the outstanding cleanup would be silently dropped.
    const swept = await provider.releaseAll();
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ leaseId: lease.leaseId, alreadyReleased: false });
    expect(removals).toBe(2);

    await expect(provider.releaseAll()).resolves.toEqual([]);
    expect(removals).toBe(2);
  });

  // Scope note: this proves the Git layer itself holds nothing after a
  // successful release. The delegated `LocalLease` behind the authority is not
  // reachable from this package's public surface, so its collectability is
  // asserted directly in `packages/workspace/test/workspace.test.ts`.
  it('retains no reference to a lease released through the Git provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-collectible-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    const stillOpen = join(root, 'still-open');
    await Promise.all([mkdir(borrowed), mkdir(stillOpen)]);
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const active = await provider.acquire({ kind: 'existing', path: stillOpen });

    const released = await (async (): Promise<WeakRef<WorkspaceLease>> => {
      const lease = await provider.acquire({ kind: 'existing', path: borrowed });
      const ref = new WeakRef<WorkspaceLease>(lease);
      await expect(lease.release()).resolves.toMatchObject({ alreadyReleased: false });
      return ref;
    })();
    const stillHeld = new WeakRef<WorkspaceLease>(active);

    await collectGarbage();
    expect(released.deref(), 'a released Git lease must not be retained by the provider').toBeUndefined();
    expect(stillHeld.deref(), 'an unreleased Git lease must stay sweepable').toBe(active);
  });

  it('cleans an owned root when clone setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-git-test-'));
    roots.push(root);
    const removed: string[] = [];
    const provider = createGitWorkspaceProvider({
      baseDirectory: join(root, 'managed'),
      clock: createFixedClock(),
      idFactory: createCounterIdFactory(),
      runGit: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'nope' }),
      removeDirectory: async (path) => {
        removed.push(path);
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    await expect(
      provider.acquire({ kind: 'managed', source: { kind: 'git', remote: 'https://example.invalid/repo' } }),
    ).rejects.toThrow();
    expect(removed).toHaveLength(1);
  });
});
