import { describe, expect, it } from 'vitest';
import type { Finding } from './lib/plan.ts';
import {
  buildPublishArgv,
  publishRelease,
  redactSecrets,
  summarizeReport,
  type CommandOutcome,
  type PublishPorts,
} from './lib/publish.ts';
import type { PlanEntry, ReleasePlan } from './lib/preflight.ts';
import { parsePackument, type RegistryLookup } from './lib/registry.ts';
import { inspectTarball, tarballFileName } from './lib/tarball.ts';
import { NPM_DOCUMENTED_SCAN_DELAY_MINUTES, VISIBILITY_BUDGET_MS, type VisibilityPolicy } from './lib/visibility.ts';
import { buildPackageTarball, fakeRegistry, published, type RegistryScript } from './testing/fixtures.ts';

const PROTOCOL = '@relvo-labs/agent-protocol';
const RUNTIME = '@relvo-labs/agent-runtime';

const protocolBytes = buildPackageTarball({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '4.5.4' } });
const runtimeBytes = buildPackageTarball({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } });

function entry(name: string, bytes: Buffer, order: number, dependencies: Record<string, string>): PlanEntry {
  const artifact = inspectTarball(tarballFileName(name, '0.2.0'), bytes);
  return {
    order,
    name,
    version: '0.2.0',
    tarball: artifact.fileName,
    size: artifact.size,
    sha256: artifact.sha256,
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    dependencies,
    peerDependencies: {},
  };
}

const plan: ReleasePlan = {
  schema: 'relvo-release-plan/1',
  sourceSha: 'e'.repeat(40),
  distTag: 'latest',
  registry: 'https://registry.npmjs.org',
  packages: [
    entry(PROTOCOL, protocolBytes, 1, { zod: '4.5.4' }),
    entry(RUNTIME, runtimeBytes, 2, { [PROTOCOL]: '^0.2.0' }),
  ],
  excluded: [],
};

/**
 * `zod` is a third-party dependency of the first package in the plan. It is
 * scripted as published because publication re-establishes, immediately before
 * each upload, that every dependency a consumer will have to resolve is still
 * resolvable — a fact the environment approval cannot freeze.
 */
const zodPublished = published('zod', { '4.5.4': {} }, { latest: '4.5.4' });

const successfulReadback: RegistryScript = {
  zod: zodPublished,
  [PROTOCOL]: [
    { kind: 'absent' },
    published(PROTOCOL, { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } }, { latest: '0.2.0' }),
  ],
  [RUNTIME]: [
    { kind: 'absent' },
    published(
      RUNTIME,
      { '0.2.0': { dependencies: { [PROTOCOL]: '^0.2.0' }, tarball: runtimeBytes } },
      { latest: '0.2.0' },
    ),
  ],
};

type Harness = {
  readonly ports: PublishPorts;
  readonly commands: string[][];
  readonly logs: string[];
  readonly sleeps: number[];
  readonly revalidations: number[];
  /** Virtual wall clock, advanced only by `sleep`. No test ever really waits. */
  readonly clock: { ms: number };
};

function harness(
  script: RegistryScript,
  npm?: (argv: readonly string[]) => CommandOutcome,
  revalidate?: (call: number) => readonly Finding[],
): Harness {
  const commands: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const revalidations: number[] = [];
  const clock = { ms: 0 };
  const registry = fakeRegistry(script);
  return {
    commands,
    logs,
    sleeps,
    revalidations,
    clock,
    ports: {
      npm: (argv) => {
        commands.push([...argv]);
        return Promise.resolve(npm?.(argv) ?? { code: 0, stdout: '+ published', stderr: '' });
      },
      registry,
      log: (line) => logs.push(line),
      sleep: (ms) => {
        sleeps.push(ms);
        clock.ms += ms;
        return Promise.resolve();
      },
      now: () => clock.ms,
      revalidateSource: () => {
        revalidations.push(revalidations.length + 1);
        return revalidate?.(revalidations.length) ?? [];
      },
    },
  };
}

