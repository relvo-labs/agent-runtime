#!/usr/bin/env node

import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
for (const directory of readdirSync(join(repoRoot, 'packages')).sort()) {
  rmSync(join(repoRoot, 'packages', directory, 'dist'), { recursive: true, force: true });
  rmSync(join(repoRoot, 'packages', directory, 'tsconfig.tsbuildinfo'), { force: true });
}
rmSync(join(repoRoot, 'coverage'), { recursive: true, force: true });
rmSync(join(repoRoot, 'tsconfig.build.tsbuildinfo'), { force: true });
process.stdout.write('clean: removed generated dist, coverage, and tsbuildinfo artifacts\n');
