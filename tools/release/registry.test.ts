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
