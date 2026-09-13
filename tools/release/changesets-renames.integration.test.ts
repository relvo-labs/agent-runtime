import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function write(directory: string, path: string, contents: string): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), contents);
}
function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function commit(directory: string, message: string): void {
  git(directory, 'add', '--all');
  git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message);
}
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'relvo-changesets-renames-'));
  scratch.push(directory);
  write(directory, 'package.json', JSON.stringify({ private: true, packageManager: 'pnpm@11.25.0' }));
  write(directory, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - examples/*\n');
  write(
    directory,
    '.changeset/config.json',
    JSON.stringify({
      changelog: false,
      commit: false,
      fixed: [],
      linked: [],
      access: 'public',
      baseBranch: 'main',
      updateInternalDependencies: 'patch',
      ignore: [],
    }),
  );
  write(directory, '.changeset/real.md', '---\n"@fixture/a": minor\n---\n\nAdd a useful capability.\n');
  write(directory, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a', version: '0.1.0' }));
  write(directory, 'packages/a/src/index.js', 'export const publicValue = 42;\n');
  write(
    directory,
    'examples/app/package.json',
    JSON.stringify({ name: '@fixture/app', private: true, version: '0.0.0' }),
  );
  write(directory, 'examples/app/src/main.js', 'export const privateValue = 41;\n');
  git(directory, 'init', '-b', 'main');
  commit(directory, 'Real baseline with public and private source');
  git(directory, 'checkout', '-b', 'version-preparation');
  const version = spawnSync(process.execPath, [join(root, 'node_modules/@changesets/cli/bin.js'), 'version'], {
    cwd: directory,
    encoding: 'utf8',
  });
  expect(version.status, version.stdout + version.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(directory, 'packages/a/package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(manifest.version).toBe('0.2.0');
  expect(existsSync(join(directory, '.changeset/real.md'))).toBe(false);
  return directory;
}
function expectSourceRefusal(directory: string, source: string): void {
  const result = spawnSync(process.execPath, [join(root, 'tools/repo/check-changesets.ts')], {
    cwd: directory,
    encoding: 'utf8',
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(`Version-only transition includes source/input changes: ${source}`);
}

const routes = [
  { name: 'public source to docs', source: 'packages/a/src/index.js', destination: 'docs/moved-source.md' },
  { name: 'private app source to docs', source: 'examples/app/src/main.js', destination: 'docs/moved-app.md' },
  { name: 'public source to package README', source: 'packages/a/src/index.js', destination: 'packages/a/README.md' },
];
const cases = routes.flatMap((route) =>
  ['unstaged', 'staged', 'committed'].flatMap((state) =>
    ['true', 'copies', 'false'].map((renames) => ({ ...route, state, renames })),
  ),
);

it.each(cases)(
  'refuses $name ($state, diff.renames=$renames) after actual CLI versioning',
  ({ source, destination, state, renames }) => {
    const directory = fixture();
    git(directory, 'config', 'diff.renames', renames);
    mkdirSync(dirname(join(directory, destination)), { recursive: true });
    renameSync(join(directory, source), join(directory, destination));
    if (state === 'staged') git(directory, 'add', '--all');
    if (state === 'committed') commit(directory, 'Version with source moved into documentation');

    // Prove the dangerous Git representation is actually present, rather than
    // merely constructing a deletion that the original guard already refused.
    const diff = git(directory, 'diff', '--name-status', '-z', 'main', '--');
    if (state !== 'unstaged' && renames !== 'false') {
      expect(diff).toContain(`R100\0${source}\0${destination}\0`);
      const names = git(directory, 'diff', '--name-only', '-z', 'main', '--').split('\0');
      expect(names).toContain(destination);
      expect(names).not.toContain(source);
    } else {
      expect(diff).toContain(`D\0${source}\0`);
    }
    expectSourceRefusal(directory, source);
  },
);

it('still refuses an ordinary source deletion after actual CLI versioning', () => {
  const directory = fixture();
  rmSync(join(directory, 'packages/a/src/index.js'));
  commit(directory, 'Version with deleted source');
  expectSourceRefusal(directory, 'packages/a/src/index.js');
});

it('still refuses mixed tooling and version changes against the real fixture main baseline', () => {
  const directory = fixture();
  write(directory, 'tools/repair.ts', 'export const repair = true;\n');
  commit(directory, 'Mixed repair and version preparation');
  expectSourceRefusal(directory, 'tools/repair.ts');
});
