import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
import {
  READ_ONLY_GIT_COMMANDS,
  READ_ONLY_GIT_SUBCOMMANDS,
  assertReadOnly,
  createGitWorkspaceProvider,
  type GitCommand,
} from '../src/index.ts';

const roots: string[] = [];

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
