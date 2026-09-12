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
 * The comparison uses npm's own `pacote`, loaded out of the npm package this
 * workspace pins — the same npm `publish.ts` spawns to upload these bytes — in
 * `offline` mode against a local file. It is credential-free and makes no
 * network request, so it satisfies the canonical gate's constraints. If that
 * tool's identity cannot be proven, this test fails: a differential test that
 * quietly stops being differential is worse than no differential test at all.
 *
 * That tool used to be located by guessing at `process.execPath`'s neighbours,
 * which is the layout of an official Node distribution and not the one
 * `pnpm/setup` installs — see `lib/npm-tool.ts` for why that made the suite
 * unloadable in CI, and why comparing against "whatever npm is around" would
 * not have been a fix.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { describeNpmTool, requireFromNpmTool, requireNpmTool } from './lib/npm-tool.ts';
import { inspectTarball } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

type PacoteManifest = { readonly name?: unknown; readonly version?: unknown };
type Pacote = {
  readonly manifest: (spec: string, options: Record<string, unknown>) => Promise<PacoteManifest>;
};

const npmTool = requireNpmTool();
const requireFromNpm = requireFromNpmTool(npmTool);
const pacote = requireFromNpm('pacote') as Pacote;
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

  // The format-signature bypass found by the closure review. A second header
  // for `package/package.json` with valid checksums, a populated `prefix` and
  // no ustar signature. npm applies `prefix` only under the ustar branch, so it
  // ignores it and overwrites the real manifest; a reader that applies `prefix`
  // unconditionally sees the harmless `package/ignored/package.json` instead.
  'v7-prefix-shadow.tgz': (() => {
    const raw = gunzipSync(
      buildPackageTarball({
        name: PROTOCOL,
        version: '0.2.0',
        extraEntries: { 'package/second.json': manifestJson(IMPOSTOR, '9.9.9') },
      }),
    );
    for (let offset = 0; offset + 512 <= raw.length;) {
      const header = raw.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
      const size = Number.parseInt(header.subarray(124, 136).toString('utf8').trim(), 8);
      if (name === 'package/second.json') {
        header.fill(0, 0, 100);
        header.write('package/package.json', 0, 'utf8');
        header.fill(0, 257, 265); // strip the ustar signature
        header.write('package/ignored', 345, 'utf8'); // …and add a prefix
        header.fill(0x20, 148, 156);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return gzipSync(raw);
  })(),

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

  // A regular-file entry whose name ends in a slash. npm rewrites its type to
  // directory, so the impostor manifest is not a manifest there at all.
  'trailing-slash-directory.tgz': buildTarball({
    'package/package.json': manifestJson(PROTOCOL, '0.2.0'),
    'package/package.json/': manifestJson(IMPOSTOR, '9.9.9'),
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
    for (const fileName of [
      'normalized-duplicate.tgz',
      'empty-segment-duplicate.tgz',
      'appended-archive.tgz',
      'v7-prefix-shadow.tgz',
    ]) {
      const bytes = archives[fileName]!;
      // npm resolves each of these to *some* identity — that is the danger.
      const theirs = await readWithNpm(fileName, bytes);
      expect(theirs.kind, `${fileName} should still be readable by npm`).toBe('identity');
      expect(readWithThisRepository(fileName, bytes), `${fileName} must be refused here`).toEqual({ kind: 'refused' });
    }
  });

  /**
   * The sharpest form of the closure finding: the two readers do not merely
   * differ in strictness here, they name *different packages* for identical
   * bytes. Asserted explicitly against npm rather than only as "we refuse", so
   * that weakening the header rules cannot quietly pass this file.
   */
  it('confirms npm reads the prefix-shadow archive as the impostor', async () => {
    const bytes = archives['v7-prefix-shadow.tgz']!;
    expect(await readWithNpm('v7-prefix-shadow.tgz', bytes)).toEqual({
      kind: 'identity',
      identity: { name: IMPOSTOR, version: '9.9.9' },
    });
    expect(readWithThisRepository('v7-prefix-shadow.tgz', bytes)).toEqual({ kind: 'refused' });
  });

  it('refuses an archive npm itself cannot recognise', async () => {
    const bytes = archives['bad-checksum.tgz']!;
    expect(await readWithNpm('bad-checksum.tgz', bytes)).toEqual({ kind: 'refused' });
    expect(readWithThisRepository('bad-checksum.tgz', bytes)).toEqual({ kind: 'refused' });
  });

  it('agrees that a trailing-slash entry is a directory, not a second manifest', async () => {
    const bytes = archives['trailing-slash-directory.tgz']!;
    const expected = { kind: 'identity', identity: { name: PROTOCOL, version: '0.2.0' } };
    expect(readWithThisRepository('trailing-slash-directory.tgz', bytes)).toEqual(expected);
    expect(await readWithNpm('trailing-slash-directory.tgz', bytes)).toEqual(expected);
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

  /**
   * The attribution that makes the rest of this file mean anything: the npm
   * read here is the pinned one, resolved out of this workspace, and it is the
   * same package `publish.ts` spawns. If those ever come apart again, every
   * agreement asserted above is an agreement with a program that never sees
   * the release.
   */
  it('states which npm it compared against, so the evidence is attributable', () => {
    const pinned = requireFromNpm('./package.json') as { name?: unknown; version?: unknown };
    expect(pinned.name).toBe('npm');
    expect(pinned.version).toBe(npmTool.version);
    expect(npmTool.modules.map((module) => module.id)).toEqual(['pacote', 'tar']);
    for (const module of npmTool.modules) {
      expect(module.manifestPath.startsWith(npmTool.packageRoot), `${module.id} must come from the pinned npm`).toBe(
        true,
      );
    }
    process.stdout.write(`pacote-differential: compared against ${describeNpmTool(npmTool)}\n`);
  });
});

/**
 * The positive control for header strictness.
 *
 * Refusing formats is only safe if the format this repository actually ships is
 * not one of them. `npm pack` and `pnpm pack` both write through node-tar, so
 * the archive below is written by *that exact writer* — the one bundled with
 * the pinned npm this test already loads — rather than by the in-memory
 * fixture builder. If a future node-tar stopped emitting the POSIX ustar
 * signature, or started splitting paths with `prefix`, this fails rather than
 * the release.
 *
 * The long nested path is deliberate: node-tar emits a pax `path` record once a
 * name exceeds the 100-byte name field, so this also covers the one path
 * override the reader still honours.
 */
describe('archives written by npm’s own tar writer', () => {
  type TarWriter = { readonly create: (options: Record<string, unknown>, paths: readonly string[]) => void };
  const tar = requireFromNpm('tar') as TarWriter;

  function packWithNodeTar(files: Readonly<Record<string, string>>): Buffer {
    const scratch = mkdtempSync(join(cache, 'node-tar-'));
    for (const [relative, contents] of Object.entries(files)) {
      const destination = join(scratch, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    const archive = join(scratch, 'packed.tgz');
    tar.create({ sync: true, gzip: true, cwd: scratch, file: archive, portable: true }, ['package']);
    return readFileSync(archive);
  }

  it('accepts an ordinary package written by node-tar, and reads it as npm does', async () => {
    const deepName = `package/dist/${'nested-directory/'.repeat(6)}index.js`;
    const bytes = packWithNodeTar({
      'package/package.json': manifestJson(PROTOCOL, '0.2.0'),
      'package/README.md': '# readme\n',
      'package/LICENSE': 'Apache-2.0\n',
      'package/NOTICE': 'NOTICE\n',
      'package/dist/index.js': 'export const marker = 1;\n',
      [deepName]: 'export const deep = 1;\n',
    });

    const ours = readWithThisRepository('node-tar-ordinary.tgz', bytes);
    expect(ours).toEqual({ kind: 'identity', identity: { name: PROTOCOL, version: '0.2.0' } });
    expect(await readWithNpm('node-tar-ordinary.tgz', bytes)).toEqual(ours);

    // The long path survived, which means the pax `path` record was honoured
    // rather than the entry being dropped or truncated.
    expect(inspectTarball('node-tar-ordinary.tgz', bytes).entries).toContain(deepName);
  });

  it('confirms node-tar writes the signature this reader requires', () => {
    const raw = gunzipSync(packWithNodeTar({ 'package/package.json': manifestJson(PROTOCOL, '0.2.0') }));
    expect(raw.subarray(257, 265)).toEqual(Buffer.from('ustar\u000000', 'latin1'));
    // …and does not use the ambiguous prefix split.
    expect(raw.subarray(345, 500).every((byte) => byte === 0)).toBe(true);
  });
});
