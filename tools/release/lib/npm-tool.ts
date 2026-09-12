/**
 * The one npm this repository uses, proven before it is used.
 *
 * Two things here need an npm, and they are only meaningful together:
 *
 *   - `pacote-differential.test.ts` reads packed artifacts with npm's own
 *     `pacote`/`tar` and asserts that this repository never disagrees with it
 *     about what an archive *is*;
 *   - `publish.ts` hands those same bytes to `npm publish`.
 *
 * The whole differential argument rests on those being the *same* npm. Before
 * this module they were not, and on a runner neither one was what it claimed:
 *
 *   - the test located npm by guessing at `process.execPath`'s neighbours
 *     (`../lib/node_modules/npm`, `./node_modules/npm`). That is the layout of
 *     an official Node distribution — nvm, a `.pkg`, a distro package. It is
 *     *not* the layout `pnpm/setup` produces: `pnpm runtime set node <version>`
 *     installs the `node` package, whose entire payload is the `node` binary,
 *     at `…/store/v11/links/@/node/<version>/<hash>/node_modules/node/bin/node`.
 *     No npm ships anywhere near it, so the suite failed to load and the gate
 *     step it belongs to could not run (run 34699256419);
 *   - `publish.ts` spawned bare `npm`, resolved through `PATH`. On a runner
 *     that is the image's preinstalled Node's npm — a different program from
 *     the one any developer's differential run compared against, and one
 *     nothing in this repository pins, locks or reviews.
 *
 * So the test proved a property about npm A while publication used npm B, and
 * the layout that broke the test is exactly the layout that made B arbitrary.
 * The fix is one npm, pinned in the catalog, locked with an integrity hash,
 * and located the same way in both places: at this repository's own explicit
 * dependency path.
 *
 * **Located, not resolved.** An independent review broke the first version of
 * this module twice, and both defects were the same mistake — asking Node's
 * resolver a question and treating its answer as proof:
 *
 *   - `createRequire(<repo>/package.json).resolve('npm/package.json')` does not
 *     mean "this repository's npm". It walks every ancestor `node_modules` and
 *     then `NODE_PATH`. With no npm installed in the workspace at all, a
 *     matching npm one directory up — or anywhere `NODE_PATH` points — was
 *     accepted as the publishing tool. npm is therefore taken from exactly
 *     `<repoRoot>/node_modules/npm`, and its real path must be owned by
 *     `<repoRoot>/node_modules`. There is no search and no fallback;
 *   - containment was checked on each reader's `package.json` and nothing else,
 *     while the loader then handed out an unrestricted `require`. A bundled
 *     `pacote` whose `main` was `../../../../outside.cjs`, or whose `exports`
 *     entry was a symlink out of the tree, passed inspection and then loaded
 *     code from outside npm. The *entry point* `require` would actually load is
 *     now resolved, realpath'd, confined to that module's own directory and
 *     recorded; `loadNpmModule` loads that exact validated file and refuses any
 *     id that was not declared and proven here.
 *
 * Everything below is a refusal, never a repair. There is no fallback to
 * `PATH`, no ancestor search, no `NODE_PATH`, no environment override and no
 * "close enough" npm: an unresolvable, malformed, mislocated, unowned or
 * wrong-versioned tool fails the caller rather than being worked around. A
 * differential test that silently compares against something else, and a
 * publication that silently uploads through something else, are the two
 * failures this module exists to make impossible.
 */

import { createRequire } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The modules the differential test loads out of npm. Order is reported order. */
export const REQUIRED_NPM_MODULES: readonly string[] = ['pacote', 'tar'];

/** The directory a workspace dependency must physically live under. */
const DEPENDENCY_DIRECTORY = 'node_modules';

export type BundledModule = {
  readonly id: string;
  /** Real path of the module's own `package.json`, inside the npm package. */
  readonly manifestPath: string;
  /** Real path of the module's directory, inside the npm package. */
  readonly directory: string;
  /**
   * Real path of the file `require(id)` resolves to — validated, and the only
   * thing `loadNpmModule` will load. Checking the manifest and then loading
   * whatever `main`/`exports` points at is how code outside npm got in.
   */
  readonly entryPath: string;
  readonly version: string;
};

