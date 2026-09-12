import { describe, expect, it } from 'vitest';
import { classifyRegistryResponse, packumentUrl, parsePackument } from './lib/registry.ts';

const NAME = '@relvo-labs/agent-protocol';

function packumentBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: NAME,
    'dist-tags': { latest: '0.1.0' },
    versions: {
      '0.1.0': {
        name: NAME,
        version: '0.1.0',
        dependencies: { zod: '4.5.4' },
        dist: { integrity: 'sha512-abc', shasum: 'deadbeef' },
      },
    },
    ...overrides,
  });
}

describe('registry response classification', () => {
  it('treats only a 404 as "this package is not published"', () => {
    expect(classifyRegistryResponse(NAME, 404, '')).toEqual({ kind: 'absent' });
  });

  it('never turns an authentication failure into an absence', () => {
    for (const status of [401, 403]) {
      const result = classifyRegistryResponse(NAME, status, '');
      expect(result.kind).toBe('unauthorized');
    }
  });

  it('never turns a server error, a rate limit or a redirect into an absence', () => {
    for (const status of [301, 429, 500, 502, 503]) {
      expect(classifyRegistryResponse(NAME, status, '').kind).toBe('error');
    }
  });

  it('refuses a 200 whose body is not JSON', () => {
    const result = classifyRegistryResponse(NAME, 200, '<html>maintenance</html>');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('not JSON');
  });

  it('refuses a packument that describes a different package', () => {
    const result = classifyRegistryResponse(NAME, 200, packumentBody({ name: '@relvo-labs/other' }));
    expect(result.kind).toBe('error');
  });

  it('refuses a packument whose version entry disagrees with its own key', () => {
    const result = parsePackument(NAME, {
      name: NAME,
      'dist-tags': {},
      versions: { '0.1.0': { name: NAME, version: '0.9.9', dist: {} } },
    });
    expect(result.kind).toBe('error');
  });

  it('refuses malformed dependency, dist and dist-tag blocks', () => {
    const malformed: unknown[] = [
      {
        name: NAME,
        'dist-tags': {},
        versions: { '0.1.0': { name: NAME, version: '0.1.0', dependencies: { zod: 4 }, dist: {} } },
      },
      { name: NAME, 'dist-tags': {}, versions: { '0.1.0': { name: NAME, version: '0.1.0' } } },
      { name: NAME, 'dist-tags': { latest: 1 }, versions: {} },
      { name: NAME, versions: [] },
      'not an object',
    ];
    for (const document of malformed) {
      expect(parsePackument(NAME, document).kind).toBe('error');
    }
  });

  /**
   * Regressions for the fail-closed contract.
   *
   * An independent review fed three malformed packuments to preflight. Each was
   * classified as `found` and each produced a release plan with zero findings:
   * an absent `dist-tags` block read as "no tag is set", a tag whose value was
   * not a version read as "nothing to compare", and a tag pointing at a version
   * the document did not list read the same way. All three are the input to the
   * dist-tag regression check, so accepting them is how a release moves
   * `latest` backwards while reporting success.
   */
  it('refuses a document with no dist-tags block at all', () => {
    const result = parsePackument(NAME, { name: NAME, versions: {} });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('dist-tags');
  });

  it('refuses a dist-tag whose value is not an exact version', () => {
    for (const value of ['0.0.invalid', 'nonsense', '^0.1.0', '0.1', 'latest', '']) {
      const document = { name: NAME, versions: {}, 'dist-tags': { latest: value } };
      const result = parsePackument(NAME, document);
      expect(result.kind, `dist-tag \`${value}\` must be refused`).toBe('error');
      if (result.kind !== 'error') continue;
      expect(result.detail).toContain('not an exact version');
    }
  });

  it('refuses a dist-tag that points at a version the document does not list', () => {
    const result = parsePackument(NAME, { name: NAME, versions: {}, 'dist-tags': { latest: '0.1.0' } });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('does not list as a version');
  });

  it('accepts an empty dist-tags block, which is a real state for a fresh name', () => {
    expect(parsePackument(NAME, { name: NAME, versions: {}, 'dist-tags': {} }).kind).toBe('found');
  });

  it('still accepts a version entry that genuinely declares no dependencies', () => {
    const result = parsePackument(NAME, {
      name: NAME,
      'dist-tags': { latest: '0.1.0' },
      versions: { '0.1.0': { name: NAME, version: '0.1.0', dist: { integrity: 'sha512-abc' } } },
    });
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.packument.versions.get('0.1.0')?.dependencies).toEqual({});
  });

  it('reads a well-formed packument', () => {
    const result = classifyRegistryResponse(NAME, 200, packumentBody());
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.packument.versions.get('0.1.0')?.dependencies).toEqual({ zod: '4.5.4' });
    expect(result.packument.versions.get('0.1.0')?.integrity).toBe('sha512-abc');
    expect(result.packument.distTags.get('latest')).toBe('0.1.0');
  });

  it('encodes a scoped name into a single packument path segment', () => {
    expect(packumentUrl('https://registry.npmjs.org/', NAME)).toBe(
      'https://registry.npmjs.org/@relvo-labs%2fagent-protocol',
    );
  });
});
