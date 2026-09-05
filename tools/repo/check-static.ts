#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

for (const packageName of ['provider-codex', 'provider-claude']) {
  const source = readFileSync(resolve(repoRoot, `packages/${packageName}/src/index.ts`), 'utf8');
  if (/node:child_process|\bfetch\s*\(|spawn\s*\(|exec\s*\(/u.test(source)) {
    problems.push(`packages/${packageName}: scaffold contains live integration behavior`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`static: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `static: OK — ${String(files.length)} candidate files scanned; adapter scaffolds remain non-live\n`,
);