export type NpmTool = {
  /** Real path of the npm package directory. */
  readonly packageRoot: string;
  /** Real path of `<packageRoot>/package.json`. */
  readonly manifestPath: string;
  /** The exact version, which must equal the reviewed catalog pin. */
  readonly version: string;
  /** Real path of the CLI entry point this repository spawns to publish. */
  readonly cliPath: string;
  /** The runtime that will execute `cliPath`; never a `PATH` lookup. */
  readonly nodePath: string;
  readonly modules: readonly BundledModule[];
};

export type NpmToolFinding = { readonly code: string; readonly message: string };

export type NpmToolResult =
  { readonly ok: true; readonly tool: NpmTool } | { readonly ok: false; readonly findings: readonly NpmToolFinding[] };

/**
 * The filesystem and resolver boundary, as one injectable record.
 *
 * Every refusal below is reachable through a substituted probe, so the
 * negative cases — a manifest that is not npm's, a `bin` entry pointing out of
 * the package, a reader entry point that escapes it — are unit tests rather
 * than claims. Each member throws on failure, the way the builtin it stands
 * for does.
 */
export type NpmToolProbe = {
  readonly realpath: (path: string) => string;
  readonly readJson: (path: string) => unknown;
  readonly isFile: (path: string) => boolean;
  /**
   * The file `require(id)` would load, resolved from `fromManifest`.
   *
   * This is the only resolver call left, it is made *after* the module's own
   * directory has been located explicitly, and its answer is confined to that
   * directory before it is used. It exists because `main`, `exports` and their
   * conditions decide the entry point, and reimplementing that decision here
   * would be a second, subtly different resolver.
   */
  readonly resolveModuleEntry: (fromManifest: string, id: string) => string;
};

export const nodeProbe: NpmToolProbe = {
  realpath: (path) => realpathSync(path),
  readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  isFile: (path) => statSync(path).isFile(),
  resolveModuleEntry: (fromManifest, id) => createRequire(fromManifest).resolve(id),
};

/** `child` is `parent` itself or lives underneath it. Both must be real paths. */
export function isContainedIn(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function readVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(value) ? value : undefined;
}

/**
 * A parsed manifest, or nothing.
 *
 * `JSON.parse` happily returns `null`, `42` or an array, and casting any of
 * those to a manifest shape turns the next property read into a `TypeError`
 * instead of a finding. A tool whose manifest is not even an object is refused
 * like any other unprovable tool, with a message that says so.
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeName(value: unknown): string {
  return typeof value === 'string' ? value : '<absent>';
}

/**
 * Validate the npm installation at an explicit path against the reviewed pin.
 *
 * Pure apart from the injected probe. Returns every reason it refused rather
 * than the first, because "npm is wrong here" is a bootstrap problem and the
 * operator reading it is usually looking at a runner they cannot poke at.
 */
