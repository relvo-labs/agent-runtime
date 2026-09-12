#!/usr/bin/env node
/**
 * Re-verification of the staged release, inside the gated job, before any
 * credential exists.
 *
 * This step is deliberately paranoid about its own job: it asserts that
 * `NPM_TOKEN` is *not* visible here, that the checkout is still the approved
 * commit, that there is still no pending version intent, and that the plan it
 * received describes exactly the release this dispatch names — re-hashing
 * every tarball rather than trusting the transport.
 *
 * Usage:
 *   node tools/release/verify-staging.ts --staging <directory>
 */

import { resolve } from 'node:path';
import {
  checkSourceCurrency,
  readActionsContext,
  readDispatchInputs,
  reportFindings,
  requireFlag,
  validatePlanAgainstRequest,
} from './lib/dispatch.ts';
import { describeNpmTool, locateNpmTool } from './lib/npm-tool.ts';
import { parseReleaseRequest, type Finding } from './lib/plan.ts';
import { digestPlan, loadStaging, resolveStagingRoot } from './lib/staging.ts';
import { readGitFacts, readPendingChangesetFiles, readRemoteMain } from './lib/workspace.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const requested = resolve(repoRoot, requireFlag(argv, '--staging'));

const findings: Finding[] = [];

// The credential belongs to exactly one later step. If it is readable here,
// the workflow's confinement has been broken and nothing else matters.
if (process.env.NPM_TOKEN !== undefined) {
  findings.push({
    code: 'credential_leaked',
    message: 'NPM_TOKEN is visible to the verification step; the credential must reach only the publish step',
  });
}

/**
 * The npm that the next step will publish with, proven while the credential
 * still does not exist.
 *
 * `publish.ts` proves it again before it uses it, but the two checks answer
 * different questions. This one answers "is the tool this job was bootstrapped
 * with the reviewed one?" at the last moment a refusal is free — the credential
 * is not in this step's environment, nothing has been uploaded, and the
 * environment approval has already been spent. A missing or unpinned npm found
 * here is a bootstrap failure; found a step later it is a bootstrap failure
 * holding a publish token.
 */
const npmTool = locateNpmTool();
if (npmTool.ok) {
  process.stdout.write(`verify-staging: publication tool ${describeNpmTool(npmTool.tool)}\n`);
} else {
  findings.push(...npmTool.findings);
}

const parsedRequest = parseReleaseRequest(readDispatchInputs(process.env));
if (!parsedRequest.ok) {
  reportFindings('verify-staging', [...findings, ...parsedRequest.findings]);
  process.exit(1);
}
const request = parsedRequest.request;
const context = readActionsContext(process.env);
const git = readGitFacts(repoRoot);

// The same rule preflight applied before the approval, applied again after it —
// and against the remote rather than only against what this job happened to
// fetch, because an approval that sat while main advanced must be refused. The
// pending-changeset scan is the dependency-free equivalent of `changeset
// status`: the gated job installs the workspace only to obtain the pinned npm
// it publishes with, and runs no workspace tooling to establish these facts.
findings.push(
  ...checkSourceCurrency({
    request,
    context,
    git,
    remoteMain: readRemoteMain(repoRoot),
    pendingChangesetFiles: readPendingChangesetFiles(repoRoot),
  }),
);

const stagingRoot = resolveStagingRoot(requested);
if (stagingRoot === undefined) {
  findings.push({ code: 'staging_missing', message: `no release plan found under ${requested}` });
  reportFindings('verify-staging', findings);
  process.exit(1);
}

const loaded = loadStaging(stagingRoot);
if (!loaded.ok) {
  reportFindings('verify-staging', [...findings, ...loaded.findings]);
  process.exit(1);
}
const plan = loaded.staging.plan;
findings.push(...validatePlanAgainstRequest(plan, request));

const digest = digestPlan(plan);
const expectedDigest = process.env.RELEASE_PLAN_DIGEST;
if (expectedDigest === undefined || expectedDigest === '') {
  findings.push({
    code: 'plan_digest_absent',
    message: 'the verify job published no plan digest; the gated job will not publish an unattested plan',
  });
} else if (expectedDigest !== digest) {
  findings.push({
    code: 'plan_digest_mismatch',
    message: `staged plan hashes to ${digest}, but the verify job recorded ${expectedDigest}`,
  });
}

if (findings.length > 0) {
  reportFindings('verify-staging', findings);
  process.exit(1);
}

for (const entry of plan.packages) {
  process.stdout.write(`verify-staging: ${String(entry.order)}. ${entry.name}@${entry.version} ${entry.integrity}\n`);
}
process.stdout.write(
  `verify-staging: OK — ${String(plan.packages.length)} reviewed tarball(s) match plan ${digest} from ${plan.sourceSha}\n`,
);
