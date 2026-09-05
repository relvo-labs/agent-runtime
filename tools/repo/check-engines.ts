#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const expected = '^22.18.0 || ^24.11.0 || ^26.0.0';
const problems: string[] = [];
const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setup = 'pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b';

const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } };
if (root.engines?.node !== expected) problems.push(`root engines.node must be ${expected}`);

for (const directory of readdirSync(join(repoRoot, 'packages')).sort()) {
  const path = join(repoRoot, 'packages', directory, 'package.json');
  let manifest: { engines?: { node?: string } };
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
  } catch {
    continue;
  }
  if (manifest.engines?.node !== expected) problems.push(`packages/${directory} engines.node must be ${expected}`);
}

const workflow = readFileSync(join(repoRoot, '.github/workflows/gate.yml'), 'utf8');
for (const version of ['22.18.0', '24.20.0', '26.8.1']) {
  if (!workflow.includes(version)) problems.push(`CI matrix must include Node ${version}`);
}
if (/node-version:\s*['"]?20(?:\.|['"\s])/u.test(workflow) || /\bNode 20\b/u.test(workflow)) {
  problems.push('Node 20 must not be configured or claimed');
}
if (!workflow.includes('push:\n    branches: [main]\n  pull_request:')) {
  problems.push('CI must run on pushes to main and on pull requests only');
}
if (!workflow.includes('timeout-minutes: 30')) problems.push('CI gate must set timeout-minutes: 30');
if (!workflow.includes(checkout)) problems.push(`CI checkout must use ${checkout}`);
if (!workflow.includes('persist-credentials: false')) {
  problems.push('CI checkout must disable persisted credentials');
}
if (!workflow.includes(setup)) problems.push(`CI toolchain must use ${setup}`);
for (const input of [
  'version: 11.25.0',
  'runtime: node@${{ matrix.node }}',
  'cache: true',
  'require-lockfile: true',
  'install: false',
]) {
  if (!workflow.includes(input)) problems.push(`CI pnpm/setup input is missing: ${input}`);
}
if (/actions\/setup-node|corepack/iu.test(workflow)) {
  problems.push('CI must not depend on actions/setup-node or Corepack');
}
if (!workflow.includes('pnpm install --frozen-lockfile') || !workflow.includes('run: pnpm gate')) {
  problems.push('CI must perform a frozen install and run the canonical gate');
}
for (const match of workflow.matchAll(/^\s*-\s+uses:\s+(\S+)/gmu)) {
  if (!/@[0-9a-f]{40}$/u.test(match[1] ?? '')) {
    problems.push(`CI action must use an immutable SHA: ${match[1] ?? '<missing>'}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`engines: ${problem}\n`);
  process.exit(1);
}
process.stdout.write('engines: OK — Node 22/24/26 bounded support, immutable CI bootstrap, no Node 20/27 claim\n');
