import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { digestBytes, inspectTarball, normalizeEntryPath, readTarEntries, tarballFileName } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

const BLOCK = 512;

/**
 * Build one tar header with a *correct* checksum, so a test can isolate the
 * property it is actually about. A header with a wrong checksum is refused
 * before anything else is read, which is itself asserted below.
 */
function tarHeader(path: string, size: number, typeFlag = '0'): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(path.slice(0, 100), 0, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8');
  header.write('        ', 148, 'utf8'); // checksum is computed over spaces
  header.write(typeFlag, 156, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return header;
}

function tarEntry(path: string, contents: string, typeFlag = '0'): Buffer {
  const body = Buffer.from(contents, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.byteLength / BLOCK) * BLOCK);
  body.copy(padded);
  return Buffer.concat([tarHeader(path, body.byteLength, typeFlag), padded]);
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
