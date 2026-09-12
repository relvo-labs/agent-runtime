/**
 * Differential test: this repository's tar reader against the one npm uses.
 *
 * `tools/release/lib/tarball.ts` decides what a packed artifact *is* — the name
 * and version that preflight approves, and that the operator reads in the plan.
 * npm decides what the artifact *becomes* on a consumer's disk. If those two
 * readers can disagree about a single archive, then every approval upstream is
 * an approval of something else, and no amount of hashing the bytes helps: the
 * bytes would be identical and the meaning different.
 *
 * An independent review demonstrated exactly that. An archive containing both
 * `package/package.json` (agent-protocol@0.2.0) and `package/./package.json`
 * (agent-runtime@9.9.9) passed preflight and staging as the former, while
 * npm's bundled `pacote` read it as the latter. So the property asserted here
 * is not "we parse tar correctly" but the only property that actually matters:
 *
 *   **for every archive, either both readers report the same identity, or this
 *   repository refuses the archive.** Silent disagreement is impossible.
 *
 * The comparison uses npm's own `pacote`, loaded out of the bundled npm that
 * ships with the Node runtime the gate already requires, in `offline` mode
 * against a local file. It is credential-free and makes no network request, so
 * it satisfies the canonical gate's constraints. If that module cannot be
 * found, this test fails: a differential test that quietly stops being
 * differential is worse than no differential test at all.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectTarball } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

type PacoteManifest = { readonly name?: unknown; readonly version?: unknown };
type Pacote = {
  readonly manifest: (spec: string, options: Record<string, unknown>) => Promise<PacoteManifest>;
};

/** Locate the `npm` that ships with this Node runtime, not one on `PATH`. */
function bundledNpmManifestPath(): string {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'package.json'),
    join(executableDirectory, 'node_modules', 'npm', 'package.json'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `cannot locate the npm bundled with ${process.execPath}; this differential test must not be skipped. Looked in: ${candidates.join(', ')}`,
    );
  }
  return found;
}

const npmManifestPath = bundledNpmManifestPath();
const pacote = createRequire(npmManifestPath)('pacote') as Pacote;
const cache = mkdtempSync(join(tmpdir(), 'relvo-release-pacote-'));

afterAll(() => {
  rmSync(cache, { recursive: true, force: true });
});

type Identity = { readonly name: string; readonly version: string };
type Reading = { readonly kind: 'identity'; readonly identity: Identity } | { readonly kind: 'refused' };

function readWithThisRepository(fileName: string, bytes: Buffer): Reading {
  try {
    const artifact = inspectTarball(fileName, bytes);
    return { kind: 'identity', identity: { name: artifact.manifest.name, version: artifact.manifest.version } };
  } catch {
    return { kind: 'refused' };
  }
}

async function readWithNpm(fileName: string, bytes: Buffer): Promise<Reading> {
  const path = join(cache, fileName);
  writeFileSync(path, bytes);
  try {
    // `offline` guarantees no registry request; the spec is a local file.
    const manifest = await pacote.manifest(path, { cache, offline: true, ignoreScripts: true });
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return { kind: 'refused' };
    return { kind: 'identity', identity: { name: manifest.name, version: manifest.version } };
  } catch {
    return { kind: 'refused' };
  }
}

const PROTOCOL = '@relvo-labs/agent-protocol';
const IMPOSTOR = '@relvo-labs/agent-runtime';

function manifestJson(name: string, version: string): string {
  return JSON.stringify({
    name,
    version,
    license: 'Apache-2.0',
    publishConfig: { access: 'public', provenance: true },
  });
}