const options = { tarballPath: (target: PlanEntry) => `/staging/tarballs/${target.tarball}`, userconfig: '/tmp/npmrc' };

/** A budget small enough to expire inside a test, with the same shape as the real one. */
const briefBudget: VisibilityPolicy = { budgetMs: 10, initialDelayMs: 1, maxDelayMs: 4, factor: 2 };

describe('publish argv', () => {
  it('publishes one explicit tarball with provenance, an explicit tag and no lifecycle scripts', () => {
    expect(
      buildPublishArgv({
        tarball: '/staging/x.tgz',
        distTag: 'next',
        registry: 'https://registry.npmjs.org',
        userconfig: '/tmp/npmrc',
      }),
    ).toEqual([
      'publish',
      '/staging/x.tgz',
      '--ignore-scripts',
      '--access',
      'public',
      '--provenance',
      '--tag',
      'next',
      '--registry',
      'https://registry.npmjs.org',
      '--userconfig',
      '/tmp/npmrc',
    ]);
  });
});

describe('ordered publication', () => {
  it('publishes in dependency order and verifies each package before moving on', async () => {
    const { ports, commands, revalidations } = harness(successfulReadback);
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(true);
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`, `${RUNTIME}@0.2.0`]);
    expect(report.acceptedPending).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(commands.map((argv) => argv[1])).toEqual([
      `/staging/tarballs/${tarballFileName(PROTOCOL, '0.2.0')}`,
      `/staging/tarballs/${tarballFileName(RUNTIME, '0.2.0')}`,
    ]);
    // Source currency is re-established once per package, not once per run.
    expect(revalidations).toHaveLength(2);
  });

  it('tolerates a registry that has not caught up yet, within a bounded number of attempts', async () => {
    const slow: RegistryScript = {
      ...successfulReadback,
      [PROTOCOL]: [
        { kind: 'absent' },
        { kind: 'absent' },
        published(
          PROTOCOL,
          { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
          { latest: '0.2.0' },
        ),
      ],
    };
    const { ports, sleeps } = harness(slow);
    const report = await publishRelease(plan, ports, options);
    expect(report.ok).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('reports an upload the registry never confirms as accepted_pending, never as unpublished', async () => {
    const neverLands: RegistryScript = { ...successfulReadback, [PROTOCOL]: { kind: 'absent' } };
    const { ports, commands } = harness(neverLands);
    const report = await publishRelease(plan, ports, { ...options, visibility: briefBudget });

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('visibility_not_confirmed');
    expect(report.published).toEqual([]);
    expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(report.notAttempted).toEqual([`${RUNTIME}@0.2.0`]);
    expect(commands).toHaveLength(1); // the dependent was never attempted
  });

  it('fails when the registry serves different bytes, dependencies or dist-tag than were reviewed', async () => {
    const wrongBytes = published(
      PROTOCOL,
      { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: runtimeBytes } },
      { latest: '0.2.0' },
    );
    const wrongDependencies = published(
      PROTOCOL,
      { '0.2.0': { dependencies: { zod: '4.5.5' }, tarball: protocolBytes } },
      { latest: '0.2.0' },
    );
    const wrongTag = published(
      PROTOCOL,
      { '0.1.0': {}, '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
      { latest: '0.1.0' },
    );

    for (const mismatch of [wrongBytes, wrongDependencies, wrongTag]) {
      const { ports } = harness({ ...successfulReadback, [PROTOCOL]: [{ kind: 'absent' }, mismatch] });
      const report = await publishRelease(plan, ports, { ...options, visibility: briefBudget });
      expect(report.ok).toBe(false);
      expect(report.failure?.code).toBe('readback_mismatch');
      // The upload itself succeeded. Calling it unpublished would invite a
      // recovery dispatch naming a version that can never be overwritten.
      expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
      expect(report.published).toEqual([]);
    }
  });

  it('stops at the first upload failure and reports exactly what is already public', async () => {
    // The registry keeps reporting the dependent as absent after npm fails, so
    // this is the unambiguous case: nothing of it reached the registry.
    const { ports, commands } = harness({ ...successfulReadback, [RUNTIME]: { kind: 'absent' } }, (argv) =>
      argv[1]?.includes('runtime') === true
        ? { code: 1, stdout: '', stderr: 'E403 forbidden' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(false);
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(report.failure).toMatchObject({ name: RUNTIME, code: 'publish_failed' });
    expect(report.failure?.message).toContain('E403');
    expect(commands).toHaveLength(2);

    const summary = summarizeReport(report);
    expect(summary).toContain(`${PROTOCOL}@0.2.0`);
    expect(summary).toContain('nothing is unpublished or overwritten');
    expect(summary).toContain('still unpublished');
  });

  it('refuses to overwrite a version that appeared between preflight and publication', async () => {
    const raced: RegistryScript = {
      ...successfulReadback,
      [PROTOCOL]: published(PROTOCOL, { '0.2.0': {} }),
    };
    const { ports, commands } = harness(raced);
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('registry_version_exists');
    expect(commands).toEqual([]);
  });

  it('refuses to publish when the registry cannot be consulted at all', async () => {
    for (const unreachable of [
      { kind: 'error', detail: 'ETIMEDOUT' },
      { kind: 'unauthorized', detail: 'E401' },
    ] satisfies RegistryLookup[]) {
      const { ports, commands } = harness({ ...successfulReadback, [PROTOCOL]: unreachable });
      const report = await publishRelease(plan, ports, options);
      expect(report.failure?.code).toBe('registry_unavailable');
      expect(commands).toEqual([]);
    }
  });
});

/**
 * Regressions for the registry facts an environment approval cannot freeze.
 *
 * Each of these reproduces an independently demonstrated bypass: the reviewer
 * moved the dist-tag forward and unpublished a required dependency *after* a
 * successful preflight, and publication proceeded and reported success.
 */
describe('facts re-established after the approval', () => {
  it('refuses when the dist-tag has moved forward since preflight', async () => {
    const { ports, commands } = harness({
      ...successfulReadback,
      [PROTOCOL]: published(PROTOCOL, { '0.3.0': {} }, { latest: '0.3.0' }),
    });
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('registry_dist_tag_regression');
    expect(report.failure?.message).toContain('backwards');
    expect(commands).toEqual([]);
    expect(report.published).toEqual([]);
  });

  it('accepts a dist-tag that points at something older than this release', async () => {
    const { ports } = harness({
      ...successfulReadback,
      [PROTOCOL]: [
        published(PROTOCOL, { '0.1.0': {} }, { latest: '0.1.0' }),
        published(
          PROTOCOL,
          { '0.1.0': {}, '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
          { latest: '0.2.0' },
        ),
      ],
    });
    const report = await publishRelease(plan, ports, options);
    expect(report.ok).toBe(true);
  });

  it('refuses when a required registry dependency disappeared after preflight', async () => {
    const { ports, commands } = harness({ ...successfulReadback, zod: { kind: 'absent' } });
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('dependency_unpublished');
    expect(report.failure?.message).toContain('zod@4.5.4');
    expect(commands).toEqual([]);
  });

  it('refuses when a required registry dependency lost the exact version it needs', async () => {
    const { ports, commands } = harness({
      ...successfulReadback,
      zod: published('zod', { '4.5.5': {} }, { latest: '4.5.5' }),
    });
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('dependency_unpublished');
    expect(commands).toEqual([]);
  });

  it('refuses when the dependency registry answer is inconclusive', async () => {
    const { ports, commands } = harness({ ...successfulReadback, zod: { kind: 'error', detail: 'ETIMEDOUT' } });
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('registry_unavailable');
    expect(commands).toEqual([]);
  });

  it('refuses to publish a dependent before the in-scope dependency it needs is public', async () => {
    const reversed: ReleasePlan = {
      ...plan,
      packages: [
        { ...entry(RUNTIME, runtimeBytes, 1, { [PROTOCOL]: '^0.2.0' }) },
        { ...entry(PROTOCOL, protocolBytes, 2, { zod: '4.5.4' }) },
      ],
    };
    const { ports, commands } = harness(successfulReadback);
    const report = await publishRelease(reversed, ports, options);

    expect(report.failure?.code).toBe('dependency_order');
    expect(commands).toEqual([]);
  });
});

/**
 * Regression for the closure finding: an in-scope dependency is re-looked-up
 * too, not trusted because this run remembers publishing it.
 *
 * The reviewer built a three-package plan, let the first publish and verify,
 * removed it from the registry while the *second* was publishing, and watched
 * the third — which depends on the first — upload successfully with `ok: true`.
 * No lookup of the first package happened after its removal, because membership
 * of `publishedSoFar` short-circuited the check.
 *
 * The scenario is reproduced exactly: a registry whose contents change as a
 * side effect of an upload, so the removal happens mid-run rather than being
 * scripted in advance.
 */
describe('in-scope dependencies are re-established, not remembered', () => {
  const PROVIDER = '@relvo-labs/agent-provider';
  const names = [PROTOCOL, PROVIDER, RUNTIME] as const;

  /** Three packages; only the third depends on the first. */
  function threePackagePlan(): { plan: ReleasePlan; bytes: Buffer[] } {
    const bytes = [
      buildPackageTarball({ name: PROTOCOL, version: '0.2.0' }),
      buildPackageTarball({ name: PROVIDER, version: '0.2.0' }),
      buildPackageTarball({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } }),
    ];
    return {
      bytes,
      plan: {
        schema: 'relvo-release-plan/1',
        sourceSha: 'e'.repeat(40),
        distTag: 'latest',
        registry: 'https://registry.npmjs.org',
        packages: [
          entry(PROTOCOL, bytes[0]!, 1, {}),
          entry(PROVIDER, bytes[1]!, 2, {}),
          entry(RUNTIME, bytes[2]!, 3, { [PROTOCOL]: '^0.2.0' }),
        ],
        excluded: [],
      },
    };
  }

  /**
   * A registry that reflects what this run has uploaded, and forgets one
   * package again at a chosen moment.
   */
  function mutableRegistry(
    bytes: readonly Buffer[],
    removeAfterUploadOf: string | undefined,
  ): { readonly ports: PublishPorts; readonly commands: string[]; readonly lookups: string[] } {
    const uploaded = new Set<string>();
    const commands: string[] = [];
    const lookups: string[] = [];
    let removed = false;
    return {
      commands,
      lookups,
      ports: {
        registry: {
          lookup: (name) => {
            lookups.push(name);
            if (removed && name === PROTOCOL) return Promise.resolve({ kind: 'absent' } as RegistryLookup);
            if (!uploaded.has(name)) return Promise.resolve({ kind: 'absent' } as RegistryLookup);
            const index = names.indexOf(name as (typeof names)[number]);
            return Promise.resolve(
              published(
                name,
                { '0.2.0': { dependencies: name === RUNTIME ? { [PROTOCOL]: '^0.2.0' } : {}, tarball: bytes[index]! } },
                { latest: '0.2.0' },
              ),
            );
          },
        },
        npm: (argv) => {
          const name = names.find((candidate) => argv[1]?.includes(candidate.replace('@relvo-labs/', '')))!;
          commands.push(name);
          uploaded.add(name);
          if (name === removeAfterUploadOf) removed = true;
          return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        },
        log: () => undefined,
        sleep: () => Promise.resolve(),
        now: () => 0,
        revalidateSource: () => [],
      },
    };
  }

  it('refuses the dependent when its in-scope dependency vanished mid-run', async () => {
    const { plan: threePlan, bytes } = threePackagePlan();
    // agent-protocol disappears while agent-provider is being published.
    const { ports, commands, lookups } = mutableRegistry(bytes, PROVIDER);
    const report = await publishRelease(threePlan, ports, { ...options, visibility: briefBudget });

    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ name: RUNTIME, code: 'dependency_unpublished' });
    expect(report.failure?.message).toContain('disappeared from the registry since this run published it');
    // The first two are public; the dependent was never uploaded.
    expect(commands).toEqual([PROTOCOL, PROVIDER]);
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`, `${PROVIDER}@0.2.0`]);
    // The proof that the lookup actually happens: protocol is consulted again
    // after it was already published and verified.
    expect(lookups.filter((name) => name === PROTOCOL).length).toBeGreaterThan(2);
  });

  it('still publishes all three when the dependency stays where this run put it', async () => {
    const { plan: threePlan, bytes } = threePackagePlan();
    const { ports, commands } = mutableRegistry(bytes, undefined);
    const report = await publishRelease(threePlan, ports, { ...options, visibility: briefBudget });

    expect(report.ok).toBe(true);
    expect(commands).toEqual([PROTOCOL, PROVIDER, RUNTIME]);
  });

  it('refuses the dependent when the in-scope lookup is merely inconclusive', async () => {
    const { plan: threePlan, bytes } = threePackagePlan();
    const uploaded = new Set<string>();
    let poisoned = false;
    const commands: string[] = [];
    const ports: PublishPorts = {
      registry: {
        lookup: (name) => {
          if (poisoned && name === PROTOCOL) {
            return Promise.resolve({ kind: 'error', detail: 'ETIMEDOUT' } as RegistryLookup);
          }
          if (!uploaded.has(name)) return Promise.resolve({ kind: 'absent' } as RegistryLookup);
          const index = names.indexOf(name as (typeof names)[number]);
          return Promise.resolve(
            published(
              name,
              { '0.2.0': { dependencies: name === RUNTIME ? { [PROTOCOL]: '^0.2.0' } : {}, tarball: bytes[index]! } },
              { latest: '0.2.0' },
            ),
          );
        },
      },
      npm: (argv) => {
        const name = names.find((candidate) => argv[1]?.includes(candidate.replace('@relvo-labs/', '')))!;
        commands.push(name);
        uploaded.add(name);
        if (name === PROVIDER) poisoned = true;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
      log: () => undefined,
      sleep: () => Promise.resolve(),
      now: () => 0,
      revalidateSource: () => [],
    };
    const report = await publishRelease(threePlan, ports, { ...options, visibility: briefBudget });

    expect(report.failure).toMatchObject({ name: RUNTIME, code: 'registry_unavailable' });
    expect(commands).toEqual([PROTOCOL, PROVIDER]);
  });
});

