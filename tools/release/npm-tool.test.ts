/**
 * The npm this repository proves before it uses it.
 *
 * Two halves, and both matter:
 *
 *   - the *positive* half runs against the npm actually installed in this
 *     workspace, so "the pin resolves, carries a CLI, and bundles the readers
 *     the differential test compares against" is observed rather than asserted;
 *   - the *negative* half drives `inspectNpmTool` through a substituted probe,
 *     because every refusal it implements describes a layout that is hard to
 *     produce on purpose and catastrophic to get wrong — an npm that is not
 *     npm, a `bin` that points out of the package, a `pacote` that is somebody
 *     else's copy. A refusal nothing exercises is a refusal that quietly stops
 *     refusing.
 *
 * The regression at the end is the one that would have caught run 34699256419
 * in review: it asserts that the publisher spawns the proven tool rather than
 * a bare `npm` resolved through `PATH`.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeNpmTool,
  inspectNpmTool,
  isContainedIn,
  locateNpmTool,
  npmCommand,
  readPinnedNpmVersion,
  REQUIRED_NPM_MODULES,
  requireNpmTool,
  type NpmToolProbe,
} from './lib/npm-tool.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

/** A probe over an in-memory tree: `path -> JSON value`, plus a resolver map. */
function probeOver(input: {
  readonly files: Readonly<Record<string, unknown>>;
  readonly resolves?: Readonly<Record<string, string>>;
}): NpmToolProbe {
  return {
    realpath: (path) => {
      if (!(path in input.files)) throw new Error(`ENOENT: ${path}`);
      return path;
    },
    readJson: (path) => {
      if (!(path in input.files)) throw new Error(`ENOENT: ${path}`);
      const value = input.files[path];
      if (value === undefined) throw new SyntaxError(`unparseable: ${path}`);
      return value;
    },
    isFile: (path) => path in input.files,
    resolveModuleManifest: (from, id) => {
      const key = `${from}::${id}`;
      const resolved = input.resolves?.[key];
      if (resolved === undefined) throw new Error(`MODULE_NOT_FOUND: ${id} from ${from}`);
      return resolved;
    },
  };
}

const ROOT = '/w/node_modules/.pnpm/npm@1.2.3/node_modules/npm';
const MANIFEST = `${ROOT}/package.json`;

/** A layout that must be accepted, so each negative case differs by one thing. */
const HEALTHY_MANIFEST = { name: 'npm', version: '1.2.3', bin: { npm: 'bin/npm-cli.js' } };

function healthyLayout(overrides?: {
  readonly manifest?: unknown;
  readonly files?: Readonly<Record<string, unknown>>;
  readonly resolves?: Readonly<Record<string, string>>;
}) {
  const files: Record<string, unknown> = {
    [MANIFEST]: 'manifest' in (overrides ?? {}) ? overrides?.manifest : HEALTHY_MANIFEST,
    [`${ROOT}/bin/npm-cli.js`]: {},
    [`${ROOT}/node_modules/pacote/package.json`]: { name: 'pacote', version: '21.5.1' },
    [`${ROOT}/node_modules/tar/package.json`]: { name: 'tar', version: '7.5.22' },
    ...overrides?.files,
  };
  const resolves: Record<string, string> = {
    [`${MANIFEST}::pacote`]: `${ROOT}/node_modules/pacote/package.json`,
    [`${MANIFEST}::tar`]: `${ROOT}/node_modules/tar/package.json`,
    ...overrides?.resolves,
  };
  return inspectNpmTool({
    manifestPath: MANIFEST,
    expectedVersion: '1.2.3',
    nodePath: '/runtime/bin/node',
    probe: probeOver({ files, resolves }),
  });
}

