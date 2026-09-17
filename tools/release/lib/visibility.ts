/**
 * Post-acceptance visibility reconciliation.
 *
 * ## The fact this module exists for
 *
 * `npm publish` exiting zero means the registry *accepted* the bytes. It does
 * not mean an anonymous read of the packument will show the version, because
 * npm scans a newly published package before it is made available: the usual
 * delay is around five minutes and npm documents that it can be fifteen minutes
 * or more.
 *
 * Run 34753860073 attempt 3 proved the cost of not modelling that.
 * `@relvo-labs/agent-protocol@0.2.0` was accepted, the job read the registry
 * five times separated by 3000 ms — four sleeps, about twelve seconds — and
 * then failed. The version was still answering 404 publicly 251 s after the
 * registry's own internal version timestamp and first answered 200 at 466 s.
 * The artifact was byte-identical to the reviewed one. Nothing was wrong except
 * the window.
 *
 * ## What reconciliation is, and what it is not
 *
 * It is a **read-only** exact-version lookup, repeated on a deterministic
 * schedule until one of four things is true. It is never a second upload: the
 * version is accepted, immutable and possibly already public, so re-running the
 * upload command could only ever fail — and a run that is *able* to re-run it is
 * a run that someone will eventually be told to "just retry".
 *
 * Only the two expected post-acceptance not-yet-visible answers are retried:
 *
 *   - the package is absent from the registry entirely (404), or
 *   - the packument is well-formed but does not yet list the exact version.
 *
 * Everything else ends reconciliation immediately and fails closed:
 *
 *   - a network failure, a 5xx, a timeout, a rate limit, an auth failure or a
 *     malformed packument — a registry that will not answer is not a registry
 *     that is still scanning, and spending a twenty-minute budget re-asking a
 *     401 would turn a credential problem into a timeout;
 *   - an identity, integrity, shasum, dependency, peer-dependency or dist-tag
 *     mismatch — the registry answered, and it is serving something other than
 *     what was reviewed. More reads cannot make that true, and waiting only
 *     delays the refusal.
 *
 * ## The budget, and why it is a floor rather than a guess
 *
 * `VISIBILITY_BUDGET_MINUTES` is deliberately larger than the fifteen minutes
 * npm documents as the upper end of the usual range: a bound equal to the
 * documented worst case fails on exactly the runs it exists to survive. It is
 * still a *bound*. When it expires the version stays `accepted_pending`, the run
 * stops non-zero before any dependent is attempted, and reconciliation becomes a
 * human step (see `docs/release.md`) — never an automatic republication.
 */

import type { Finding } from './plan.ts';
import type { PlanEntry } from './preflight.ts';
import { classifyReadback, verifyReadback } from './readback.ts';
import type { RegistryPort } from './registry.ts';

/** What npm documents as the upper end of the usual publish-scan delay. */
export const NPM_DOCUMENTED_SCAN_DELAY_MINUTES = 15;

/**
 * Per-package read-only reconciliation budget. Strictly greater than the
 * documented delay above; see the module note.
 */
export const VISIBILITY_BUDGET_MINUTES = 20;
export const VISIBILITY_BUDGET_MS = VISIBILITY_BUDGET_MINUTES * 60_000;

/** The publishable scope this repository plans for: the eight public packages. */
export const RELEASE_SCOPE_PACKAGES = 8;

/**
 * Per package, everything the gated job does around the wait: the pre-upload
 * re-establishment of source currency, dist-tag and every dependency, and the
 * upload itself including provenance signing.
 */
export const PER_PACKAGE_UPLOAD_MINUTES = 2;

/**
 * Once per job: checkout with complete history, `pnpm/setup`, the frozen
 * script-free install, the artifact download and `verify-staging.ts` re-hashing
 * and re-reading every tarball.
 */
export const PUBLISH_JOB_SETUP_MINUTES = 14;

