/**
 * Fail-closed release preflight.
 *
 * This is the whole decision. Everything after it — the environment approval,
 * the token, `npm publish` — only executes a plan this function already
 * refused to reject. It therefore answers every question that could make a
 * publication wrong *before* any credential exists in the job:
 *
 *   - is this exactly the commit the operator named, and is it main's tip?
 *   - is there pending version intent that a release would silently skip?
 *   - does every named package exist, at exactly the named version, and is
 *     every artifact the one that the gate validated?
 *   - is the scope closed under its own dependency graph, in which order, and
 *     is every transitive dependency already resolvable on the registry?
 *   - is any of these versions already published, and would this dist-tag move
 *     backwards?
 *
 * A finding is a refusal. There is no severity ladder and no override input:
 * narrowing the scope is a human decision expressed as a new dispatch.
 */

import { compareExactVersions, exactVersionOfRange, topologicalOrder } from './graph.ts';
import { PACKAGE_NAME_RE, type Finding, type ReleaseRequest } from './plan.ts';
import { DEFAULT_REGISTRY, type RegistryLookup, type RegistryPort } from './registry.ts';
import type { PackedArtifact } from './tarball.ts';

export type ActionsContext = {
  readonly eventName: string;
  readonly ref: string;
  /** `github.sha`, the commit the runner resolved the dispatch ref to. */
  readonly runnerSha: string;
};

export type GitFacts = {
  readonly headSha: string;
  readonly originMainSha: string;
  /** `git status --porcelain` output; anything non-empty is a dirty checkout. */
  readonly porcelain: string;
};

export type ChangesetRelease = {
  readonly name: string;
  readonly type: string;
  readonly oldVersion: string;
  readonly newVersion: string;
};

export type WorkspacePackage = {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
};

export type PreflightInput = {
  readonly request: ReleaseRequest;
  readonly context: ActionsContext;
  readonly git: GitFacts;
  /** `.changeset/*.md` files excluding `README.md`. */
  readonly pendingChangesetFiles: readonly string[];
  /** Releases reported by `changeset status`. */
  readonly changesetReleases: readonly ChangesetRelease[];
  readonly workspace: readonly WorkspacePackage[];
  readonly artifacts: readonly PackedArtifact[];
  readonly registryUrl?: string;
};

export type PlanEntry = {
  readonly order: number;
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly size: number;
  readonly sha256: string;
  readonly integrity: string;
  readonly shasum: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
};

export type ReleasePlan = {
  readonly schema: 'relvo-release-plan/1';
  readonly sourceSha: string;
  readonly distTag: string;
  readonly registry: string;
  readonly packages: readonly PlanEntry[];
  /** Publishable workspace packages deliberately left out of this dispatch. */
  readonly excluded: readonly { readonly name: string; readonly version: string }[];
};

export type PreflightOutcome = {
  readonly findings: readonly Finding[];
  readonly plan: ReleasePlan | undefined;
};

export const REQUIRED_TARBALL_ENTRIES: readonly string[] = [
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
  'package/package.json',
];

function isInternal(name: string): boolean {
  return PACKAGE_NAME_RE.test(name);
}

/** One lookup per package name, whatever the dependency graph asks for. */
function createLookupCache(registry: RegistryPort): (name: string) => Promise<RegistryLookup> {
  const cache = new Map<string, Promise<RegistryLookup>>();
  return (name: string): Promise<RegistryLookup> => {
    const existing = cache.get(name);
    if (existing !== undefined) return existing;
    const pending = registry.lookup(name);
    cache.set(name, pending);
    return pending;
  };
}

function checkContext(input: PreflightInput, findings: Finding[]): void {
  const { context, git, request } = input;
  if (context.eventName !== 'workflow_dispatch') {
    findings.push({
      code: 'context_event',
      message: `release may only run from workflow_dispatch, got \`${context.eventName}\``,
    });
  }
  if (context.ref !== 'refs/heads/main') {
    findings.push({
      code: 'context_ref',
      message: `release may only be dispatched on refs/heads/main, got \`${context.ref}\``,
    });
  }
  if (context.runnerSha !== request.sourceSha) {
    findings.push({
      code: 'context_sha',
      message: `dispatch resolved to ${context.runnerSha}, which is not the named source commit ${request.sourceSha}`,
    });
  }
  if (git.headSha !== request.sourceSha) {
    findings.push({ code: 'git_head', message: `checkout HEAD is ${git.headSha}, expected ${request.sourceSha}` });
  }
  if (git.originMainSha !== request.sourceSha) {
    findings.push({
      code: 'git_main_tip',
      message: `origin/main is ${git.originMainSha}; only the exact tip of main may be released, not ${request.sourceSha}`,
    });
  }
  if (git.porcelain.trim() !== '') {
    findings.push({
      code: 'git_dirty',
      message: 'checkout has uncommitted changes; refusing to publish an unreviewed tree',
    });
  }
}

