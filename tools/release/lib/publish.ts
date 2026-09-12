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
 *   - a full registry recheck immediately before *each* upload, so nothing that
 *     the approval was based on is assumed to still hold;
 *   - readback after each upload, before the next package is attempted;
 *   - on any failure: stop, report exactly what is already public, and exit
 *     non-zero. Nothing is unpublished, nothing is retried in place, and the
 *     remaining packages are left for a new, human-reviewed dispatch whose
 *     scope names only what is still unpublished.
 *
 * Two properties of that recheck are worth stating, because preflight alone
 * cannot provide them. Preflight runs before the environment approval, and an
 * approval can sit for as long as a reviewer takes: in that window the registry
 * is mutable. A dist-tag can be moved forward by someone else, and a version
 * this scope depends on can be unpublished. Both are re-established here, per
 * package, immediately before its bytes are uploaded.
 *
 * The second property is accounting. A zero exit means npm accepted the upload;
 * only a readback means the registry serves what was reviewed. Those are
 * different facts and this module keeps them apart, because reporting an
 * accepted-but-unverified upload as "not published" would invite exactly the
 * wrong recovery — a second dispatch naming a version that is already public
 * and can never be overwritten.
 */

import { compareExactVersions, exactVersionOfRange } from './graph.ts';
import type { Finding } from './plan.ts';
import type { PlanEntry, ReleasePlan } from './preflight.ts';
import type { RegistryLookup, RegistryPort } from './registry.ts';
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
  /**
   * Re-reads the facts about *this checkout* that authorised the release, and
   * returns a finding for each one that no longer holds.
   *
   * This exists because the registry is not the only thing that can move
   * between the approval and the upload. `main` can advance, the checkout can
   * be modified, and new version intent can land. Preflight established those
   * facts before the approval; this establishes them again immediately before
   * each package's bytes leave the runner, so a long-pending approval cannot
   * publish a commit that is no longer the tip of main.
   */
  readonly revalidateSource: () => Promise<readonly Finding[]> | readonly Finding[];
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

/**
 * What the registry did with the bytes, as distinct from what we could confirm
 * about them afterwards.
 *
 *   - `accepted`  — npm reported success, or the version was observed on the
 *                   registry afterwards. It is public and immutable.
 *   - `rejected`  — npm failed *and* the registry definitively does not carry
 *                   the version. Nothing was published.
 *   - `unknown`   — npm failed and the registry could not be consulted. The
 *                   version may or may not be public; a human must look.
 */
export type UploadState = 'accepted' | 'rejected' | 'unknown';

export type PublishOutcome = {
  readonly name: string;
  readonly version: string;
  readonly upload: UploadState;
  readonly verified: boolean;
  readonly detail: string | undefined;
};