/**
 * The reviewed `publish` job timeout, derived rather than chosen.
 *
 * A timeout shorter than the worst case the publisher is willing to wait for is
 * the same bug as a readback window shorter than the registry's scan delay: the
 * job is killed mid-wait, and what it leaves behind is an accepted version whose
 * visibility nobody adjudicated. 8 × (20 + 2) + 14 = 190.
 */
export const PUBLISH_JOB_TIMEOUT_MINUTES =
  RELEASE_SCOPE_PACKAGES * (VISIBILITY_BUDGET_MINUTES + PER_PACKAGE_UPLOAD_MINUTES) + PUBLISH_JOB_SETUP_MINUTES;

/** The `verify` job holds no credential and waits for nothing. */
export const VERIFY_JOB_TIMEOUT_MINUTES = 45;

/**
 * Deterministic backoff. No jitter and no randomness: the schedule a test runs
 * is the schedule a release runs, and "how long did we actually wait" is a
 * property the tests can assert exactly.
 */
export type VisibilityPolicy = {
  /** Total wall-clock budget for one package's reconciliation. */
  readonly budgetMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
};

export const DEFAULT_VISIBILITY_POLICY: VisibilityPolicy = {
  budgetMs: VISIBILITY_BUDGET_MS,
  initialDelayMs: 5_000,
  maxDelayMs: 30_000,
  factor: 2,
};

/**
 * The delay before read `attempt + 1`, or `undefined` when the budget is spent.
 *
 * The final delay is clipped to whatever remains, so the last read happens at
 * the budget boundary rather than past it: the bound stated in `docs/release.md`
 * is the bound the code actually applies.
 */
export function nextVisibilityDelayMs(
  policy: VisibilityPolicy,
  attempt: number,
  elapsedMs: number,
): number | undefined {
  const remaining = policy.budgetMs - elapsedMs;
  if (remaining <= 0) return undefined;
  const growth = policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, growth, remaining);
}

export type VisibilityPorts = {
  readonly registry: RegistryPort;
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic-enough clock. Injected so the budget is testable without waiting. */
  readonly now: () => number;
};

export type VisibilityOutcome = {
  /**
   *   - `verified`         — the registry serves exactly what was reviewed;
   *   - `not_yet_visible`  — still 404/version-missing when the budget expired;
   *   - `unavailable`      — network, 5xx, timeout, auth or malformed answer;
   *   - `mismatch`         — answered, and serving something else.
   */
  readonly kind: 'verified' | 'not_yet_visible' | 'unavailable' | 'mismatch';
  readonly reads: number;
  readonly elapsedMs: number;
  readonly findings: readonly Finding[];
};

/**
 * Read-only reconciliation of one accepted version.
 *
 * There is no upload port here at all. That is the design: this function
 * physically cannot republish, so no future edit to the retry policy can turn
 * into a second `npm publish`.
 */
export async function reconcileVisibility(
  entry: PlanEntry,
  distTag: string,
  ports: VisibilityPorts,
  policy: VisibilityPolicy = DEFAULT_VISIBILITY_POLICY,
): Promise<VisibilityOutcome> {
  const started = ports.now();
  let reads = 0;
  for (;;) {
    const findings = verifyReadback(entry, distTag, await ports.registry.lookup(entry.name));
    reads += 1;
    const verdict = classifyReadback(findings);
    const elapsedMs = ports.now() - started;
    if (verdict !== 'not_yet_visible') return { kind: verdict, reads, elapsedMs, findings };

    const delay = nextVisibilityDelayMs(policy, reads, elapsedMs);
    if (delay === undefined) return { kind: 'not_yet_visible', reads, elapsedMs, findings };
    await ports.sleep(delay);
  }
}

/** Human-readable bound, for log lines and refusal messages. */
export function describeBudget(policy: VisibilityPolicy): string {
  const minutes = policy.budgetMs / 60_000;
  return `${Number.isInteger(minutes) ? minutes.toString() : minutes.toFixed(1)}m`;
}
