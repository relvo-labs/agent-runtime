import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { digestBytes, inspectTarball, normalizeEntryPath, readTarEntries, tarballFileName } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

const BLOCK = 512;

/**
 * Build one tar header with a *correct* checksum and a valid POSIX ustar
 * signature, so a test can isolate the property it is actually about. A header
 * with a wrong checksum, or without the ustar signature, is refused before
 * anything else is read — both of which are asserted separately below.
 */
function tarHeader(
  path: string,
  size: number,
  typeFlag = '0',
  options: { signature?: string; prefix?: string } = {},
): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(path.slice(0, 100), 0, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8');
  header.write('        ', 148, 'utf8'); // checksum is computed over spaces
  header.write(typeFlag, 156, 'utf8');
  header.write(options.signature ?? 'ustar\0' + '00', 257, 'latin1');
  if (options.prefix !== undefined) header.write(options.prefix, 345, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return header;
}

function tarEntry(
  path: string,
  contents: string,
  typeFlag = '0',
  options: { signature?: string; prefix?: string } = {},
): Buffer {
  const body = Buffer.from(contents, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.byteLength / BLOCK) * BLOCK);
  body.copy(padded);
  return Buffer.concat([tarHeader(path, body.byteLength, typeFlag, options), padded]);
}

const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2);

describe('packed artifact inspection', () => {
  it('reads identity, dependency ranges and digests out of the tarball itself', () => {
    const bytes = buildPackageTarball({
      name: '@relvo-labs/agent-runtime',
      version: '0.2.0',
      dependencies: { '@relvo-labs/agent-protocol': '^0.2.0' },
      peerDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.259' },
      optionalPeers: ['@anthropic-ai/claude-agent-sdk'],
    });
    const artifact = inspectTarball('relvo-labs-agent-runtime-0.2.0.tgz', bytes);

    expect(artifact.manifest.name).toBe('@relvo-labs/agent-runtime');
    expect(artifact.manifest.version).toBe('0.2.0');
    expect(artifact.manifest.dependencies).toEqual({ '@relvo-labs/agent-protocol': '^0.2.0' });
    expect(artifact.manifest.optionalPeers).toEqual(['@anthropic-ai/claude-agent-sdk']);
    expect(artifact.manifest.publishAccess).toBe('public');
    expect(artifact.manifest.publishProvenance).toBe(true);
    expect(artifact.entries).toContain('package/package.json');
    expect(artifact).toMatchObject(digestBytes(bytes));
  });

  it('derives the npm tarball file name for a scoped package', () => {
    expect(tarballFileName('@relvo-labs/agent-workspace-git', '0.2.0')).toBe(
      'relvo-labs-agent-workspace-git-0.2.0.tgz',
    );
  });

  it('refuses an archive with no manifest', () => {
    expect(() => inspectTarball('x.tgz', buildTarball({ 'package/README.md': 'hi\n' }))).toThrow(
      /package\/package\.json/u,
    );
  });

  it('refuses a manifest that is not JSON or not a package', () => {
    expect(() => inspectTarball('x.tgz', buildTarball({ 'package/package.json': '{not json' }))).toThrow(/not JSON/u);
    expect(() => inspectTarball('x.tgz', buildTarball({ 'package/package.json': '{"name":"x"}' }))).toThrow(
      /string name\/version/u,
    );
  });

  it('refuses an archive that claims more bytes than it carries', () => {
    const truncated = Buffer.concat([tarHeader('package/package.json', 9999), Buffer.alloc(BLOCK)]);
    expect(() => readTarEntries(truncated)).toThrow(/past the end of the archive/u);
  });

  it('refuses an entry type it does not understand, such as a symlink', () => {
    const archive = Buffer.concat([tarHeader('package/package.json', 0, '2'), END_OF_ARCHIVE]);
    expect(() => readTarEntries(archive)).toThrow(/unsupported type flag/u);
  });

  it('refuses an archive with no end-of-archive marker', () => {
    expect(() => readTarEntries(tarEntry('package/package.json', '{}'))).toThrow(/no end-of-archive marker/u);
  });
});

/**
 * Regressions for archive-identity ambiguity.
 *
 * An independent review built an archive carrying both `package/package.json`
 * and `package/./package.json`. This reader accepted it and reported one
 * identity; npm's own extractor read the other. Everything below exists so that
 * class of disagreement is a refusal rather than a difference of opinion — see
 * `pacote-differential.test.ts`, which proves the agreement against npm itself.
 */