/**
 * Regressions for publication accounting. A zero exit from `npm publish` and a
 * confirmed registry readback are different facts; folding them together made
 * a successful, immutable upload disappear from the summary.
 */
describe('upload accounting', () => {
  it('records an upload the registry confirms as public even though npm failed', async () => {
    const { ports } = harness(
      {
        ...successfulReadback,
        [PROTOCOL]: [
          { kind: 'absent' },
          published(
            PROTOCOL,
            { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
            { latest: '0.2.0' },
          ),
        ],
      },
      () => ({ code: 1, stdout: '', stderr: 'EAI_AGAIN after upload' }),
    );
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('publish_failed_version_public');
    expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(report.published).toEqual([]);
    const summary = summarizeReport(report);
    expect(summary).toContain('accepted_pending — npm accepted, visibility NOT confirmed');
    expect(summary).toContain('never named in a recovery dispatch');
  });

  it('classifies an upload it cannot adjudicate as unknown rather than as failed', async () => {
    const { ports } = harness(
      { ...successfulReadback, [PROTOCOL]: [{ kind: 'absent' }, { kind: 'error', detail: 'ETIMEDOUT' }] },
      () => ({ code: 1, stdout: '', stderr: 'socket hang up' }),
    );
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('publish_unknown');
    expect(report.unknown).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(report.published).toEqual([]);
    const summary = summarizeReport(report);
    expect(summary).toContain('outcome unknown');
    expect(summary).toContain('Reconcile every package listed above');
  });

  it('reports a definitively rejected upload as published nothing', async () => {
    const { ports } = harness({ ...successfulReadback, [PROTOCOL]: { kind: 'absent' } }, () => ({
      code: 1,
      stdout: '',
      stderr: 'E403 forbidden',
    }));
    const report = await publishRelease(plan, ports, options);

    expect(report.failure?.code).toBe('publish_failed');
    expect(report.published).toEqual([]);
    expect(report.acceptedPending).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.outcomes).toEqual([
      { name: PROTOCOL, version: '0.2.0', upload: 'rejected', verified: false, detail: expect.any(String) },
    ]);
  });

  it('never claims a successful run published nothing', () => {
    expect(
      summarizeReport({
        ok: true,
        published: [`${PROTOCOL}@0.2.0`],
        acceptedPending: [],
        unknown: [],
        outcomes: [],
        failure: undefined,
        notAttempted: [],
      }),
    ).toBe(`published and verified: ${PROTOCOL}@0.2.0`);
  });
});

