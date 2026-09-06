#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const allowed = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);
const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr || 'pnpm licenses list failed');

const report = JSON.parse(result.stdout) as Readonly<Record<string, readonly { readonly name: string }[]>>;
const denied = Object.entries(report).filter(([license]) => !allowed.has(license));
if (denied.length > 0) {
  for (const [license, packages] of denied) {
    process.stderr.write(`licenses: ${license}: ${packages.map((entry) => entry.name).join(', ')}\n`);
  }
  process.exit(1);
}
const count = Object.values(report).reduce((total, packages) => total + packages.length, 0);
process.stdout.write(`licenses: OK — ${String(count)} production dependency entry, permissive licenses only\n`);
