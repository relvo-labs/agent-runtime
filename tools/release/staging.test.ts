import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSourceCurrency, validatePlanAgainstRequest } from './lib/dispatch.ts';
import type { PlanEntry, ReleasePlan } from './lib/preflight.ts';
import {
  digestPlan,
  loadStaging,
  resolveStagingRoot,
  writeStaging,
  PLAN_DIGEST_FILE,
  TARBALL_DIRECTORY,
} from './lib/staging.ts';
import { inspectTarball, tarballFileName } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

const PROTOCOL = '@relvo-labs/agent-protocol';
const SHA = 'f'.repeat(40);
const bytes = buildPackageTarball({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '4.5.4' } });
const artifact = inspectTarball(tarballFileName(PROTOCOL, '0.2.0'), bytes);

const scratches: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'relvo-release-staging-test-'));
  scratches.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of scratches.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function entry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    order: 1,
    name: PROTOCOL,
    version: '0.2.0',
    tarball: artifact.fileName,
    size: artifact.size,
    sha256: artifact.sha256,
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    dependencies: { zod: '4.5.4' },
    peerDependencies: {},
    ...overrides,
  };
}

function plan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    schema: 'relvo-release-plan/1',
    sourceSha: SHA,
    distTag: 'latest',
    registry: 'https://registry.npmjs.org',
    packages: [entry()],
    excluded: [],
    ...overrides,
  };
}

function stage(release: ReleasePlan = plan()): string {
  const root = scratch();
  writeStaging(root, release, new Map([[PROTOCOL, bytes]]));
  return root;
}

function codes(root: string): readonly string[] {
  const result = loadStaging(root);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

describe('staged release verification', () => {
  it('round-trips a plan and its tarballs', () => {
    const root = stage();
    const result = loadStaging(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staging.plan.packages[0]?.name).toBe(PROTOCOL);
    expect(result.staging.artifacts.get(PROTOCOL)?.sha256).toBe(artifact.sha256);
    expect(result.staging.tarballPath(entry())).toBe(join(root, TARBALL_DIRECTORY, artifact.fileName));
  });

  it('refuses a tarball whose bytes changed in transit', () => {
    const root = stage();
    const path = join(root, TARBALL_DIRECTORY, artifact.fileName);
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0])]));
    expect(codes(root)).toContain('staging_tarball_digest');
  });

  it('refuses a tarball that is not the package the plan names', () => {
    const other = buildPackageTarball({ name: '@relvo-labs/agent-runtime', version: '0.2.0' });
    const otherArtifact = inspectTarball(artifact.fileName, other);
    const root = scratch();
    writeStaging(
      root,
      plan({
        packages: [
          entry({
            size: otherArtifact.size,
            sha256: otherArtifact.sha256,
            integrity: otherArtifact.integrity,
            shasum: otherArtifact.shasum,
          }),
        ],
      }),
      new Map([[PROTOCOL, other]]),
    );
    expect(codes(root)).toContain('staging_tarball_identity');
  });

  /**
   * Regression: the gated job must refuse an archive whose identity npm would
   * read differently, even though the bytes are exactly the reviewed ones.
   *
   * An independent review staged an archive carrying both
   * `package/package.json` (agent-protocol@0.2.0) and `package/./package.json`
   * (agent-runtime@9.9.9). Preflight planned it as the former and `loadStaging`
   * accepted it; npm's own reader resolved it as the latter. Every hash in the
   * plan matched, because the ambiguity is in the archive, not the transport.
   */
  it('refuses a staged archive that resolves to two identities', () => {
    const ambiguous = buildTarball({
      'package/package.json': JSON.stringify({ name: PROTOCOL, version: '0.2.0' }),
      'package/./package.json': JSON.stringify({ name: '@relvo-labs/agent-runtime', version: '9.9.9' }),
      'package/README.md': '# x\n',
      'package/LICENSE': 'Apache-2.0\n',
      'package/NOTICE': 'NOTICE\n',
    });
    const root = scratch();
    mkdirSync(join(root, TARBALL_DIRECTORY), { recursive: true });
    writeFileSync(join(root, TARBALL_DIRECTORY, artifact.fileName), ambiguous);
    writeFileSync(join(root, 'plan.json'), `${JSON.stringify(plan(), null, 2)}\n`);
    writeFileSync(join(root, PLAN_DIGEST_FILE), `${digestPlan(plan())}\n`);

    expect(codes(root)).toContain('staging_tarball_unreadable');
  });

  it('refuses a plan whose recorded digest does not describe it', () => {
    const root = stage();
    writeFileSync(join(root, PLAN_DIGEST_FILE), `${'0'.repeat(64)}\n`);
    expect(codes(root)).toContain('staging_digest_mismatch');
  });

  it('refuses a plan that is missing, malformed, reordered or escapes the staging directory', () => {
    const missing = scratch();
    expect(codes(missing)).toContain('staging_plan_unreadable');

    const malformed = stage();
    writeFileSync(join(malformed, 'plan.json'), '{"schema":"something-else"}');
    expect(codes(malformed)).toContain('staging_plan_malformed');

    const reordered = stage(plan({ packages: [entry({ order: 7 })] }));
    expect(codes(reordered)).toContain('staging_plan_malformed');

    const traversal = scratch();
    mkdirSync(join(traversal, TARBALL_DIRECTORY), { recursive: true });
    writeFileSync(
      join(traversal, 'plan.json'),
      JSON.stringify(plan({ packages: [entry({ tarball: '../escape.tgz' })] })),
    );
    expect(codes(traversal)).toContain('staging_plan_malformed');
  });

  it('refuses a staging directory carrying an artifact the plan does not name', () => {
    const root = stage();
    writeFileSync(join(root, TARBALL_DIRECTORY, 'extra-1.0.0.tgz'), bytes);
    expect(codes(root)).toContain('staging_unexpected_artifact');
  });

  it('refuses a plan whose tarball never arrived', () => {
    const root = stage();
    rmSync(join(root, TARBALL_DIRECTORY, artifact.fileName));
    expect(codes(root)).toContain('staging_tarball_missing');
  });

  it('refuses a tarball whose packed dependencies were altered after planning', () => {
    const root = stage(plan({ packages: [entry({ dependencies: { zod: '4.5.5' } })] }));
    expect(codes(root)).toContain('staging_tarball_dependencies');
  });

  it('locates the staging root whether the download nested it or not', () => {
    const direct = stage();
    expect(resolveStagingRoot(direct)).toBe(direct);

    const parent = scratch();
    const nested = join(parent, 'release-staging');
    mkdirSync(nested, { recursive: true });
    writeStaging(nested, plan(), new Map([[PROTOCOL, bytes]]));
    expect(resolveStagingRoot(parent)).toBe(nested);

    const ambiguous = scratch();
    for (const name of ['one', 'two']) {
      const child = join(ambiguous, name);
      mkdirSync(child, { recursive: true });
      writeStaging(child, plan(), new Map([[PROTOCOL, bytes]]));
    }
    expect(resolveStagingRoot(ambiguous)).toBeUndefined();
    expect(resolveStagingRoot(join(ambiguous, 'absent'))).toBeUndefined();
  });

  it('hashes the plan reproducibly', () => {
    expect(digestPlan(plan())).toBe(digestPlan(plan()));
    expect(digestPlan(plan())).not.toBe(digestPlan(plan({ distTag: 'next' })));
  });
});

