/**
 * The staging directory is the contract between the credential-free job and
 * the gated one: `plan.json`, its digest, and the exact tarballs the plan
 * describes.
 *
 * The transport itself is already integrity-checked twice by GitHub (the
 * upload records a digest; the download is told to fail on a mismatch), but
 * the gated job still re-derives everything locally before the credential is
 * introduced. It re-hashes every tarball, re-reads every packed manifest and
 * re-checks the plan digest, so nothing that reaches `npm publish` is trusted
 * because it arrived — only because it still matches what was reviewed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './plan.ts';
import { serializePlan, type PlanEntry, type ReleasePlan } from './preflight.ts';
import { inspectTarball, type PackedArtifact } from './tarball.ts';

export const PLAN_FILE = 'plan.json';
export const PLAN_DIGEST_FILE = 'plan.sha256';
export const TARBALL_DIRECTORY = 'tarballs';

export function digestPlan(plan: ReleasePlan): string {
  return createHash('sha256').update(serializePlan(plan)).digest('hex');
}

export function writeStaging(root: string, plan: ReleasePlan, tarballs: ReadonlyMap<string, Buffer>): void {
  mkdirSync(join(root, TARBALL_DIRECTORY), { recursive: true });
  for (const entry of plan.packages) {
    const bytes = tarballs.get(entry.name);
    if (bytes === undefined) throw new Error(`no packed bytes for ${entry.name}`);
    writeFileSync(join(root, TARBALL_DIRECTORY, entry.tarball), bytes);
  }
  writeFileSync(join(root, PLAN_FILE), serializePlan(plan));
  writeFileSync(join(root, PLAN_DIGEST_FILE), `${digestPlan(plan)}\n`);
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}

/** Strict plan reader: an unreadable plan is a refusal, never a partial plan. */
export function parsePlanDocument(document: unknown): { ok: true; plan: ReleasePlan } | { ok: false; reason: string } {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ok: false, reason: 'plan is not an object' };
  }
  const record = document as Record<string, unknown>;
  if (record.schema !== 'relvo-release-plan/1') return { ok: false, reason: 'plan schema is not relvo-release-plan/1' };
  const sourceSha = record.sourceSha;
  const distTag = record.distTag;
  const registry = record.registry;
  if (typeof sourceSha !== 'string' || typeof distTag !== 'string' || typeof registry !== 'string') {
    return { ok: false, reason: 'plan header fields are missing or not strings' };
  }
  const rawPackages = record.packages;
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) return { ok: false, reason: 'plan names no packages' };

  const packages: PlanEntry[] = [];
  for (const [index, raw] of rawPackages.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `plan entry ${index + 1} is not an object` };
    }
    const entry = raw as Record<string, unknown>;
    const dependencies = readStringRecord(entry.dependencies ?? {});
    const peerDependencies = readStringRecord(entry.peerDependencies ?? {});
    if (
      typeof entry.name !== 'string' ||
      typeof entry.version !== 'string' ||
      typeof entry.tarball !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.integrity !== 'string' ||
      typeof entry.shasum !== 'string' ||
      typeof entry.size !== 'number' ||
      typeof entry.order !== 'number' ||
      dependencies === undefined ||
      peerDependencies === undefined
    ) {
      return { ok: false, reason: `plan entry ${index + 1} is malformed` };
    }
    if (entry.order !== index + 1) return { ok: false, reason: `plan entry ${index + 1} is out of order` };
    if (entry.tarball.includes('/') || entry.tarball.includes('..')) {
      return { ok: false, reason: `plan entry ${index + 1} names a tarball outside the staging directory` };
    }
    packages.push({
      order: entry.order,
      name: entry.name,
      version: entry.version,
      tarball: entry.tarball,
      size: entry.size,
      sha256: entry.sha256,
      integrity: entry.integrity,
      shasum: entry.shasum,
      dependencies,
      peerDependencies,
    });
  }

  const rawExcluded = record.excluded;
  const excluded: { name: string; version: string }[] = [];
  if (Array.isArray(rawExcluded)) {
    for (const raw of rawExcluded) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.name !== 'string' || typeof entry.version !== 'string') {
        return { ok: false, reason: 'plan excluded list is malformed' };
      }
      excluded.push({ name: entry.name, version: entry.version });
    }
  }

  return { ok: true, plan: { schema: 'relvo-release-plan/1', sourceSha, distTag, registry, packages, excluded } };
}

export type LoadedStaging = {
  readonly plan: ReleasePlan;
  readonly artifacts: ReadonlyMap<string, PackedArtifact>;
  readonly tarballPath: (entry: PlanEntry) => string;
};

export type LoadResult =
  | { readonly ok: true; readonly staging: LoadedStaging }
  | { readonly ok: false; readonly findings: readonly Finding[] };

