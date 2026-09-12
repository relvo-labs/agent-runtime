/**
 * Publication order and version comparison.
 *
 * npm has no transaction: the order packages reach the registry is the order
 * consumers can observe them in. A dependent that lands before its dependency
 * is briefly uninstallable, so publication follows the dependency DAG and
 * refuses to start at all if that DAG has a cycle.
 */

export type GraphNode = { readonly name: string; readonly dependsOn: readonly string[] };

export type TopologicalResult =
  { readonly ok: true; readonly order: readonly string[] } | { readonly ok: false; readonly cycle: readonly string[] };

/**
 * Deterministic topological sort: among nodes whose dependencies are already
 * placed, the alphabetically first is always chosen, so the same scope always
 * produces the same reviewable order.
 */
export function topologicalOrder(nodes: readonly GraphNode[]): TopologicalResult {
  const names = new Set(nodes.map((node) => node.name));
  const pending = new Map<string, Set<string>>();
  for (const node of nodes) {
    pending.set(node.name, new Set(node.dependsOn.filter((dependency) => names.has(dependency))));
  }

  const order: string[] = [];
  for (;;) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    const next = ready[0];
    if (next === undefined) break;
    order.push(next);
    pending.delete(next);
    for (const dependencies of pending.values()) dependencies.delete(next);
  }

  if (pending.size > 0) return { ok: false, cycle: [...pending.keys()].sort() };
  return { ok: true, order };
}

const PRERELEASE_SEPARATOR = '-';

/**
 * Compare two exact semver strings. Build metadata is not accepted anywhere in
 * this tooling, so only the release triple and an optional dot-separated
 * prerelease need ordering.
 */
export function compareExactVersions(left: string, right: string): number {
  const split = (version: string): { release: number[]; prerelease: string[] } => {
    const separator = version.indexOf(PRERELEASE_SEPARATOR);
    const release = (separator === -1 ? version : version.slice(0, separator)).split('.').map(Number);
    const prerelease = separator === -1 ? [] : version.slice(separator + 1).split('.');
    return { release, prerelease };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // a release outranks any prerelease of it
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The only dependency ranges this release path understands are an exact
 * version and the caret of an exact version. Anything else — a tag, a URL, a
 * `workspace:` protocol that survived packing, a wider range — is refused
 * rather than approximated, because "is this range already satisfiable on the
 * registry?" must be answerable by exact lookup, not by range arithmetic.
 */
export function exactVersionOfRange(range: string): string | undefined {
  const candidate = range.startsWith('^') ? range.slice(1) : range;
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(candidate)
    ? candidate
    : undefined;
}
