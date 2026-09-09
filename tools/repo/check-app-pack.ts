#!/usr/bin/env node
/**
 * Packs every workspace package (same set `check-artifacts.ts` packs), then
 * copies `examples/reference-app` — source files only, never a workspace
 * symlink — into an isolated scratch consumer whose `node_modules` resolves
 * every `@relvo-labs/*` import to those packed tarballs, with a clean pnpm
 * store. Proves: the app's own typecheck and build succeed against the
 * *published* declarations (no source alias, no workspace-link-only proof —
 * see `examples/reference-app/tsconfig.json`), and a real HTTP server built
 * from that install actually serves the full scripted lifecycle end to end,
 * including the `@relvo-labs/agent-provider/testing` subpath the scripted
 * lane depends on.
 *
 * Never network beyond the local pnpm store/registry already used by
 * `check-artifacts.ts`; never a model credential; nothing here is committed
 * (scratch directory is removed in a `finally`).
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import ts from 'typescript';

/** This repo's `tsconfig*.json` files use `//` comments — plain `JSON.parse` cannot read them. */
function readJsoncTsconfig(path: string): { compilerOptions: Record<string, unknown>; include: string[] } {
  const raw = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (raw.error !== undefined) {
    throw new Error(`could not read ${path}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, '\n')}`);
  }
  return raw.config as { compilerOptions: Record<string, unknown>; include: string[] };
}

type Manifest = {
  readonly name: string;
  readonly version: string;
};

const repoRoot = resolve(import.meta.dirname, '../..');
const scratchRoot = mkdtempSync(join(tmpdir(), 'relvo-app-pack-'));
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

type ManagedServer = {
  /** Read back from the child's own stdout — never assumed from a fixed port. */
  readonly baseUrl: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Resolved output so far, for diagnostics on failure. */
  output(): string;
  /**
   * Sends SIGTERM, then genuinely waits for the process to exit (bounded),
   * escalating to SIGKILL only if it has not. `ChildProcess#killed` means
   * "a signal was sent", not "the process has exited" — checking it instead
   * of the `exit` event would make the SIGKILL escalation below dead code.
   */
  stop(): Promise<void>;
};

const READY_LINE = /listening on (http:\/\/\S+)/u;
const SHUTDOWN_GRACE_MS = 3000;

/**
 * Spawns `command`/`args` with `REFERENCE_APP_PORT=0` (an ephemeral port,
 * never a fixed one this script guesses), and resolves only once the child's
 * OWN stdout reports the address it actually bound
 * (`reference-app: listening on http://host:port`, from `src/server.ts`).
 *
 * This is the one property a fixed-port + blind-poll approach cannot
 * guarantee: readiness here is correlated to *this* spawned process, not to
 * whatever happens to answer on a guessed port. If this process's port were
 * ever already in use, `server.ts`'s own `listen()` would reject and this
 * function rejects too — it never falls back to polling an unrelated
 * listener and reporting a false pass.
 */
async function startManagedServer(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readyDeadlineMs: number;
}): Promise<ManagedServer> {
  const child = spawn(process.execPath, options.args, {
    cwd: options.cwd,
    env: { ...options.env, REFERENCE_APP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exitPromise = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      exited = true;
      resolveExit();
    });
  });

  const baseUrl = await new Promise<string>((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error(`server did not report readiness within ${String(options.readyDeadlineMs)}ms:\n${output}`));
    }, options.readyDeadlineMs);
    function detach(): void {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
    }
    function onData(): void {
      if (settled) return;
      const match = READY_LINE.exec(output);
      if (match === null) return;
      settled = true;
      detach();
      resolveReady(match[1]!);
    }
    function onExit(): void {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error(`server process exited before it reported readiness:\n${output}`));
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData(); // in case the line already arrived before these listeners attached
  });

  return {
    baseUrl,
    child,
    output: () => output,
    async stop(): Promise<void> {
      if (exited) return;
      child.kill('SIGTERM');
      const exitedGracefully = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((r) => {
          setTimeout(() => {
            r(false);
          }, SHUTDOWN_GRACE_MS);
        }),
      ]);
      if (!exitedGracefully) {
        // Harmless if the process exited between the race settling and here
        // (`kill` on an already-gone pid is a no-op, not a throw).
        child.kill('SIGKILL');
        await Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
      }
    },
  };
}

