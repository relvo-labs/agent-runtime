#!/usr/bin/env node
/**
 * Gate step: the release path is structurally what was reviewed.
 *
 * This runs on every `pnpm gate`, with no credential and no network, so a
 * change that widens the release workflow — a second trigger, a second
 * credentialed step, an unpinned action, an inline shell program, a publish
 * command that bypasses the reviewed scripts — fails on a developer machine
 * and in CI, long before anyone can dispatch it.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluateReleaseWorkflowPolicy } from './lib/workflow-policy.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const workflowDirectory = join(repoRoot, '.github/workflows');
const releaseWorkflowPath = join(workflowDirectory, 'release.yml');
const problems: string[] = [];

const source = readFileSync(releaseWorkflowPath, 'utf8');
problems.push(...evaluateReleaseWorkflowPolicy(source));

// The parser discards comments, so the human-readable version marker beside
// each immutable SHA is asserted against the raw text.
for (const [index, line] of source.split('\n').entries()) {
  const uses = /^\s*(?:-\s+)?uses:\s+(\S+)(.*)$/u.exec(line);
  if (uses === null) continue;
  if (!/@[0-9a-f]{40}$/u.test(uses[1] ?? '')) {
    problems.push(`release.yml line ${String(index + 1)}: action must be pinned to an immutable commit`);
  }
  if (!/#\s*v\d+\.\d+\.\d+/u.test(uses[2] ?? '')) {
    problems.push(`release.yml line ${String(index + 1)}: pinned action must record the reviewed version as a comment`);
  }
}

// Repository-wide: exactly one workflow may mention a secret at all.
for (const entry of readdirSync(workflowDirectory).sort()) {
  if (!/\.ya?ml$/u.test(entry)) continue;
  const workflow = readFileSync(join(workflowDirectory, entry), 'utf8');
  if (entry !== 'release.yml' && workflow.includes('secrets.')) {
    problems.push(`.github/workflows/${entry} references a secret; only the reviewed release workflow may`);
  }
  for (const forbidden of ['npm publish', 'changeset publish', 'pnpm publish']) {
    if (entry !== 'release.yml' && workflow.includes(forbidden)) {
      problems.push(
        `.github/workflows/${entry} runs \`${forbidden}\`; publication belongs to the release workflow alone`,
      );
    }
  }
}

// Publication is never reachable from an ordinary script.
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
for (const [name, command] of Object.entries(rootManifest.scripts ?? {})) {
  for (const forbidden of ['npm publish', 'pnpm publish', 'changeset publish']) {
    if (command.includes(forbidden)) {
      problems.push(`root script \`${name}\` runs \`${forbidden}\`; publication only happens in the release workflow`);
    }
  }
}

for (const required of [
  'tools/release/preflight.ts',
  'tools/release/verify-staging.ts',
  'tools/release/publish.ts',
  'docs/release.md',
]) {
  if (!existsSync(join(repoRoot, required))) problems.push(`the release path requires ${required}`);
}

// The runbook is part of the control, not commentary: the approvals a human
// still owes must be stated where the operator reads them.
const runbook = existsSync(join(repoRoot, 'docs/release.md'))
  ? readFileSync(join(repoRoot, 'docs/release.md'), 'utf8')
  : '';
for (const heading of ['## Outstanding human approvals', '## First-release evidence policy']) {
  if (!runbook.includes(heading)) problems.push(`docs/release.md must contain a \`${heading}\` section`);
}
if (!readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8').includes('.github/workflows/release.yml')) {
  problems.push('AGENTS.md must describe the release workflow rather than claiming none exists');
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`release: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  'release: OK — manual dispatch only, gate before pack, one credentialed step in the gated job, provenance and pinned actions\n',
);
