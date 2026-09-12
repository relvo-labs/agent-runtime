/**
 * Deterministic test doubles for the release path.
 *
 * Nothing here talks to a registry, a package manager or a credential. The
 * tarballs are built in memory by a minimal tar writer, and the registry is a
 * programmable in-memory double whose answers — including its failures — are
 * stated by the test. A release test must never be able to publish anything.
 */

import { gzipSync } from 'node:zlib';
import type { RegistryLookup, RegistryPort } from '../lib/registry.ts';
import { parsePackument } from '../lib/registry.ts';
import { digestBytes } from '../lib/tarball.ts';

const BLOCK = 512;

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(path.slice(0, 100), 0, 'utf8');
  block.write('000644 \0', 100, 'utf8');
  block.write('000000 \0', 108, 'utf8');
  block.write('000000 \0', 116, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8');
  block.write('00000000000 ', 136, 'utf8');
  block.write('        ', 148, 'utf8'); // checksum placeholder
  block.write('0', 156, 'utf8'); // regular file
  block.write('ustar\0', 257, 'utf8');
  block.write('00', 263, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return block;
}

/** Build a gzipped tar archive from `path -> contents`. */
export function buildTarball(files: Readonly<Record<string, string>>): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const body = Buffer.from(contents, 'utf8');
    chunks.push(header(path, body.byteLength), body);
    const padding = (BLOCK - (body.byteLength % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export type PackageFixture = {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalPeers?: readonly string[];
  readonly access?: string;
  readonly provenance?: boolean;
  readonly private?: boolean;
  readonly license?: string | null;
  readonly repository?: string | null;
  readonly omitEntries?: readonly string[];
  readonly extraEntries?: Readonly<Record<string, string>>;
};

/** A packed tarball shaped exactly like this repository's real ones. */
export function buildPackageTarball(fixture: PackageFixture): Buffer {
  const manifest: Record<string, unknown> = {
    name: fixture.name,
    version: fixture.version,
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    publishConfig: { access: fixture.access ?? 'public', provenance: fixture.provenance ?? true },
  };
  if (fixture.private === true) manifest.private = true;
  if (fixture.license !== null) manifest.license = fixture.license ?? 'Apache-2.0';
  if (fixture.repository !== null) {
    manifest.repository = {
      type: 'git',
      url: fixture.repository ?? 'git+https://github.com/relvo-labs/agent-runtime.git',
    };
  }
  if (fixture.dependencies !== undefined) manifest.dependencies = fixture.dependencies;
  if (fixture.peerDependencies !== undefined) manifest.peerDependencies = fixture.peerDependencies;
  if (fixture.optionalPeers !== undefined) {
    manifest.peerDependenciesMeta = Object.fromEntries(fixture.optionalPeers.map((peer) => [peer, { optional: true }]));
  }

  const omitted = new Set(fixture.omitEntries ?? []);
  const files: Record<string, string> = Object.fromEntries(
    Object.entries({
      'package/package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'package/README.md': `# ${fixture.name}\n`,
      'package/LICENSE': 'Apache-2.0\n',
      'package/NOTICE': 'NOTICE\n',
      'package/dist/index.js': 'export const marker = 1;\n',
      'package/dist/index.d.ts': 'export declare const marker: number;\n',
      ...(fixture.extraEntries ?? {}),
    }).filter(([path]) => !omitted.has(path)),
  );
  return buildTarball(files);
}

export type RegistryScript = Readonly<Record<string, RegistryLookup | readonly RegistryLookup[]>>;

export type FakeRegistry = RegistryPort & {
  /** Every name looked up, in order, including repeats. */
  readonly calls: readonly string[];
};

/**
 * A registry double. A name mapped to a list answers each call in turn (the
 * last answer repeats), which is how readback-after-publish is exercised
 * without a network or a clock.
 */
export function fakeRegistry(script: RegistryScript, fallback: RegistryLookup = { kind: 'absent' }): FakeRegistry {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  return {
    calls,
    lookup: (name: string): Promise<RegistryLookup> => {
      calls.push(name);
      const entry = script[name];
      if (entry === undefined) return Promise.resolve(fallback);
      if (!Array.isArray(entry)) return Promise.resolve(entry as RegistryLookup);
      const sequence = entry as readonly RegistryLookup[];
      const index = counters.get(name) ?? 0;
      counters.set(name, index + 1);
      return Promise.resolve(sequence[Math.min(index, sequence.length - 1)] ?? fallback);
    },
  };
}

/** Build a `found` lookup for a package that is published at these versions. */
export function published(
  name: string,
  versions: Readonly<
    Record<
      string,
      { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; tarball?: Buffer }
    >
  >,
  distTags: Readonly<Record<string, string>> = {},
): RegistryLookup {
  const document: Record<string, unknown> = { name, 'dist-tags': distTags, versions: {} };
  const versionMap = document.versions as Record<string, unknown>;
  for (const [version, detail] of Object.entries(versions)) {
    const digests = detail.tarball === undefined ? undefined : digestBytes(detail.tarball);
    versionMap[version] = {
      name,
      version,
      dependencies: detail.dependencies ?? {},
      peerDependencies: detail.peerDependencies ?? {},
      dist: {
        ...(digests === undefined ? {} : { integrity: digests.integrity, shasum: digests.shasum }),
      },
    };
  }
  return parsePackument(name, document);
}