function checkVersionIntent(input: PreflightInput, findings: Finding[]): void {
  for (const file of [...input.pendingChangesetFiles].sort()) {
    findings.push({
      code: 'pending_version_intent',
      message: `\`.changeset/${file}\` is unreleased version intent; version it in a separate reviewed release PR before publishing`,
    });
  }
  for (const release of input.changesetReleases) {
    if (release.type === 'none') continue;
    findings.push({
      code: 'pending_version_intent',
      message: `changeset status still proposes ${release.name} ${release.oldVersion} -> ${release.newVersion} (${release.type}); publish only from a versioned commit`,
    });
  }
}

function checkScope(input: PreflightInput, findings: Finding[]): void {
  const byName = new Map(input.workspace.map((entry) => [entry.name, entry]));
  for (const target of input.request.targets) {
    const workspacePackage = byName.get(target.name);
    if (workspacePackage === undefined) {
      findings.push({
        code: 'scope_unknown_package',
        message: `\`${target.name}\` is not a package in this workspace`,
      });
      continue;
    }
    if (workspacePackage.private) {
      findings.push({
        code: 'scope_private_package',
        message: `\`${target.name}\` is private and must never be published`,
      });
    }
    if (workspacePackage.version !== target.version) {
      findings.push({
        code: 'scope_version_mismatch',
        message: `\`${target.name}\` is ${workspacePackage.version} at ${input.request.sourceSha}, but the dispatch names ${target.version}; this tool never invents a version`,
      });
    }
  }
}

function checkArtifacts(input: PreflightInput, findings: Finding[]): Map<string, PackedArtifact> {
  const byName = new Map<string, PackedArtifact>();
  for (const artifact of input.artifacts) {
    if (byName.has(artifact.manifest.name)) {
      findings.push({
        code: 'artifact_duplicate',
        message: `two packed artifacts claim to be \`${artifact.manifest.name}\``,
      });
      continue;
    }
    byName.set(artifact.manifest.name, artifact);
  }

  for (const target of input.request.targets) {
    const artifact = byName.get(target.name);
    if (artifact === undefined) {
      findings.push({ code: 'artifact_missing', message: `no packed tarball was produced for \`${target.name}\`` });
      continue;
    }
    const manifest = artifact.manifest;
    if (manifest.version !== target.version) {
      findings.push({
        code: 'artifact_identity',
        message: `${artifact.fileName} packs ${manifest.name}@${manifest.version}, not the requested ${target.name}@${target.version}`,
      });
    }
    if (manifest.private) {
      findings.push({ code: 'artifact_private', message: `${manifest.name} is marked private inside its own tarball` });
    }
    if (manifest.publishAccess !== 'public' || manifest.publishProvenance !== true) {
      findings.push({
        code: 'artifact_publish_config',
        message: `${manifest.name} must declare publishConfig.access=public and publishConfig.provenance=true in the packed manifest`,
      });
    }
    if (manifest.license === undefined) {
      findings.push({ code: 'artifact_license', message: `${manifest.name} packs no license field` });
    }
    if (manifest.repositoryUrl === undefined) {
      findings.push({
        code: 'artifact_repository',
        message: `${manifest.name} packs no repository url; provenance must be attributable to this repository`,
      });
    }
    for (const required of REQUIRED_TARBALL_ENTRIES) {
      if (!artifact.entries.includes(required)) {
        findings.push({ code: 'artifact_contents', message: `${artifact.fileName} is missing ${required}` });
      }
    }
    const leaked = artifact.entries.filter(
      (entry) => entry.startsWith('package/src/') || entry.startsWith('package/test/'),
    );
    if (leaked.length > 0) {
      findings.push({
        code: 'artifact_contents',
        message: `${artifact.fileName} ships source or test files: ${leaked.slice(0, 3).join(', ')}`,
      });
    }
  }
  return byName;
}

