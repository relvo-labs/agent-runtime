import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyReadback, PENDING_VISIBILITY_CODES, verifyReadback } from './lib/readback.ts';
import type { PlanEntry } from './lib/preflight.ts';
import type { RegistryLookup } from './lib/registry.ts';
import { inspectTarball, tarballFileName } from './lib/tarball.ts';
import {
  DEFAULT_VISIBILITY_POLICY,
  NPM_DOCUMENTED_SCAN_DELAY_MINUTES,
  PER_PACKAGE_UPLOAD_MINUTES,
  PUBLISH_JOB_SETUP_MINUTES,
  PUBLISH_JOB_TIMEOUT_MINUTES,
  RELEASE_SCOPE_PACKAGES,
  VISIBILITY_BUDGET_MINUTES,
  VISIBILITY_BUDGET_MS,
  describeBudget,
  nextVisibilityDelayMs,
  reconcileVisibility,
  type VisibilityPorts,
} from './lib/visibility.ts';
import { buildPackageTarball, published } from './testing/fixtures.ts';

const PROTOCOL = '@relvo-labs/agent-protocol';
const bytes = buildPackageTarball({ name: PROTOCOL, version: '0.2.0' });
const artifact = inspectTarball(tarballFileName(PROTOCOL, '0.2.0'), bytes);
const entry: PlanEntry = {
  order: 1,
  name: PROTOCOL,
  version: '0.2.0',
  tarball: artifact.fileName,
  size: artifact.size,
  sha256: artifact.sha256,
  integrity: artifact.integrity,
  shasum: artifact.shasum,
  dependencies: {},
  peerDependencies: {},
};
const visible = published(PROTOCOL, { '0.2.0': { tarball: bytes } }, { latest: '0.2.0' });

/** A registry whose answers depend only on the virtual clock. */
function scriptedPorts(answer: (elapsedMs: number) => RegistryLookup): VisibilityPorts & {
  readonly clock: { ms: number };
  readonly reads: number[];
} {
  const clock = { ms: 0 };
  const reads: number[] = [];
  return {
    clock,
    reads,
    registry: {
      lookup: () => {
        reads.push(clock.ms);
        return Promise.resolve(answer(clock.ms));
      },
    },
    sleep: (ms) => {
      clock.ms += ms;
      return Promise.resolve();
    },
    now: () => clock.ms,
  };
}

describe('the visibility budget', () => {
  it('is strictly greater than the delay npm documents as possible', () => {
    expect(VISIBILITY_BUDGET_MINUTES).toBeGreaterThan(NPM_DOCUMENTED_SCAN_DELAY_MINUTES);
    expect(VISIBILITY_BUDGET_MS).toBe(VISIBILITY_BUDGET_MINUTES * 60_000);
    expect(describeBudget(DEFAULT_VISIBILITY_POLICY)).toBe(`${String(VISIBILITY_BUDGET_MINUTES)}m`);
  });

  /**
   * The workflow timeout and the wait the publisher is willing to make are the
   * same decision seen from two ends. If they disagree, the runner kills the
   * job mid-wait and leaves an accepted upload nobody adjudicated — which is
   * the failure this repair exists to remove, in a different costume.
   */
  it('is what the reviewed publish-job timeout is derived from', () => {
    expect(PUBLISH_JOB_TIMEOUT_MINUTES).toBe(
      RELEASE_SCOPE_PACKAGES * (VISIBILITY_BUDGET_MINUTES + PER_PACKAGE_UPLOAD_MINUTES) + PUBLISH_JOB_SETUP_MINUTES,
    );
    expect(PUBLISH_JOB_TIMEOUT_MINUTES).toBeGreaterThan(RELEASE_SCOPE_PACKAGES * VISIBILITY_BUDGET_MINUTES);
  });

  it('is the number the release workflow actually sets on the gated job', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain(`    timeout-minutes: ${String(PUBLISH_JOB_TIMEOUT_MINUTES)}\n`);
  });
});

