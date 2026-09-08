/**
 * The production transport, proven against a **real child process**.
 *
 * Everything else in this package is tested through the injected seam. This
 * file deliberately is not: spawning, argv handling, pipe framing, EOF, exit
 * and signal escalation are exactly the properties a fake cannot demonstrate.
 *
 * The child is a small Node program passed with `-e`, so the suite stays
 * credential-free, network-free, and needs no Codex installation. It speaks the
 * pinned 0.153.4 frame shapes and always terminates.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isProviderRejection } from '@relvo-labs/agent-provider';

import { createCodexProvider } from '../src/index.ts';
import { CODEX_APP_SERVER_ARGV, createCodexStdioTransport } from '../src/transport.ts';
import { createCodexClient, type CodexClientEnd } from '../src/client.ts';

/**
 * A minimal app-server stand-in.
 *
 * It asserts its own argv first: if the adapter had gone through a shell, the
 * arguments would have been re-parsed and this check would fail.
 */
const FAKE_APP_SERVER = `
const MODE = process.env.FAKE_MODE || 'echo';
if (!process.argv.includes('app-server') || !process.argv.includes('--stdio')) {
  process.stderr.write('unexpected argv\\n');
  process.exit(3);
}
if (process.env.EXPECT_CWD && process.cwd() !== process.env.EXPECT_CWD) {
  process.stderr.write('unexpected cwd\\n');
  process.exit(4);
}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const delta = (d) => send({ method: 'item/agentMessage/delta', params: { threadId: 'T1', turnId: 'U1', itemId: 'I1', delta: d } });
const completed = (status) => send({ method: 'turn/completed', params: { threadId: 'T1', turn: { id: 'U1', items: [], itemsView: 'complete', status, error: null } } });

if (MODE === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (MODE === 'noise') {
  // Log-like output on stderr must never be parsed as protocol.
  process.stderr.write('INFO starting app-server\\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
process.stdin.on('end', () => { if (MODE !== 'ignore-term') process.exit(0); });

function handle(message) {
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'linux' } });
      return;
    case 'initialized':
      return;
    case 'thread/start':
      send({ method: 'thread/started', params: { thread: { id: 'T1' } } });
      send({ id: message.id, result: { thread: { id: 'T1', cwd: process.cwd(), turns: [] } } });
      return;
    case 'turn/start': {
      if (MODE === 'exit-on-turn') { process.exit(0); return; }
      send({ id: message.id, result: { turn: { id: 'U1', items: [], itemsView: 'complete', status: 'inProgress', error: null } } });
      if (MODE === 'garbage') {
        // A hostile or newer producer between two valid frames.
        process.stdout.write('this line is not json at all\\n');
        process.stdout.write('{"truncated":\\n');
        process.stdout.write('\\n');
      }
      // Split one frame across two writes to exercise chunk reassembly.
      const framed = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'T1', turnId: 'U1', itemId: 'I1', delta: 'hello ' } }) + '\\n';
      process.stdout.write(framed.slice(0, 20));
      process.stdout.write(framed.slice(20));
      delta('from a real child');
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'T1', turnId: 'U1', tokenUsage: { total: { totalTokens: 99 }, last: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, modelContextWindow: 1000 } } });
      if (MODE === 'hang') return;
      completed('completed');
      return;
    }
    case 'turn/interrupt':
      send({ id: message.id, result: {} });
      // Output already queued when the stop landed.
      delta('[queued after interrupt]');
      completed('interrupted');
      return;
    default:
      return;
  }
}
`;

const scratchRoots: string[] = [];