export function inspectNpmTool(input: {
  /** `<repoRoot>/node_modules/npm/package.json`. Never a resolver's answer. */
  readonly manifestPath: string;
  /** `<repoRoot>/node_modules`; the package's real path must be inside it. */
  readonly dependencyRoot: string;
  readonly expectedVersion: string;
  readonly nodePath: string;
  readonly probe: NpmToolProbe;
  readonly modules?: readonly string[];
}): NpmToolResult {
  const { expectedVersion, nodePath, probe } = input;
  const findings: NpmToolFinding[] = [];

  let manifestPath: string;
  try {
    manifestPath = probe.realpath(input.manifestPath);
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_tool_missing',
          message: `${input.manifestPath} does not exist; run \`pnpm install --frozen-lockfile\` — npm is a pinned devDependency of this workspace, and this is the only place it is read from`,
        },
      ],
    };
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = probe.readJson(manifestPath);
    const object = asObject(parsed);
    if (object === undefined) {
      return {
        ok: false,
        findings: [
          {
            code: 'npm_tool_manifest_shape',
            message: `${manifestPath} does not contain a JSON object (read ${parsed === null ? 'null' : typeof parsed}); it cannot describe the reviewed tool`,
          },
        ],
      };
    }
    manifest = object;
  } catch {
    return {
      ok: false,
      findings: [{ code: 'npm_tool_unreadable', message: `${manifestPath} could not be read as JSON` }],
    };
  }

  const packageRoot = dirname(manifestPath);

  // Ownership, not merely presence. `<repoRoot>/node_modules/npm` may be a
  // symlink — under pnpm it always is — but it must land inside this
  // repository's own dependency tree. A link out to a system-wide or ancestor
  // installation is exactly the "npm that happens to be on the machine" this
  // module exists to refuse.
  let dependencyRoot: string | undefined;
  try {
    dependencyRoot = probe.realpath(input.dependencyRoot);
  } catch {
    findings.push({
      code: 'npm_tool_not_owned',
      message: `${input.dependencyRoot} does not exist, so the npm at ${packageRoot} cannot be shown to belong to this workspace`,
    });
  }
  if (dependencyRoot !== undefined && !isContainedIn(dependencyRoot, packageRoot)) {
    findings.push({
      code: 'npm_tool_not_owned',
      message: `${packageRoot} is outside ${dependencyRoot}; the publishing tool must be this workspace's own installed dependency, not one reached from an ancestor directory, NODE_PATH or a link out of the tree`,
    });
  }

  if (manifest.name !== 'npm') {
    findings.push({
      code: 'npm_tool_identity',
      message: `${manifestPath} declares name \`${describeName(manifest.name)}\`, not \`npm\``,
    });
  }

  const version = readVersion(manifest.version);
  if (version === undefined) {
    findings.push({
      code: 'npm_tool_version_malformed',
      message: `${manifestPath} declares no exact version; a tool whose identity cannot be stated cannot be the one that was reviewed`,
    });
  } else if (version !== expectedVersion) {
    findings.push({
      code: 'npm_tool_version_mismatch',
      message: `resolved npm ${version} at ${packageRoot}, but this workspace pins npm ${expectedVersion}; the differential test and the publisher must both use the reviewed pin`,
    });
  }

  // The CLI is taken from the manifest's own `bin` map rather than assumed, and
  // then required to stay inside the package: a `bin` that escapes the package
  // root is how a resolvable "npm" becomes a spawn of something else entirely.
  const binField = asObject(manifest.bin);
  const declaredCli = binField?.npm;
  let cliPath: string | undefined;
  if (typeof declaredCli !== 'string' || declaredCli.trim() === '') {
    findings.push({
      code: 'npm_tool_cli_undeclared',
      message: `${manifestPath} declares no \`bin.npm\` entry; there is no reviewed command to publish with`,
    });
  } else if (isAbsolute(declaredCli)) {
    findings.push({
      code: 'npm_tool_cli_escapes',
      message: `${manifestPath} declares an absolute \`bin.npm\` (${declaredCli}); the CLI must live inside the npm package`,
    });
  } else {
    const candidate = resolve(packageRoot, declaredCli);
    let real: string;
    try {
      real = probe.realpath(candidate);
    } catch {
      findings.push({
        code: 'npm_tool_cli_missing',
        message: `${candidate} does not exist; the resolved npm package carries no CLI entry point`,
      });
      real = '';
    }
    if (real !== '') {
      if (!isContainedIn(packageRoot, real)) {
        findings.push({
          code: 'npm_tool_cli_escapes',
          message: `\`bin.npm\` resolves to ${real}, which is outside the npm package at ${packageRoot}`,
        });
      } else if (!probe.isFile(real)) {
        findings.push({ code: 'npm_tool_cli_missing', message: `${real} is not a file` });
      } else {
        cliPath = real;
      }
    }
  }

  // The differential test compares against npm's *own* readers, so each one is
  // located inside npm, identified, and bound to the entry point it will load.
  const modules: BundledModule[] = [];
  for (const id of input.modules ?? REQUIRED_NPM_MODULES) {
    const inspected = inspectBundledModule({ id, packageRoot, manifestPath, probe });
    if (inspected.ok) modules.push(inspected.module);
    else findings.push(...inspected.findings);
  }

  if (findings.length > 0 || version === undefined || cliPath === undefined) {
    return { ok: false, findings };
  }
  return { ok: true, tool: { packageRoot, manifestPath, version, cliPath, nodePath, modules } };
}

/**
 * One bundled reader: its directory, its manifest and — the part that was
 * missing — the entry point `require` will actually load.
 *
 * The directory is derived, not resolved: npm vendors its dependencies, so a
 * bundled reader lives at `<npm>/node_modules/<id>` or it is not npm's copy.
 * Only the entry point needs the resolver, because `main`, `exports` and their
 * conditions decide it; that answer is then confined to this directory, so a
 * `main` of `../../../../outside.cjs`, an `exports` target symlinked out of the
 * tree, or a traversal into a *sibling* module inside npm are all refused
 * before anything is loaded.
 */