/**
 * Regression for the "current main" rule. Preflight proves `source_sha` is
 * main's tip before the environment approval; an approval can sit for hours,
 * so the publisher proves it again before every upload.
 */
describe('source currency at the moment of upload', () => {
  it('refuses before the first upload when main has already moved', async () => {
    const { ports, commands } = harness(successfulReadback, undefined, () => [
      { code: 'git_main_tip', message: `origin/main is now ${'f'.repeat(40)}` },
    ]);
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('source_no_longer_current');
    expect(report.failure?.message).toContain('origin/main is now');
    expect(commands).toEqual([]);
    expect(report.published).toEqual([]);
  });

  it('stops mid-plan when main moves between two packages, leaving the rest unattempted', async () => {
    const { ports, commands } = harness(successfulReadback, undefined, (call) =>
      call === 1 ? [] : [{ code: 'git_dirty', message: 'checkout has uncommitted changes' }],
    );
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ name: RUNTIME, code: 'source_no_longer_current' });
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(commands).toHaveLength(1);
    expect(report.notAttempted).toEqual([]);
  });
});

/**
 * Regression for issue #30, reproduced through the production orchestrator.
 *
 * Run 34753860073 attempt 3: npm accepted `@relvo-labs/agent-protocol@0.2.0`,
 * the job read the registry five times separated by 3000 ms — about twelve
 * seconds — and failed. The version first answered 200 publicly 466 seconds
 * after the registry's own internal version timestamp, with integrity matching
 * the reviewed artifact exactly. npm documents this: a newly published package
 * is scanned before it is available, usually for about five minutes and
 * possibly for fifteen or more.
 *
 * These tests run `publishRelease` itself — the function `tools/release/
 * publish.ts` calls — with the upload and registry transports replaced, so no
 * npm process exists and nothing can be published. The clock is virtual: the
 * suite asserts elapsed release time without spending any.
 */
