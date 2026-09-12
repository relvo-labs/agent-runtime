/**
 * Dispatch-input parsing for the manual release workflow.
 *
 * Everything a human types into `workflow_dispatch` arrives here as an
 * untrusted string. This module turns those strings into a `ReleaseRequest`
 * or into findings — it never guesses, never normalises a near-miss into a
 * valid value, and never derives a version that the operator did not state.
 */

export type Finding = { readonly code: string; readonly message: string };

export type ReleaseTarget = { readonly name: string; readonly version: string };

export type ReleaseRequest = {
  readonly sourceSha: string;
  readonly targets: readonly ReleaseTarget[];
  readonly distTag: string;
};

export type DispatchInputs = {
  readonly sourceSha: string;
  readonly packages: string;
  readonly distTag: string;
  readonly confirm: string;
};

export type RequestResult =
  | { readonly ok: true; readonly request: ReleaseRequest }
  | { readonly ok: false; readonly findings: readonly Finding[] };

/** This repository may only publish under its own scope. */
export const PACKAGE_NAME_RE = /^@relvo-labs\/[a-z][a-z0-9-]*$/u;
/** Exact semver, optional prerelease, no build metadata and no range syntax. */
export const EXACT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/u;
export const DIST_TAG_RE = /^[a-z][a-z0-9-]{0,31}$/u;
/** One dispatch may not quietly become a bulk publication. */
export const MAX_TARGETS = 16;

export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/**
 * The exact phrase the operator must retype. It restates the three facts that
 * make a publication irreversible — how many packages, from which commit, and
 * under which tag — so a mis-set input cannot be confirmed by reflex.
 */
export function confirmationPhrase(input: {
  readonly count: number;
  readonly sourceSha: string;
  readonly distTag: string;
}): string {
  return `publish ${input.count} package(s) from ${input.sourceSha} to ${input.distTag}`;
}

function parseScopeEntry(entry: string, findings: Finding[]): ReleaseTarget | undefined {
  const separator = entry.lastIndexOf('@');
  if (separator <= 0) {
    findings.push({ code: 'dispatch_scope_entry', message: `scope entry must be \`<name>@<version>\`, got: ${entry}` });
    return undefined;
  }
  const name = entry.slice(0, separator);
  const version = entry.slice(separator + 1);
  let valid = true;
  if (!PACKAGE_NAME_RE.test(name)) {
    findings.push({
      code: 'dispatch_scope_entry',
      message: `scope entry name \`${name}\` is not a publishable @relvo-labs package name`,
    });
    valid = false;
  }
  if (!EXACT_VERSION_RE.test(version)) {
    findings.push({
      code: 'dispatch_scope_entry',
      message: `scope entry \`${entry}\` must state one exact version, not a range or tag`,
    });
    valid = false;
  }
  return valid ? { name, version } : undefined;
}

export function parseReleaseRequest(raw: DispatchInputs): RequestResult {
  const findings: Finding[] = [];

  // Nothing below is trimmed. These inputs are documented as exact, and the
  // confirmation phrase is meant to be a literal restatement of them — so a
  // value that only becomes valid after normalisation is a value the operator
  // did not actually type, and accepting it would quietly weaken the one
  // control whose entire purpose is literalness.
  const sourceSha = raw.sourceSha;
  if (!COMMIT_SHA_RE.test(sourceSha)) {
    findings.push({
      code: 'dispatch_source_sha',
      message: 'source SHA must be one full 40-character lowercase commit id; abbreviations and refs are refused',
    });
  }

  // The scope list is the one input with deliberately supported separators:
  // whitespace and commas split it, and nothing else about an entry is
  // normalised.
  const entries = raw.packages.split(/[\s,]+/u).filter((entry) => entry !== '');
  const targets: ReleaseTarget[] = [];
  for (const entry of entries) {
    const target = parseScopeEntry(entry, findings);
    if (target !== undefined) targets.push(target);
  }
  if (entries.length === 0) {
    findings.push({ code: 'dispatch_scope_empty', message: 'release scope is empty; name every package explicitly' });
  }
  if (entries.length > MAX_TARGETS) {
    findings.push({
      code: 'dispatch_scope_size',
      message: `release scope names ${entries.length} packages; at most ${MAX_TARGETS} may be published in one dispatch`,
    });
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.name)) {
      findings.push({
        code: 'dispatch_scope_duplicate',
        message: `\`${target.name}\` appears more than once in the scope`,
      });
    }
    seen.add(target.name);
  }

  const distTag = raw.distTag;
  if (!DIST_TAG_RE.test(distTag)) {
    findings.push({
      code: 'dispatch_dist_tag',
      message: `dist-tag \`${distTag}\` must be lowercase, start with a letter, and contain only letters, digits and hyphens`,
    });
  }
  if (distTag === 'latest' && targets.some((target) => isPrerelease(target.version))) {
    findings.push({
      code: 'dispatch_dist_tag_prerelease',
      message: 'a prerelease version must not be published under `latest`; use a dedicated dist-tag',
    });
  }

  // The phrase is derived from the *parsed* inputs, so a typo in any of them
  // also invalidates the confirmation rather than being confirmed by it.
  const expected = confirmationPhrase({ count: entries.length, sourceSha, distTag });
  if (raw.confirm !== expected) {
    findings.push({
      code: 'dispatch_confirmation',
      message: `confirmation must read exactly: ${expected}`,
    });
  }

  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, request: { sourceSha, targets, distTag } };
}
