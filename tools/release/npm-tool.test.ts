/**
 * The npm this repository proves before it uses it.
 *
 * Three kinds of test, and all three are load-bearing:
 *
 *   - the *positive* half runs against the npm actually installed in this
 *     workspace, so "the pin resolves, carries a CLI, and bundles the readers
 *     the differential test compares against" is observed rather than asserted;
 *   - the *real-filesystem* half builds whole workspaces in a scratch
 *     directory — an npm one level up, an npm on `NODE_PATH`, a reader whose
 *     `main` traverses out of the package, a reader whose `exports` target is a
 *     symlink out of the tree — and requires each one to be refused. These
 *     exist because an independent review built exactly these layouts and had
 *     them *accepted*; a synthetic probe cannot prove they are closed, because
 *     the defect was in what the real resolver does;
 *   - the *probe* half drives `inspectNpmTool` over an in-memory tree for the
 *     refusals whose inputs are awkward to materialise. A refusal nothing
 *     exercises is a refusal that quietly stops refusing.
 *
 * The regression at the end asserts that the publisher spawns the proven tool
 * rather than a bare `npm` resolved through `PATH` — the defect that produced
 * run 34699256419.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeNpmTool,
  inspectNpmTool,
  isContainedIn,
  loadNpmModule,
  locateNpmTool,
  npmCommand,
  readPinnedNpmVersion,
  REQUIRED_NPM_MODULES,
  requireNpmTool,
  type NpmToolProbe,
  type NpmToolResult,
} from './lib/npm-tool.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const toolModule = join(repoRoot, 'tools/release/lib/npm-tool.ts');

/** Scratch root for the real-filesystem fixtures. Never inside the repository. */
const scratch = mkdtempSync(join(tmpdir(), 'relvo-npm-tool-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Real-filesystem fixtures
// ---------------------------------------------------------------------------

const FIXTURE_VERSION = '9.9.9';

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

type ReaderShape = {
  /** Replaces the reader's manifest wholesale. */
  readonly manifest?: string;
  /** Extra files, relative to the reader's directory. */
  readonly files?: Readonly<Record<string, string>>;
  /** Symlinks to create, relative to the reader's directory. */
  readonly links?: Readonly<Record<string, string>>;
  /** Omit the reader's entry file entirely. */
  readonly omitEntry?: boolean;
};

/**
 * A workspace that `locateNpmTool` must accept, so every negative fixture
 * below differs from an accepted one by exactly the thing under test.
 *
 * `npmAt` decides where the npm package is physically written — that is what
 * separates "installed here" from "reachable from here".
 */
function buildWorkspace(
  name: string,
  options?: {
    readonly npmAt?: 'workspace' | 'ancestor' | 'external';
    readonly declareDependency?: boolean;
    readonly linkWorkspaceNpmToExternal?: boolean;
    readonly readers?: Readonly<Record<string, ReaderShape>>;
  },
): { readonly base: string; readonly workspace: string; readonly npmRoot: string; readonly outside: string } {
  const base = join(scratch, name);
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside.cjs');
  write(outside, 'module.exports = { marker: "OUTSIDE_NPM_PACKAGE" };\n');

  write(workspace + '/pnpm-workspace.yaml', `catalog:\n  npm: ${FIXTURE_VERSION}\n`);
  write(
    workspace + '/package.json',
    `${JSON.stringify(
      {
        name: 'fixture',
        private: true,
        devDependencies: (options?.declareDependency ?? true) ? { npm: 'catalog:' } : {},
      },
      null,
      2,
    )}\n`,
  );

  const placement = options?.npmAt ?? 'workspace';
  const npmRoot =
    placement === 'workspace'
      ? join(workspace, 'node_modules/npm')
      : placement === 'ancestor'
        ? join(base, 'node_modules/npm')
        : join(base, 'external/npm');

  write(
    join(npmRoot, 'package.json'),
    `${JSON.stringify({ name: 'npm', version: FIXTURE_VERSION, bin: { npm: 'bin/npm-cli.js' } })}\n`,
  );
  write(join(npmRoot, 'bin/npm-cli.js'), 'process.stdout.write("fixture npm\\n");\n');

  for (const id of REQUIRED_NPM_MODULES) {
    const shape = options?.readers?.[id];
    const directory = join(npmRoot, 'node_modules', id);
    write(
      join(directory, 'package.json'),
      shape?.manifest ?? `${JSON.stringify({ name: id, version: '1.0.0', main: 'index.cjs' })}\n`,
    );
    if (shape?.omitEntry !== true) {
      write(join(directory, 'index.cjs'), `module.exports = { marker: "INSIDE_${id.toUpperCase()}" };\n`);
    }
    for (const [where, contents] of Object.entries(shape?.files ?? {})) {
      write(join(directory, where), contents);
    }
    for (const [where, target] of Object.entries(shape?.links ?? {})) {
      const link = join(directory, where);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
    }
  }

  if (options?.linkWorkspaceNpmToExternal === true) {
    const link = join(workspace, 'node_modules/npm');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(npmRoot, link);
  }

  return { base, workspace, npmRoot, outside };
}

function codes(result: NpmToolResult): readonly string[] {
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

/** Runs `locateNpmTool` in a child process, so `NODE_PATH` is really applied. */
function locateInChild(root: string, env: Readonly<Record<string, string>>): NpmToolResult {
  const harness = join(scratch, 'harness.mjs');
  write(
    harness,
    [
      "import { pathToFileURL } from 'node:url';",
      'const mod = await import(pathToFileURL(process.argv[2]).href);',
      'process.stdout.write(JSON.stringify(mod.locateNpmTool({ repoRoot: process.argv[3] })));',
      '',
    ].join('\n'),
  );
  const child = spawnSync(process.execPath, [harness, toolModule, root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (child.status !== 0) throw new Error(`harness failed (${String(child.status)}): ${child.stderr}`);
  return JSON.parse(child.stdout) as NpmToolResult;
}

describe('the npm package is located, never searched for', () => {
  /**
   * The first blocker, reproduced. `createRequire(<repo>/package.json)
   * .resolve('npm/package.json')` walks every ancestor `node_modules`; a review
   * removed the workspace's own npm entirely, put a matching one a directory
   * up, and had it accepted as the publishing tool. The workspace path is the
   * only path now, so an ancestor npm is simply not there.
   */
  it('refuses an npm that exists only in an ancestor directory', () => {
    const { workspace, npmRoot } = buildWorkspace('ancestor', { npmAt: 'ancestor' });
    expect(readFileSync(join(npmRoot, 'package.json'), 'utf8')).toContain('"npm"');
    const result = locateNpmTool({ repoRoot: workspace });
    expect(codes(result)).toEqual(['npm_tool_missing']);
    if (!result.ok) expect(result.findings[0]?.message).toContain(join(workspace, 'node_modules/npm/package.json'));
  });

  /**
   * The same blocker through the other door. `NODE_PATH` is consulted after
   * the ancestor walk, so a matching npm anywhere it points was accepted too.
   * Run in a child process because `NODE_PATH` is read once at startup —
   * setting `process.env` in-process would prove nothing.
   */
  it('refuses an npm reachable only through NODE_PATH', () => {
    const { workspace, base } = buildWorkspace('nodepath', { npmAt: 'external' });
    const nodePath = join(base, 'external');

    // The fixture is genuinely reachable that way: a plain resolve finds it.
    const reachable = spawnSync(process.execPath, ['-e', 'process.stdout.write(require.resolve("npm/package.json"))'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: nodePath },
      cwd: base,
    });
    expect(reachable.stdout).toBe(join(nodePath, 'npm/package.json'));

    expect(codes(locateInChild(workspace, { NODE_PATH: nodePath }))).toEqual(['npm_tool_missing']);
  });

  /**
   * Ownership is decided on the real path. `node_modules/npm` is a symlink
   * under pnpm and must stay one, so the rule cannot be "no symlinks" — it is
   * "the link must land inside this workspace's own dependency tree".
   */
  it('refuses an npm symlinked out of the workspace dependency tree', () => {
    const { workspace } = buildWorkspace('linked-out', { npmAt: 'external', linkWorkspaceNpmToExternal: true });
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_tool_not_owned']);
  });

  it('accepts an npm installed in the workspace itself', () => {
    const { workspace, npmRoot } = buildWorkspace('installed');
    const result = locateNpmTool({ repoRoot: workspace });
    expect(codes(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.tool.packageRoot).toBe(npmRoot);
    expect(result.tool.modules.map((module) => module.id)).toEqual([...REQUIRED_NPM_MODULES]);
  });

  /** The workspace must ask for npm, not merely happen to contain one. */
  it('refuses a workspace that does not declare npm as a catalog devDependency', () => {
    const { workspace } = buildWorkspace('undeclared', { declareDependency: false });
    const result = locateNpmTool({ repoRoot: workspace });
    expect(codes(result)).toEqual(['npm_dependency_undeclared']);
  });
});

describe('the readers are bound to the entry point they will load', () => {
  /**
   * The second blocker, reproduced. Containment was checked on
   * `pacote/package.json` and nothing else, and the loader then handed out an
   * unrestricted `require`. A `main` pointing out of the package loaded
   * `outside.cjs` while inspection reported npm's own bundled reader.
   */
  it.each([...REQUIRED_NPM_MODULES])('refuses a %s whose `main` traverses out of npm', (id) => {
    const { workspace, npmRoot, outside } = buildWorkspace(`${id}-main-traversal`);
    const directory = join(npmRoot, 'node_modules', id);
    // Computed, so the fixture cannot silently become a non-existent path and
    // pass for the wrong reason: this really does point at `outside.cjs`.
    const escape = relative(directory, outside);
    write(join(directory, 'package.json'), `${JSON.stringify({ name: id, version: '1.0.0', main: escape })}\n`);
    expect(escape.startsWith('../')).toBe(true);
    expect(createRequire(join(npmRoot, 'package.json')).resolve(id)).toBe(outside);

    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_entry_escapes']);
  });

  /** The same escape with a path that never leaves the package textually. */
  it.each([...REQUIRED_NPM_MODULES])('refuses a %s whose `exports` target is a symlink out of npm', (id) => {
    const { workspace, base } = buildWorkspace(`${id}-exports-symlink`, {
      readers: {
        [id]: {
          manifest: `${JSON.stringify({
            name: id,
            version: '1.0.0',
            exports: { '.': './escape.cjs', './package.json': './package.json' },
          })}\n`,
          links: { 'escape.cjs': join(scratch, `${id}-exports-symlink/outside.cjs`) },
        },
      },
    });
    expect(base).toBe(join(scratch, `${id}-exports-symlink`));
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_entry_escapes']);
  });

  /**
   * Stronger than the reviewed escape: the entry stays inside npm but leaves
   * its own package, so `pacote` would have been tar's code. Identity is per
   * package, not per tree.
   */
  it('refuses a reader whose entry point traverses into a sibling module inside npm', () => {
    const { workspace } = buildWorkspace('sibling-traversal', {
      readers: {
        pacote: { manifest: `${JSON.stringify({ name: 'pacote', version: '1.0.0', main: '../tar/index.cjs' })}\n` },
      },
    });
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_entry_escapes']);
  });

  /** Previously passed inspection and then threw at `require` time. */
  it('refuses a reader whose entry point does not exist', () => {
    const { workspace } = buildWorkspace('missing-entry', {
      readers: {
        tar: { manifest: `${JSON.stringify({ name: 'tar', version: '1.0.0', main: 'gone.cjs' })}\n`, omitEntry: true },
      },
    });
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_entry_unresolvable']);
  });

  it('refuses a reader that is not bundled inside npm at all', () => {
    const { workspace, npmRoot } = buildWorkspace('reader-absent');
    rmSync(join(npmRoot, 'node_modules/pacote'), { recursive: true, force: true });
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_missing']);
  });

  it('refuses a reader whose manifest names a different package', () => {
    const { workspace } = buildWorkspace('reader-wrong-name', {
      readers: {
        tar: { manifest: `${JSON.stringify({ name: 'tar-stream', version: '1.0.0', main: 'index.cjs' })}\n` },
      },
    });
    expect(codes(locateNpmTool({ repoRoot: workspace }))).toEqual(['npm_module_identity']);
  });

  it('records the validated entry point, and loads exactly that file', () => {
    const { workspace, npmRoot } = buildWorkspace('entry-bound');
    const result = locateNpmTool({ repoRoot: workspace });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pacote = result.tool.modules.find((module) => module.id === 'pacote');
    expect(pacote?.entryPath).toBe(join(npmRoot, 'node_modules/pacote/index.cjs'));
    expect(loadNpmModule(result.tool, 'pacote')).toEqual({ marker: 'INSIDE_PACOTE' });
  });

  /** The loader is an allow-list, not a `require` with npm's search paths. */
  it('refuses to load any module that was not declared and proven', () => {
    const { workspace } = buildWorkspace('loader-allowlist');
    const result = locateNpmTool({ repoRoot: workspace });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of ['semver', 'fs', './lib/npm.js', 'libnpmpublish']) {
      expect(() => loadNpmModule(result.tool, id)).toThrow(/not one of the validated npm readers/u);
    }
  });
});

// ---------------------------------------------------------------------------
// In-memory probe fixtures
// ---------------------------------------------------------------------------

/** A probe over an in-memory tree: `path -> JSON value`, plus a resolver map. */
function probeOver(input: {
  readonly files: Readonly<Record<string, unknown>>;
  readonly entries?: Readonly<Record<string, string>>;
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
    resolveModuleEntry: (from, id) => {
      const resolved = input.entries?.[`${from}::${id}`];
      if (resolved === undefined) throw new Error(`MODULE_NOT_FOUND: ${id} from ${from}`);
      return resolved;
    },
  };
}

const DEPS = '/w/node_modules';
const ROOT = `${DEPS}/.pnpm/npm@1.2.3/node_modules/npm`;
const MANIFEST = `${ROOT}/package.json`;

const HEALTHY_MANIFEST = { name: 'npm', version: '1.2.3', bin: { npm: 'bin/npm-cli.js' } };

/** A layout that must be accepted, so each negative case differs by one thing. */
function healthyLayout(overrides?: {
  readonly manifest?: unknown;
  readonly files?: Readonly<Record<string, unknown>>;
  readonly entries?: Readonly<Record<string, string>>;
  readonly dependencyRoot?: string;
}): NpmToolResult {
  const files: Record<string, unknown> = {
    [DEPS]: {},
    [MANIFEST]: 'manifest' in (overrides ?? {}) ? overrides?.manifest : HEALTHY_MANIFEST,
    [`${ROOT}/bin/npm-cli.js`]: {},
    [`${ROOT}/node_modules/pacote`]: {},
    [`${ROOT}/node_modules/pacote/package.json`]: { name: 'pacote', version: '21.5.1' },
    [`${ROOT}/node_modules/pacote/lib/index.js`]: {},
    [`${ROOT}/node_modules/tar`]: {},
    [`${ROOT}/node_modules/tar/package.json`]: { name: 'tar', version: '7.5.22' },
    [`${ROOT}/node_modules/tar/index.js`]: {},
    ...overrides?.files,
  };
  const entries: Record<string, string> = {
    [`${MANIFEST}::pacote`]: `${ROOT}/node_modules/pacote/lib/index.js`,
    [`${MANIFEST}::tar`]: `${ROOT}/node_modules/tar/index.js`,
    ...overrides?.entries,
  };
  return inspectNpmTool({
    manifestPath: MANIFEST,
    dependencyRoot: overrides?.dependencyRoot ?? DEPS,
    expectedVersion: '1.2.3',
    nodePath: '/runtime/bin/node',
    probe: probeOver({ files, entries }),
  });
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
    expect(codes(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.tool.version).toBe('1.2.3');
    expect(result.tool.cliPath).toBe(`${ROOT}/bin/npm-cli.js`);
    expect(result.tool.modules.map((module) => `${module.id}@${module.version}`)).toEqual([
      'pacote@21.5.1',
      'tar@7.5.22',
    ]);
    expect(result.tool.modules[0]?.entryPath).toBe(`${ROOT}/node_modules/pacote/lib/index.js`);
  });

  it('refuses a manifest that is not there', () => {
    const result = inspectNpmTool({
      manifestPath: '/nowhere/package.json',
      dependencyRoot: DEPS,
      expectedVersion: '1.2.3',
      nodePath: '/runtime/bin/node',
      probe: probeOver({ files: {} }),
    });
    expect(codes(result)).toEqual(['npm_tool_missing']);
  });

  it('refuses a manifest that is not JSON', () => {
    expect(codes(healthyLayout({ manifest: undefined }))).toEqual(['npm_tool_unreadable']);
  });

  /**
   * `JSON.parse` returns `null` for the literal `null`, and casting that to a
   * manifest turned the next property read into a `TypeError` — a crash where
   * a finding belonged. Reported by review as a diagnostic-robustness defect.
   */
  it.each([
    ['null', null],
    ['an array', []],
    ['a number', 42],
    ['a string', 'npm'],
  ])('refuses a manifest that parses to %s, with a finding rather than a throw', (_label, value) => {
    let result: NpmToolResult | undefined;
    expect(() => {
      result = healthyLayout({ manifest: value });
    }).not.toThrow();
    expect(codes(result!)).toEqual(['npm_tool_manifest_shape']);
  });

  it('refuses a reader manifest that parses to null, with a finding rather than a throw', () => {
    let result: NpmToolResult | undefined;
    expect(() => {
      result = healthyLayout({ files: { [`${ROOT}/node_modules/tar/package.json`]: null } });
    }).not.toThrow();
    expect(codes(result!)).toEqual(['npm_module_manifest_shape']);
  });

  it('refuses a package that is not npm, however well formed', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, name: 'npm-check' } });
    expect(codes(result)).toContain('npm_tool_identity');
  });

  /**
   * The spoof that matters most: a real, working npm that is simply not the
   * reviewed one. Nothing about it looks broken, and comparing a tar reader
   * against one npm while publishing through another is precisely the defect
   * this module exists to close.
   */
  it('refuses an npm whose version is not the reviewed pin', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, version: '9.9.9' } });
    expect(codes(result)).toEqual(['npm_tool_version_mismatch']);
    if (result.ok) return;
    expect(result.findings[0]?.message).toMatch(/pins npm 1\.2\.3/u);
  });

  it('refuses a version that is not an exact one', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, version: 'latest' } });
    expect(codes(result)).toEqual(['npm_tool_version_malformed']);
  });

  it('refuses a package outside the workspace dependency root', () => {
    expect(
      codes(healthyLayout({ dependencyRoot: '/elsewhere/node_modules', files: { '/elsewhere/node_modules': {} } })),
    ).toEqual(['npm_tool_not_owned']);
  });

  it('refuses a package declaring no npm CLI', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, bin: { npx: 'bin/npx-cli.js' } } });
    expect(codes(result)).toEqual(['npm_tool_cli_undeclared']);
  });

  it('refuses a CLI the package does not actually carry', () => {
    const result = healthyLayout({ manifest: { ...HEALTHY_MANIFEST, bin: { npm: 'bin/gone.js' } } });
    expect(codes(result)).toEqual(['npm_tool_cli_missing']);
  });

  it('refuses a `bin.npm` that walks out of the package', () => {
    const result = healthyLayout({
      manifest: { ...HEALTHY_MANIFEST, bin: { npm: '../impostor/bin/npm-cli.js' } },
      files: { [`${DEPS}/.pnpm/npm@1.2.3/node_modules/impostor/bin/npm-cli.js`]: {} },
    });
    expect(codes(result)).toEqual(['npm_tool_cli_escapes']);
  });

  it('refuses an absolute `bin.npm`', () => {
    const result = healthyLayout({
      manifest: { ...HEALTHY_MANIFEST, bin: { npm: '/usr/local/bin/impostor.js' } },
      files: { '/usr/local/bin/impostor.js': {} },
    });
    expect(codes(result)).toEqual(['npm_tool_cli_escapes']);
  });

  /**
   * The same escape reached through a symlink rather than a `..` segment: the
   * declared path is unremarkable and stays inside the package, and only its
   * real target is elsewhere. This is why containment is decided on real
   * paths.
   */
  it('refuses a CLI that is a symlink out of the package', () => {
    const outside = '/opt/impostor/npm-cli.js';
    const inner = probeOver({
      files: {
        [DEPS]: {},
        [MANIFEST]: HEALTHY_MANIFEST,
        [outside]: {},
        [`${ROOT}/node_modules/pacote`]: {},
        [`${ROOT}/node_modules/pacote/package.json`]: { name: 'pacote', version: '21.5.1' },
        [`${ROOT}/node_modules/pacote/lib/index.js`]: {},
        [`${ROOT}/node_modules/tar`]: {},
        [`${ROOT}/node_modules/tar/package.json`]: { name: 'tar', version: '7.5.22' },
        [`${ROOT}/node_modules/tar/index.js`]: {},
      },
      entries: {
        [`${MANIFEST}::pacote`]: `${ROOT}/node_modules/pacote/lib/index.js`,
        [`${MANIFEST}::tar`]: `${ROOT}/node_modules/tar/index.js`,
      },
    });
    const result = inspectNpmTool({
      manifestPath: MANIFEST,
      dependencyRoot: DEPS,
      expectedVersion: '1.2.3',
      nodePath: '/runtime/bin/node',
      probe: {
        ...inner,
        // `<root>/bin/npm-cli.js` exists, and points somewhere else entirely.
        realpath: (path) => (path === `${ROOT}/bin/npm-cli.js` ? outside : inner.realpath(path)),
      },
    });
    expect(codes(result)).toEqual(['npm_tool_cli_escapes']);
  });

  it('reports every reason it refused, not just the first', () => {
    const result = healthyLayout({
      manifest: { name: 'not-npm', version: '9.9.9', bin: { npm: 'bin/gone.js' } },
    });
    expect(codes(result)).toEqual(['npm_tool_identity', 'npm_tool_version_mismatch', 'npm_tool_cli_missing']);
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
      expect(isContainedIn(module.directory, module.entryPath)).toBe(true);
    }
  });

  it('takes npm from this repository’s own node_modules', () => {
    const tool = requireNpmTool();
    expect(isContainedIn(join(repoRoot, 'node_modules'), tool.packageRoot)).toBe(true);
    expect(tool.nodePath).toBe(process.execPath);
    expect(describeNpmTool(tool)).toContain(`npm@${tool.version}`);
  });

  /**
   * The layout assertion the original lookup got wrong. Nothing about the
   * proven tool may depend on where the runtime happens to live: under
   * `pnpm/setup` the runtime is a `node` package in a content-addressed store
   * with no npm beside it, and under nvm it is a full distribution with one.
   */
  it('never takes npm from beside the running runtime', () => {
    const tool = requireNpmTool();
    expect(isContainedIn(dirname(dirname(process.execPath)), tool.packageRoot)).toBe(false);
  });

  it('loads the real pacote and tar out of the proven npm', () => {
    const tool = requireNpmTool();
    for (const id of REQUIRED_NPM_MODULES) {
      const loaded = loadNpmModule(tool, id);
      expect(loaded, `${id} must load`).toBeTruthy();
    }
  });

  it('runs the proven CLI on this runtime rather than a PATH lookup', () => {
    const tool = requireNpmTool();
    const { command, args } = npmCommand(tool, ['publish', 'x.tgz', '--provenance']);
    expect(command).toBe(process.execPath);
    expect(args).toEqual([tool.cliPath, 'publish', 'x.tgz', '--provenance']);
  });
});

/**
 * Regression for the defect that produced run 34699256419.
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
