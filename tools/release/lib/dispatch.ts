/**
 * Shared CLI plumbing: reading the dispatch inputs out of the environment,
 * and re-checking a staged plan against them.
 *
 * The dispatch inputs are read from `RELEASE_*` environment variables rather
 * than interpolated into a shell command, so operator-supplied text is never
 * part of a command line. Every job re-derives the request from those
 * variables and re-checks the plan against it: the gated job never assumes the
 * plan it received describes the release that was actually approved.
 */

import type { Finding, DispatchInputs, ReleaseRequest } from './plan.ts';
import type { ActionsContext, GitFacts, ReleasePlan } from './preflight.ts';
import { DEFAULT_REGISTRY } from './registry.ts';

export function readDispatchInputs(env: NodeJS.ProcessEnv): DispatchInputs {
  return {
    sourceSha: env.RELEASE_SOURCE_SHA ?? '',
    packages: env.RELEASE_PACKAGES ?? '',
    distTag: env.RELEASE_DIST_TAG ?? '',
    confirm: env.RELEASE_CONFIRM ?? '',
  };
}

export function readActionsContext(env: NodeJS.ProcessEnv): ActionsContext {
  return {
    eventName: env.RELEASE_EVENT_NAME ?? '',
    ref: env.RELEASE_REF ?? '',
    runnerSha: env.RELEASE_RUNNER_SHA ?? '',
  };
}

export function requireFlag(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing required argument \`${flag} <value>\``);
  return value;
}

/**
 * The facts about *this checkout* that must still hold at the moment of
 * publication, re-derived rather than inherited.
 *
 * Preflight established all of these before the environment approval, and an
 * approval can sit for as long as a reviewer takes. In that window `main` can
 * advance, a maintainer can land new version intent, and the working tree can
 * be modified by an earlier step. The rule the runbook states — *only the exact
 * current tip of main may be released* — is only true if it is checked when it
 * matters, so the gated job re-checks it, and the publisher re-checks it again
 * before every single upload.
 *
 * `originMainSha` is the meaningful one: the other facts are stable within a
 * job, but the remote-tracking ref is whatever `main` was when this job checked
 * out, which is after the approval was given.
 */
export function checkSourceCurrency(input: {
  readonly request: ReleaseRequest;
  readonly context: ActionsContext;
  readonly git: GitFacts;
  readonly pendingChangesetFiles: readonly string[];
}): readonly Finding[] {
  const { context, git, request } = input;
  const findings: Finding[] = [];
  if (context.eventName !== 'workflow_dispatch') {
    findings.push({
      code: 'context_event',
      message: `release may only run from workflow_dispatch, got \`${context.eventName}\``,
    });
  }
  if (context.ref !== 'refs/heads/main') {
    findings.push({
      code: 'context_ref',
      message: `release may only be dispatched on refs/heads/main, got \`${context.ref}\``,
    });
  }
  if (context.runnerSha !== request.sourceSha) {
    findings.push({
      code: 'context_sha',
      message: `dispatch resolved to ${context.runnerSha}, which is not the named source commit ${request.sourceSha}`,
    });
  }
  if (git.headSha !== request.sourceSha) {
    findings.push({ code: 'git_head', message: `checkout HEAD is ${git.headSha}, expected ${request.sourceSha}` });
  }
  if (git.originMainSha !== request.sourceSha) {
    findings.push({
      code: 'git_main_tip',
      message: `origin/main is now ${git.originMainSha}; only the exact current tip of main may be released, not ${request.sourceSha}`,
    });
  }
  if (git.porcelain.trim() !== '') {
    findings.push({
      code: 'git_dirty',
      message: 'checkout has uncommitted changes; refusing to publish an unreviewed tree',
    });
  }
  for (const file of [...input.pendingChangesetFiles].sort()) {
    findings.push({
      code: 'pending_version_intent',
      message: `\`.changeset/${file}\` is unreleased version intent; version it in a separate reviewed release PR before publishing`,
    });
  }
  return findings;
}

export function validatePlanAgainstRequest(plan: ReleasePlan, request: ReleaseRequest): readonly Finding[] {
  const findings: Finding[] = [];
  if (plan.sourceSha !== request.sourceSha) {
    findings.push({
      code: 'plan_source_mismatch',
      message: `staged plan was built from ${plan.sourceSha}, but this dispatch names ${request.sourceSha}`,
    });
  }
  if (plan.distTag !== request.distTag) {
    findings.push({
      code: 'plan_dist_tag_mismatch',
      message: `staged plan targets dist-tag \`${plan.distTag}\`, but this dispatch names \`${request.distTag}\``,
    });
  }
  if (plan.registry !== DEFAULT_REGISTRY) {
    findings.push({
      code: 'plan_registry_mismatch',
      message: `staged plan targets ${plan.registry}; this release path publishes only to ${DEFAULT_REGISTRY}`,
    });
  }
  const planned = new Set(plan.packages.map((entry) => `${entry.name}@${entry.version}`));
  const requested = new Set(request.targets.map((target) => `${target.name}@${target.version}`));
  for (const entry of planned) {
    if (!requested.has(entry)) {
      findings.push({
        code: 'plan_scope_mismatch',
        message: `staged plan contains ${entry}, which this dispatch does not name`,
      });
    }
  }
  for (const entry of requested) {
    if (!planned.has(entry)) {
      findings.push({
        code: 'plan_scope_mismatch',
        message: `this dispatch names ${entry}, which the staged plan does not contain`,
      });
    }
  }
  return findings;
}

export function reportFindings(label: string, findings: readonly Finding[]): void {
  for (const finding of findings) process.stderr.write(`${label}: [${finding.code}] ${finding.message}\n`);
  process.stderr.write(`${label}: refused with ${String(findings.length)} finding(s); nothing was published\n`);
}