describe('archive path normalization', () => {
  it('collapses the segments an extractor collapses', () => {
    expect(normalizeEntryPath('package/./package.json')).toBe('package/package.json');
    expect(normalizeEntryPath('package//dist/index.js')).toBe('package/dist/index.js');
    expect(normalizeEntryPath('package/dist/')).toBe('package/dist');
  });

  it('refuses a path that escapes, absolutises or hides itself', () => {
    for (const raw of ['../package/package.json', '/package/package.json', 'package\\package.json', './.', 'a\0b']) {
      expect(() => normalizeEntryPath(raw)).toThrow();
    }
  });

  it('refuses two entries that normalize to one destination', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', '{"name":"@relvo-labs/agent-protocol","version":"0.2.0"}'),
      tarEntry('package/./package.json', '{"name":"@relvo-labs/agent-runtime","version":"9.9.9"}'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/resolves `package\/package\.json` more than once/u);
  });

  it('refuses a literal duplicate of the same path', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', '{"name":"a","version":"1.0.0"}'),
      tarEntry('package/package.json', '{"name":"b","version":"1.0.0"}'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/more than once/u);
  });

  it('refuses content outside the package tree npm installs', () => {
    const archive = buildTarball({
      'package/package.json': '{"name":"@relvo-labs/agent-protocol","version":"0.2.0"}',
      'elsewhere/evil.js': 'boom',
    });
    expect(() => inspectTarball('x.tgz', archive)).toThrow(/outside the package\/ tree/u);
  });
});

