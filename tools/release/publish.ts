#!/usr/bin/env node
/**
 * The only step in this repository that can publish.
 *
 * It re-verifies the staged plan one final time, writes a temporary npmrc that
 * *interpolates* the token from the environment rather than storing it, and
 * publishes each reviewed tarball in dependency order with provenance. The
 * npmrc is removed in a `finally`, every command's output is scrubbed of the
 * token before it is printed, and any failure stops the run non-zero with an
 * exact account of what is already public.
 *
 * Usage:
 *   node tools/release/publish.ts --staging <directory>
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readActionsContext,
  readDispatchInputs,
  reportFindings,
  requireFlag,
  validatePlanAgainstRequest,
} from './lib/dispatch.ts';
import { parseReleaseRequest, type Finding } from './lib/plan.ts';
import { publishRelease, redactSecrets, summarizeReport, type CommandOutcome } from './lib/publish.ts';
import { createHttpsRegistry } from './lib/registry.ts';
import { digestPlan, loadStaging, resolveStagingRoot } from './lib/staging.ts';
import { readGitFacts } from './lib/workspace.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const requested = resolve(repoRoot, requireFlag(argv, '--staging'));

const token = process.env.NPM_TOKEN;
if (token === undefined || token.trim() === '') {
  process.stderr.write('publish: NPM_TOKEN is not available to this step; nothing can be published\n');
  process.exit(1);
}

const findings: Finding[] = [];
const parsedRequest = parseReleaseRequest(readDispatchInputs(process.env));
if (!parsedRequest.ok) {
  reportFindings('publish', parsedRequest.findings);
  process.exit(1);
}
const request = parsedRequest.request;
const context = readActionsContext(process.env);
const git = readGitFacts(repoRoot);
if (context.ref !== 'refs/heads/main') {
  findings.push({
    code: 'context_ref',
    message: `release may only be dispatched on refs/heads/main, got \`${context.ref}\``,
  });
}
if (git.headSha !== request.sourceSha) {
  findings.push({ code: 'git_head', message: `checkout HEAD is ${git.headSha}, expected ${request.sourceSha}` });
}

const stagingRoot = resolveStagingRoot(requested);
if (stagingRoot === undefined) {
  reportFindings('publish', [
    ...findings,
    { code: 'staging_missing', message: `no release plan found under ${requested}` },
  ]);
  process.exit(1);
}
const loaded = loadStaging(stagingRoot);
if (!loaded.ok) {
  reportFindings('publish', [...findings, ...loaded.findings]);
  process.exit(1);
}
const staging = loaded.staging;
findings.push(...validatePlanAgainstRequest(staging.plan, request));

const expectedDigest = process.env.RELEASE_PLAN_DIGEST;
const digest = digestPlan(staging.plan);
if (expectedDigest !== digest) {
  findings.push({
    code: 'plan_digest_mismatch',
    message: `staged plan hashes to ${digest}, but the verify job recorded ${expectedDigest ?? '<absent>'}`,
  });
}
if (findings.length > 0) {
  reportFindings('publish', findings);
  process.exit(1);
}

const write = (line: string): void => {
  process.stdout.write(`${redactSecrets(line, [token])}\n`);
};

function runNpm(args: readonly string[]): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((settle, reject) => {
    const child = spawn('npm', [...args], { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      settle({ code: code ?? 1, stdout: redactSecrets(stdout, [token]), stderr: redactSecrets(stderr, [token]) });
    });
  });
}

// The credential is never written to disk: npm interpolates `${NPM_TOKEN}`
// from this process's environment when it reads the file.
const credentialRoot = mkdtempSync(join(tmpdir(), 'relvo-release-npmrc-'));
const userconfig = join(credentialRoot, 'npmrc');
const registryUrl = new URL(staging.plan.registry);
const authLine = `//${registryUrl.host}${registryUrl.pathname.replace(/\/?$/u, '/')}:_authToken=\${NPM_TOKEN}`;

let exitCode = 0;
try {
  writeFileSync(userconfig, `${authLine}\n`, { mode: 0o600 });
  const report = await publishRelease(
    staging.plan,
    {
      npm: runNpm,
      registry: createHttpsRegistry(staging.plan.registry),
      log: write,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    },
    { tarballPath: staging.tarballPath, userconfig },
  );
  const summary = summarizeReport(report);
  if (report.ok) {
    process.stdout.write(`publish: OK — plan ${digest} from ${staging.plan.sourceSha}\n${summary}\n`);
  } else {
    process.stderr.write(`publish: FAILED — plan ${digest} from ${staging.plan.sourceSha}\n${summary}\n`);
    exitCode = 1;
  }
} finally {
  rmSync(credentialRoot, { recursive: true, force: true });
}
process.exit(exitCode);