function inspectBundledModule(input: {
  readonly id: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly probe: NpmToolProbe;
}):
  | { readonly ok: true; readonly module: BundledModule }
  | { readonly ok: false; readonly findings: readonly NpmToolFinding[] } {
  const { id, packageRoot, manifestPath, probe } = input;
  const expectedDirectory = join(packageRoot, DEPENDENCY_DIRECTORY, id);

  let directory: string;
  let moduleManifestPath: string;
  try {
    moduleManifestPath = probe.realpath(join(expectedDirectory, 'package.json'));
    directory = probe.realpath(expectedDirectory);
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_module_missing',
          message: `${join(expectedDirectory, 'package.json')} does not exist; this npm does not bundle the \`${id}\` the differential test compares against`,
        },
      ],
    };
  }

  if (!isContainedIn(packageRoot, directory) || dirname(moduleManifestPath) !== directory) {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_module_escapes',
          message: `\`${id}\` resolves to ${directory}, outside the npm package at ${packageRoot}; the comparison must use npm's own bundled copy, not another one that happens to be installed`,
        },
      ],
    };
  }

  let moduleManifest: Record<string, unknown>;
  try {
    const parsed = probe.readJson(moduleManifestPath);
    const object = asObject(parsed);
    if (object === undefined) {
      return {
        ok: false,
        findings: [
          {
            code: 'npm_module_manifest_shape',
            message: `${moduleManifestPath} does not contain a JSON object (read ${parsed === null ? 'null' : typeof parsed})`,
          },
        ],
      };
    }
    moduleManifest = object;
  } catch {
    return {
      ok: false,
      findings: [{ code: 'npm_module_unreadable', message: `${moduleManifestPath} could not be read as JSON` }],
    };
  }

  if (moduleManifest.name !== id) {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_module_identity',
          message: `${moduleManifestPath} declares name \`${describeName(moduleManifest.name)}\`, not \`${id}\``,
        },
      ],
    };
  }

  const version = readVersion(moduleManifest.version);
  if (version === undefined) {
    return {
      ok: false,
      findings: [{ code: 'npm_module_version_malformed', message: `${moduleManifestPath} declares no exact version` }],
    };
  }

  let entryPath: string;
  try {
    entryPath = probe.realpath(probe.resolveModuleEntry(manifestPath, id));
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_module_entry_unresolvable',
          message: `\`require('${id}')\` from ${manifestPath} resolves to nothing loadable; a reader that cannot be loaded cannot be compared against`,
        },
      ],
    };
  }

  if (!isContainedIn(directory, entryPath)) {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_module_entry_escapes',
          message: `\`require('${id}')\` would load ${entryPath}, which is outside ${directory}; \`main\` and \`exports\` are part of a package's identity, so an entry point that leaves its own directory is refused rather than loaded`,
        },
      ],
    };
  }

  if (!probe.isFile(entryPath)) {
    return {
      ok: false,
      findings: [{ code: 'npm_module_entry_unresolvable', message: `${entryPath} is not a file` }],
    };
  }

  return { ok: true, module: { id, manifestPath: moduleManifestPath, directory, entryPath, version } };
}

/**
 * The exact npm version this workspace reviewed, read from the catalog that
 * `pnpm-lock.yaml` resolved and `verify-deps-before-run` re-checks.
 *
 * Read rather than duplicated as a constant: a second copy of the version in
 * TypeScript is a second thing to forget, and the moment the two disagree the
 * check either blocks a reviewed bump or waves through an unreviewed one. The
 * grammar is deliberately narrow and every other spelling is a refusal — this
 * is a one-line lookup, not a YAML parser.
 */
export function readPinnedNpmVersion(
  workspaceYaml: string,
): { readonly ok: true; readonly version: string } | { readonly ok: false; readonly message: string } {
  const matches = [...workspaceYaml.matchAll(/^ {2}npm:[ \t]*(\S+)[ \t]*$/gmu)];
  if (matches.length === 0) {
    return {
      ok: false,
      message: 'pnpm-workspace.yaml declares no `npm:` catalog pin; the release tooling has no reviewed npm to use',
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `pnpm-workspace.yaml declares ${String(matches.length)} \`npm:\` catalog entries; exactly one reviewed pin is required`,
    };
  }
  const version = readVersion(matches[0]?.[1]);
  if (version === undefined) {
    return {
      ok: false,
      message: `pnpm-workspace.yaml pins npm as \`${matches[0]?.[1] ?? '<empty>'}\`, which is not an exact version`,
    };
  }
  return { ok: true, version };
}

