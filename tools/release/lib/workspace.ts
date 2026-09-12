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

export type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

/**
 * The command boundary, as one named function.
 *
 * Everything in this module that shells out goes through here, so a test can
 * substitute the boundary rather than a builtin, and so there is exactly one
 * place that decides what environment a child process sees.
 */
export type CommandRunner = (program: string, args: readonly string[], cwd: string) => CommandResult;

/**
 * `NPM_TOKEN` exists in exactly one step, and nothing spawned from this module
 * needs it. Git in particular is invoked *while* the credential is in the
 * publisher's environment, so it is removed from the child's environment rather
 * than merely trusted not to be used.
 */
function credentialFreeEnv(): NodeJS.ProcessEnv {
  const { NPM_TOKEN: _removed, ...rest } = process.env;
  return rest;
}

export const runCommand: CommandRunner = (program, args, cwd) => {
  const result = spawnSync(program, args, { cwd, env: credentialFreeEnv(), encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

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

export function readGitFacts(repoRoot: string, run: CommandRunner = runCommand): GitFacts {
  const revParse = (ref: string): string => {
    const result = run('git', ['rev-parse', ref], repoRoot);
    return result.code === 0 ? result.stdout.trim() : `<unresolved ${ref}>`;
  };
  const status = run('git', ['status', '--porcelain'], repoRoot);
  return {
    headSha: revParse('HEAD'),
    originMainSha: revParse('refs/remotes/origin/main'),
    porcelain: status.code === 0 ? status.stdout : '<git status failed>',
  };
}

/** The current tip of `main` **on the remote**, or an explicit refusal to say. */
export type RemoteMain =
  { readonly kind: 'observed'; readonly sha: string } | { readonly kind: 'unavailable'; readonly detail: string };

const LS_REMOTE_LINE_RE = /^(?<sha>[0-9a-f]{40})\t(?<ref>\S+)$/u;

/**
 * Classify `git ls-remote` output. Pure, so every failure mode is testable
 * without a network, a remote or a subprocess.
 *
 * Fail-closed in every direction: a non-zero exit, empty output, a line this
 * cannot parse, a ref that is not the one asked for, a short or upper-case
 * object id, or more than one matching line all produce `unavailable`. There is
 * no path from "the remote did not answer clearly" to "the remote agrees".
 */
export function parseRemoteMain(result: CommandResult, ref = 'refs/heads/main'): RemoteMain {
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || '<no output>').split('\n').slice(-3).join('; ');
    return { kind: 'unavailable', detail: `git ls-remote exited ${String(result.code)}: ${detail}` };
  }
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return { kind: 'unavailable', detail: `the remote lists no \`${ref}\`; it may have been renamed or deleted` };
  }
  const matches: string[] = [];
  for (const line of lines) {
    const parsed = LS_REMOTE_LINE_RE.exec(line.trimEnd());
    if (parsed?.groups === undefined) {
      return { kind: 'unavailable', detail: `git ls-remote produced a line this tool cannot parse: \`${line}\`` };
    }
    if (parsed.groups.ref !== ref) continue;
    matches.push(parsed.groups.sha!);
  }
  if (matches.length === 0) {
    return { kind: 'unavailable', detail: `git ls-remote answered without a \`${ref}\` entry` };
  }
  if (matches.length > 1) {
    return { kind: 'unavailable', detail: `git ls-remote reports \`${ref}\` more than once; the answer is ambiguous` };
  }
  return { kind: 'observed', sha: matches[0]! };
}

/**
 * Ask the remote where `main` actually is, right now.
 *
 * The cached `refs/remotes/origin/main` that `readGitFacts` reads is whatever
 * the checkout fetched — which, in the gated job, is a snapshot taken when that
 * job started. An independent review advanced `main` on the server after that
 * point and every per-upload source check still passed, because nothing ever
 * asked the remote anything. This does.
 *
 * It is a read-only query over the transport the checkout already used. It
 * writes nothing, persists no credential (the child process does not even
 * receive `NPM_TOKEN`), fetches no objects, and needs no permission beyond what
 * cloning the repository required. If it cannot get an answer, the caller
 * refuses — see `parseRemoteMain`.
 */
export function readRemoteMain(repoRoot: string, run: CommandRunner = runCommand): RemoteMain {
  let result: CommandResult;
  try {
    result = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], repoRoot);
  } catch (error) {
    return { kind: 'unavailable', detail: `git ls-remote could not be run: ${String(error)}` };
  }
  return parseRemoteMain(result);
}
