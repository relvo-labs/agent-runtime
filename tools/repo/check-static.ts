#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../..');
const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (tracked.status !== 0) throw new Error(tracked.stderr || 'git ls-files failed');

const files = tracked.stdout
  .split('\n')
  .filter(Boolean)
  .filter((path) => !path.startsWith('packages/protocol/schemas/') && path !== 'pnpm-lock.yaml' && path !== 'LICENSE');
const secretPatterns: readonly [string, RegExp][] = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['provider token', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['assigned secret', /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\n]{8,}['"]/iu],
];
const problems: string[] = [];

for (const file of files) {
  if (/\.(?:png|jpe?g|gif|webp|log)$/iu.test(file) || /(?:completion-report|runtime-log)/iu.test(file)) {
    problems.push(`${file}: generated report, screenshot, or log artifact is not allowed`);
    continue;
  }
  let source: string;
  try {
    source = readFileSync(resolve(repoRoot, file), 'utf8');
  } catch {
    continue;
  }
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(source)) problems.push(`${file}: suspicious ${label} pattern`);
  }
}

// ---------------------------------------------------------------------------
// Adapter boundaries
// ---------------------------------------------------------------------------
//
// The Codex package is still an explicit scaffold: it must contain no live
// integration behaviour at all.

for (const packageName of ['provider-codex']) {
  const source = readFileSync(resolve(repoRoot, `packages/${packageName}/src/index.ts`), 'utf8');
  if (/node:child_process|\bfetch\s*\(|spawn\s*\(|exec\s*\(/u.test(source)) {
    problems.push(`packages/${packageName}: scaffold contains live integration behavior`);
  }
}

// The Claude package is live, so the assertion changes shape rather than
// disappearing. Two invariants keep it honest:
//
//   1. Control paths stay structured. The adapter drives the SDK's message
//      API; it must never grow a pseudo-terminal, a spawned CLI or ANSI
//      scraping of its own.
//   2. The SDK stays an optional peer resolved at runtime. A static import
//      would make a proprietary, ~200 MB dependency mandatory for every
//      consumer and would put it in the published runtime closure.

const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Terminal-control detection.
 *
 * Matching call sites alone is not enough: an alias hides them
 * (`import { exec as run } from 'child_process'`). The module specifier is the
 * part that cannot be renamed away, so that is what this matches — bare and
 * `node:`-prefixed, static import, dynamic import and require alike — alongside
 * the call shapes and ANSI escapes that would indicate scraping.
 */
function terminalControlIn(source: string): boolean {
  const processModule = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/u;
  const ptyModule = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node-pty|@lydell\/node-pty)['"]/u;
  const callShape = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/u;
  const ansiEscape = /\\u001[bB]\[|\\x1[bB]\[/u;
  return processModule.test(source) || ptyModule.test(source) || callShape.test(source) || ansiEscape.test(source);
}

// The detector is itself checked, so a future edit cannot silently relax it.
// A probe that stops failing is a validator that stopped validating.
const TERMINAL_CONTROL_PROBES: readonly { readonly source: string; readonly detected: boolean }[] = [
  { source: "import { exec as run } from 'child_process';", detected: true },
  { source: "import { spawn } from 'node:child_process';", detected: true },
  { source: "const cp = await import('child_process');", detected: true },
  { source: "const { execFile: go } = require('node:child_process');", detected: true },
  { source: "import pty from 'node-pty';", detected: true },
  { source: 'child.stdout.write("\\u001b[2J");', detected: true },
  { source: 'const result = spawnSync(argv);', detected: true },
  { source: "import { query } from '@anthropic-ai/claude-agent-sdk';", detected: false },
  { source: "import { isAbsolute } from 'node:path';", detected: false },
  { source: 'const handle = query({ prompt, options });', detected: false },
];
for (const probe of TERMINAL_CONTROL_PROBES) {
  if (terminalControlIn(probe.source) !== probe.detected) {
    problems.push(
      `terminal-control detector regressed: \`${probe.source}\` should ${probe.detected ? '' : 'not '}be detected`,
    );
  }
}

for (const file of files.filter((path) => path.startsWith('packages/provider-claude/src/'))) {
  const source = readFileSync(resolve(repoRoot, file), 'utf8');
  if (terminalControlIn(source)) {
    problems.push(`${file}: claude adapter must drive the SDK, not a terminal or a child process`);
  }
  if (new RegExp(String.raw`(?:from|import)\s*\(?\s*['"]${CLAUDE_SDK_PACKAGE}['"]`, 'u').test(source)) {
    problems.push(`${file}: ${CLAUDE_SDK_PACKAGE} must stay an optional peer resolved at runtime`);
  }
}

const claudeManifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages/provider-claude/package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
if (claudeManifest.dependencies?.[CLAUDE_SDK_PACKAGE] !== undefined) {
  problems.push(`packages/provider-claude: ${CLAUDE_SDK_PACKAGE} must not be a runtime dependency`);
}
if (claudeManifest.peerDependencies?.[CLAUDE_SDK_PACKAGE] === undefined) {
  problems.push(`packages/provider-claude: ${CLAUDE_SDK_PACKAGE} must be declared as a peer dependency`);
}
if (claudeManifest.peerDependenciesMeta?.[CLAUDE_SDK_PACKAGE]?.optional !== true) {
  problems.push(`packages/provider-claude: the ${CLAUDE_SDK_PACKAGE} peer must be optional`);
}

// The adapter documents the SDK line its hand-authored seam was derived from.
// If the catalog pin moves without that constant moving, the package is
// advertising a compatibility claim nobody re-checked.
const workspaceManifest = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const pinned = new RegExp(String.raw`^\s*'${CLAUDE_SDK_PACKAGE}':\s*(\S+)\s*$`, 'mu').exec(workspaceManifest)?.[1];
const declared = /CLAUDE_AGENT_SDK_VERSION = '([^']+)'/u.exec(
  readFileSync(resolve(repoRoot, 'packages/provider-claude/src/provider.ts'), 'utf8'),
)?.[1];
if (pinned === undefined) {
  problems.push(`pnpm-workspace.yaml: ${CLAUDE_SDK_PACKAGE} must carry an exact catalog pin`);
} else if (pinned !== declared) {
  problems.push(
    `packages/provider-claude: CLAUDE_AGENT_SDK_VERSION (${declared ?? 'absent'}) must match the catalog pin (${pinned})`,
  );
}

// ---------------------------------------------------------------------------
// Package-filtered tests must actually run
// ---------------------------------------------------------------------------
//
// `pnpm test` at the workspace root passing says nothing about whether the
// per-package command every skill documents — `pnpm --filter <pkg> test` —
// finds anything. A root-anchored `include` pattern resolves against the
// *package* directory when the package script runs, matches nothing, and
// Vitest exits non-zero. That failure is invisible to the gate's root test
// step, so it is asserted here instead.

const CANONICAL_TEST_SCRIPT = 'vitest run test';

const vitestConfig = (await import(pathToFileURL(join(repoRoot, 'vitest.config.ts')).href)) as {
  readonly default?: { readonly test?: { readonly include?: readonly string[] } };
};
const includePatterns = vitestConfig.default?.test?.include ?? [];
if (includePatterns.length === 0) {
  problems.push('vitest config declares no test include patterns');
}
for (const pattern of includePatterns) {
  if (!pattern.startsWith('**/')) {
    problems.push(
      `vitest include \`${pattern}\` is anchored at the workspace root, ` +
        'so `pnpm --filter <package> test` would match no files',
    );
  }
}

function countTestFiles(directory: string): number {
  let found = 0;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found += countTestFiles(path);
    else if (entry.endsWith('.test.ts')) found += 1;
  }
  return found;
}

for (const directory of readdirSync(join(repoRoot, 'packages')).sort()) {
  const manifestPath = join(repoRoot, 'packages', directory, 'package.json');
  let manifest: { scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, string> };
  } catch {
    continue;
  }
  const script = manifest.scripts?.test;
  if (script !== CANONICAL_TEST_SCRIPT) {
    problems.push(`packages/${directory} test script must be \`${CANONICAL_TEST_SCRIPT}\`, found \`${script ?? ''}\``);
  }
  if (countTestFiles(join(repoRoot, 'packages', directory, 'test')) === 0) {
    problems.push(`packages/${directory} declares a test script but ships no \`test/**/*.test.ts\` file to run`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`static: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `static: OK — ${String(files.length)} candidate files scanned; the codex scaffold remains non-live, ` +
    'the claude adapter stays structured with an optional SDK peer; every package test script is executable\n',
);
