import { describe, expect, it } from 'vitest';
import { runPreflight, type PreflightInput } from './lib/preflight.ts';
import type { RegistryScript } from './testing/fixtures.ts';
import { fakeRegistry, buildPackageTarball, published } from './testing/fixtures.ts';
import { inspectTarball, tarballFileName, type PackedArtifact } from './lib/tarball.ts';
import type { RegistryPort } from './lib/registry.ts';
import type { PackageFixture } from './testing/fixtures.ts';

const SHA = 'c'.repeat(40);
const PROTOCOL = '@relvo-labs/agent-protocol';
const RUNTIME = '@relvo-labs/agent-runtime';
const PROVIDER = '@relvo-labs/agent-provider';

function artifact(fixture: PackageFixture): PackedArtifact {
  return inspectTarball(tarballFileName(fixture.name, fixture.version), buildPackageTarball(fixture));
}

function baseline(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    request: {
      sourceSha: SHA,
      distTag: 'latest',
      targets: [
        { name: PROTOCOL, version: '0.2.0' },
        { name: RUNTIME, version: '0.2.0' },
      ],
    },
    context: { eventName: 'workflow_dispatch', ref: 'refs/heads/main', runnerSha: SHA },
    git: { headSha: SHA, originMainSha: SHA, porcelain: '' },
    pendingChangesetFiles: [],
    changesetReleases: [{ name: '@relvo-labs/reference-app', type: 'none', oldVersion: '0.0.0', newVersion: '0.0.0' }],
    workspace: [
      { directory: 'packages/protocol', name: PROTOCOL, version: '0.2.0', private: false },
      { directory: 'packages/provider', name: PROVIDER, version: '0.2.0', private: false },
      { directory: 'packages/runtime', name: RUNTIME, version: '0.2.0', private: false },
      { directory: 'examples/reference-app', name: '@relvo-labs/reference-app', version: '0.0.0', private: true },
    ],
    artifacts: [
      artifact({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '4.5.4' } }),
      artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } }),
    ],
    ...overrides,
  };
}

const REGISTRY: RegistryScript = { zod: published('zod', { '4.5.4': {} }) };

function registry(script: RegistryScript = REGISTRY): RegistryPort {
  return fakeRegistry({ ...REGISTRY, ...script });
}

async function codes(input: PreflightInput, port: RegistryPort = registry()): Promise<readonly string[]> {
  const outcome = await runPreflight(input, port);
  return outcome.findings.map((finding) => finding.code);
}

