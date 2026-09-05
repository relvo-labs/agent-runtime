import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
import { assertReadOnly, createGitWorkspaceProvider, type GitCommand } from '../src/index.ts';

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
