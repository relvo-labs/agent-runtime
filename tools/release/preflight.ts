#!/usr/bin/env node
/**
 * Credential-free release preflight and pack.
 *
 * Runs in the ungated `verify` job, after the canonical gate. It reads the
 * dispatch inputs, packs exactly the named packages, and asks
 * `lib/preflight.ts` whether this release may proceed. On success it writes
 * the staging directory the gated job will consume; on any finding it writes
 * nothing and exits non-zero.
 *
 * Usage:
 *   node tools/release/preflight.ts --staging <directory> [--registry <url>]
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readActionsContext, readDispatchInputs, reportFindings, requireFlag } from './lib/dispatch.ts';
import { parseReleaseRequest, type ReleaseTarget } from './lib/plan.ts';
import { runPreflight, serializePlan } from './lib/preflight.ts';
import { createHttpsRegistry, DEFAULT_REGISTRY } from './lib/registry.ts';
import { digestPlan, writeStaging } from './lib/staging.ts';
import { inspectTarball, tarballFileName, type PackedArtifact } from './lib/tarball.ts';
import {
  readChangesetStatus,
  readGitFacts,
  readPendingChangesetFiles,
  readWorkspaceInventory,
  runCommand,
} from './lib/workspace.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const stagingRoot = resolve(repoRoot, requireFlag(argv, '--staging'));
const registryUrl = argv.includes('--registry') ? requireFlag(argv, '--registry') : DEFAULT_REGISTRY;

if (existsSync(stagingRoot) && readdirSync(stagingRoot).length > 0) {
  process.stderr.write(`preflight: staging directory ${stagingRoot} is not empty; refusing to mix release artifacts\n`);
  process.exit(1);
}

const parsedRequest = parseReleaseRequest(readDispatchInputs(process.env));
if (!parsedRequest.ok) {
  reportFindings('preflight', parsedRequest.findings);
  process.exit(1);
}
const request = parsedRequest.request;

function packTarget(target: ReleaseTarget, destination: string): { artifact: PackedArtifact; bytes: Buffer } {
  const result = runCommand('pnpm', ['--filter', target.name, 'pack', '--pack-destination', destination], repoRoot);
  if (result.code !== 0) {
    throw new Error(`pnpm pack failed for ${target.name}\n${result.stdout}${result.stderr}`.trim());
  }
  const fileName = tarballFileName(target.name, target.version);
  const bytes = readFileSync(join(destination, fileName));
  return { artifact: inspectTarball(fileName, bytes), bytes };
}

const packScratch = mkdtempSync(join(tmpdir(), 'relvo-release-pack-'));
try {
  const artifacts: PackedArtifact[] = [];
  const bytesByName = new Map<string, Buffer>();
  for (const target of request.targets) {
    const packed = packTarget(target, packScratch);
    artifacts.push(packed.artifact);
    bytesByName.set(packed.artifact.manifest.name, packed.bytes);
  }

  const outcome = await runPreflight(
    {
      request,
      context: readActionsContext(process.env),
      git: readGitFacts(repoRoot),
      pendingChangesetFiles: readPendingChangesetFiles(repoRoot),
      changesetReleases: await readChangesetStatus(repoRoot),
      workspace: readWorkspaceInventory(repoRoot),
      artifacts,
      registryUrl,
    },
    createHttpsRegistry(registryUrl),
  );

  if (outcome.plan === undefined) {
    reportFindings('preflight', outcome.findings);
    process.exit(1);
  }

  const plan = outcome.plan;
  mkdirSync(stagingRoot, { recursive: true });
  writeStaging(stagingRoot, plan, bytesByName);

  const digest = digestPlan(plan);
  process.stdout.write(`${serializePlan(plan)}\n`);
  process.stdout.write(`preflight: plan digest ${digest}\n`);
  for (const entry of plan.packages) {
    process.stdout.write(`preflight: ${String(entry.order)}. ${entry.name}@${entry.version} ${entry.integrity}\n`);
  }
  for (const excluded of plan.excluded) {
    process.stdout.write(`preflight: NOT in scope — ${excluded.name}@${excluded.version}\n`);
  }
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput !== undefined && githubOutput !== '') appendFileSync(githubOutput, `plan-digest=${digest}\n`);
  process.stdout.write(
    `preflight: OK — ${String(plan.packages.length)} package(s) staged for \`${plan.distTag}\`; approval is still required before anything is published\n`,
  );
} finally {
  rmSync(packScratch, { recursive: true, force: true });
}