describe('release preflight', () => {
  it('produces a dependency-ordered plan when everything checks out', async () => {
    const outcome = await runPreflight(baseline(), registry());
    expect(outcome.findings).toEqual([]);
    expect(outcome.plan?.packages.map((entry) => `${entry.order}:${entry.name}`)).toEqual([
      `1:${PROTOCOL}`,
      `2:${RUNTIME}`,
    ]);
    expect(outcome.plan?.packages[0]?.integrity).toMatch(/^sha512-/u);
    expect(outcome.plan?.packages[1]?.dependencies).toEqual({ [PROTOCOL]: '^0.2.0' });
    // Publishable packages left out of the dispatch are reported, not silently dropped.
    expect(outcome.plan?.excluded).toEqual([{ name: PROVIDER, version: '0.2.0' }]);
  });

  it('refuses while any version intent is still pending', async () => {
    expect(await codes(baseline({ pendingChangesetFiles: ['foundation-runtime-v0-4.md'] }))).toContain(
      'pending_version_intent',
    );
    expect(
      await codes(
        baseline({
          changesetReleases: [{ name: PROTOCOL, type: 'minor', oldVersion: '0.1.0', newVersion: '0.2.0' }],
        }),
      ),
    ).toContain('pending_version_intent');
  });

  it('refuses a dispatch that is not the exact tip of main', async () => {
    const other = 'd'.repeat(40);
    expect(await codes(baseline({ context: { eventName: 'push', ref: 'refs/heads/main', runnerSha: SHA } }))).toContain(
      'context_event',
    );
    expect(
      await codes(baseline({ context: { eventName: 'workflow_dispatch', ref: 'refs/heads/topic', runnerSha: SHA } })),
    ).toContain('context_ref');
    expect(
      await codes(baseline({ context: { eventName: 'workflow_dispatch', ref: 'refs/heads/main', runnerSha: other } })),
    ).toContain('context_sha');
    expect(await codes(baseline({ git: { headSha: other, originMainSha: SHA, porcelain: '' } }))).toContain('git_head');
    expect(await codes(baseline({ git: { headSha: SHA, originMainSha: other, porcelain: '' } }))).toContain(
      'git_main_tip',
    );
    expect(
      await codes(
        baseline({ git: { headSha: SHA, originMainSha: SHA, porcelain: ' M packages/runtime/src/index.ts' } }),
      ),
    ).toContain('git_dirty');
  });

  it('refuses a scope the workspace does not support', async () => {
    const request = {
      sourceSha: SHA,
      distTag: 'latest',
      targets: [{ name: '@relvo-labs/agent-ghost', version: '0.2.0' }],
    };
    expect(await codes(baseline({ request, artifacts: [] }))).toContain('scope_unknown_package');

    const privateRequest = {
      sourceSha: SHA,
      distTag: 'latest',
      targets: [{ name: '@relvo-labs/reference-app', version: '0.0.0' }],
    };
    expect(
      await codes(
        baseline({
          request: privateRequest,
          artifacts: [artifact({ name: '@relvo-labs/reference-app', version: '0.0.0', private: true })],
        }),
      ),
    ).toContain('scope_private_package');
  });

  it('never accepts a version the commit does not actually carry', async () => {
    const request = { sourceSha: SHA, distTag: 'latest', targets: [{ name: PROTOCOL, version: '0.3.0' }] };
    const findings = await codes(
      baseline({
        request,
        artifacts: [artifact({ name: PROTOCOL, version: '0.3.0', dependencies: { zod: '4.5.4' } })],
      }),
    );
    expect(findings).toContain('scope_version_mismatch');
  });

  it('refuses a tarball whose identity or contents are not the reviewed ones', async () => {
    const mislabelled = inspectTarball(
      tarballFileName(PROTOCOL, '0.2.0'),
      buildPackageTarball({ name: PROTOCOL, version: '0.1.9', dependencies: { zod: '4.5.4' } }),
    );
    expect(await codes(baseline({ artifacts: [mislabelled, baseline().artifacts[1]!] }))).toContain(
      'artifact_identity',
    );

    const missingLicense = artifact({
      name: PROTOCOL,
      version: '0.2.0',
      dependencies: { zod: '4.5.4' },
      omitEntries: ['package/LICENSE'],
    });
    expect(await codes(baseline({ artifacts: [missingLicense, baseline().artifacts[1]!] }))).toContain(
      'artifact_contents',
    );

    const withSource = artifact({
      name: PROTOCOL,
      version: '0.2.0',
      dependencies: { zod: '4.5.4' },
      extraEntries: { 'package/src/index.ts': 'export const leaked = 1;\n' },
    });
    expect(await codes(baseline({ artifacts: [withSource, baseline().artifacts[1]!] }))).toContain('artifact_contents');

    const restricted = artifact({
      name: PROTOCOL,
      version: '0.2.0',
      dependencies: { zod: '4.5.4' },
      access: 'restricted',
    });
    expect(await codes(baseline({ artifacts: [restricted, baseline().artifacts[1]!] }))).toContain(
      'artifact_publish_config',
    );

    const unprovenanced = artifact({
      name: PROTOCOL,
      version: '0.2.0',
      dependencies: { zod: '4.5.4' },
      provenance: false,
    });
    expect(await codes(baseline({ artifacts: [unprovenanced, baseline().artifacts[1]!] }))).toContain(
      'artifact_publish_config',
    );

    const unattributed = artifact({
      name: PROTOCOL,
      version: '0.2.0',
      dependencies: { zod: '4.5.4' },
      repository: null,
    });
    expect(await codes(baseline({ artifacts: [unattributed, baseline().artifacts[1]!] }))).toContain(
      'artifact_repository',
    );

    expect(await codes(baseline({ artifacts: [baseline().artifacts[0]!] }))).toContain('artifact_missing');
  });

  it('requires the scope to be closed over its own dependency graph', async () => {
    // runtime alone, with protocol neither in scope nor published
    const request = { sourceSha: SHA, distTag: 'latest', targets: [{ name: RUNTIME, version: '0.2.0' }] };
    const artifacts = [artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } })];
    expect(await codes(baseline({ request, artifacts }))).toContain('dependency_unpublished');

    // the same scope is fine once the dependency is already published at that exact version
    const withPublished = registry({ [PROTOCOL]: published(PROTOCOL, { '0.2.0': {} }) });
    expect(await codes(baseline({ request, artifacts }), withPublished)).toEqual([]);

    // ...but not when only a different version is published
    const wrongVersion = registry({ [PROTOCOL]: published(PROTOCOL, { '0.1.0': {} }) });
    expect(await codes(baseline({ request, artifacts }), wrongVersion)).toContain('dependency_unpublished');
  });

  it('refuses when an in-scope dependency is being published at a different version', async () => {
    const artifacts = [
      artifact({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '4.5.4' } }),
      artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.1.0' } }),
    ];
    expect(await codes(baseline({ artifacts }))).toContain('dependency_scope_mismatch');
  });

  it('refuses a dependency range it cannot resolve to one exact version', async () => {
    for (const range of ['workspace:^', '>=0.2.0', '0.2.x', 'latest', 'github:relvo-labs/agent-protocol']) {
      const artifacts = [
        artifact({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '4.5.4' } }),
        artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: range } }),
      ];
      expect(await codes(baseline({ artifacts }))).toContain('dependency_range_unsupported');
    }
  });

  it('refuses an unpublished third-party dependency', async () => {
    const artifacts = [
      artifact({ name: PROTOCOL, version: '0.2.0', dependencies: { zod: '9.9.9' } }),
      artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } }),
    ];
    expect(await codes(baseline({ artifacts }))).toContain('dependency_unpublished');
  });

  it('ignores an optional peer dependency but still checks a required one', async () => {
    const optional = [
      artifact({
        name: PROTOCOL,
        version: '0.2.0',
        dependencies: { zod: '4.5.4' },
        peerDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.259' },
        optionalPeers: ['@anthropic-ai/claude-agent-sdk'],
      }),
      baseline().artifacts[1]!,
    ];
    expect(await codes(baseline({ artifacts: optional }))).toEqual([]);

    const required = [
      artifact({
        name: PROTOCOL,
        version: '0.2.0',
        dependencies: { zod: '4.5.4' },
        peerDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.259' },
      }),
      baseline().artifacts[1]!,
    ];
    expect(await codes(baseline({ artifacts: required }))).toContain('dependency_unpublished');
  });

  it('refuses a dependency cycle inside the scope', async () => {
    const artifacts = [
      artifact({ name: PROTOCOL, version: '0.2.0', dependencies: { [RUNTIME]: '^0.2.0' } }),
      artifact({ name: RUNTIME, version: '0.2.0', dependencies: { [PROTOCOL]: '^0.2.0' } }),
    ];
    expect(await codes(baseline({ artifacts }))).toContain('dependency_cycle');
  });

  it('refuses to republish a version that already exists', async () => {
    const port = registry({ [PROTOCOL]: published(PROTOCOL, { '0.2.0': {} }) });
    expect(await codes(baseline(), port)).toContain('registry_version_exists');
  });

  it('refuses to move a dist-tag backwards', async () => {
    const port = registry({ [PROTOCOL]: published(PROTOCOL, { '0.3.0': {} }, { latest: '0.3.0' }) });
    expect(await codes(baseline(), port)).toContain('registry_dist_tag_regression');
  });

  it('distinguishes a genuine 404 from a registry that will not answer', async () => {
    expect(await codes(baseline())).toEqual([]);

    const unauthorized = fakeRegistry({ ...REGISTRY, [PROTOCOL]: { kind: 'unauthorized', detail: 'forbidden' } });
    expect(await codes(baseline(), unauthorized)).toContain('registry_unauthorized');

    const unavailable = fakeRegistry({ ...REGISTRY, [PROTOCOL]: { kind: 'error', detail: 'socket hang up' } });
    expect(await codes(baseline(), unavailable)).toContain('registry_unavailable');

    const malformedDependency = fakeRegistry({
      zod: { kind: 'error', detail: 'registry returned a body that is not JSON' },
    });
    expect(await codes(baseline(), malformedDependency)).toContain('registry_unavailable');
  });

  it('looks each package up once, however many dependents mention it', async () => {
    const port = fakeRegistry(REGISTRY);
    await runPreflight(baseline(), port);
    const protocolLookups = port.calls.filter((name) => name === PROTOCOL);
    expect(protocolLookups).toHaveLength(1);
  });

  it('produces no plan at all when anything is refused', async () => {
    const outcome = await runPreflight(baseline({ pendingChangesetFiles: ['pending.md'] }), registry());
    expect(outcome.plan).toBeUndefined();
  });
});