describe('post-acceptance visibility reconciliation', () => {
  const ABSENT: RegistryLookup = { kind: 'absent' };
  const protocolVisible = published(
    PROTOCOL,
    { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
    { latest: '0.2.0' },
  );
  const runtimeVisible = published(
    RUNTIME,
    { '0.2.0': { dependencies: { [PROTOCOL]: '^0.2.0' }, tarball: runtimeBytes } },
    { latest: '0.2.0' },
  );
  /** The other expected not-yet-visible answer: the package exists, the version does not. */
  const versionMissing = published(PROTOCOL, { '0.1.0': {} }, { latest: '0.1.0' });
  /** A registry answer this tooling cannot account for: no `dist-tags` at all. */
  const malformed = parsePackument(PROTOCOL, {
    name: PROTOCOL,
    versions: { '0.2.0': { name: PROTOCOL, version: '0.2.0', dist: {} } },
  });
  const wrongIntegrity = published(
    PROTOCOL,
    { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: runtimeBytes } },
    { latest: '0.2.0' },
  );

  type Scripted = {
    /** What the registry answers about the accepted version until it is visible. */
    readonly pending: RegistryLookup;
    /** Virtual milliseconds after which the registry serves it, or never. */
    readonly visibleAfterMs?: number;
    /** What it serves then; the reviewed packument unless stated otherwise. */
    readonly settled?: RegistryLookup;
  };

  function scriptedRun(script: Scripted): {
    readonly ports: PublishPorts;
    readonly commands: string[][];
    readonly logs: string[];
    readonly sleeps: number[];
    readonly clock: { ms: number };
    readonly uploadsOf: (name: string) => number;
  } {
    const clock = { ms: 0 };
    const commands: string[][] = [];
    const logs: string[] = [];
    const sleeps: number[] = [];
    const uploaded = new Set<string>();
    const nameOf = (argv: readonly string[]): string => (argv[1]?.includes('protocol') === true ? PROTOCOL : RUNTIME);
    return {
      commands,
      logs,
      sleeps,
      clock,
      uploadsOf: (name) => commands.filter((argv) => nameOf(argv) === name).length,
      ports: {
        npm: (argv) => {
          commands.push([...argv]);
          uploaded.add(nameOf(argv));
          return Promise.resolve({ code: 0, stdout: '+ accepted', stderr: '' });
        },
        registry: {
          lookup: (name) => {
            if (name === 'zod') return Promise.resolve(zodPublished);
            if (name === RUNTIME) return Promise.resolve(uploaded.has(RUNTIME) ? runtimeVisible : ABSENT);
            if (!uploaded.has(PROTOCOL)) return Promise.resolve(ABSENT);
            if (script.visibleAfterMs !== undefined && clock.ms >= script.visibleAfterMs) {
              return Promise.resolve(script.settled ?? protocolVisible);
            }
            return Promise.resolve(script.pending);
          },
        },
        log: (line) => logs.push(line),
        sleep: (ms) => {
          sleeps.push(ms);
          clock.ms += ms;
          return Promise.resolve();
        },
        now: () => clock.ms,
        revalidateSource: () => [],
      },
    };
  }

  it('waits out a 404 that clears well beyond npm’s documented fifteen minutes, uploading exactly once', async () => {
    // Sixteen minutes: past the documented worst case, inside the budget.
    const visibleAfterMs = 16 * 60_000;
    expect(visibleAfterMs).toBeGreaterThan(NPM_DOCUMENTED_SCAN_DELAY_MINUTES * 60_000);
    const run = scriptedRun({ pending: ABSENT, visibleAfterMs });
    const report = await publishRelease(plan, run.ports, options);

    expect(report.ok).toBe(true);
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`, `${RUNTIME}@0.2.0`]);
    expect(report.acceptedPending).toEqual([]);
    // The whole point: the bytes were handed to npm once, and the delay was
    // absorbed by reads, not by a second upload.
    expect(run.uploadsOf(PROTOCOL)).toBe(1);
    expect(run.uploadsOf(RUNTIME)).toBe(1);
    expect(run.clock.ms).toBeGreaterThanOrEqual(visibleAfterMs);
    expect(run.clock.ms).toBeLessThanOrEqual(VISIBILITY_BUDGET_MS);
    // The acceptance receipt is written the moment npm exits zero, before any
    // reconciliation, and never calls the version unpublished.
    const receipt = run.logs.find((line) => line.includes('accepted_pending'));
    expect(receipt).toContain(`${PROTOCOL}@0.2.0`);
    expect(receipt).toContain('never uploaded again');
    expect(run.logs.join('\n')).not.toMatch(/unpublished|not published/u);
  });

  it('waits out a packument that does not yet list the exact version', async () => {
    const visibleAfterMs = 17 * 60_000;
    const run = scriptedRun({ pending: versionMissing, visibleAfterMs });
    const report = await publishRelease(plan, run.ports, options);

    expect(report.ok).toBe(true);
    expect(report.published).toContain(`${PROTOCOL}@0.2.0`);
    expect(run.uploadsOf(PROTOCOL)).toBe(1);
    expect(run.clock.ms).toBeGreaterThanOrEqual(visibleAfterMs);
  });

  it('expires the budget exactly, keeps the version accepted_pending and stops before the dependent', async () => {
    const run = scriptedRun({ pending: ABSENT });
    const report = await publishRelease(plan, run.ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('visibility_not_confirmed');
    expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
    expect(report.published).toEqual([]);
    expect(report.outcomes).toEqual([
      { name: PROTOCOL, version: '0.2.0', upload: 'accepted_pending', verified: false, detail: expect.any(String) },
    ]);
    // Bounded: the wait is the stated budget, not "until the job is killed".
    expect(run.clock.ms).toBe(VISIBILITY_BUDGET_MS);
    expect(run.uploadsOf(PROTOCOL)).toBe(1);
    expect(run.uploadsOf(RUNTIME)).toBe(0);
    expect(report.notAttempted).toEqual([`${RUNTIME}@0.2.0`]);

    expect(report.failure?.message).toContain('must never be republished');
    expect(report.failure?.message).toContain('manual-review or blocked-package');
    const summary = summarizeReport(report);
    expect(summary).toContain(`accepted_pending — npm accepted, visibility NOT confirmed: ${PROTOCOL}@0.2.0`);
    expect(summary).toContain('never be republished');
  });

  /**
   * The budget belongs to the delay it was sized for. An unanswerable registry
   * is a different fact from a package that is still being scanned, and
   * spending twenty minutes re-asking a 401 would turn a credential problem
   * into a job timeout with an unadjudicated upload behind it.
   */
  it('fails closed at once on a network, auth or malformed answer without spending the budget', async () => {
    const unanswerable: readonly RegistryLookup[] = [
      { kind: 'error', detail: 'ETIMEDOUT' },
      { kind: 'error', detail: 'registry returned 503' },
      { kind: 'unauthorized', detail: 'registry returned 401; credentials or access changed' },
      malformed,
    ];
    expect(malformed.kind).toBe('error');

    for (const answer of unanswerable) {
      const run = scriptedRun({ pending: answer });
      const report = await publishRelease(plan, run.ports, options);

      expect(report.ok).toBe(false);
      expect(report.failure?.code).toBe('readback_unavailable');
      expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
      expect(report.failure?.message).toContain('never republish it');
      expect(run.sleeps).toEqual([]);
      expect(run.clock.ms).toBe(0);
      expect(run.uploadsOf(PROTOCOL)).toBe(1);
    }
  });

  it('fails closed at once when the registry serves different bytes than were reviewed', async () => {
    const run = scriptedRun({ pending: wrongIntegrity });
    const report = await publishRelease(plan, run.ports, options);

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('readback_mismatch');
    expect(report.failure?.message).toMatch(/integrity|shasum/u);
    expect(report.acceptedPending).toEqual([`${PROTOCOL}@0.2.0`]);
    // An answered mismatch is never retried: more reads cannot make it match.
    expect(run.sleeps).toEqual([]);
    expect(run.uploadsOf(PROTOCOL)).toBe(1);
  });
});

describe('log hygiene', () => {
  it('scrubs a credential from anything about to be printed', () => {
    const credential = 'npm_0123456789abcdef';
    expect(redactSecrets(`auth=${credential} done`, [credential])).toBe('auth=***redacted*** done');
    expect(redactSecrets('nothing to hide', [undefined])).toBe('nothing to hide');
    // Short values are never treated as secrets: masking them would redact ordinary output.
    expect(redactSecrets('code 200', ['200'])).toBe('code 200');
  });
});