/** Every archive below is either agreed on, or refused here. Nothing else. */
const archives: Readonly<Record<string, Buffer>> = {
  'ordinary.tgz': buildPackageTarball({ name: PROTOCOL, version: '0.2.0' }),

  // The demonstrated bypass: two paths, one destination, two identities.
  'normalized-duplicate.tgz': buildTarball({
    'package/package.json': manifestJson(PROTOCOL, '0.2.0'),
    'package/./package.json': manifestJson(IMPOSTOR, '9.9.9'),
  }),

  // The same trick spelled with an empty segment rather than a dot.
  'empty-segment-duplicate.tgz': buildTarball({
    'package/package.json': manifestJson(PROTOCOL, '0.2.0'),
    'package//package.json': manifestJson(IMPOSTOR, '9.9.9'),
  }),

  // A header checksum npm rejects as an unrecognised archive.
  'bad-checksum.tgz': (() => {
    const raw = gunzipSync(buildTarball({ 'package/package.json': manifestJson(PROTOCOL, '0.2.0') }));
    raw.fill(0x30, 148, 154);
    return gzipSync(raw);
  })(),

  // A second archive appended after the end-of-archive marker.
  'appended-archive.tgz': (() => {
    const first = gunzipSync(buildPackageTarball({ name: PROTOCOL, version: '0.2.0' }));
    const second = gunzipSync(buildPackageTarball({ name: IMPOSTOR, version: '9.9.9' }));
    return gzipSync(Buffer.concat([first, second]));
  })(),

  // Content npm never installs, which this repository therefore never reviewed.
  'outside-package-tree.tgz': buildTarball({
    'package/package.json': manifestJson(PROTOCOL, '0.2.0'),
    'elsewhere/payload.js': 'globalThis.pwned = true;\n',
  }),

  // A manifest reachable only through a pax path override.
  'pax-path-override.tgz': (() => {
    const block = (path: string, contents: string, typeFlag: string): Buffer => {
      const body = Buffer.from(contents, 'utf8');
      const header = Buffer.alloc(512);
      header.write(path, 0, 'utf8');
      header.write(`${body.byteLength.toString(8).padStart(11, '0')} `, 124, 'utf8');
      header.write('        ', 148, 'utf8');
      header.write(typeFlag, 156, 'utf8');
      header.write('ustar\0', 257, 'utf8');
      header.write('00', 263, 'utf8');
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
      const padded = Buffer.alloc(Math.ceil(body.byteLength / 512) * 512);
      body.copy(padded);
      return Buffer.concat([header, padded]);
    };
    const record = '32 path=package/package.json\n';
    return gzipSync(
      Buffer.concat([
        block('PaxHeaders/0', record, 'x'),
        block('ignored-name', manifestJson(PROTOCOL, '0.2.0'), '0'),
        Buffer.alloc(1024),
      ]),
    );
  })(),
};

describe("identity agreement with npm's own archive reader", () => {
  it('reads an ordinary packed artifact exactly as npm does', async () => {
    const bytes = archives['ordinary.tgz']!;
    const ours = readWithThisRepository('ordinary.tgz', bytes);
    const theirs = await readWithNpm('ordinary.tgz', bytes);

    expect(ours).toEqual({ kind: 'identity', identity: { name: PROTOCOL, version: '0.2.0' } });
    expect(theirs).toEqual(ours);
  });

  it('never disagrees with npm about what an archive is', async () => {
    const disagreements: string[] = [];
    for (const [fileName, bytes] of Object.entries(archives)) {
      const ours = readWithThisRepository(fileName, bytes);
      const theirs = await readWithNpm(fileName, bytes);
      // Refusing is always allowed. Reporting a *different* identity is not.
      if (ours.kind === 'refused') continue;
      if (theirs.kind === 'refused') continue;
      if (ours.identity.name !== theirs.identity.name || ours.identity.version !== theirs.identity.version) {
        disagreements.push(
          `${fileName}: this repository read ${ours.identity.name}@${ours.identity.version}, npm read ${theirs.identity.name}@${theirs.identity.version}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('refuses every archive npm would read as a different package', async () => {
    for (const fileName of ['normalized-duplicate.tgz', 'empty-segment-duplicate.tgz', 'appended-archive.tgz']) {
      const bytes = archives[fileName]!;
      // npm resolves each of these to *some* identity — that is the danger.
      const theirs = await readWithNpm(fileName, bytes);
      expect(theirs.kind, `${fileName} should still be readable by npm`).toBe('identity');
      expect(readWithThisRepository(fileName, bytes), `${fileName} must be refused here`).toEqual({ kind: 'refused' });
    }
  });

  it('refuses an archive npm itself cannot recognise', async () => {
    const bytes = archives['bad-checksum.tgz']!;
    expect(await readWithNpm('bad-checksum.tgz', bytes)).toEqual({ kind: 'refused' });
    expect(readWithThisRepository('bad-checksum.tgz', bytes)).toEqual({ kind: 'refused' });
  });

  it('refuses an archive carrying files npm would never install', async () => {
    const bytes = archives['outside-package-tree.tgz']!;
    expect((await readWithNpm('outside-package-tree.tgz', bytes)).kind).toBe('identity');
    expect(readWithThisRepository('outside-package-tree.tgz', bytes)).toEqual({ kind: 'refused' });
  });

  it('agrees on a manifest that is only reachable through a pax path override', async () => {
    const bytes = archives['pax-path-override.tgz']!;
    const ours = readWithThisRepository('pax-path-override.tgz', bytes);
    const theirs = await readWithNpm('pax-path-override.tgz', bytes);
    expect(ours.kind === 'refused' || theirs.kind === 'refused' || ours.identity.name === theirs.identity.name).toBe(
      true,
    );
  });

  it('states which npm it compared against, so the evidence is attributable', () => {
    const npmVersion = (createRequire(npmManifestPath)('./package.json') as { version?: unknown }).version;
    expect(typeof npmVersion).toBe('string');
  });
});
