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
 * and resolved the same way in both places: through this repository's own
 * module graph.
 *
 * Everything below is a refusal, never a repair. There is no fallback to
 * `PATH`, no environment variable that can redirect the lookup, and no
 * "close enough" npm: an unresolvable, malformed, mislocated or
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

export type BundledModule = {
  readonly id: string;
  /** Real path of the module's own `package.json`, inside the npm package. */
  readonly manifestPath: string;
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
 * the package, a `pacote` that resolves to some other copy — are unit tests
 * rather than claims. Each member throws on failure, the way the builtin it
 * stands for does.
 */
export type NpmToolProbe = {
  readonly realpath: (path: string) => string;
  readonly readJson: (path: string) => unknown;
  readonly isFile: (path: string) => boolean;
  /** Resolves `<id>/package.json` the way `require` would from `fromManifest`. */
  readonly resolveModuleManifest: (fromManifest: string, id: string) => string;
};

export const nodeProbe: NpmToolProbe = {
  realpath: (path) => realpathSync(path),
  readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  isFile: (path) => statSync(path).isFile(),
  resolveModuleManifest: (fromManifest, id) => createRequire(fromManifest).resolve(`${id}/package.json`),
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
 * Validate a candidate npm installation against the reviewed pin.
 *
 * Pure apart from the injected probe. Returns every reason it refused rather
 * than the first, because "npm is wrong here" is a bootstrap problem and the
 * operator reading it is usually looking at a runner they cannot poke at.
 */
export function inspectNpmTool(input: {
  readonly manifestPath: string;
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
          message: `the npm package manifest ${input.manifestPath} does not exist; run \`pnpm install --frozen-lockfile\` — npm is a pinned devDependency of this workspace, not something inherited from the runtime or PATH`,
        },
      ],
    };
  }

  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = probe.readJson(manifestPath) as { name?: unknown; version?: unknown; bin?: unknown };
  } catch {
    return {
      ok: false,
      findings: [{ code: 'npm_tool_unreadable', message: `${manifestPath} could not be read as JSON` }],
    };
  }

  const packageRoot = dirname(manifestPath);

  if (manifest.name !== 'npm') {
    findings.push({
      code: 'npm_tool_identity',
      message: `${manifestPath} declares name \`${typeof manifest.name === 'string' ? manifest.name : '<absent>'}\`, not \`npm\``,
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
  const binField = manifest.bin;
  const declaredCli =
    typeof binField === 'object' && binField !== null && !Array.isArray(binField)
      ? (binField as Record<string, unknown>).npm
      : undefined;
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

  // The differential test compares against npm's *own* readers. A `pacote` or
  // `tar` that resolves outside the npm package is some other copy — possibly
  // a different major — and comparing against it would prove nothing about
  // what npm does with these bytes.
  const modules: BundledModule[] = [];
  for (const id of input.modules ?? REQUIRED_NPM_MODULES) {
    let resolved: string;
    try {
      resolved = probe.realpath(probe.resolveModuleManifest(manifestPath, id));
    } catch {
      findings.push({
        code: 'npm_module_unresolvable',
        message: `\`${id}\` cannot be resolved from ${manifestPath}; this npm does not bundle the reader the differential test compares against`,
      });
      continue;
    }
    if (!isContainedIn(packageRoot, resolved)) {
      findings.push({
        code: 'npm_module_escapes',
        message: `\`${id}\` resolves to ${resolved}, outside the npm package at ${packageRoot}; the comparison must use npm's own bundled copy, not another one that happens to be installed`,
      });
      continue;
    }
    let moduleVersion: string | undefined;
    try {
      const moduleManifest = probe.readJson(resolved) as { name?: unknown; version?: unknown };
      if (moduleManifest.name !== id) {
        findings.push({
          code: 'npm_module_identity',
          message: `${resolved} declares name \`${typeof moduleManifest.name === 'string' ? moduleManifest.name : '<absent>'}\`, not \`${id}\``,
        });
        continue;
      }
      moduleVersion = readVersion(moduleManifest.version);
    } catch {
      findings.push({ code: 'npm_module_unreadable', message: `${resolved} could not be read as JSON` });
      continue;
    }
    if (moduleVersion === undefined) {
      findings.push({ code: 'npm_module_version_malformed', message: `${resolved} declares no exact version` });
      continue;
    }
    modules.push({ id, manifestPath: resolved, version: moduleVersion });
  }

  if (findings.length > 0 || version === undefined || cliPath === undefined) {
    return { ok: false, findings };
  }
  return { ok: true, tool: { packageRoot, manifestPath, version, cliPath, nodePath, modules } };
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

/** Resolve and prove the tool, or return every reason it was refused. */
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

  // Resolved through this repository's own module graph — the one the lockfile
  // describes and `verify-deps-before-run=true` re-checks — so an npm that is
  // merely present on the machine can never satisfy it.
  let manifestPath: string;
  try {
    manifestPath = probe.resolveModuleManifest(join(root, 'package.json'), 'npm');
  } catch {
    return {
      ok: false,
      findings: [
        {
          code: 'npm_tool_unresolvable',
          message: `npm is not resolvable from ${root}; run \`pnpm install --frozen-lockfile\`. This repository never falls back to an npm on PATH: the differential test and the publisher must use the pinned package or refuse`,
        },
      ],
    };
  }

  return inspectNpmTool({ manifestPath, expectedVersion: pinned.version, nodePath: process.execPath, probe });
}

/** `locateNpmTool`, as a throwing accessor for callers that cannot continue. */
export function requireNpmTool(options?: { readonly repoRoot?: string; readonly probe?: NpmToolProbe }): NpmTool {
  const result = locateNpmTool(options);
  if (result.ok) return result.tool;
  throw new Error(
    `npm tool identity could not be proven:\n${result.findings.map((finding) => `  - [${finding.code}] ${finding.message}`).join('\n')}`,
  );
}

/** A `require` rooted in the proven npm package, for loading its own modules. */
export function requireFromNpmTool(tool: NpmTool): ReturnType<typeof createRequire> {
  return createRequire(tool.manifestPath);
}