/** A workspace whose name would be word-split or re-parsed by any shell. */
function hostileWorkspace(): string {
  const base = mkdtempSync(join(tmpdir(), 'relvo-codex-'));
  const root = join(base, 'a dir; touch pwned && echo $HOME');
  // `mkdtemp` already created `base`; create the hostile child directly.
  rmSync(root, { recursive: true, force: true });
  scratchRoots.push(base);
  return root;
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function spawnFake(cwd: string, mode: string, extra: Record<string, string> = {}) {
  return createCodexStdioTransport(
    { cwd },
    {
      executable: process.execPath,
      extraArgs: ['-e', FAKE_APP_SERVER],
      env: { ...process.env, FAKE_MODE: mode, ...extra },
      // Short enough that the escalation test is quick, long enough that a
      // loaded CI machine cannot make the signal round-trip look like a child
      // that refused to die. Only the `ignore-term` case ever waits these out;
      // every other child exits on stdin EOF and returns at the first check.
      closeGraceMs: 300,
      killGraceMs: 5_000,
    },
  );
}

describe('argv and shell safety', () => {
  it('appends exactly `app-server --stdio` to the configured argv', () => {
    expect(CODEX_APP_SERVER_ARGV).toEqual(['app-server', '--stdio']);
  });

  it('passes a workspace path containing shell metacharacters through unchanged', async () => {
    const { mkdirSync } = await import('node:fs');
    const root = hostileWorkspace();
    mkdirSync(root, { recursive: true });

    // The child exits non-zero if its cwd was mangled, which a shell would do.
    const transport = spawnFake(root, 'echo', { EXPECT_CWD: root });
    const ends: CodexClientEnd[] = [];
    const client = createCodexClient(transport, {
      onNotification: () => undefined,
      onServerRequest: () => undefined,
      onDrop: () => undefined,
      onEnd: (end) => ends.push(end),
    });

    await expect(
      client.request('initialize', { clientInfo: { name: 'x', title: null, version: '1' } }),
    ).resolves.toBeDefined();
    const started = (await client.request('thread/start', { cwd: root })) as { thread: { cwd: string } };
    expect(started.thread.cwd).toBe(root);
    await client.close();
  });
});

describe('a real turn over real pipes', () => {
  it('completes a text run end to end through the neutral SPI', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'echo') });
    const events: string[] = [];
    const usage: unknown[] = [];
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });

    const run = await session.startRun({
      input: { parts: [{ type: 'text', text: 'hello; rm -rf / && echo $SECRET' }] },
      runRef: 'run-1',
      sink: {
        emit: (input) => {
          if (input.payload.type === 'run.message_delta') events.push(input.payload.text);
          if (input.payload.type === 'run.usage') usage.push(input.payload.usage);
        },
      },
    });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(events.join('')).toBe('hello from a real child');
    expect(usage).toEqual([{ inputTokens: 3, outputTokens: 4, totalTokens: 7 }]);

    await session.dispose();
  }, 20_000);

  it('interrupts cooperatively and still delivers queued output', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'hang') });
    const text: string[] = [];
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });
    const run = await session.startRun({
      input: { parts: [{ type: 'text', text: 'work forever' }] },
      runRef: 'run-1',
      sink: {
        emit: (input) => {
          if (input.payload.type === 'run.message_delta') text.push(input.payload.text);
        },
      },
    });

    await run.interrupt('user cancelled');
    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted' });
    expect(text.join('')).toContain('[queued after interrupt]');

    await session.dispose();
  }, 20_000);

  it('drops malformed lines from stdout and keeps the run correct', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'garbage') });
    const text: string[] = [];
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });
    const run = await session.startRun({
      input: { parts: [{ type: 'text', text: 'go' }] },
      runRef: 'run-1',
      sink: {
        emit: (input) => {
          if (input.payload.type === 'run.message_delta') text.push(input.payload.text);
        },
      },
    });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(text.join('')).toBe('hello from a real child');
    await session.dispose();
  }, 20_000);

  it('never parses stderr as protocol', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'noise') });
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });
    const run = await session.startRun({
      input: { parts: [{ type: 'text', text: 'go' }] },
      runRef: 'run-1',
      sink: { emit: () => undefined },
    });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    await session.dispose();
  }, 20_000);
});

describe('process exit and teardown', () => {
  it('fails an in-flight run when the child exits, and never hangs it', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'exit-on-turn') });
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });

    // The child exits *instead of* answering `turn/start`, so the request must
    // be settled by the exit rather than waiting for a reply that never comes.
    await expect(
      session.startRun({
        input: { parts: [{ type: 'text', text: 'go' }] },
        runRef: 'run-1',
        sink: { emit: () => undefined },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );

    await session.dispose();
  }, 20_000);

  it('reports a spawn failure as a typed, retryable rejection', async () => {
    const provider = createCodexProvider({
      transport: ({ cwd }) =>
        createCodexStdioTransport(
          { cwd },
          { executable: join(tmpdir(), 'definitely-not-a-real-codex-binary'), closeGraceMs: 200, killGraceMs: 200 },
        ),
    });

    await expect(
      provider.createSession({
        options: {},
        workspace: { root: tmpdir(), ownership: 'borrowed' },
        sink: { emit: () => undefined },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );
  }, 20_000);

  it('escalates to a signal when the child ignores stdin EOF, and terminates', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const transport = spawnFake(root, 'ignore-term');
    const client = createCodexClient(transport, {
      onNotification: () => undefined,
      onServerRequest: () => undefined,
      onDrop: () => undefined,
      onEnd: () => undefined,
    });
    await client.request('initialize', { clientInfo: { name: 'x', title: null, version: '1' } });

    // Closing stdin is ignored and SIGTERM is trapped, so teardown must still
    // finish by escalating. The assertion is simply that this resolves.
    await expect(transport.close()).resolves.toBeUndefined();
  }, 20_000);

  it('is idempotent and leaves no run unsettled', async () => {
    const root = hostileWorkspace();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });

    const provider = createCodexProvider({ transport: ({ cwd }) => spawnFake(cwd, 'hang') });
    const session = await provider.createSession({
      options: {},
      workspace: { root, ownership: 'borrowed' },
      sink: { emit: () => undefined },
    });
    const run = await session.startRun({
      input: { parts: [{ type: 'text', text: 'go' }] },
      runRef: 'run-1',
      sink: { emit: () => undefined },
    });

    await session.dispose();
    await session.dispose();

    await expect(run.completion).resolves.toMatchObject({ outcome: 'interrupted' });
  }, 20_000);
});