describe('archive framing', () => {
  it('refuses a header whose checksum does not match its contents', () => {
    const raw = gunzipSync(buildTarball({ 'package/package.json': '{"name":"a","version":"1.0.0"}' }));
    raw.fill(48, 148, 154); // overwrite the checksum with octal zeroes
    expect(() => inspectTarball('x.tgz', gzipSync(raw))).toThrow(/checksum/u);
  });

  it('refuses a malformed checksum field outright', () => {
    const header = tarHeader('package/package.json', 0);
    header.write('zzzzzz\0 ', 148, 'utf8');
    expect(() => readTarEntries(Buffer.concat([header, END_OF_ARCHIVE]))).toThrow(/malformed checksum/u);
  });

  it('refuses a second archive appended after the end-of-archive marker', () => {
    const first = gunzipSync(buildTarball({ 'package/package.json': '{"name":"a","version":"1.0.0"}' }));
    const second = gunzipSync(buildTarball({ 'package/package.json': '{"name":"b","version":"9.9.9"}' }));
    expect(() => readTarEntries(Buffer.concat([first, second]))).toThrow(/after its end-of-archive marker/u);
  });

  it('refuses a global pax header, which would apply to entries it does not accompany', () => {
    const archive = Buffer.concat([
      tarEntry('pax_global_header', '30 comment=anything-at-all\n', 'g'),
      tarEntry('package/package.json', '{"name":"a","version":"1.0.0"}'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/global pax header/u);
  });

  it('honours a pax path override but refuses any other pax key', () => {
    const overridden = Buffer.concat([
      tarEntry('./PaxHeaders/x', '32 path=package/package.json\n', 'x'),
      tarEntry('unused', '{"name":"a","version":"1.0.0"}'),
      END_OF_ARCHIVE,
    ]);
    expect([...readTarEntries(overridden).keys()]).toEqual(['package/package.json']);

    const resized = Buffer.concat([
      tarEntry('./PaxHeaders/x', '11 size=99\n', 'x'),
      tarEntry('package/package.json', '{"name":"a","version":"1.0.0"}'),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(resized)).toThrow(/unsupported key `size`/u);
  });

  it('refuses an extended header that names an entry which never arrives', () => {
    const dangling = Buffer.concat([tarEntry('./PaxHeaders/x', '32 path=package/package.json\n', 'x')]);
    expect(() => readTarEntries(dangling)).toThrow(/dangling extended header/u);
  });
});

/**
 * Regressions for header *format*, which is where the second identity hid.
 *
 * An independent closure review built an archive whose second
 * `package/package.json` header had valid checksums, a populated `prefix` field
 * and **no** ustar signature. npm's bundled `node-tar` applies `prefix` only
 * inside its ustar-signature branch, so npm ignored it and let that header
 * overwrite the real manifest; this reader applied it and saw a different,
 * harmless path. Preflight and `loadStaging` both passed while npm read
 * `agent-runtime@9.9.9`.
 *
 * The rule is now: a format whose field semantics cannot be guaranteed to match
 * npm is refused, rather than interpreted as far as this reader happens to
 * understand it.
 */
describe('header format signatures', () => {
  const manifest = '{"name":"@relvo-labs/agent-protocol","version":"0.2.0"}';

  it('refuses a header with no format signature at all', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', manifest, '0', { signature: '\0'.repeat(8) }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/POSIX ustar signature/u);
  });

  it('refuses a GNU-format header, whose field semantics differ from npm’s', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', manifest, '0', { signature: 'ustar  \0' }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/POSIX ustar signature/u);
  });

  it('applies a prefix under a valid signature, because node-tar emits one', () => {
    // Deep paths in a real `pnpm pack` artifact are split exactly this way, so
    // refusing the field would reject legitimate artifacts. It is applied the
    // way npm applies it instead.
    const archive = Buffer.concat([tarEntry('package.json', manifest, '0', { prefix: 'package' }), END_OF_ARCHIVE]);
    expect([...readTarEntries(archive).keys()]).toEqual(['package/package.json']);
  });

  it('selects the 155-byte prefix exactly when npm does', () => {
    // npm switches on byte 475: non-zero means the prefix runs the full 155
    // bytes, zero means it stops at 130 and the rest is atime/ctime. A prefix
    // long enough to reach byte 475 must therefore be read whole.
    const long = `${'d'.repeat(129)}/tail`; // 135 bytes: crosses the 130 boundary
    const archive = Buffer.concat([tarEntry('package.json', manifest, '0', { prefix: long }), END_OF_ARCHIVE]);
    expect([...readTarEntries(archive).keys()]).toEqual([`${long}/package.json`]);
  });

  it('refuses the exact closure fixture: an unsigned second header carrying a prefix', () => {
    // Byte-for-byte the shape the reviewer built: a legitimate first manifest,
    // then a second header for the same npm destination that this reader used
    // to file under `package/ignored/package.json` and ignore.
    const archive = Buffer.concat([
      tarEntry('package/package.json', manifest, '0'),
      tarEntry('package/package.json', '{"name":"@relvo-labs/agent-runtime","version":"9.9.9"}', '0', {
        signature: '\0'.repeat(8),
        prefix: 'package/ignored',
      }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/POSIX ustar signature/u);
  });

  it('treats a trailing-slash regular file as the directory npm treats it as', () => {
    // npm rewrites type `0` to type `5` when the name ends in a slash, so
    // `package/package.json/` carries no manifest there either. Reading it as a
    // file would put a manifest where npm sees none.
    const archive = Buffer.concat([
      tarEntry('package/package.json', manifest, '0'),
      tarEntry('package/package.json/', '{"name":"@relvo-labs/agent-runtime","version":"9.9.9"}', '0'),
      END_OF_ARCHIVE,
    ]);
    const entries = readTarEntries(archive);
    expect([...entries.keys()]).toEqual(['package/package.json']);
    expect(entries.get('package/package.json')!.toString('utf8')).toBe(manifest);
  });

  it('refuses that fixture as a collision too, once the signature is made valid', () => {
    // The same two headers with a proper ustar signature no longer disagree
    // with npm about the path — both read `package/ignored/package.json` — so
    // this asserts the second line of defence rather than the first: were the
    // prefix pointed back at the real manifest, it would be a duplicate.
    const archive = Buffer.concat([
      tarEntry('package/package.json', manifest, '0'),
      tarEntry('package.json', '{"name":"@relvo-labs/agent-runtime","version":"9.9.9"}', '0', { prefix: 'package' }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/resolves `package\/package\.json` more than once/u);
  });

  it('refuses a GNU long-name entry rather than reading half of it', () => {
    const archive = Buffer.concat([
      tarEntry('././@LongLink', 'package/package.json\0', 'L'),
      tarEntry('ignored', manifest),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(/GNU long-name entry|POSIX ustar signature/u);
  });

  it('still reads an ordinary artifact packed by this repository', () => {
    // The positive control: the strictness above must not cost a real tarball.
    const artifact = inspectTarball(
      'ordinary.tgz',
      buildPackageTarball({ name: '@relvo-labs/agent-protocol', version: '0.2.0' }),
    );
    expect(artifact.manifest.name).toBe('@relvo-labs/agent-protocol');
    expect(artifact.entries).toContain('package/package.json');
  });
});
