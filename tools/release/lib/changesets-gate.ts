import { isDeepStrictEqual } from 'node:util';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { readChangesetState } from './changesets.ts';
import { readPendingChangesetFiles, runCommand } from './workspace.ts';

function git(root: string, ...args: string[]): string {
  const result = runCommand('git', args, root);
  if (result.code !== 0) throw new Error(`Cannot prove Changesets baseline: ${result.stderr}`);
  return result.stdout;
}
function paths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}
function manifest(root: string, path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;
}

/**
 * Materialize only baseline metadata, never executable source or a Git ref. Planning
 * uses the installed, locked libraries; it neither checks out nor versions the user tree.
 */
function baselineMetadata(root: string, base: string, destination: string): void {
  const files = paths(git(root, 'ls-tree', '-r', '--name-only', '-z', base));
  for (const path of files) {
    if (!(
      path === 'package.json' ||
      path === 'pnpm-workspace.yaml' ||
      path.startsWith('.changeset/') ||
      path.endsWith('/package.json')
    ))
      continue;
    const target = resolve(destination, path);
    if (!target.startsWith(`${destination}/`)) throw new Error('Invalid baseline metadata path');
    const mode = git(root, 'ls-tree', base, '--', path).split(' ')[0];
    if (mode !== '100644' && mode !== '100755') throw new Error(`Non-regular baseline metadata: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(root, 'show', `${base}:${path}`));
  }
}

export async function checkChangesets(root: string): Promise<'feature-coverage' | 'version-only'> {
  const current = await readChangesetState(root);
  if (current.config.baseBranch !== 'main') throw new Error('Changesets baseline must remain main');
  const base = git(root, 'merge-base', current.config.baseBranch, 'HEAD').trim();
  const changed = new Set([
    ...paths(git(root, 'diff', '--name-only', '-z', base, '--')),
    ...paths(git(root, 'ls-files', '--others', '--exclude-standard', '-z')),
  ]);
  const scratch = mkdtempSync(join(tmpdir(), 'relvo-changesets-baseline-'));
  try {
    baselineMetadata(root, base, scratch);
    const baseline = await readChangesetState(scratch);
    const before = new Map(baseline.packages.packages.map((pkg) => [relative(scratch, pkg.dir), pkg]));
    const after = new Map(current.packages.packages.map((pkg) => [relative(root, pkg.dir), pkg]));
    const removedIntents = readPendingChangesetFiles(scratch).filter(
      (file) => !readPendingChangesetFiles(root).includes(file),
    );
    const versionChanged = [...before].some(
      ([dir, pkg]) => after.get(dir)?.packageJson.version !== pkg.packageJson.version,
    );
    if (removedIntents.length > 0 || versionChanged) {
      if (current.preState !== undefined || baseline.preState !== undefined)
        throw new Error('Version-only proof does not support prerelease state');
      if (readPendingChangesetFiles(root).length > 0 || current.plan.releases.length > 0)
        throw new Error('Version-only transition must consume all pending intents');
      if (
        baseline.changesets.length === 0 ||
        baseline.changesets.some((intent) => intent.releases.length === 0 || intent.summary.trim() === '')
      )
        throw new Error('Version-only transition requires consumed real baseline intents');
      if (baseline.changesets.some((intent) => !removedIntents.includes(`${intent.id}.md`)))
        throw new Error('Baseline intent was not consumed');
      if (baseline.plan.releases.length === 0) throw new Error('Baseline intents propose no releases');
      if (changed.has('.changeset/config.json') || changed.has('pnpm-workspace.yaml'))
        throw new Error('Version-only transition changed planning configuration');
      if (!isDeepStrictEqual([...before.keys()].sort(), [...after.keys()].sort()))
        throw new Error('Version-only transition added or deleted a package');
      const planned = new Map(
        baseline.plan.releases.filter((release) => release.type !== 'none').map((release) => [release.name, release]),
      );
      for (const [dir, pkg] of before) {
        const release = planned.get(pkg.packageJson.name);
        const expected = { ...pkg.packageJson, ...(release === undefined ? {} : { version: release.newVersion }) };
        if (!isDeepStrictEqual(manifest(root, `${dir}/package.json`), expected))
          throw new Error(`Version-only manifest does not match pinned baseline plan: ${dir}/package.json`);
      }
      // A version PR may carry release evidence, but no source or build/tooling
      // edits anywhere in the repository. The repair itself must be in its baseline.
      const allowed = new Set([
        ...removedIntents.map((file) => `.changeset/${file}`),
        ...[...before.keys()].flatMap((dir) => [
          `${dir}/package.json`,
          `${dir}/README.md`,
          ...(baseline.config.changelog === false ? [] : [`${dir}/CHANGELOG.md`]),
        ]),
      ]);
      for (const path of changed) {
        const isReleaseDocumentation = /^(?:docs\/.*\.md|README\.md)$/u.test(path);
        if (!allowed.has(path) && !isReleaseDocumentation)
          throw new Error(`Version-only transition includes source/input changes: ${path}`);
        if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error(`Version-only transition includes a symlink: ${path}`);
      }
      return 'version-only';
    }

    // Keep the real CLI coverage check. A release-plan inventory by itself does
    // not establish that changed published output has accompanying version intent.
    const cli = resolve(import.meta.dirname, '../../../node_modules/@changesets/cli/bin.js');
    const result = runCommand(process.execPath, [cli, 'status'], root);
    if (result.code !== 0) throw new Error(`Changesets feature coverage failed:\n${result.stdout}${result.stderr}`);
    for (const [dir, pkg] of after) {
      if (pkg.packageJson.private === true || ![...changed].some((path) => path.startsWith(`${dir}/`))) continue;
      if (
        !current.changesets.some(
          (intent) =>
            intent.summary.trim() !== '' &&
            intent.releases.some((release) => release.name === pkg.packageJson.name && release.type !== 'none'),
        )
      )
        throw new Error(`Missing real feature changeset for ${pkg.packageJson.name}`);
    }
    return 'feature-coverage';
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