describe('the backoff schedule', () => {
  it('grows to a cap and is fully deterministic', () => {
    const policy = DEFAULT_VISIBILITY_POLICY;
    expect(nextVisibilityDelayMs(policy, 1, 0)).toBe(5_000);
    expect(nextVisibilityDelayMs(policy, 2, 5_000)).toBe(10_000);
    expect(nextVisibilityDelayMs(policy, 3, 15_000)).toBe(20_000);
    expect(nextVisibilityDelayMs(policy, 4, 35_000)).toBe(30_000);
    expect(nextVisibilityDelayMs(policy, 9, 600_000)).toBe(30_000);
  });

  it('clips the final delay to the budget and then refuses to wait again', () => {
    const policy = DEFAULT_VISIBILITY_POLICY;
    expect(nextVisibilityDelayMs(policy, 40, VISIBILITY_BUDGET_MS - 7_000)).toBe(7_000);
    expect(nextVisibilityDelayMs(policy, 41, VISIBILITY_BUDGET_MS)).toBeUndefined();
    expect(nextVisibilityDelayMs(policy, 41, VISIBILITY_BUDGET_MS + 1)).toBeUndefined();
  });
});

describe('readback classification', () => {
  it('treats only an absent package or a missing exact version as not-yet-visible', () => {
    expect(classifyReadback([])).toBe('verified');
    for (const code of PENDING_VISIBILITY_CODES) {
      expect(classifyReadback([{ code, message: 'x' }])).toBe('not_yet_visible');
    }
    expect(classifyReadback([{ code: 'readback_unavailable', message: 'ETIMEDOUT' }])).toBe('unavailable');
    expect(classifyReadback([{ code: 'readback_integrity', message: 'x' }])).toBe('mismatch');
    expect(classifyReadback([{ code: 'readback_dist_tag', message: 'x' }])).toBe('mismatch');
    // Fail closed: an unrecognised finding is a reason to stop, not to wait.
    expect(classifyReadback([{ code: 'readback_something_new', message: 'x' }])).toBe('mismatch');
    // A mixed answer is never merely "not yet".
    expect(
      classifyReadback([
        { code: 'readback_absent', message: 'x' },
        { code: 'readback_identity', message: 'x' },
      ]),
    ).toBe('mismatch');
  });

  it('derives those codes from what a real readback produces', () => {
    expect(classifyReadback(verifyReadback(entry, 'latest', { kind: 'absent' }))).toBe('not_yet_visible');
    expect(
      classifyReadback(verifyReadback(entry, 'latest', published(PROTOCOL, { '0.1.0': {} }, { latest: '0.1.0' }))),
    ).toBe('not_yet_visible');
    expect(classifyReadback(verifyReadback(entry, 'latest', { kind: 'unauthorized', detail: '401' }))).toBe(
      'unavailable',
    );
    expect(classifyReadback(verifyReadback(entry, 'latest', { kind: 'error', detail: 'malformed' }))).toBe(
      'unavailable',
    );
    expect(classifyReadback(verifyReadback(entry, 'latest', visible))).toBe('verified');
  });
});

describe('read-only reconciliation', () => {
  it('keeps reading until the version appears, and reports how long that took', async () => {
    const appearsAt = 466_000; // the observed delay in run 34753860073 attempt 3
    const ports = scriptedPorts((elapsed) => (elapsed >= appearsAt ? visible : { kind: 'absent' }));
    const outcome = await reconcileVisibility(entry, 'latest', ports);

    expect(outcome.kind).toBe('verified');
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(appearsAt);
    expect(outcome.elapsedMs).toBeLessThan(appearsAt + DEFAULT_VISIBILITY_POLICY.maxDelayMs);
    expect(outcome.reads).toBeGreaterThan(1);
  });

  it('stops at the budget, with the last read taken at the boundary', async () => {
    const ports = scriptedPorts(() => ({ kind: 'absent' }));
    const outcome = await reconcileVisibility(entry, 'latest', ports);

    expect(outcome.kind).toBe('not_yet_visible');
    expect(outcome.elapsedMs).toBe(VISIBILITY_BUDGET_MS);
    expect(ports.reads.at(-1)).toBe(VISIBILITY_BUDGET_MS);
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['readback_absent']);
  });

  it('returns after a single read when the answer is one that cannot change by waiting', async () => {
    for (const [answer, kind] of [
      [{ kind: 'error', detail: 'ETIMEDOUT' } satisfies RegistryLookup, 'unavailable'],
      [{ kind: 'unauthorized', detail: '401' } satisfies RegistryLookup, 'unavailable'],
      [published(PROTOCOL, { '0.2.0': {} }, { latest: '0.2.0' }), 'mismatch'],
    ] as const) {
      const ports = scriptedPorts(() => answer);
      const outcome = await reconcileVisibility(entry, 'latest', ports);
      expect(outcome.kind).toBe(kind);
      expect(outcome.reads).toBe(1);
      expect(ports.clock.ms).toBe(0);
    }
  });
});