export function describeNpmTool(tool: NpmTool): string {
  const modules = tool.modules.map((module) => `${module.id}@${module.version}`).join(', ');
  return `npm@${tool.version} (${tool.cliPath}) on node ${process.version} (${tool.nodePath}); bundled ${modules}`;
}

/**
 * The argv for running the proven tool. The runtime is `process.execPath`, not
 * a `node` found on `PATH`, so the npm that publishes runs on the same Node
 * that verified the artifacts.
 */
export function npmCommand(
  tool: NpmTool,
  argv: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  return { command: tool.nodePath, args: [tool.cliPath, ...argv] };
}

const repoRoot = resolve(import.meta.dirname, '../../..');

/** Locate and prove the tool, or return every reason it was refused. */
export function locateNpmTool(options?: { readonly repoRoot?: string; readonly probe?: NpmToolProbe }): NpmToolResult {
  const root = options?.repoRoot ?? repoRoot;
  const probe = options?.probe ?? nodeProbe;

  let workspaceYaml: string;
  try {
    workspaceYaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return {
      ok: false,
      findings: [{ code: 'workspace_unreadable', message: `cannot read ${join(root, 'pnpm-workspace.yaml')}` }],
    };
  }
  const pinned = readPinnedNpmVersion(workspaceYaml);
  if (!pinned.ok) return { ok: false, findings: [{ code: 'npm_pin_missing', message: pinned.message }] };

  // The workspace must *ask* for npm, not merely have one lying around. The
  // catalog pin says which version is reviewed; this says that this repository
  // is the thing that depends on it, so `pnpm install --frozen-lockfile` is
  // what put it on disk and the lockfile's integrity hash covers it.
  const rootManifestPath = join(root, 'package.json');
  let rootManifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as unknown;
    const object = asObject(parsed);
    if (object === undefined) throw new TypeError('not an object');
    rootManifest = object;
  } catch {
    return {
      ok: false,
      findings: [{ code: 'workspace_unreadable', message: `cannot read ${rootManifestPath} as a JSON object` }],
    };
  }
  const declared = asObject(rootManifest.devDependencies)?.npm;
  if (declared !== 'catalog:') {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_dependency_undeclared',
          message: `${rootManifestPath} does not declare npm as \`devDependencies.npm: "catalog:"\` (found ${typeof declared === 'string' ? `\`${declared}\`` : '<absent>'}); the publishing tool is a reviewed dependency of this workspace or it is refused`,
        },
      ],
    };
  }

  // One explicit path. Not `createRequire(...).resolve('npm/package.json')`,
  // which searches every ancestor `node_modules` and then `NODE_PATH` — a
  // review installed no npm in the workspace at all and had both of those
  // accepted as the publishing tool.
  return inspectNpmTool({
    manifestPath: join(root, DEPENDENCY_DIRECTORY, 'npm', 'package.json'),
    dependencyRoot: join(root, DEPENDENCY_DIRECTORY),
    expectedVersion: pinned.version,
    nodePath: process.execPath,
    probe,
  });
}

/** `locateNpmTool`, as a throwing accessor for callers that cannot continue. */
export function requireNpmTool(options?: { readonly repoRoot?: string; readonly probe?: NpmToolProbe }): NpmTool {
  const result = locateNpmTool(options);
  if (result.ok) return result.tool;
  throw new Error(
    `npm tool identity could not be proven:\n${result.findings.map((finding) => `  - [${finding.code}] ${finding.message}`).join('\n')}`,
  );
}

/**
 * Load one of the readers that was declared, located and validated above.
 *
 * Deliberately not a `require` handed to the caller. An unrestricted require
 * rooted in npm's manifest re-runs resolution at load time, which is where
 * `main` and `exports` get their second chance to point somewhere else; it
 * also lets a caller load anything npm can see rather than the two readers
 * this repository reviewed. This loads the exact real file recorded in the
 * tool, and refuses an id that is not part of it.
 */
export function loadNpmModule(tool: NpmTool, id: string): unknown {
  const module = tool.modules.find((candidate) => candidate.id === id);
  if (module === undefined) {
    throw new Error(
      `\`${id}\` is not one of the validated npm readers (${tool.modules.map((candidate) => candidate.id).join(', ') || '<none>'}); only modules proven by \`locateNpmTool\` may be loaded`,
    );
  }
  return createRequire(tool.manifestPath)(module.entryPath);
}