function codesOf(result: ReturnType<typeof inspectNpmTool>): readonly string[] {
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

describe('the reviewed npm pin', () => {
  it('is declared exactly once in the catalog, as an exact version', () => {
    const pinned = readPinnedNpmVersion(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('is what the root manifest asks for, through the catalog and never a literal range', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.npm).toBe('catalog:');
  });

  it.each([
    ['no pin at all', 'catalog:\n  zod: 1.0.0\n', /declares no `npm:` catalog pin/u],
    ['two pins', 'catalog:\n  npm: 1.0.0\n  npm: 2.0.0\n', /declares 2 `npm:` catalog entries/u],
    ['a range rather than a version', 'catalog:\n  npm: ^11.0.0\n', /not an exact version/u],
    ['a dist-tag', 'catalog:\n  npm: latest\n', /not an exact version/u],
  ])('refuses %s', (_label, source, reason) => {
    const pinned = readPinnedNpmVersion(source);
    expect(pinned.ok).toBe(false);
    if (pinned.ok) return;
    expect(pinned.message).toMatch(reason);
  });
});

describe('proving an npm installation', () => {
  it('accepts the pinned package, its CLI and its bundled readers', () => {
    const result = healthyLayout();
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.tool.version).toBe('1.2.3');
    expect(result.tool.cliPath).toBe(`${ROOT}/bin/npm-cli.js`);
    expect(result.tool.modules.map((module) => `${module.id}@${module.version}`)).toEqual([
      'pacote@21.5.1',
      'tar@7.5.22',
    ]);
  });

  it('refuses a manifest that is not there', () => {
    const result = inspectNpmTool({
      manifestPath: '/nowhere/package.json',
      expectedVersion: '1.2.3',
      nodePath: '/runtime/bin/node',
      probe: probeOver({ files: {} }),
    });
    expect(codesOf(result)).toEqual(['npm_tool_missing']);
  });

  it('refuses a manifest that is not JSON', () => {
    expect(codesOf(healthyLayout({ manifest: undefined }))).toEqual(['npm_tool_unreadable']);
  });

  it('refuses a package that is not npm, however well formed', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, name: 'npm-check' } });
    expect(codesOf(result)).toContain('npm_tool_identity');
  });

  /**
   * The spoof that matters most: a real, working npm that is simply not the
   * reviewed one. Nothing about it looks broken, and comparing a tar reader
   * against one npm while publishing through another is precisely the defect
   * this module exists to close.
   */
  it('refuses an npm whose version is not the reviewed pin', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, version: '9.9.9' } });
    expect(codesOf(result)).toEqual(['npm_tool_version_mismatch']);
    if (result.ok) return;
    expect(result.findings[0]?.message).toMatch(/pins npm 1\.2\.3/u);
  });

  it('refuses a version that is not an exact one', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, version: 'latest' } });
    expect(codesOf(result)).toEqual(['npm_tool_version_malformed']);
  });

  it('refuses a package that declares no npm CLI', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, bin: { npx: 'bin/npx-cli.js' } } });
    expect(codesOf(result)).toEqual(['npm_tool_cli_undeclared']);
  });

  it('refuses a CLI the package does not actually carry', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, bin: { npm: 'bin/gone.js' } } });
    expect(codesOf(result)).toEqual(['npm_tool_cli_missing']);
  });

  it('refuses a `bin.npm` that walks out of the package', () => {
    const result = healthyLayout({
      manifest: { ...HEALTHY_MANIFEST, bin: { npm: '../impostor/bin/npm-cli.js' } },
      files: { '/w/node_modules/.pnpm/npm@1.2.3/node_modules/impostor/bin/npm-cli.js': {} },
    });
    expect(codesOf(result)).toEqual(['npm_tool_cli_escapes']);
  });

  it('refuses an absolute `bin.npm`', () => {
    const result = healthyLayout({
      manifest: { ...HEALTHY_MANIFEST, bin: { npm: '/usr/local/bin/impostor.js' } },
      files: { '/usr/local/bin/impostor.js': {} },
    });
    expect(codesOf(result)).toEqual(['npm_tool_cli_escapes']);
  });

  /**
   * The same escape reached through a symlink rather than a `..` segment: the
   * declared path is unremarkable and stays inside the package, and only its
   * real target is elsewhere. This is why containment is decided on real
   * paths.
   */
  it('refuses a CLI that is a symlink out of the package', () => {
    const outside = '/opt/impostor/npm-cli.js';
    const files: Record<string, unknown> = { [outside]: {} };
    const inner = probeOver({
      files: {
        [MANIFEST]: HEALTHY_MANIFEST,
        [`${ROOT}/node_modules/pacote/package.json`]: { name: 'pacote', version: '21.5.1' },
        [`${ROOT}/node_modules/tar/package.json`]: { name: 'tar', version: '7.5.22' },
        ...files,
      },
      resolves: {
        [`${MANIFEST}::pacote`]: `${ROOT}/node_modules/pacote/package.json`,
        [`${MANIFEST}::tar`]: `${ROOT}/node_modules/tar/package.json`,
      },
    });
    const result = inspectNpmTool({
      manifestPath: MANIFEST,
      expectedVersion: '1.2.3',
      nodePath: '/runtime/bin/node',
      probe: {
        ...inner,
        // `<root>/bin/npm-cli.js` exists, and points somewhere else entirely.
        realpath: (path) => (path === `${ROOT}/bin/npm-cli.js` ? outside : inner.realpath(path)),
      },
    });
    expect(codesOf(result)).toEqual(['npm_tool_cli_escapes']);
  });

  it('refuses an npm that does not bundle a reader the differential test needs', () => {
    const result = healthyLayout({ resolves: { [`${MANIFEST}::pacote`]: '' } });
    // An empty target resolves to a path the probe cannot realpath.
    expect(codesOf(result)).toEqual(['npm_module_unresolvable']);
  });

  /**
   * A hoisted `pacote` at the workspace root resolves, loads and reads
   * tarballs — it is simply not the one npm uses. The differential argument is
   * about npm's behaviour, so a reader from anywhere else is refused rather
   * than accepted as equivalent.
   */
  it('refuses a reader that resolves outside the npm package', () => {
    const outside = '/w/node_modules/pacote/package.json';
    const result = healthyLayout({
      files: { [outside]: { name: 'pacote', version: '21.5.1' } },
      resolves: { [`${MANIFEST}::pacote`]: outside },
    });
    expect(codesOf(result)).toEqual(['npm_module_escapes']);
  });

  it('refuses a reader whose manifest names a different package', () => {
    const result = healthyLayout({
      files: { [`${ROOT}/node_modules/tar/package.json`]: { name: 'tar-stream', version: '3.1.7' } },
    });
    expect(codesOf(result)).toEqual(['npm_module_identity']);
  });

  it('reports every reason it refused, not just the first', () => {
    const result = healthyLayout({
      manifest: { name: 'not-npm', version: '9.9.9', bin: { npm: 'bin/gone.js' } },
    });
    expect(codesOf(result)).toEqual(['npm_tool_identity', 'npm_tool_version_mismatch', 'npm_tool_cli_missing']);
  });

  it.each([
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/x/a/b', false],
  ])('containment: %s contains %s -> %s', (parent, child, expected) => {
    expect(isContainedIn(parent, child)).toBe(expected);
  });
});