export type PublishReport = {
  readonly ok: boolean;
  /** `name@version` values uploaded *and* verified against the registry. */
  readonly published: readonly string[];
  /** Uploaded and public, but readback could not confirm what is served. */
  readonly acceptedUnverified: readonly string[];
  /** Attempted, and not even known to have failed. Requires reconciliation. */
  readonly unknown: readonly string[];
  /** Every package the run touched, in publication order. */
  readonly outcomes: readonly PublishOutcome[];
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

/**
 * The dist-tag this dispatch would move must not already point at something
 * newer. Preflight asserts this too, but against a registry it read before the
 * approval; between then and now anyone with write access to the scope could
 * have moved it.
 */
function checkDistTagStillSafe(entry: PlanEntry, distTag: string, before: RegistryLookup): string | undefined {
  if (before.kind !== 'found') return undefined;
  const tagged = before.packument.distTags.get(distTag);
  if (tagged === undefined) return undefined;
  if (compareExactVersions(tagged, entry.version) <= 0) return undefined;
  return `dist-tag \`${distTag}\` now points at ${entry.name}@${tagged}; publishing ${entry.version} under it would move it backwards`;
}

/**
 * Every runtime dependency this package will ask a consumer to resolve must
 * still be resolvable at the exact version the packed manifest names.
 *
 * Scope note: this rechecks `dependencies`, which is what an installing
 * consumer must be able to resolve. Peer ranges were closed over at preflight,
 * where the packed `peerDependenciesMeta` was available to tell a required peer
 * from an optional one; the plan does not carry that distinction, and refusing
 * on an optional peer would be a false blocker.
 *
 * ## Why an in-scope dependency is looked up too
 *
 * An earlier version of this function treated membership of `publishedSoFar` as
 * proof that an in-scope dependency was resolvable, and skipped the lookup. An
 * independent review showed what that costs: with a three-package plan, the
 * first package was published and verified, then removed from the registry
 * while the *second* package was being published. The third package depended on
 * the first, uploaded successfully, and the run reported `ok: true` — because
 * nothing looked at the first package again after it was verified.
 *
 * `publishedSoFar` is this run's own recollection; the registry is the fact. So
 * the ordering check is kept — a dependent must never be uploaded before its
 * in-scope dependency, which is a plan-shape error rather than a registry one —
 * and a fresh lookup is performed *as well*, immediately before the dependent's
 * bytes are uploaded.
 */
async function checkDependenciesStillAvailable(
  entry: PlanEntry,
  plan: ReleasePlan,
  publishedSoFar: ReadonlySet<string>,
  ports: PublishPorts,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  const inScope = new Map(plan.packages.map((target) => [target.name, target.version]));

  for (const [dependency, range] of Object.entries(entry.dependencies)) {
    const exact = exactVersionOfRange(range);
    if (exact === undefined) {
      return {
        code: 'dependency_range_unsupported',
        message: `${entry.name} depends on ${dependency}@${range}, which is not an exact version or the caret of one`,
      };
    }

    const scoped = inScope.get(dependency);
    if (scoped !== undefined) {
      // Plan shape first: a dependent must never precede its dependency.
      if (scoped !== exact) {
        return {
          code: 'dependency_scope_mismatch',
          message: `${entry.name} requires ${dependency}@${exact}, but this plan publishes ${dependency}@${scoped}`,
        };
      }
      if (!publishedSoFar.has(`${dependency}@${exact}`)) {
        return {
          code: 'dependency_order',
          message: `${entry.name} requires ${dependency}@${exact}, which this plan has not yet published; refusing to publish a dependent first`,
        };
      }
      // …and then the registry, because "we published it" is not "it is there".
    }

    const result = await ports.registry.lookup(dependency);
    if (result.kind === 'found') {
      if (result.packument.versions.has(exact)) continue;
      return {
        code: 'dependency_unpublished',
        message:
          scoped === undefined
            ? `${entry.name} requires ${dependency}@${exact}, which the registry no longer lists; it was available at preflight`
            : `${entry.name} requires ${dependency}@${exact}, which this run published and verified but the registry no longer lists`,
      };
    }
    if (result.kind === 'absent') {
      return {
        code: 'dependency_unpublished',
        message:
          scoped === undefined
            ? `${entry.name} requires ${dependency}@${exact}, but \`${dependency}\` is no longer on the registry at all`
            : `${entry.name} requires ${dependency}@${exact}, but \`${dependency}\` has disappeared from the registry since this run published it`,
      };
    }
    return {
      code: 'registry_unavailable',
      message: `could not re-establish whether ${dependency}@${exact} is still published: ${result.detail}`,
    };
  }
  return undefined;
}

export async function publishRelease(
  plan: ReleasePlan,
  ports: PublishPorts,
  options: PublishOptions,
): Promise<PublishReport> {
  const attempts = options.readbackAttempts ?? 5;
  const delayMs = options.readbackDelayMs ?? 3_000;
  const published: string[] = [];
  const acceptedUnverified: string[] = [];
  const unknown: string[] = [];
  const outcomes: PublishOutcome[] = [];

  const report = (ok: boolean, failure: PublishFailure | undefined, index: number): PublishReport => ({
    ok,
    published,
    acceptedUnverified,
    unknown,
    outcomes,
    failure,
    notAttempted: plan.packages.slice(index + 1).map((remaining) => `${remaining.name}@${remaining.version}`),
  });

  /** Stop before any byte of this package was uploaded. */
  const refuse = (entry: PlanEntry, code: string, message: string, index: number): PublishReport =>
    report(false, { name: entry.name, version: entry.version, code, message }, index);

  /** Stop after an upload was attempted, recording what became of it. */
  const settle = (
    entry: PlanEntry,
    upload: UploadState,
    code: string,
    message: string,
    index: number,
  ): PublishReport => {
    const subject = `${entry.name}@${entry.version}`;
    outcomes.push({ name: entry.name, version: entry.version, upload, verified: false, detail: message });
    if (upload === 'accepted') acceptedUnverified.push(subject);
    if (upload === 'unknown') unknown.push(subject);
    return report(false, { name: entry.name, version: entry.version, code, message }, index);
  };

  for (const [index, entry] of plan.packages.entries()) {
    const subject = `${entry.name}@${entry.version}`;

    // Source facts first: if this checkout is no longer the approved commit at
    // the tip of main, nothing about the registry matters.
    const stale = await ports.revalidateSource();
    if (stale.length > 0) {
      return refuse(
        entry,
        'source_no_longer_current',
        `the approved source is no longer current: ${stale.map((finding) => finding.message).join('; ')}`,
        index,
      );
    }

    const before = await ports.registry.lookup(entry.name);
    if (before.kind === 'unauthorized' || before.kind === 'error') {
      return refuse(
        entry,
        'registry_unavailable',
        `registry could not be consulted before publishing: ${before.detail}`,
        index,
      );
    }
    if (before.kind === 'found' && before.packument.versions.has(entry.version)) {
      return refuse(
        entry,
        'registry_version_exists',
        `${subject} appeared on the registry after preflight; refusing to overwrite an immutable version`,
        index,
      );
    }
    const tagRegression = checkDistTagStillSafe(entry, plan.distTag, before);
    if (tagRegression !== undefined) {
      return refuse(entry, 'registry_dist_tag_regression', tagRegression, index);
    }
    const dependencyProblem = await checkDependenciesStillAvailable(
      entry,
      plan,
      new Set([...published, ...acceptedUnverified]),
      ports,
    );
    if (dependencyProblem !== undefined) {
      return refuse(entry, dependencyProblem.code, dependencyProblem.message, index);
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
      // A non-zero exit is not proof that nothing was uploaded: npm can fail
      // after the registry has accepted the tarball. Ask the registry what
      // actually happened rather than assuming the safe-sounding answer.
      const detail = `npm publish exited ${outcome.code}: ${tail(outcome.stderr || outcome.stdout)}`;
      const after = await ports.registry.lookup(entry.name);
      if (after.kind === 'found' && after.packument.versions.has(entry.version)) {
        return settle(
          entry,
          'accepted',
          'publish_failed_version_public',
          `${detail} — but ${subject} is on the registry and is therefore public and immutable; do not republish it`,
          index,
        );
      }
      if (after.kind === 'found' || after.kind === 'absent') {
        outcomes.push({ name: entry.name, version: entry.version, upload: 'rejected', verified: false, detail });
        return report(
          false,
          { name: entry.name, version: entry.version, code: 'publish_failed', message: detail },
          index,
        );
      }
      return settle(
        entry,
        'unknown',
        'publish_unknown',
        `${detail} — and the registry could not be consulted afterwards (${after.detail}), so it is unknown whether ${subject} is public`,
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
      return settle(
        entry,
        'accepted',
        'readback_mismatch',
        `npm accepted ${subject}, but registry readback failed after ${attempts} attempts: ${readback
          .map((finding) => finding.message)
          .join('; ')}`,
        index,
      );
    }

    published.push(subject);
    outcomes.push({ name: entry.name, version: entry.version, upload: 'accepted', verified: true, detail: undefined });
    ports.log(`[release] verified ${subject} on the registry`);
  }

  return report(true, undefined, plan.packages.length - 1);
}

/**
 * Operator-facing summary. Partial publication is reported, never hidden, and
 * an upload whose fate is uncertain is never folded into "not published" — the
 * recovery instruction depends on getting that distinction right.
 */
export function summarizeReport(report: PublishReport): string {
  const list = (values: readonly string[]): string => (values.length === 0 ? '<none>' : values.join(', '));
  const lines: string[] = [];
  lines.push(`published and verified: ${list(report.published)}`);
  if (report.acceptedUnverified.length > 0) {
    lines.push(`published but NOT verified: ${list(report.acceptedUnverified)}`);
    lines.push('  these versions are public and immutable; they must never be named in a recovery dispatch');
  }
  if (report.unknown.length > 0) {
    lines.push(`outcome unknown: ${list(report.unknown)}`);
    lines.push('  these may or may not be public; establish their registry state before dispatching anything else');
  }
  if (report.ok) return lines.join('\n');

  const failure = report.failure;
  if (failure !== undefined) {
    lines.push(`failed at: ${failure.name}@${failure.version} [${failure.code}]`);
    lines.push(`reason: ${failure.message}`);
  }
  lines.push(`not attempted: ${list(report.notAttempted)}`);

  const unresolved = report.acceptedUnverified.length + report.unknown.length > 0;
  lines.push(
    unresolved
      ? 'recovery: nothing was unpublished or overwritten, but this run did not establish the full registry state. ' +
          'Reconcile every package listed above against the registry first, then dispatch a new release whose scope ' +
          'names only the packages that are confirmed still unpublished, at the same versions.'
      : 'recovery: nothing is unpublished or overwritten. Review what is already public, then dispatch a new release ' +
          'whose scope names only the packages that are still unpublished, at the same versions.',
  );
  return lines.join('\n');
}
