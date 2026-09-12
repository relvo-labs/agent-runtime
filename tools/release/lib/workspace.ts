/**
 * Facts read from the checkout: workspace inventory, pending version intent
 * and the exact commit under the runner's feet.
 *
 * These are the inputs the preflight evaluator reasons about. They are kept
 * here, behind small total functions, so the evaluator itself stays pure and
 * fully testable without a git repository or a package manager.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangesetRelease, GitFacts, WorkspacePackage } from './preflight.ts';

export function runCommand(
  program: string,
  args: readonly string[],
  cwd: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(program, args, { cwd, env: process.env, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function readWorkspaceInventory(repoRoot: string): readonly WorkspacePackage[] {
  const packagesRoot = join(repoRoot, 'packages');
  const inventory: WorkspacePackage[] = [];
  for (const directory of readdirSync(packagesRoot).sort()) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(packagesRoot, directory, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const name = manifest.name;
    const version = manifest.version;
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    inventory.push({ directory: `packages/${directory}`, name, version, private: manifest.private === true });
  }
  return inventory;
}

/** Unreleased changeset files, `README.md` excluded — it is documentation. */
export function readPendingChangesetFiles(repoRoot: string): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(repoRoot, '.changeset'));
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith('.md') && entry !== 'README.md').sort();
}

/**
 * `changeset status` is the authoritative answer to "is there version intent
 * that this release would skip?". It needs the workspace's dev dependencies,
 * so it only runs in the credential-free verify job; the gated job re-checks
 * the dependency-free `.changeset/*.md` inventory instead.
 */
export function readChangesetStatus(repoRoot: string): readonly ChangesetRelease[] {
  const scratch = mkdtempSync(join(tmpdir(), 'relvo-changeset-'));
  const output = join(scratch, 'status.json');
  try {
    const result = runCommand('pnpm', ['changeset', 'status', `--output=${output}`], repoRoot);
    if (result.code !== 0) {
      throw new Error(`changeset status failed with code ${result.code}\n${result.stdout}${result.stderr}`.trim());
    }
    const document = JSON.parse(readFileSync(output, 'utf8')) as unknown;
    if (typeof document !== 'object' || document === null) throw new Error('changeset status produced no document');
    const releases = (document as Record<string, unknown>).releases;
    if (!Array.isArray(releases)) throw new Error('changeset status produced no releases array');
    return releases.map((entry) => {
      const release = entry as Record<string, unknown>;
      return {
        name: String(release.name),
        type: String(release.type),
        oldVersion: String(release.oldVersion),
        newVersion: String(release.newVersion),
      };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readGitFacts(repoRoot: string): GitFacts {
  const revParse = (ref: string): string => {
    const result = runCommand('git', ['rev-parse', ref], repoRoot);
    return result.code === 0 ? result.stdout.trim() : `<unresolved ${ref}>`;
  };
  const status = runCommand('git', ['status', '--porcelain'], repoRoot);
  return {
    headSha: revParse('HEAD'),
    originMainSha: revParse('refs/remotes/origin/main'),
    porcelain: status.code === 0 ? status.stdout : '<git status failed>',
  };
}