async function checkDependencyClosure(
  input: PreflightInput,
  artifactsByName: Map<string, PackedArtifact>,
  lookup: (name: string) => Promise<RegistryLookup>,
  findings: Finding[],
): Promise<readonly string[]> {
  const inScope = new Map(input.request.targets.map((target) => [target.name, target.version]));
  const nodes: { name: string; dependsOn: string[] }[] = [];

  for (const target of input.request.targets) {
    const artifact = artifactsByName.get(target.name);
    if (artifact === undefined) continue;
    const dependsOn: string[] = [];
    const required = {
      ...artifact.manifest.dependencies,
      ...Object.fromEntries(
        Object.entries(artifact.manifest.peerDependencies).filter(
          ([peer]) => !artifact.manifest.optionalPeers.includes(peer),
        ),
      ),
    };

    for (const [dependency, range] of Object.entries(required)) {
      const exact = exactVersionOfRange(range);
      if (exact === undefined) {
        findings.push({
          code: 'dependency_range_unsupported',
          message: `${target.name} depends on ${dependency}@${range}; the release path accepts only an exact version or the caret of one`,
        });
        continue;
      }
      if (isInternal(dependency)) {
        const scoped = inScope.get(dependency);
        if (scoped !== undefined) {
          if (scoped !== exact) {
            findings.push({
              code: 'dependency_scope_mismatch',
              message: `${target.name} requires ${dependency}@${exact}, but this dispatch publishes ${dependency}@${scoped}`,
            });
          }
          dependsOn.push(dependency);
          continue;
        }
      }
      const result = await lookup(dependency);
      if (result.kind === 'found') {
        if (!result.packument.versions.has(exact)) {
          findings.push({
            code: 'dependency_unpublished',
            message: `${target.name} requires ${dependency}@${exact}, which is not published and is not in this release scope`,
          });
        }
        continue;
      }
      if (result.kind === 'absent') {
        findings.push({
          code: 'dependency_unpublished',
          message: `${target.name} requires ${dependency}@${exact}, but \`${dependency}\` does not exist on the registry and is not in this release scope`,
        });
        continue;
      }
      findings.push({
        code: result.kind === 'unauthorized' ? 'registry_unauthorized' : 'registry_unavailable',
        message: `could not establish whether ${dependency}@${exact} is published: ${result.detail}`,
      });
    }
    nodes.push({ name: target.name, dependsOn });
  }

  const sorted = topologicalOrder(nodes);
  if (!sorted.ok) {
    findings.push({
      code: 'dependency_cycle',
      message: `release scope has a dependency cycle among: ${sorted.cycle.join(', ')}`,
    });
    return [];
  }
  return sorted.order;
}

async function checkRegistrySafety(
  input: PreflightInput,
  lookup: (name: string) => Promise<RegistryLookup>,
  findings: Finding[],
): Promise<void> {
  for (const target of input.request.targets) {
    const result = await lookup(target.name);
    if (result.kind === 'absent') continue; // never published: the first release of this name
    if (result.kind === 'unauthorized') {
      findings.push({
        code: 'registry_unauthorized',
        message: `registry refused to describe ${target.name}: ${result.detail}`,
      });
      continue;
    }
    if (result.kind === 'error') {
      findings.push({
        code: 'registry_unavailable',
        message: `registry did not answer for ${target.name}: ${result.detail}`,
      });
      continue;
    }
    if (result.packument.versions.has(target.version)) {
      findings.push({
        code: 'registry_version_exists',
        message: `${target.name}@${target.version} is already published; npm versions are immutable, so republishing is refused`,
      });
    }
    const tagged = result.packument.distTags.get(input.request.distTag);
    if (tagged !== undefined && compareExactVersions(tagged, target.version) > 0) {
      findings.push({
        code: 'registry_dist_tag_regression',
        message: `dist-tag \`${input.request.distTag}\` already points at ${target.name}@${tagged}; publishing ${target.version} would move it backwards`,
      });
    }
  }
}

export async function runPreflight(input: PreflightInput, registry: RegistryPort): Promise<PreflightOutcome> {
  const findings: Finding[] = [];
  const lookup = createLookupCache(registry);

  checkContext(input, findings);
  checkVersionIntent(input, findings);
  checkScope(input, findings);
  const artifactsByName = checkArtifacts(input, findings);
  const order = await checkDependencyClosure(input, artifactsByName, lookup, findings);
  await checkRegistrySafety(input, lookup, findings);

  if (findings.length > 0) return { findings, plan: undefined };

  const packages: PlanEntry[] = order.map((name, index) => {
    const artifact = artifactsByName.get(name)!;
    return {
      order: index + 1,
      name,
      version: artifact.manifest.version,
      tarball: artifact.fileName,
      size: artifact.size,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      shasum: artifact.shasum,
      dependencies: artifact.manifest.dependencies,
      peerDependencies: artifact.manifest.peerDependencies,
    };
  });

  const scoped = new Set(input.request.targets.map((target) => target.name));
  const excluded = input.workspace
    .filter((entry) => !entry.private && !scoped.has(entry.name))
    .map((entry) => ({ name: entry.name, version: entry.version }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));

  return {
    findings,
    plan: {
      schema: 'relvo-release-plan/1',
      sourceSha: input.request.sourceSha,
      distTag: input.request.distTag,
      registry: input.registryUrl ?? DEFAULT_REGISTRY,
      packages,
      excluded,
    },
  };
}

/** Canonical, timestamp-free serialization: the digest is reproducible. */
export function serializePlan(plan: ReleasePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