async function main(): Promise<void> {
  const tarballs = new Map<string, string>();
  for (const directory of packageDirectories()) {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', directory, 'package.json'), 'utf8'),
    ) as Manifest;
    command('pnpm', ['--filter', manifest.name, 'pack', '--pack-destination', packedDirectory]);
    const suffix = `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
    tarballs.set(manifest.name, join(packedDirectory, suffix));
  }
  process.stdout.write(`app-pack: packed ${String(tarballs.size)} package tarballs\n`);

  // ---- assemble the isolated consumer -------------------------------------
  const appRoot = resolve(repoRoot, 'examples/reference-app');
  const consumer = join(scratchRoot, 'app-consumer');
  mkdirSync(consumer, { recursive: true });
  cpSync(join(appRoot, 'src'), join(consumer, 'src'), { recursive: true });
  cpSync(join(appRoot, 'public'), join(consumer, 'public'), { recursive: true });
  // Self-contained tsconfigs: the real ones `extends` a path relative to the
  // repository, which does not exist in this scratch copy.
  cpSync(join(repoRoot, 'tsconfig.base.json'), join(consumer, 'tsconfig.base.json'));
  const appTsconfig = readJsoncTsconfig(join(appRoot, 'tsconfig.json'));
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      { extends: './tsconfig.base.json', compilerOptions: appTsconfig.compilerOptions, include: appTsconfig.include },
      null,
      2,
    )}\n`,
  );
  const appTsconfigBuild = readJsoncTsconfig(join(appRoot, 'tsconfig.build.json'));
  writeFileSync(
    join(consumer, 'tsconfig.build.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: appTsconfigBuild.compilerOptions,
        include: appTsconfigBuild.include,
      },
      null,
      2,
    )}\n`,
  );

  const dependencies: Record<string, string> = {};
  for (const [name, tarball] of tarballs) {
    if (name.startsWith('@relvo-labs/agent-')) dependencies[name] = `file:${tarball}`;
  }
  // Only the packages the app actually declares — proves no undeclared
  // transitive import slipped in, the same property `dag:check` proves for
  // the workspace itself.
  const appManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const declaredDependencies: Record<string, string> = {};
  for (const name of Object.keys(appManifest.dependencies)) {
    const tarball = dependencies[name];
    if (tarball === undefined) throw new Error(`app-pack: no packed tarball for declared dependency ${name}`);
    declaredDependencies[name] = tarball;
  }
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'relvo-packed-app-consumer',
        private: true,
        type: 'module',
        dependencies: declaredDependencies,
        // `tsconfig.base.json` sets `types: ["node"]`; this is the only thing
        // this scratch consumer needs beyond the packed tarballs themselves,
        // and it is not published by this repository — mirrors the pin
        // `tools/repo/check-artifacts.ts` already uses for the same reason.
        devDependencies: { '@types/node': '22.20.1' },
      },
      null,
      2,
    )}\n`,
  );
  // The `overrides` map must cover every packed package, not only the ones
  // this app declares directly: `@relvo-labs/agent-runtime` itself depends on
  // `@relvo-labs/agent-executor`, which is real, required, and otherwise
  // unresolvable (it is not published to any registry) — an override applies
  // wherever a name is found in the graph, direct or transitive.
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
  process.stdout.write('app-pack: installed against packed tarballs in a clean store\n');

  // ---- typecheck / build, outside any workspace source resolution --------
  command('pnpm', ['exec', 'tsc', '--project', join(consumer, 'tsconfig.json')]);
  command('pnpm', ['exec', 'tsc', '--project', join(consumer, 'tsconfig.build.json')]);
  process.stdout.write('app-pack: typecheck and build OK against packed declarations (no source alias)\n');

  // ---- serve static assets + real scripted HTTP lifecycle -----------------
  const workspaceBase = join(scratchRoot, 'workspaces');
  const server = await startManagedServer({
    args: ['src/server.ts'],
    cwd: consumer,
    env: { ...process.env, REFERENCE_APP_HOST: '127.0.0.1', REFERENCE_APP_WORKSPACE_BASE: workspaceBase },
    readyDeadlineMs: 10_000,
  });

  try {
    const base = server.baseUrl;
    const csrf = { 'content-type': 'application/json', 'x-relvo-reference-app': '1' };
    const asset = await fetch(`${base}/`);
    if (asset.status !== 200) throw new Error(`app-pack: static index did not serve, got ${String(asset.status)}`);

    const opened = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: csrf,
      body: JSON.stringify({ commandId: 'app-pack-open-1', providerId: 'scripted-demo' }),
    });
    const openedBody = (await opened.json()) as { receipt: { disposition: string; result: { sessionId: string } } };
    if (openedBody.receipt.disposition !== 'applied') {
      throw new Error(`app-pack: open_session did not apply: ${JSON.stringify(openedBody)}`);
    }
    const sessionId = openedBody.receipt.result.sessionId;

    const submitted = await fetch(`${base}/api/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: csrf,
      body: JSON.stringify({ commandId: 'app-pack-turn-1', text: 'packaging smoke' }),
    });
    const submittedBody = (await submitted.json()) as { receipt: { disposition: string } };
    if (submittedBody.receipt.disposition !== 'applied') {
      throw new Error(`app-pack: submit_turn did not apply: ${JSON.stringify(submittedBody)}`);
    }

    const advanced = await fetch(`${base}/api/sessions/${sessionId}/advance-script`, {
      method: 'POST',
      headers: { 'x-relvo-reference-app': '1' },
    });
    const advancedBody = (await advanced.json()) as { snapshot: { runs: { state: string }[] } };
    if (advancedBody.snapshot.runs[0]?.state !== 'succeeded') {
      throw new Error(`app-pack: scripted run did not succeed: ${JSON.stringify(advancedBody)}`);
    }

    const closed = await fetch(`${base}/api/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: csrf,
      body: JSON.stringify({ commandId: 'app-pack-close-1' }),
    });
    const closedBody = (await closed.json()) as { receipt: { disposition: string } };
    if (closedBody.receipt.disposition !== 'applied') {
      throw new Error(`app-pack: close_session did not apply: ${JSON.stringify(closedBody)}`);
    }
    process.stdout.write(
      'app-pack: OK — served static assets and a full scripted open→turn→advance→close HTTP lifecycle from the packed install\n',
    );
  } catch (error) {
    process.stderr.write(`app-pack: server output was:\n${server.output()}\n`);
    throw error;
  } finally {
    // Genuinely awaited — including the SIGKILL escalation if needed — so the
    // process is truly gone (not merely signalled) before this function
    // returns and the outer `finally` below removes the workspace directory
    // it may still be holding a handle into.
    await server.stop();
  }
}

try {
  await main();
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
