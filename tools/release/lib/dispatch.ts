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
import type { ActionsContext, ReleasePlan } from './preflight.ts';
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
