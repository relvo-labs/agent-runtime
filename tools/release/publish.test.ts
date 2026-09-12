import { describe, expect, it } from 'vitest';
import {
  buildPublishArgv,
  publishRelease,
  redactSecrets,
  summarizeReport,
  type CommandOutcome,
  type PublishPorts,
} from './lib/publish.ts';
import type { PlanEntry, ReleasePlan } from './lib/preflight.ts';
import type { RegistryLookup } from './lib/registry.ts';
import { inspectTarball, tarballFileName } from './lib/tarball.ts';
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

const successfulReadback: RegistryScript = {
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
};

function harness(script: RegistryScript, npm?: (argv: readonly string[]) => CommandOutcome): Harness {
  const commands: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const registry = fakeRegistry(script);
  return {
    commands,
    logs,
    sleeps,
    ports: {
      npm: (argv) => {
        commands.push([...argv]);
        return Promise.resolve(npm?.(argv) ?? { code: 0, stdout: '+ published', stderr: '' });
      },
      registry,
      log: (line) => logs.push(line),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

const options = { tarballPath: (target: PlanEntry) => `/staging/tarballs/${target.tarball}`, userconfig: '/tmp/npmrc' };

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
    const { ports, commands } = harness(successfulReadback);
    const report = await publishRelease(plan, ports, options);

    expect(report.ok).toBe(true);
    expect(report.published).toEqual([`${PROTOCOL}@0.2.0`, `${RUNTIME}@0.2.0`]);
    expect(commands.map((argv) => argv[1])).toEqual([
      `/staging/tarballs/${tarballFileName(PROTOCOL, '0.2.0')}`,
      `/staging/tarballs/${tarballFileName(RUNTIME, '0.2.0')}`,
    ]);
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

  it('fails when the registry never serves what was published', async () => {
    const neverLands: RegistryScript = { ...successfulReadback, [PROTOCOL]: { kind: 'absent' } };
    const { ports, commands } = harness(neverLands);
    const report = await publishRelease(plan, ports, { ...options, readbackAttempts: 2, readbackDelayMs: 1 });

    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('readback_mismatch');
    expect(report.published).toEqual([]);
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
      { '0.2.0': { dependencies: { zod: '4.5.4' }, tarball: protocolBytes } },
      { latest: '0.1.0' },
    );

    for (const mismatch of [wrongBytes, wrongDependencies, wrongTag]) {
      const { ports } = harness({ ...successfulReadback, [PROTOCOL]: [{ kind: 'absent' }, mismatch] });
      const report = await publishRelease(plan, ports, { ...options, readbackAttempts: 1, readbackDelayMs: 1 });
      expect(report.ok).toBe(false);
      expect(report.failure?.code).toBe('readback_mismatch');
    }
  });

  it('stops at the first upload failure and reports exactly what is already public', async () => {
    const { ports, commands } = harness(successfulReadback, (argv) =>
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
    const raced: RegistryScript = { ...successfulReadback, [PROTOCOL]: published(PROTOCOL, { '0.2.0': {} }) };
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

describe('log hygiene', () => {
  it('scrubs a credential from anything about to be printed', () => {
    const credential = 'npm_0123456789abcdef';
    expect(redactSecrets(`auth=${credential} done`, [credential])).toBe('auth=***redacted*** done');
    expect(redactSecrets('nothing to hide', [undefined])).toBe('nothing to hide');
    // Short values are never treated as secrets: masking them would redact ordinary output.
    expect(redactSecrets('code 200', ['200'])).toBe('code 200');
  });
});
