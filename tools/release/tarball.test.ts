import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { digestBytes, inspectTarball, readTarEntries, tarballFileName } from './lib/tarball.ts';
import { buildPackageTarball, buildTarball } from './testing/fixtures.ts';

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
    const truncated = buildTarball({ 'package/package.json': '{}' });
    const raw = Buffer.from(gzipSync(Buffer.alloc(0)));
    expect(truncated.byteLength).toBeGreaterThan(raw.byteLength);
    const tar = Buffer.alloc(512);
    tar.write('package/package.json', 0, 'utf8');
    tar.write(`${(9999).toString(8).padStart(11, '0')} `, 124, 'utf8');
    tar.write('        ', 148, 'utf8');
    tar.write('0', 156, 'utf8');
    expect(() => readTarEntries(tar)).toThrow(/past the end of the archive/u);
  });

  it('refuses an archive that lists the same path twice', () => {
    const chunks: Buffer[] = [];
    const entry = buildTarball({ 'package/package.json': '{}' });
    expect(entry.byteLength).toBeGreaterThan(0);
    const single = (contents: string): Buffer => {
      const header = Buffer.alloc(512);
      header.write('package/package.json', 0, 'utf8');
      header.write(`${Buffer.byteLength(contents).toString(8).padStart(11, '0')} `, 124, 'utf8');
      header.write('        ', 148, 'utf8');
      header.write('0', 156, 'utf8');
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
      const body = Buffer.alloc(512);
      body.write(contents, 0, 'utf8');
      return Buffer.concat([header, body]);
    };
    chunks.push(single('{"name":"a","version":"1.0.0"}'), single('{"name":"b","version":"1.0.0"}'), Buffer.alloc(1024));
    expect(() => readTarEntries(Buffer.concat(chunks))).toThrow(/twice/u);
  });

  it('refuses an entry type it does not understand, such as a symlink', () => {
    const header = Buffer.alloc(512);
    header.write('package/package.json', 0, 'utf8');
    header.write(`${(0).toString(8).padStart(11, '0')} `, 124, 'utf8');
    header.write('        ', 148, 'utf8');
    header.write('2', 156, 'utf8'); // symlink
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    expect(() => readTarEntries(Buffer.concat([header, Buffer.alloc(1024)]))).toThrow(/unsupported type flag/u);
  });
});
