/**
 * Ordered, non-overwriting publication.
 *
 * Publication is the only irreversible step in this repository, so it is the
 * most conservative one:
 *
 *   - one explicit tarball per `npm publish` invocation, never a directory,
 *     never `--workspaces`, never `changeset publish`;
 *   - dependency order, so a dependent is never resolvable before the
 *     dependency it needs;
 *   - a registry check immediately before each upload, so a version that
 *     appeared since preflight is refused rather than overwritten;
 *   - readback after each upload, before the next package is attempted;
 *   - on any failure: stop, report exactly what is already public, and exit
 *     non-zero. Nothing is unpublished, nothing is retried in place, and the
 *     remaining packages are left for a new, human-reviewed dispatch whose
 *     scope names only what is still unpublished.
 */

import type { Finding } from './plan.ts';
import type { PlanEntry, ReleasePlan } from './preflight.ts';
import type { RegistryPort } from './registry.ts';
import { verifyReadback } from './readback.ts';

export type CommandOutcome = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PublishPorts = {
  /** Runs `npm` with the given argv. Must never echo its environment. */
  readonly npm: (argv: readonly string[]) => Promise<CommandOutcome>;
  readonly registry: RegistryPort;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
};

export type PublishOptions = {
  /** Absolute path of the verified tarball for a plan entry. */
  readonly tarballPath: (entry: PlanEntry) => string;
  /** Temporary npmrc holding only an env-interpolated auth line. */
  readonly userconfig: string;
  readonly readbackAttempts?: number;
  readonly readbackDelayMs?: number;
};

export type PublishFailure = {
  readonly name: string;
  readonly version: string;
  readonly code: string;
  readonly message: string;
};

export type PublishReport = {
  readonly ok: boolean;
  /** `name@version` values that are now public, in publication order. */
  readonly published: readonly string[];
  readonly failure: PublishFailure | undefined;
  readonly notAttempted: readonly string[];
};

export function buildPublishArgv(input: {
  readonly tarball: string;
  readonly distTag: string;
  readonly registry: string;
  readonly userconfig: string;
}): readonly string[] {
  return [
    'publish',
    input.tarball,
    '--ignore-scripts',
    '--access',
    'public',
    '--provenance',
    '--tag',
    input.distTag,
    '--registry',
    input.registry,
    '--userconfig',
    input.userconfig,
  ];
}

/**
 * Defence in depth for command output. The npmrc interpolates the token from
 * the environment and never stores it, and npm does not print it — but output
 * that is about to be written to a public log is scrubbed anyway.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 8) continue;
    out = out.split(secret).join('***redacted***');
  }
  return out;
}

function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

export async function publishRelease(
  plan: ReleasePlan,
  ports: PublishPorts,
  options: PublishOptions,
): Promise<PublishReport> {
  const attempts = options.readbackAttempts ?? 5;
  const delayMs = options.readbackDelayMs ?? 3_000;
  const published: string[] = [];

  const stop = (entry: PlanEntry, code: string, message: string, index: number): PublishReport => ({
    ok: false,
    published,
    failure: { name: entry.name, version: entry.version, code, message },
    notAttempted: plan.packages.slice(index + 1).map((remaining) => `${remaining.name}@${remaining.version}`),
  });

  for (const [index, entry] of plan.packages.entries()) {
    const subject = `${entry.name}@${entry.version}`;

    const before = await ports.registry.lookup(entry.name);
    if (before.kind === 'unauthorized' || before.kind === 'error') {
      return stop(
        entry,
        'registry_unavailable',
        `registry could not be consulted before publishing: ${before.detail}`,
        index,
      );
    }
    if (before.kind === 'found' && before.packument.versions.has(entry.version)) {
      return stop(
        entry,
        'registry_version_exists',
        `${subject} appeared on the registry after preflight; refusing to overwrite an immutable version`,
        index,
      );
    }

    ports.log(`[release] publishing ${subject} (${entry.order}/${plan.packages.length}) as \`${plan.distTag}\``);
    const argv = buildPublishArgv({
      tarball: options.tarballPath(entry),
      distTag: plan.distTag,
      registry: plan.registry,
      userconfig: options.userconfig,
    });
    const outcome = await ports.npm(argv);
    if (outcome.code !== 0) {
      return stop(
        entry,
        'publish_failed',
        `npm publish exited ${outcome.code}: ${tail(outcome.stderr || outcome.stdout)}`,
        index,
      );
    }

    let readback: readonly Finding[] = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      readback = verifyReadback(entry, plan.distTag, await ports.registry.lookup(entry.name));
      if (readback.length === 0) break;
      if (attempt < attempts) await ports.sleep(delayMs);
    }
    if (readback.length > 0) {
      return stop(
        entry,
        'readback_mismatch',
        `registry readback failed after ${attempts} attempts: ${readback.map((finding) => finding.message).join('; ')}`,
        index,
      );
    }

    published.push(subject);
    ports.log(`[release] verified ${subject} on the registry`);
  }

  return { ok: true, published, failure: undefined, notAttempted: [] };
}

/** Operator-facing summary. Partial publication is reported, never hidden. */
export function summarizeReport(report: PublishReport): string {
  const lines: string[] = [];
  lines.push(`published: ${report.published.length === 0 ? '<none>' : report.published.join(', ')}`);
  if (report.ok) return lines.join('\n');

  const failure = report.failure;
  if (failure !== undefined) {
    lines.push(`failed at: ${failure.name}@${failure.version} [${failure.code}]`);
    lines.push(`reason: ${failure.message}`);
  }
  lines.push(`not attempted: ${report.notAttempted.length === 0 ? '<none>' : report.notAttempted.join(', ')}`);
  lines.push(
    'recovery: nothing is unpublished or overwritten. Review what is already public, then dispatch a new release ' +
      'whose scope names only the packages that are still unpublished, at the same versions.',
  );
  return lines.join('\n');
}
