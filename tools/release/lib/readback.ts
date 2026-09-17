/**
 * Registry readback.
 *
 * A zero exit from `npm publish` says the upload was accepted, not that the
 * registry now serves what was reviewed. Readback re-reads the public
 * packument and compares it against the plan entry for the exact bytes that
 * were uploaded: identity, integrity, the dependency ranges consumers will
 * resolve, and the dist-tag the operator asked for. Anything it cannot
 * confirm is a failure — never a warning, and never repaired by republishing.
 *
 * A single readback is one observation. `classifyReadback` says which kind of
 * observation it was, which is what decides whether repeating it could ever
 * change the answer: see `visibility.ts`.
 */

import type { Finding } from './plan.ts';
import type { PlanEntry } from './preflight.ts';
import type { RegistryLookup } from './registry.ts';

function compareRanges(
  label: string,
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  findings: Finding[],
  subject: string,
): void {
  for (const [name, range] of Object.entries(expected)) {
    const published = actual[name];
    if (published === undefined) {
      findings.push({
        code: 'readback_dependencies',
        message: `${subject}: published ${label} is missing ${name}@${range}`,
      });
      continue;
    }
    if (published !== range) {
      findings.push({
        code: 'readback_dependencies',
        message: `${subject}: published ${label} ${name}@${published} does not match the packed ${name}@${range}`,
      });
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) {
      findings.push({
        code: 'readback_dependencies',
        message: `${subject}: published ${label} contains ${name}, which the reviewed tarball does not declare`,
      });
    }
  }
}

/**
 * The only two findings a *successful* publication may still produce while npm
 * finishes scanning it: the package is not listed at all, or the packument is
 * well-formed and does not yet carry the exact version.
 */
export const PENDING_VISIBILITY_CODES: readonly string[] = ['readback_absent', 'readback_version_missing'];

/** A registry that would not answer at all. Never a "not yet" answer. */
export const READBACK_UNAVAILABLE_CODE = 'readback_unavailable';

export type ReadbackVerdict = 'verified' | 'not_yet_visible' | 'unavailable' | 'mismatch';

/**
 * Classify one readback.
 *
 * Fail-closed by construction: `mismatch` is the default, so a finding code
 * added later is treated as a reason to stop rather than as a reason to wait.
 * The order matters — an unanswerable registry is checked before anything else,
 * because an auth failure or a malformed document must never be spent as if it
 * were the 404 of a package that is still being scanned.
 */
export function classifyReadback(findings: readonly Finding[]): ReadbackVerdict {
  if (findings.length === 0) return 'verified';
  if (findings.some((finding) => finding.code === READBACK_UNAVAILABLE_CODE)) return 'unavailable';
  if (findings.every((finding) => PENDING_VISIBILITY_CODES.includes(finding.code))) return 'not_yet_visible';
  return 'mismatch';
}

export function verifyReadback(entry: PlanEntry, distTag: string, lookup: RegistryLookup): readonly Finding[] {
  const findings: Finding[] = [];
  const subject = `${entry.name}@${entry.version}`;

  if (lookup.kind === 'absent') {
    return [{ code: 'readback_absent', message: `${subject}: registry does not list this package after publishing` }];
  }
  if (lookup.kind === 'unauthorized') {
    return [{ code: 'readback_unavailable', message: `${subject}: registry refused the readback: ${lookup.detail}` }];
  }
  if (lookup.kind === 'error') {
    return [
      { code: 'readback_unavailable', message: `${subject}: registry readback did not answer: ${lookup.detail}` },
    ];
  }

  const published = lookup.packument.versions.get(entry.version);
  if (published === undefined) {
    return [
      { code: 'readback_version_missing', message: `${subject}: registry does not list this version after publishing` },
    ];
  }
  if (published.name !== entry.name) {
    findings.push({ code: 'readback_identity', message: `${subject}: registry reports name \`${published.name}\`` });
  }
  if (published.integrity === undefined && published.shasum === undefined) {
    findings.push({ code: 'readback_integrity', message: `${subject}: registry reports no dist integrity at all` });
  }
  if (published.integrity !== undefined && published.integrity !== entry.integrity) {
    findings.push({
      code: 'readback_integrity',
      message: `${subject}: registry integrity ${published.integrity} does not match the published tarball ${entry.integrity}`,
    });
  }
  if (published.shasum !== undefined && published.shasum !== entry.shasum) {
    findings.push({
      code: 'readback_integrity',
      message: `${subject}: registry shasum ${published.shasum} does not match the published tarball ${entry.shasum}`,
    });
  }
  compareRanges('dependencies', entry.dependencies, published.dependencies, findings, subject);
  compareRanges('peerDependencies', entry.peerDependencies, published.peerDependencies, findings, subject);

  const tagged = lookup.packument.distTags.get(distTag);
  if (tagged !== entry.version) {
    findings.push({
      code: 'readback_dist_tag',
      message: `${subject}: dist-tag \`${distTag}\` points at ${tagged ?? '<unset>'}`,
    });
  }
  return findings;
}
