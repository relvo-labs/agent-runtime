import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkChangesets } from './lib/changesets-gate.ts';
import {
  readChangesetStatus,
  readPendingChangesetFiles,
  readGitFacts,
  readWorkspaceInventory,
} from './lib/workspace.ts';
import { runPreflight } from './lib/preflight.ts';
import { fakeRegistry } from './testing/fixtures.ts';

const root = resolve(import.meta.dirname, '../..');
const cli = join(root, 'node_modules/@changesets/cli/bin.js');
const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function write(directory: string, path: string, contents: string): void {
  mkdirSync(resolve(directory, path, '..'), { recursive: true });
  writeFileSync(join(directory, path), contents);
}
function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function changeset(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
}
function fixture(linked = false, intent = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'relvo-changesets-test-'));
  scratch.push(directory);
  write(directory, 'package.json', JSON.stringify({ private: true, packageManager: 'pnpm@11.25.0' }));
  write(directory, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - examples/*\n');
  write(directory, '.gitignore', 'node_modules\n');
  write(
    directory,
    '.changeset/config.json',
    JSON.stringify({
      changelog: false,
      commit: false,
      fixed: [],
      linked: linked ? [['@fixture/a', '@fixture/b']] : [],
      access: 'public',
      baseBranch: 'main',
      updateInternalDependencies: 'patch',
      ignore: [],
    }),
  );
  write(directory, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a', version: '0.1.0' }));
  write(directory, 'packages/a/src/index.js', 'export const value = 1;\n');
  if (intent)
    write(directory, '.changeset/real-intent.md', '---\n"@fixture/a": minor\n---\n\nAdd a useful capability.\n');
  if (linked) {
    write(
      directory,
      'packages/b/package.json',
      JSON.stringify({ name: '@fixture/b', version: '0.1.0', dependencies: { '@fixture/a': 'workspace:^' } }),
    );
    write(
      directory,
      'examples/private/package.json',
      JSON.stringify({ name: '@fixture/private', version: '0.0.0', private: true }),
    );
  }
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  git(directory, 'init', '-b', 'main');
  git(directory, 'add', '.');
  git(
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'baseline with real intent',
  );
  git(directory, 'checkout', '-b', 'version-preparation');
  return directory;
}

it('inventories a real CLI version candidate even though pinned status refuses before JSON', async () => {
  const directory = fixture();
  const version = changeset(directory, 'version');
  expect(version.status, version.stdout + version.stderr).toBe(0);
  expect(
    (JSON.parse(readFileSync(join(directory, 'packages/a/package.json'), 'utf8')) as Record<string, unknown>).version,
  ).toBe('0.2.0');
  const output = join(directory, 'status.json');
  const status = changeset(directory, 'status', `--output=${output}`);
  expect(status.status).toBe(1);
  expect(status.stdout + status.stderr).toContain('no changesets were found');
  expect(existsSync(output)).toBe(false);
  expect(await readChangesetStatus(directory)).toEqual([]);
});

it('inventories real pending releases independently of Git feature coverage', async () => {
  const directory = fixture();
  expect(await readChangesetStatus(directory)).toEqual([
    { name: '@fixture/a', type: 'minor', oldVersion: '0.1.0', newVersion: '0.2.0' },
  ]);
});

it('accepts a committed version transition produced by the pinned CLI', async () => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  git(directory, 'add', '.');
  git(
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'consume version intent',
  );
  expect(await checkChangesets(directory)).toBe('version-only');
});

it('permits release evidence documentation alongside exact version outcomes', async () => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  write(directory, 'packages/a/README.md', 'Deterministic evidence only.\n');
  write(directory, 'docs/release-notes.md', 'Release notes.\n');
  expect(await checkChangesets(directory)).toBe('version-only');
});

it.each([
  ['source changes', 'packages/a/src/index.js', 'export const value = 2;\n'],
  ['root build inputs', 'tsconfig.base.json', '{}'],
  ['tooling source', 'tools/new.ts', 'export const bypass = true;\n'],
  ['source disguised under docs', 'docs/example.ts', 'export const bypass = true;\n'],
  ['new source', 'packages/a/src/new.js', 'export const newValue = 2;\n'],
  ['changed build inputs', 'packages/a/tsconfig.json', '{}'],
  ['unexpected package', 'packages/b/package.json', '{"name":"@fixture/b","version":"0.2.0"}'],
  ['arbitrary version', 'packages/a/package.json', '{"name":"@fixture/a","version":"0.3.0"}'],
  [
    'changed manifest fields',
    'packages/a/package.json',
    '{"name":"@fixture/a","version":"0.2.0","scripts":{"install":"bad"}}',
  ],
  ['renamed package', 'packages/a/package.json', '{"name":"@fixture/renamed","version":"0.2.0"}'],
  ['made private', 'packages/a/package.json', '{"name":"@fixture/a","version":"0.2.0","private":true}'],
  ['new pending intent', '.changeset/new.md', '---\n"@fixture/a": patch\n---\n\nAnother fix.\n'],
  ['empty pending intent', '.changeset/empty.md', '---\n---\n'],
  ['malformed pending intent', '.changeset/bad.md', 'not valid frontmatter'],
])('refuses a version transition with %s', async (_label, path, contents) => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  write(directory, path, contents);
  await expect(checkChangesets(directory)).rejects.toThrow();
});

it('refuses deleted intent without matching bumps', async () => {
  const directory = fixture();
  rmSync(join(directory, '.changeset/real-intent.md'));
  await expect(checkChangesets(directory)).rejects.toThrow('manifest does not match');
});
it('refuses deleted package after consuming intents', async () => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  rmSync(join(directory, 'packages/a'), { recursive: true });
  await expect(checkChangesets(directory)).rejects.toThrow();
});
it('refuses changed planning config alongside versions', async () => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  const path = '.changeset/config.json';
  const config = JSON.parse(readFileSync(join(directory, path), 'utf8')) as Record<string, unknown>;
  write(directory, path, JSON.stringify({ ...config, updateInternalDependencies: 'minor' }));
  await expect(checkChangesets(directory)).rejects.toThrow('planning configuration');
});
it('refuses a version bump with no real baseline intent', async () => {
  const directory = fixture(false, false);
  write(directory, 'packages/a/package.json', '{"name":"@fixture/a","version":"0.2.0"}');
  await expect(checkChangesets(directory)).rejects.toThrow('real baseline intents');
});
it('refuses a zero-intent feature branch from a baseline without intents', async () => {
  const directory = fixture(false, false);
  write(directory, 'packages/a/src/index.js', 'export const value = 2;\n');
  await expect(checkChangesets(directory)).rejects.toThrow('feature coverage failed');
});
it('refuses a dummy empty intent covering source changes', async () => {
  const directory = fixture(false, false);
  write(directory, 'packages/a/src/index.js', 'export const value = 2;\n');
  write(directory, '.changeset/empty.md', '---\n---\n');
  await expect(checkChangesets(directory)).rejects.toThrow('Missing real feature changeset');
});
it('preserves feature coverage with real intent', async () => {
  const directory = fixture();
  write(directory, 'packages/a/src/index.js', 'export const value = 2;\n');
  expect(await checkChangesets(directory)).toBe('feature-coverage');
});
it('does not let unrelated or empty intents cover a feature', async () => {
  const directory = fixture();
  write(directory, 'packages/b/package.json', '{"name":"@fixture/b","version":"0.1.0"}');
  write(directory, '.changeset/empty.md', '---\n---\n');
  await expect(checkChangesets(directory)).rejects.toThrow('Missing real feature changeset');
});
it('fails closed when the configured baseline is unavailable', async () => {
  const directory = fixture();
  git(directory, 'branch', '-D', 'main');
  await expect(checkChangesets(directory)).rejects.toThrow('Cannot prove Changesets baseline');
});
it.each(['---\n---\n', '---\n{}\n---\n\nDocumentation only.\n'])(
  'keeps empty pending files visible to publication even with no release plan (%s)',
  async (contents) => {
    const directory = fixture();
    expect(changeset(directory, 'version').status).toBe(0);
    write(directory, '.changeset/empty.md', contents);
    expect(await readChangesetStatus(directory)).toEqual([]);
    expect(readPendingChangesetFiles(directory)).toContain('empty.md');
    const sha = git(directory, 'rev-parse', 'HEAD');
    const outcome = await runPreflight(
      {
        request: { sourceSha: sha, distTag: 'latest', targets: [{ name: '@fixture/a', version: '0.2.0' }] },
        context: {
          eventName: 'local_nonpublishing_verification',
          ref: git(directory, 'symbolic-ref', 'HEAD'),
          runnerSha: sha,
        },
        git: readGitFacts(directory),
        pendingChangesetFiles: readPendingChangesetFiles(directory),
        changesetReleases: await readChangesetStatus(directory),
        workspace: readWorkspaceInventory(directory),
        artifacts: [],
      },
      fakeRegistry({}),
    );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.findings.map((finding) => finding.code)).toContain('pending_version_intent');
  },
);
it('refuses malformed pending intent during real library inventory', async () => {
  const directory = fixture();
  write(directory, '.changeset/bad.md', 'not valid frontmatter');
  await expect(readChangesetStatus(directory)).rejects.toThrow();
});

it('matches real linked dependency propagation and leaves the private package unchanged', async () => {
  const directory = fixture(true);
  const expected = await readChangesetStatus(directory);
  expect(expected.map((release) => release.name).sort()).toEqual(['@fixture/a', '@fixture/b']);
  expect(changeset(directory, 'version').status).toBe(0);
  for (const release of expected) {
    const path = `packages/${release.name.slice('@fixture/'.length)}/package.json`;
    expect((JSON.parse(readFileSync(join(directory, path), 'utf8')) as Record<string, unknown>).version).toBe(
      release.newVersion,
    );
  }
  expect(
    (JSON.parse(readFileSync(join(directory, 'examples/private/package.json'), 'utf8')) as Record<string, unknown>)
      .version,
  ).toBe('0.0.0');
  expect(await checkChangesets(directory)).toBe('version-only');
});
it('refuses to compare against HEAD instead of the real configured main baseline', async () => {
  const directory = fixture();
  const path = '.changeset/config.json';
  const config = JSON.parse(readFileSync(join(directory, path), 'utf8')) as Record<string, unknown>;
  write(directory, path, JSON.stringify({ ...config, baseBranch: 'HEAD' }));
  await expect(checkChangesets(directory)).rejects.toThrow('baseline must remain main');
});
it('refuses a symlink disguised as release documentation', async () => {
  const directory = fixture();
  expect(changeset(directory, 'version').status).toBe(0);
  symlinkSync('src/index.js', join(directory, 'packages/a/README.md'));
  await expect(checkChangesets(directory)).rejects.toThrow('symlink');
});

it('uses the exact library modules installed for the pinned Changesets 3.0.1 CLI', () => {
  const direct = createRequire(import.meta.url);
  const fromCli = createRequire(direct.resolve('@changesets/cli/package.json'));
  const cliManifest = JSON.parse(readFileSync(direct.resolve('@changesets/cli/package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(cliManifest.version).toBe('3.0.1');
  for (const name of [
    '@changesets/assemble-release-plan',
    '@changesets/config',
    '@changesets/pre',
    '@changesets/read',
    '@manypkg/get-packages',
  ]) {
    expect(direct.resolve(name)).toBe(fromCli.resolve(name));
  }
});

it('refuses a partially applied linked release plan', async () => {
  const directory = fixture(true);
  expect(changeset(directory, 'version').status).toBe(0);
  const path = 'packages/b/package.json';
  const packageJson = JSON.parse(readFileSync(join(directory, path), 'utf8')) as Record<string, unknown>;
  write(directory, path, JSON.stringify({ ...packageJson, version: '0.1.0' }));
  await expect(checkChangesets(directory)).rejects.toThrow('manifest does not match');
});
