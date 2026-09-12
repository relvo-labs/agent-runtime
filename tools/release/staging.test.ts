import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSourceCurrency, validatePlanAgainstRequest } from './lib/dispatch.ts';
import type { PlanEntry, ReleasePlan } from './lib/preflight.ts';
import { parseRemoteMain, readRemoteMain, type CommandRunner, type RemoteMain } from './lib/workspace.ts';
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
    remoteMain: { kind: 'observed', sha: SHA } satisfies RemoteMain,
    pendingChangesetFiles: [] as readonly string[],
  };
  const codesOf = (input: Parameters<typeof checkSourceCurrency>[0]): readonly string[] =>
    checkSourceCurrency(input).map((finding) => finding.code);

  it('accepts a checkout that is still the approved tip of main', () => {
    expect(checkSourceCurrency(current)).toEqual([]);
  });

  it('refuses once the cached origin/main has advanced past the approved commit', () => {
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

  /**
   * Regression for the closure finding. The cached `origin/main` cannot change
   * once the gated job has checked out, so re-reading it proves nothing about
   * the world after the approval. A review advanced `main` on the server and
   * every per-upload check still passed. The remote is now a separate input.
   */
  it('refuses when the remote has moved even though the cached ref has not', () => {
    const advanced = { ...current, remoteMain: { kind: 'observed', sha: 'd'.repeat(40) } satisfies RemoteMain };
    // The whole point: the cached ref still agrees, so `git_main_tip` is silent.
    expect(codesOf(advanced)).not.toContain('git_main_tip');
    expect(codesOf(advanced)).toEqual(['git_remote_main_tip']);
    expect(checkSourceCurrency(advanced)[0]?.message).toContain('advanced after this release was approved');
  });

  it('refuses when the remote cannot be consulted at all', () => {
    const blind = {
      ...current,
      remoteMain: {
        kind: 'unavailable',
        detail: 'git ls-remote exited 128: fatal: could not read',
      } satisfies RemoteMain,
    };
    expect(codesOf(blind)).toEqual(['git_remote_unavailable']);
    expect(checkSourceCurrency(blind)[0]?.message).toContain('unverifiable branch tip');
  });
});

/**
 * The command boundary itself, exercised with injected git output rather than a
 * real remote. No subprocess runs, nothing is fetched, and every fail-closed
 * path is reachable deterministically.
 */
describe('observing the remote tip of main', () => {
  const run = (result: { code?: number; stdout?: string; stderr?: string }): CommandRunner => {
    return (program, args) => {
      calls.push([program, ...args]);
      return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
  };
  let calls: string[][] = [];
  beforeEach(() => {
    calls = [];
  });

  it('asks the remote, read-only, for exactly refs/heads/main', () => {
    const observed = readRemoteMain('/repo', run({ stdout: `${SHA}\trefs/heads/main\n` }));
    expect(observed).toEqual({ kind: 'observed', sha: SHA });
    expect(calls).toEqual([['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main']]);
  });

  it('reproduces the closure probe: the server moves while the cached ref does not', () => {
    // The reviewer stubbed the same boundary and advanced only the server.
    const cachedGit = { headSha: SHA, originMainSha: SHA, porcelain: '' };
    const serverSha = 'c'.repeat(40);
    const observed = readRemoteMain('/repo', run({ stdout: `${serverSha}\trefs/heads/main\n` }));
    const findings = checkSourceCurrency({
      request: { sourceSha: SHA, distTag: 'latest', targets: [] },
      context: { eventName: 'workflow_dispatch', ref: 'refs/heads/main', runnerSha: SHA },
      git: cachedGit,
      remoteMain: observed,
      pendingChangesetFiles: [],
    });
    expect(findings.map((finding) => finding.code)).toEqual(['git_remote_main_tip']);
  });

  it('refuses every way the remote can fail to give a clear answer', () => {
    const unavailable = (result: Parameters<typeof run>[0]): string =>
      (readRemoteMain('/repo', run(result)) as { kind: string; detail: string }).detail;

    expect(readRemoteMain('/repo', run({ code: 128, stderr: 'fatal: repository not found' })).kind).toBe('unavailable');
    expect(unavailable({ code: 2, stderr: 'could not read Username' })).toContain('git ls-remote exited 2');
    // `--exit-code` makes an absent ref a non-zero exit, but an empty success
    // must refuse too rather than be read as "main does not exist, carry on".
    expect(unavailable({ stdout: '' })).toContain('lists no `refs/heads/main`');
    expect(unavailable({ stdout: 'not-a-ref-line\n' })).toContain('cannot parse');
    expect(unavailable({ stdout: `${'a'.repeat(39)}\trefs/heads/main\n` })).toContain('cannot parse');
    expect(unavailable({ stdout: `${SHA.toUpperCase()}\trefs/heads/main\n` })).toContain('cannot parse');
    expect(unavailable({ stdout: `${SHA}\trefs/heads/other\n` })).toContain('without a `refs/heads/main` entry');
    expect(unavailable({ stdout: `${SHA}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/main\n` })).toContain(
      'more than once',
    );
  });

  it('treats a boundary that throws as unavailable rather than propagating', () => {
    const thrown = readRemoteMain('/repo', () => {
      throw new Error('ENOENT git');
    });
    expect(thrown.kind).toBe('unavailable');
  });

  it('ignores unrelated refs that accompany the answer', () => {
    const observed = readRemoteMain(
      '/repo',
      run({ stdout: `${'e'.repeat(40)}\trefs/heads/mainline\n${SHA}\trefs/heads/main\n` }),
    );
    expect(observed).toEqual({ kind: 'observed', sha: SHA });
  });

  it('classifies output without running anything at all', () => {
    expect(parseRemoteMain({ code: 0, stdout: `${SHA}\trefs/heads/main`, stderr: '' })).toEqual({
      kind: 'observed',
      sha: SHA,
    });
  });
});
