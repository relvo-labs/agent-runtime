#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

type LayerRule = {
  readonly level: number;
  readonly allowed: readonly string[];
};

const RULES: Readonly<Record<string, LayerRule>> = {
  '@relvo-labs/agent-protocol': { level: 0, allowed: [] },
  '@relvo-labs/agent-executor': { level: 1, allowed: ['@relvo-labs/agent-protocol'] },
  '@relvo-labs/agent-provider': { level: 1, allowed: ['@relvo-labs/agent-protocol'] },
  '@relvo-labs/agent-workspace': { level: 1, allowed: ['@relvo-labs/agent-protocol'] },
  '@relvo-labs/agent-provider-codex': {
    level: 2,
    allowed: ['@relvo-labs/agent-protocol', '@relvo-labs/agent-provider'],
  },
  '@relvo-labs/agent-provider-claude': {
    level: 2,
    allowed: ['@relvo-labs/agent-protocol', '@relvo-labs/agent-provider'],
  },
  '@relvo-labs/agent-workspace-git': {
    level: 2,
    allowed: ['@relvo-labs/agent-protocol', '@relvo-labs/agent-workspace'],
  },
  '@relvo-labs/agent-runtime': {
    level: 3,
    allowed: [
      '@relvo-labs/agent-protocol',
      '@relvo-labs/agent-executor',
      '@relvo-labs/agent-provider',
      '@relvo-labs/agent-workspace',
    ],
  },
};

type PackageInfo = {
  readonly name: string;
  readonly directory: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: readonly string[];
};

const repoRoot = resolve(import.meta.dirname, '../..');
const packagesRoot = join(repoRoot, 'packages');
const problems: string[] = [];

function walkTypescript(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTypescript(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const packages = new Map<string, PackageInfo>();
for (const directory of readdirSync(packagesRoot).sort()) {
  const root = join(packagesRoot, directory);
  if (!statSync(root).isDirectory()) continue;
  const manifestPath = join(root, 'package.json');
  let manifest: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    problems.push(`packages/${directory}: missing or invalid package.json`);
    continue;
  }
  if (!manifest.name) {
    problems.push(`packages/${directory}: package name is missing`);
    continue;
  }
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  packages.set(manifest.name, {
    name: manifest.name,
    directory: root,
    dependencies,
    exports: Object.keys(manifest.exports ?? {}),
  });
}

for (const expected of Object.keys(RULES)) {
  if (!packages.has(expected)) problems.push(`required package ${expected} is missing`);
}
for (const actual of packages.keys()) {
  if (RULES[actual] === undefined) problems.push(`package ${actual} has no declared layer rule`);
}

function basePackage(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

const importPattern = /(?:from\s+|import\s*\()\s*['"](@relvo-labs\/[^'"]+)['"]/gu;
const edges = new Map<string, Set<string>>();

for (const info of packages.values()) {
  const rule = RULES[info.name];
  const ownEdges = new Set<string>();
  edges.set(info.name, ownEdges);

  for (const dependency of Object.keys(info.dependencies).filter((name) => name.startsWith('@relvo-labs/'))) {
    ownEdges.add(dependency);
    if (!rule?.allowed.includes(dependency))
      problems.push(`${info.name}: forbidden workspace dependency on ${dependency}`);
    if (!packages.has(dependency)) problems.push(`${info.name}: workspace dependency ${dependency} is absent`);
    const targetRule = RULES[dependency];
    if (rule && targetRule && targetRule.level >= rule.level) {
      problems.push(`${info.name}: dependency ${dependency} does not point to a lower layer`);
    }
  }

  for (const file of walkTypescript(info.directory)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      const dependency = basePackage(specifier);
      if (dependency === info.name) continue;
      if (!(dependency in info.dependencies)) {
        problems.push(`${file.slice(repoRoot.length + 1)}: undeclared workspace import ${specifier}`);
      }
      const target = packages.get(dependency);
      if (!target) {
        problems.push(`${file.slice(repoRoot.length + 1)}: import targets absent package ${dependency}`);
        continue;
      }
      const subpath = `.${specifier.slice(dependency.length)}`;
      if (specifier !== dependency && !target.exports.includes(subpath)) {
        problems.push(`${file.slice(repoRoot.length + 1)}: deep import ${specifier} is not a declared export`);
      }
      if (!rule?.allowed.includes(dependency)) {
        problems.push(`${file.slice(repoRoot.length + 1)}: import ${dependency} crosses a forbidden layer`);
      }
    }
  }
}

const visiting = new Set<string>();
const visited = new Set<string>();
function visit(name: string, path: readonly string[]): void {
  if (visiting.has(name)) {
    problems.push(`workspace dependency cycle: ${[...path, name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of edges.get(name) ?? []) visit(dependency, [...path, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of edges.keys()) visit(name, []);

const tsconfig = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8');
const vitest = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
for (const name of packages.keys()) {
  if (!tsconfig.includes(`"${name}"`)) problems.push(`${name}: missing tsconfig paths registration`);
  if (!vitest.includes(`'${name}'`)) problems.push(`${name}: missing Vitest alias registration`);
}

const runtimeSource = walkTypescript(join(packagesRoot, 'runtime'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
if (/@relvo-labs\/agent-provider-(?:codex|claude)/u.test(runtimeSource)) {
  problems.push('@relvo-labs/agent-runtime imports a concrete provider adapter');
}

if (problems.length > 0) {
  for (const problem of [...new Set(problems)].sort()) process.stderr.write(`dag: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`dag: OK — ${String(packages.size)} packages, acyclic neutral layering enforced\n`);