/**
 * Locate the real staging root. A download action may place a single artifact
 * directly in the requested path or inside one directory named after it; both
 * are accepted, anything else is refused rather than searched.
 */
export function resolveStagingRoot(requested: string): string | undefined {
  const hasPlan = (candidate: string): boolean => {
    try {
      return statSync(join(candidate, PLAN_FILE)).isFile();
    } catch {
      return false;
    }
  };
  if (hasPlan(requested)) return requested;
  let entries: string[];
  try {
    entries = readdirSync(requested);
  } catch {
    return undefined;
  }
  const nested = entries.map((entry) => join(requested, entry)).filter((candidate) => hasPlan(candidate));
  return nested.length === 1 ? nested[0] : undefined;
}

function compareRecords(
  label: string,
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string | undefined {
  const left = JSON.stringify(Object.entries(expected).sort());
  const right = JSON.stringify(Object.entries(actual).sort());
  return left === right ? undefined : `${label} in the tarball do not match the plan`;
}

export function loadStaging(root: string): LoadResult {
  const findings: Finding[] = [];
  let planDocument: unknown;
  try {
    planDocument = JSON.parse(readFileSync(join(root, PLAN_FILE), 'utf8'));
  } catch (error) {
    return {
      ok: false,
      findings: [{ code: 'staging_plan_unreadable', message: `cannot read ${PLAN_FILE}: ${String(error)}` }],
    };
  }
  const parsed = parsePlanDocument(planDocument);
  if (!parsed.ok) {
    return { ok: false, findings: [{ code: 'staging_plan_malformed', message: parsed.reason }] };
  }
  const plan = parsed.plan;

  let recordedDigest = '';
  try {
    recordedDigest = readFileSync(join(root, PLAN_DIGEST_FILE), 'utf8').trim();
  } catch (error) {
    findings.push({ code: 'staging_digest_missing', message: `cannot read ${PLAN_DIGEST_FILE}: ${String(error)}` });
  }
  const actualDigest = digestPlan(plan);
  if (recordedDigest !== '' && recordedDigest !== actualDigest) {
    findings.push({
      code: 'staging_digest_mismatch',
      message: `staged plan digest ${recordedDigest} does not match the plan it accompanies (${actualDigest})`,
    });
  }

  const artifacts = new Map<string, PackedArtifact>();
  for (const entry of plan.packages) {
    const path = join(root, TARBALL_DIRECTORY, entry.tarball);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      findings.push({ code: 'staging_tarball_missing', message: `${entry.name}: ${String(error)}` });
      continue;
    }
    let artifact: PackedArtifact;
    try {
      artifact = inspectTarball(entry.tarball, bytes);
    } catch (error) {
      findings.push({ code: 'staging_tarball_unreadable', message: `${entry.name}: ${String(error)}` });
      continue;
    }
    if (artifact.size !== entry.size || artifact.sha256 !== entry.sha256) {
      findings.push({
        code: 'staging_tarball_digest',
        message: `${entry.tarball} hashes to ${artifact.sha256} (${artifact.size} bytes), not the planned ${entry.sha256} (${entry.size} bytes)`,
      });
      continue;
    }
    if (artifact.integrity !== entry.integrity || artifact.shasum !== entry.shasum) {
      findings.push({ code: 'staging_tarball_digest', message: `${entry.tarball} integrity does not match the plan` });
      continue;
    }
    if (artifact.manifest.name !== entry.name || artifact.manifest.version !== entry.version) {
      findings.push({
        code: 'staging_tarball_identity',
        message: `${entry.tarball} packs ${artifact.manifest.name}@${artifact.manifest.version}, not ${entry.name}@${entry.version}`,
      });
      continue;
    }
    const dependencyProblem =
      compareRecords('dependencies', entry.dependencies, artifact.manifest.dependencies) ??
      compareRecords('peerDependencies', entry.peerDependencies, artifact.manifest.peerDependencies);
    if (dependencyProblem !== undefined) {
      findings.push({ code: 'staging_tarball_dependencies', message: `${entry.tarball}: ${dependencyProblem}` });
      continue;
    }
    artifacts.set(entry.name, artifact);
  }

  let staged: string[] = [];
  try {
    staged = readdirSync(join(root, TARBALL_DIRECTORY)).sort();
  } catch (error) {
    findings.push({ code: 'staging_tarballs_missing', message: `cannot list ${TARBALL_DIRECTORY}: ${String(error)}` });
  }
  const planned = new Set(plan.packages.map((entry) => entry.tarball));
  for (const file of staged) {
    if (!planned.has(file)) {
      findings.push({ code: 'staging_unexpected_artifact', message: `${file} is staged but not named by the plan` });
    }
  }

  if (findings.length > 0) return { ok: false, findings };
  return {
    ok: true,
    staging: { plan, artifacts, tarballPath: (entry) => join(root, TARBALL_DIRECTORY, entry.tarball) },
  };
}
