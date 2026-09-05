#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly provenance?: boolean;
  };
};

const repoRoot = resolve(import.meta.dirname, '../..');
const scratchRoot = mkdtempSync(join(tmpdir(), 'relvo-artifacts-'));
const packedDirectory = join(scratchRoot, 'packed');
mkdirSync(packedDirectory);

function command(program: string, args: readonly string[], cwd = repoRoot): string {
  const result = spawnSync(program, args, { cwd, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`.trim());
  }
  return result.stdout;
}

function packageDirectories(): string[] {
  return readdirSync(join(repoRoot, 'packages'))
    .filter((directory) => {
      try {
        JSON.parse(readFileSync(join(repoRoot, 'packages', directory, 'package.json'), 'utf8')) as Manifest;
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function exportTargets(manifest: Manifest): string[] {
  const targets: string[] = [];
  for (const value of Object.values(manifest.exports)) {
    if (typeof value === 'string') targets.push(value);
    else targets.push(...Object.values(value));
  }
  return targets.filter((target) => target !== './package.json');
}

function inspectTarball(tarball: string): Manifest {
  const files = command('tar', ['-tzf', tarball]).split('\n').filter(Boolean).sort();
  const forbidden = files.filter(
    (file) =>
      file.startsWith('package/src/') ||
      file.startsWith('package/test/') ||
      /(?:^|\/)tsconfig[^/]*\.json$/u.test(file) ||
      file.endsWith('.tsbuildinfo') ||
      file.endsWith('.map') ||
      file.endsWith('.tgz'),
  );
  if (forbidden.length > 0) throw new Error(`${basename(tarball)} contains forbidden files: ${forbidden.join(', ')}`);

  for (const required of ['package/LICENSE', 'package/NOTICE', 'package/README.md', 'package/package.json']) {
    if (!files.includes(required)) throw new Error(`${basename(tarball)} is missing ${required}`);
  }

  const manifest = JSON.parse(command('tar', ['-xOzf', tarball, 'package/package.json'])) as Manifest;
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig.provenance !== true) {
    throw new Error(`${manifest.name} must publish publicly with npm provenance enabled`);
  }
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (typeof value !== 'string' && Object.keys(value)[0] !== 'types') {
      throw new Error(`${manifest.name} export ${subpath} must put the types condition first`);
    }
  }
  for (const target of exportTargets(manifest)) {
    const archived = `package/${target.replace(/^\.\//u, '')}`;
    if (!files.includes(archived))
      throw new Error(`${manifest.name} export target ${target} is absent from its tarball`);
  }
  return manifest;
}

try {
  const tarballs = new Map<string, string>();
  for (const directory of packageDirectories()) {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', directory, 'package.json'), 'utf8'),
    ) as Manifest;
    command('pnpm', ['--filter', manifest.name, 'pack', '--pack-destination', packedDirectory]);
    const suffix = `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
    const tarball = join(packedDirectory, suffix);
    const packedManifest = inspectTarball(tarball);
    if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
      throw new Error(`${manifest.name} tarball identity does not match its source manifest`);
    }
    command('pnpm', ['exec', 'publint', 'run', tarball, '--strict']);
    command('pnpm', ['exec', 'attw', tarball, '--profile', 'esm-only', '--no-emoji', '--no-color']);
    tarballs.set(manifest.name, tarball);
    process.stdout.write(`artifacts: ${manifest.name} pack/publint/ATTW OK\n`);
  }

  const consumer = join(scratchRoot, 'consumer');
  mkdirSync(join(consumer, 'src'), { recursive: true });
  cpSync(join(repoRoot, 'examples/consumer-smoke/src/index.ts'), join(consumer, 'src/index.ts'));
  cpSync(join(repoRoot, 'examples/consumer-smoke/tsconfig.json'), join(consumer, 'tsconfig.json'));

  const dependencies: Record<string, string> = {};
  for (const [name, tarball] of tarballs) dependencies[name] = `file:${tarball}`;
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'relvo-packed-consumer',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: { '@types/node': '22.20.1' },
      },
      null,
      2,
    )}\n`,
  );
  const overrideLines = Object.entries(dependencies).map(([name, tarball]) => `  '${name}': '${tarball}'`);
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), `packages:\n  - .\noverrides:\n${overrideLines.join('\n')}\n`);

  const cleanStore = join(scratchRoot, 'store');
  command('pnpm', [
    '--dir',
    consumer,
    'install',
    '--store-dir',
    cleanStore,
    '--ignore-scripts',
    '--frozen-lockfile=false',
  ]);
  command('pnpm', ['exec', 'tsc', '--project', join(consumer, 'tsconfig.json')]);
  command(
    'node',
    [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify([...tarballs.keys()])}.map((name) => import(name)));`,
    ],
    consumer,
  );
  process.stdout.write(
    `artifacts: OK — ${String(tarballs.size)} tarballs installed, typed, and imported from a clean store\n`,
  );
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
