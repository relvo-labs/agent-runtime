/**
 * The registry seam.
 *
 * Every registry answer is classified into exactly one of four outcomes, and
 * only one of them — `absent`, a genuine 404 for a package that has never been
 * published — is safe to treat as "nothing is there". An authentication
 * failure, a rate limit, a 5xx, a timeout, a truncated body or a JSON document
 * that does not have the shape of a packument all classify as a *refusal to
 * answer*, never as an absence. Preflight fails closed on all of them, so a
 * registry that cannot be reached can never be mistaken for a registry that
 * says a version is free.
 */

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export type RegistryVersion = {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly integrity: string | undefined;
  readonly shasum: string | undefined;
};

export type RegistryPackument = {
  readonly name: string;
  readonly versions: ReadonlyMap<string, RegistryVersion>;
  readonly distTags: ReadonlyMap<string, string>;
};

export type RegistryLookup =
  | { readonly kind: 'found'; readonly packument: RegistryPackument }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unauthorized'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

export type RegistryPort = {
  /** Never throws: transport failures are returned as `error`. */
  readonly lookup: (name: string) => Promise<RegistryLookup>;
};

function readStringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}

function readOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/**
 * Strict packument reader. Anything unexpected is a malformed document rather
 * than a field to ignore: a registry response this code cannot fully account
 * for must not be used to authorise a publication.
 */
export function parsePackument(requestedName: string, document: unknown): RegistryLookup {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { kind: 'error', detail: `registry document for ${requestedName} is not an object` };
  }
  const record = document as Record<string, unknown>;
  if (record.name !== requestedName) {
    return {
      kind: 'error',
      detail: `registry document names \`${String(record.name)}\`, expected \`${requestedName}\``,
    };
  }
  const rawVersions = record.versions;
  if (typeof rawVersions !== 'object' || rawVersions === null || Array.isArray(rawVersions)) {
    return { kind: 'error', detail: `registry document for ${requestedName} has no versions map` };
  }
  const versions = new Map<string, RegistryVersion>();
  for (const [version, rawEntry] of Object.entries(rawVersions)) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return { kind: 'error', detail: `registry entry ${requestedName}@${version} is not an object` };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry.name !== requestedName || entry.version !== version) {
      return { kind: 'error', detail: `registry entry ${requestedName}@${version} disagrees with its own identity` };
    }
    const dependencies = readStringMap(entry.dependencies);
    const peerDependencies = readStringMap(entry.peerDependencies);
    if (dependencies === undefined || peerDependencies === undefined) {
      return { kind: 'error', detail: `registry entry ${requestedName}@${version} has a malformed dependency map` };
    }
    const dist = entry.dist;
    if (typeof dist !== 'object' || dist === null || Array.isArray(dist)) {
      return { kind: 'error', detail: `registry entry ${requestedName}@${version} has no dist block` };
    }
    const integrity = readOptionalString((dist as Record<string, unknown>).integrity);
    const shasum = readOptionalString((dist as Record<string, unknown>).shasum);
    if (integrity === null || shasum === null) {
      return { kind: 'error', detail: `registry entry ${requestedName}@${version} has a malformed dist integrity` };
    }
    versions.set(version, { name: requestedName, version, dependencies, peerDependencies, integrity, shasum });
  }

  const rawTags = record['dist-tags'];
  const distTagsRecord = readStringMap(rawTags);
  if (distTagsRecord === undefined) {
    return { kind: 'error', detail: `registry document for ${requestedName} has a malformed dist-tags map` };
  }
  return {
    kind: 'found',
    packument: { name: requestedName, versions, distTags: new Map(Object.entries(distTagsRecord)) },
  };
}

/** Pure status classification, so the fail-closed policy is unit-testable. */
export function classifyRegistryResponse(name: string, status: number, body: string): RegistryLookup {
  if (status === 404) return { kind: 'absent' };
  if (status === 401 || status === 403) {
    return { kind: 'unauthorized', detail: `registry returned ${status} for ${name}; credentials or access changed` };
  }
  if (status !== 200) return { kind: 'error', detail: `registry returned ${status} for ${name}` };
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { kind: 'error', detail: `registry returned a body for ${name} that is not JSON` };
  }
  return parsePackument(name, document);
}

export function packumentUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/u, '')}/${name.replace('/', '%2f')}`;
}

export function createHttpsRegistry(registry: string = DEFAULT_REGISTRY, timeoutMs = 15_000): RegistryPort {
  return {
    lookup: async (name: string): Promise<RegistryLookup> => {
      try {
        const response = await fetch(packumentUrl(registry, name), {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = response.status === 200 ? await response.text() : '';
        return classifyRegistryResponse(name, response.status, body);
      } catch (error) {
        return { kind: 'error', detail: `registry request for ${name} failed: ${String(error)}` };
      }
    },
  };
}
