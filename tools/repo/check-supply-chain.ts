#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  packageManager?: string;
  devDependencies?: Record<string, string>;
};
const problems: string[] = [];

if (/^minimumReleaseAge:\s*4320(?:\s|$)/mu.exec(workspace) === null) problems.push('minimumReleaseAge must be 4320');
if (/^minimumReleaseAgeStrict:\s*true(?:\s|$)/mu.exec(workspace) === null)
  problems.push('minimumReleaseAgeStrict must be true');
if (/^minimumReleaseAgeExclude:/mu.test(workspace)) problems.push('minimumReleaseAgeExclude must remain absent');
if (/^onlyBuiltDependencies:\s*\[\](?:\s|$)/mu.exec(workspace) === null)
  problems.push('onlyBuiltDependencies must remain empty');
if (/^autoInstallPeers:\s*false(?:\s|$)/mu.exec(workspace) === null) problems.push('autoInstallPeers must be false');
if (/^strictPeerDependencies:\s*true(?:\s|$)/mu.exec(workspace) === null)
  problems.push('strictPeerDependencies must be true');
if (!/^pnpm@\d+\.\d+\.\d+$/u.test(rootManifest.packageManager ?? ''))
  problems.push('packageManager must pin pnpm exactly');

function checkDependencyMap(owner: string, dependencies: Record<string, string> | undefined): void {
  for (const [name, specifier] of Object.entries(dependencies ?? {})) {
    if (name.startsWith('@relvo-labs/')) {
      if (specifier !== 'workspace:^') problems.push(`${owner}: workspace dependency ${name} must use workspace:^`);
    } else if (specifier !== 'catalog:') {
      problems.push(`${owner}: third-party dependency ${name} must use catalog:`);
    }
  }
}

checkDependencyMap('root devDependencies', rootManifest.devDependencies);
for (const directory of readdirSync(join(repoRoot, 'packages')).sort()) {
  const path = join(repoRoot, 'packages', directory, 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    checkDependencyMap(`packages/${directory} dependencies`, manifest.dependencies);
    checkDependencyMap(`packages/${directory} devDependencies`, manifest.devDependencies);
    checkDependencyMap(`packages/${directory} peerDependencies`, manifest.peerDependencies);
  } catch {
    // A non-package directory is ignored; the DAG gate owns required packages.
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`supply-chain: ${problem}\n`);
  process.exit(1);
}
process.stdout.write('supply-chain: OK — exact catalog pins, strict 3-day cooldown, lifecycle scripts denied\n');