describe('staged plan against the dispatch that approved it', () => {
  const request = { sourceSha: SHA, distTag: 'latest', targets: [{ name: PROTOCOL, version: '0.2.0' }] };

  it('accepts the plan the dispatch describes', () => {
    expect(validatePlanAgainstRequest(plan(), request)).toEqual([]);
  });

  it('refuses a plan from another commit, tag, registry or scope', () => {
    const code = (candidate: ReleasePlan): readonly string[] =>
      validatePlanAgainstRequest(candidate, request).map((finding) => finding.code);

    expect(code(plan({ sourceSha: 'a'.repeat(40) }))).toContain('plan_source_mismatch');
    expect(code(plan({ distTag: 'next' }))).toContain('plan_dist_tag_mismatch');
    expect(code(plan({ registry: 'https://internal.example.com' }))).toContain('plan_registry_mismatch');
    expect(code(plan({ packages: [entry({ version: '0.3.0' })] }))).toContain('plan_scope_mismatch');
    expect(code(plan({ packages: [entry(), entry({ order: 2, name: '@relvo-labs/agent-runtime' })] }))).toContain(
      'plan_scope_mismatch',
    );
  });
});

/**
 * The rule the runbook states — *only the exact current tip of main may be
 * released* — is only true if it is checked after the environment approval, not
 * just before it. Preflight runs before approval, and an approval can sit for
 * hours; `origin/main` in the gated job is whatever main was when that job
 * checked out. Both gated entry points re-derive these facts, and the publisher
 * re-derives them again before every individual upload.
 */
describe('source currency after the approval', () => {
  const request = { sourceSha: SHA, distTag: 'latest', targets: [{ name: PROTOCOL, version: '0.2.0' }] };
  const current = {
    request,
    context: { eventName: 'workflow_dispatch', ref: 'refs/heads/main', runnerSha: SHA },
    git: { headSha: SHA, originMainSha: SHA, porcelain: '' },
    pendingChangesetFiles: [] as readonly string[],
  };
  const codesOf = (input: Parameters<typeof checkSourceCurrency>[0]): readonly string[] =>
    checkSourceCurrency(input).map((finding) => finding.code);

  it('accepts a checkout that is still the approved tip of main', () => {
    expect(checkSourceCurrency(current)).toEqual([]);
  });

  it('refuses once main has advanced past the approved commit', () => {
    const moved = { ...current, git: { ...current.git, originMainSha: 'a'.repeat(40) } };
    expect(codesOf(moved)).toContain('git_main_tip');
    expect(checkSourceCurrency(moved)[0]?.message).toContain('only the exact current tip of main');
  });

  it('refuses a checkout, dispatch or event that drifted from the approved one', () => {
    expect(codesOf({ ...current, git: { ...current.git, headSha: 'b'.repeat(40) } })).toContain('git_head');
    expect(codesOf({ ...current, git: { ...current.git, porcelain: ' M packages/x\n' } })).toContain('git_dirty');
    expect(codesOf({ ...current, context: { ...current.context, runnerSha: 'c'.repeat(40) } })).toContain(
      'context_sha',
    );
    expect(codesOf({ ...current, context: { ...current.context, ref: 'refs/heads/topic' } })).toContain('context_ref');
    expect(codesOf({ ...current, context: { ...current.context, eventName: 'push' } })).toContain('context_event');
  });

  it('refuses version intent that landed after the approval', () => {
    expect(codesOf({ ...current, pendingChangesetFiles: ['late-intent.md'] })).toContain('pending_version_intent');
  });
});