describe('the tool this workspace actually resolves', () => {
  it('proves the installed npm against the catalog pin', () => {
    const result = locateNpmTool();
    if (!result.ok) {
      throw new Error(result.findings.map((finding) => `[${finding.code}] ${finding.message}`).join('\n'));
    }
    const pinned = readPinnedNpmVersion(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
    expect(pinned.ok && result.tool.version).toBe(pinned.ok ? pinned.version : undefined);
    expect(result.tool.modules.map((module) => module.id)).toEqual([...REQUIRED_NPM_MODULES]);
    for (const module of result.tool.modules) {
      expect(isContainedIn(result.tool.packageRoot, module.manifestPath)).toBe(true);
    }
  });

  /**
   * The layout assertion the old lookup got wrong. Nothing about the proven
   * tool may depend on where the runtime happens to live: under `pnpm/setup`
   * the runtime is a `node` package in a content-addressed store with no npm
   * beside it, and under nvm it is a full distribution with one. The tool must
   * come from the workspace either way.
   */
  it('resolves npm from the workspace, never from beside the running runtime', () => {
    const tool = requireNpmTool();
    expect(isContainedIn(repoRoot, tool.packageRoot)).toBe(true);
    expect(tool.nodePath).toBe(process.execPath);
    expect(describeNpmTool(tool)).toContain(`npm@${tool.version}`);
  });

  it('runs the proven CLI on this runtime rather than a PATH lookup', () => {
    const tool = requireNpmTool();
    const { command, args } = npmCommand(tool, ['publish', 'x.tgz', '--provenance']);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([tool.cliPath, 'publish', 'x.tgz', '--provenance']);
  });
});

/**
 * Regression for the defect itself.
 *
 * `publish.ts` spawning bare `npm` is not a style problem: `PATH` on a hosted
 * runner points at the image's preinstalled Node's npm, which is not pinned,
 * not locked, not reviewed, and not the npm the canonical gate compared these
 * archives against. Asserted against the source, because the alternative is a
 * test that needs a registry and a credential to notice.
 */
describe('the publisher spawns the proven tool', () => {
  const source = readFileSync(join(repoRoot, 'tools/release/publish.ts'), 'utf8');

  it('never spawns an npm resolved through PATH', () => {
    expect(source).not.toMatch(/spawn\(\s*['"]npm['"]/u);
  });

  it('builds its argv from the proven tool', () => {
    expect(source).toContain('npmCommand(npmTool, args)');
  });

  it('refuses to continue when the tool cannot be proven', () => {
    expect(source).toContain('locateNpmTool()');
    expect(source).toMatch(/if \(!locatedNpm\.ok\) \{[\s\S]*?process\.exit\(1\);/u);
  });
});
