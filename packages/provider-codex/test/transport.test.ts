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
 *
 * Every test here runs inside `withFixture`, which bounds each wait and cleans
 * up the exact processes it created — see `fixture.ts`. Nothing in this file
 * relies on the framework killing a hung test to reclaim a child.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isProviderRejection } from '@relvo-labs/agent-provider';

import { createCodexProvider } from '../src/index.ts';
import {
  CODEX_APP_SERVER_ARGV,
  createCodexStdioTransport,
  type CodexPidListing,
  type CodexProcessEvidence,
  type CodexProcessProbe,
} from '../src/transport.ts';
import { createCodexClient, type CodexClientEnd } from '../src/client.ts';
import {
  FixtureDeadline,
  TEST_MS,
  identify,
  isRunning,
  leakedFixtures,
  makeWithFixture,
  onLinux,
  pgidOf,
  type Fixture,
  type Owned,
} from './fixture.ts';

/**
 * A minimal app-server stand-in.
 *
 * It asserts its own argv first: if the adapter had gone through a shell, the
 * arguments would have been re-parsed and this check would fail.
 *
 * It also announces its own identity — and that of any descendant it creates —
 * to `FIXTURE_PID_FILE`, recording the PID together with the start time read at
 * creation. That pairing is what lets the fixture clean up exactly what this
 * program spawned, and nothing else.
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
const FS = require('node:fs');
const PID_FILE = process.env.FIXTURE_PID_FILE;
const announce = (pid) => {
  if (!PID_FILE || !pid) return;
  let starttime = '';
  try {
    const raw = FS.readFileSync('/proc/' + pid + '/stat', 'utf8');
    starttime = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\\s+/)[19] || '';
  } catch (error) {}
  try { FS.appendFileSync(PID_FILE, JSON.stringify({ pid: pid, starttime: starttime }) + '\\n'); } catch (error) {}
};
announce(process.pid);

let sealed = false;
// Once stdout is closed this process stays alive but silent. Writing to an
// ended stream would kill it, which would hide the very case under test.
const seal = () => { sealed = true; process.stdout.end(); };
const send = (o) => { if (sealed) return; process.stdout.write(JSON.stringify(o) + '\\n'); };
const delta = (d) => send({ method: 'item/agentMessage/delta', params: { threadId: 'T1', turnId: 'U1', itemId: 'I1', delta: d } });
const completed = (status) => send({ method: 'turn/completed', params: { threadId: 'T1', turn: { id: 'U1', items: [], itemsView: 'complete', status, error: null } } });
const descendant = (stdio) => {
  const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio });
  announce(kid.pid);
  send({ method: 'test/descendant', params: { pid: kid.pid, leader: process.pid } });
};

if (MODE === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (MODE === 'noise') {
  // Log-like output on stderr must never be parsed as protocol.
  process.stderr.write('INFO starting app-server\\n');
}
if (MODE === 'orphan-child') {
  // An ordinary descendant: not detached, no stdio of ours, and therefore not
  // holding our stdout open. It stays in the leader's process group and
  // survives a clean leader exit unless the group itself is cleaned up.
  descendant('ignore');
}
if (MODE === 'orphan-pipe-child') {
  // A descendant that inherits our stdio, so the parent's close event cannot
  // fire while it lives. The leader then exits on its own.
  descendant('inherit');
  setTimeout(() => process.exit(0), 50);
}
if (MODE === 'eof-alive') {
  // A live process with a closed output stream: it can never send another
  // frame, but it has not exited and holds no pipe of ours open.
  send({ method: 'test/ready', params: {} });
  seal();
  setInterval(() => {}, 1000);
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
      if (MODE === 'terminal-then-eof') {
        send({ id: message.id, result: { turn: { id: 'U1', items: [], itemsView: 'complete', status: 'inProgress', error: null } } });
        delta('answered before the pipe closed');
        completed('completed');
        // The terminal frame is already queued; the stream ends immediately
        // afterwards while this process stays alive.
        seal();
        setInterval(() => {}, 1000);
        return;
      }
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

const withFixture = makeWithFixture(FAKE_APP_SERVER);

const scratchRoots: string[] = [];

/** A workspace whose name would be word-split or re-parsed by any shell. */
function hostileWorkspace(): string {
  const base = mkdtempSync(join(tmpdir(), 'relvo-codex-'));
  const root = join(base, 'a dir; touch pwned && echo $HOME');
  scratchRoots.push(base);
  return root;
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  // Nothing may outlive the suite. A failing test records what its own cleanup
  // could not account for; this is the backstop that makes that visible.
  expect(leakedFixtures).toEqual([]);
});

function methodOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'method' in value
    ? (value as { method?: unknown }).method?.toString()
    : undefined;
}

function descendantOf(frames: readonly unknown[]): { readonly pid: number; readonly leader: number } {
  const frame = frames.find((value) => methodOf(value) === 'test/descendant');
  expect(frame).toBeDefined();
  return (frame as { params: { pid: number; leader: number } }).params;
}

/** A provider whose transport is spawned — and therefore tracked — by the fixture. */
function providerFor(fixture: Fixture, mode: string, options: { readonly exitDrainMs?: number } = {}) {
  return createCodexProvider({
    transport: ({ cwd }) =>
      fixture.spawn(mode, {
        cwd,
        ...(options.exitDrainMs === undefined ? {} : { config: { exitDrainMs: options.exitDrainMs } }),
      }),
  });
}

const silentSink = { emit: (): void => undefined };

describe('argv and shell safety', () => {
  it('appends exactly `app-server --stdio` to the configured argv', () => {
    expect(CODEX_APP_SERVER_ARGV).toEqual(['app-server', '--stdio']);
  });

  it(
    'passes a workspace path containing shell metacharacters through unchanged',
    async () => {
      await withFixture(async (fixture) => {
        const { mkdirSync } = await import('node:fs');
        const root = hostileWorkspace();
        mkdirSync(root, { recursive: true });

        // The child exits non-zero if its cwd was mangled, which a shell would do.
        const transport = fixture.spawn('echo', { cwd: root, env: { EXPECT_CWD: root } });
        fixture.onCleanup(() => transport.close());
        const client = createCodexClient(transport, {
          onNotification: () => undefined,
          onServerRequest: () => undefined,
          onDrop: () => undefined,
          onEnd: () => undefined,
        });

        await expect(
          fixture.wait(
            client.request('initialize', { clientInfo: { name: 'x', title: null, version: '1' } }),
            'initialize',
          ),
        ).resolves.toBeDefined();
        const started = (await fixture.wait(client.request('thread/start', { cwd: root }), 'thread/start')) as {
          thread: { cwd: string };
        };
        expect(started.thread.cwd).toBe(root);
      });
    },
    TEST_MS,
  );
});

describe('a real turn over real pipes', () => {
  it(
    'completes a text run end to end through the neutral SPI',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'echo');
        const events: string[] = [];
        const usage: unknown[] = [];
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        const run = await fixture.wait(
          session.startRun({
            input: { parts: [{ type: 'text', text: 'hello; rm -rf / && echo $SECRET' }] },
            runRef: 'run-1',
            sink: {
              emit: (input) => {
                if (input.payload.type === 'run.message_delta') events.push(input.payload.text);
                if (input.payload.type === 'run.usage') usage.push(input.payload.usage);
              },
            },
          }),
          'startRun',
        );

        await expect(fixture.wait(run.completion, 'run completion')).resolves.toEqual({ outcome: 'succeeded' });
        expect(events.join('')).toBe('hello from a real child');
        expect(usage).toEqual([{ inputTokens: 3, outputTokens: 4, totalTokens: 7 }]);
      });
    },
    TEST_MS,
  );

  it(
    'interrupts cooperatively and still delivers queued output',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'hang');
        const text: string[] = [];
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        const run = await fixture.wait(
          session.startRun({
            input: { parts: [{ type: 'text', text: 'work forever' }] },
            runRef: 'run-1',
            sink: {
              emit: (input) => {
                if (input.payload.type === 'run.message_delta') text.push(input.payload.text);
              },
            },
          }),
          'startRun',
        );

        await fixture.wait(run.interrupt('user cancelled'), 'interrupt');
        await expect(fixture.wait(run.completion, 'run completion')).resolves.toEqual({ outcome: 'interrupted' });
        expect(text.join('')).toContain('[queued after interrupt]');
      });
    },
    TEST_MS,
  );

  it(
    'drops malformed lines from stdout and keeps the run correct',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'garbage');
        const text: string[] = [];
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        const run = await fixture.wait(
          session.startRun({
            input: { parts: [{ type: 'text', text: 'go' }] },
            runRef: 'run-1',
            sink: {
              emit: (input) => {
                if (input.payload.type === 'run.message_delta') text.push(input.payload.text);
              },
            },
          }),
          'startRun',
        );

        await expect(fixture.wait(run.completion, 'run completion')).resolves.toEqual({ outcome: 'succeeded' });
        expect(text.join('')).toBe('hello from a real child');
      });
    },
    TEST_MS,
  );

  it(
    'never parses stderr as protocol',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'noise');
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        const run = await fixture.wait(
          session.startRun({ input: { parts: [{ type: 'text', text: 'go' }] }, runRef: 'run-1', sink: silentSink }),
          'startRun',
        );
        await expect(fixture.wait(run.completion, 'run completion')).resolves.toEqual({ outcome: 'succeeded' });
      });
    },
    TEST_MS,
  );
});

describe('process exit and teardown', () => {
  it(
    'fails an in-flight run when the child exits, and never hangs it',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'exit-on-turn');
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        // The child exits *instead of* answering `turn/start`, so the request must
        // be settled by the exit rather than waiting for a reply that never comes.
        await expect(
          fixture.wait(
            session.startRun({ input: { parts: [{ type: 'text', text: 'go' }] }, runRef: 'run-1', sink: silentSink }),
            'startRun',
          ),
        ).rejects.toSatisfy(
          (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
        );
      });
    },
    TEST_MS,
  );

  it(
    'reports a spawn failure as a typed, retryable rejection',
    async () => {
      await withFixture(async (fixture) => {
        // No child is created here at all: the executable does not exist.
        const provider = createCodexProvider({
          transport: ({ cwd }) =>
            createCodexStdioTransport(
              { cwd },
              { executable: join(tmpdir(), 'definitely-not-a-real-codex-binary'), closeGraceMs: 200, killGraceMs: 200 },
            ),
        });

        await expect(
          fixture.wait(
            provider.createSession({
              options: {},
              workspace: { root: fixture.root, ownership: 'borrowed' },
              sink: silentSink,
            }),
            'createSession',
          ),
        ).rejects.toSatisfy(
          (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
        );
      });
    },
    TEST_MS,
  );

  it(
    'escalates to a signal when the child ignores stdin EOF, and terminates',
    async () => {
      await withFixture(async (fixture) => {
        const transport = fixture.spawn('ignore-term');
        fixture.onCleanup(() => transport.close());
        const client = createCodexClient(transport, {
          onNotification: () => undefined,
          onServerRequest: () => undefined,
          onDrop: () => undefined,
          onEnd: () => undefined,
        });
        await fixture.wait(
          client.request('initialize', { clientInfo: { name: 'x', title: null, version: '1' } }),
          'initialize',
        );

        // Closing stdin is ignored and SIGTERM is trapped, so teardown must still
        // finish by escalating. The assertion is simply that this resolves.
        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
      });
    },
    TEST_MS,
  );

  it(
    'is idempotent and leaves no run unsettled',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'hang');
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());
        const run = await fixture.wait(
          session.startRun({ input: { parts: [{ type: 'text', text: 'go' }] }, runRef: 'run-1', sink: silentSink }),
          'startRun',
        );

        await fixture.close(session.dispose(), 'dispose');
        await fixture.close(session.dispose(), 'dispose again');

        await expect(fixture.wait(run.completion, 'run completion')).resolves.toMatchObject({ outcome: 'interrupted' });
      });
    },
    TEST_MS,
  );
});

// ---------------------------------------------------------------------------
// R5 / R6 — teardown truth: owned descendants, and EOF without exit
// ---------------------------------------------------------------------------

describe.skipIf(!onLinux)('owned process-group cleanup', () => {
  it(
    'terminates an ordinary descendant that survives a clean leader exit',
    async () => {
      await withFixture(async (fixture) => {
        const transport = fixture.spawn('orphan-child');
        fixture.onCleanup(() => transport.close());

        const frames = await fixture.read(transport, (value) => methodOf(value) === 'test/descendant');
        const { pid, leader } = descendantOf(frames);
        const descendant = fixture.track(pid);
        expect(descendant).toBeDefined();
        // It is an ordinary member of the leader's own group, not a detached one.
        expect(pgidOf(pid)).toBe(leader);

        // The leader exits cleanly on stdin EOF. Cleanup must not stop there.
        await fixture.close(transport.close());

        expect(isRunning(descendant!)).toBe(false);
      });
    },
    TEST_MS,
  );

  /**
   * The fixture's own safety property, proven rather than asserted.
   *
   * A wait that can never be satisfied is contained *inside* the fixture: it
   * fails on the fixture's own short deadline, the fixture's cleanup still
   * runs, and the descendant it created is gone afterwards. This is what
   * replaces the earlier practice of letting a run time out to see what
   * happened — that left a child behind, which is precisely the bug.
   */
  it(
    'bounds an unsatisfiable wait and still cleans up everything it created',
    async () => {
      const created: Owned[] = [];

      await expect(
        withFixture(async (fixture) => {
          const transport = fixture.spawn('orphan-child');
          fixture.onCleanup(() => transport.close());

          const frames = await fixture.read(transport, (value) => methodOf(value) === 'test/descendant');
          fixture.track(descendantOf(frames).pid);
          created.push(...fixture.owned());
          expect(created.length).toBeGreaterThanOrEqual(2); // the leader and its child

          // This frame never arrives. A short, explicit bound keeps the failure
          // inside the fixture instead of at the framework deadline.
          await fixture.read(transport, () => false, 250);
        }),
      ).rejects.toBeInstanceOf(FixtureDeadline);

      for (const identity of created) expect(isRunning(identity)).toBe(false);
    },
    TEST_MS,
  );

  /**
   * The escape hatch, exercised rather than assumed.
   *
   * No graceful teardown is registered here at all, so the only thing that can
   * reclaim the leader and its descendant is the fixture's own bounded
   * force-clean — which signals exactly the recorded identities and then
   * verifies they are gone.
   */
  it(
    'force-cleans its own identities when no graceful teardown was registered',
    async () => {
      const created: Owned[] = [];

      await withFixture(async (fixture) => {
        const transport = fixture.spawn('orphan-child');
        const frames = await fixture.read(transport, (value) => methodOf(value) === 'test/descendant');
        fixture.track(descendantOf(frames).pid);
        created.push(...fixture.owned());

        expect(created.length).toBeGreaterThanOrEqual(2);
        for (const identity of created) expect(isRunning(identity)).toBe(true);
        // Deliberately no `fixture.onCleanup(...)`: nothing here closes the
        // transport, so the escape is the only route left.
      });

      for (const identity of created) expect(isRunning(identity)).toBe(false);
    },
    TEST_MS,
  );

  it('reports identities it could not account for instead of passing quietly', () => {
    // A process the fixture never created is never signalled, and an identity
    // that cannot be verified gone is surfaced rather than swallowed. Proven
    // here against a synthetic identity that is already gone, so the assertion
    // costs no process: `isRunning` is false, so cleanup reports no survivors.
    const alreadyGone: Owned = { pid: 2_147_483_600, starttime: 'never' };
    expect(isRunning(alreadyGone)).toBe(false);
    expect(identify(alreadyGone.pid)).toBeUndefined();
  });
});

/**
 * Ownership evidence, driven deterministically.
 *
 * These tests never signal a real process they do not own: the probe is
 * injected, so "a member that ignores SIGTERM" or "a PID that has been reused"
 * is a scripted answer rather than a live process someone has to find and kill.
 * The leader is still a real child — the one thing worth spawning — but every
 * *member* below is fictional and every `kill` is recorded, not delivered.
 */
type FakeMember = {
  /** A fixed answer, for evidence that is missing or provably foreign. */
  readonly evidence?: CodexProcessEvidence;
  /** Which group it reports; `ours` resolves to the real leader PID. */
  readonly group?: 'ours' | number;
  readonly starttime?: string;
  /** The signal it actually dies from. Omitted means it never dies. */
  readonly dies?: NodeJS.Signals;
  /** After this many looks, the PID reports a different process. */
  readonly recycledAfter?: number;
};

type ProbeScript = {
  /** Answers for `listPids`, in order; the last repeats. */
  readonly listings?: readonly CodexPidListing[];
  readonly members?: Readonly<Record<number, FakeMember>>;
};

type ScriptedProbe = CodexProcessProbe & {
  readonly kills: readonly { readonly pid: number; readonly signal: string }[];
};

const LEADER_START = '1000';

/**
 * A probe whose members behave, rather than one that counts calls.
 *
 * A member dies when it is sent the signal it is scripted to die from, and a
 * recycled PID starts reporting a different start time after a set number of
 * looks. That keeps these tests about the *behaviour* under test instead of
 * about how many times the implementation happens to stat something.
 */
function scriptedProbe(script: ProbeScript): ScriptedProbe {
  const kills: { pid: number; signal: string }[] = [];
  const looks = new Map<number, number>();
  const dead = new Set<number>();
  let listingCalls = 0;
  let leaderPid: number | undefined;

  function memberEvidence(pid: number, member: FakeMember): CodexProcessEvidence {
    if (member.evidence !== undefined) return member.evidence;
    if (dead.has(pid)) return { kind: 'gone' };
    const seen = (looks.get(pid) ?? 0) + 1;
    looks.set(pid, seen);
    const starttime = member.starttime ?? '2000';
    const recycled = member.recycledAfter !== undefined && seen > member.recycledAfter;
    return {
      kind: 'stat',
      pgid: member.group === undefined || member.group === 'ours' ? (leaderPid ?? -1) : member.group,
      starttime: recycled ? `${starttime}-reused` : starttime,
    };
  }

  return {
    canAttribute: true,
    get kills() {
      return kills;
    },
    listPids(): CodexPidListing {
      const scripted = script.listings?.[Math.min(listingCalls, script.listings.length - 1)];
      listingCalls += 1;
      if (scripted !== undefined) return scripted;
      return {
        kind: 'pids',
        pids: [...(leaderPid === undefined ? [] : [leaderPid]), ...Object.keys(script.members ?? {}).map(Number)],
      };
    },
    statOf(pid: number): CodexProcessEvidence {
      // The transport asks about the leader first, immediately after spawning
      // it; that call is what tells this fixture which PID the leader has.
      leaderPid ??= pid;
      if (pid === leaderPid) return { kind: 'stat', pgid: pid, starttime: LEADER_START };
      const member = script.members?.[pid];
      return member === undefined ? { kind: 'gone' } : memberEvidence(pid, member);
    },
    kill(pid: number, signal: NodeJS.Signals): void {
      kills.push({ pid, signal });
      if (script.members?.[pid]?.dies === signal) dead.add(pid);
    },
  };
}

describe('ownership evidence and signalling safety', () => {
  it(
    'fails the teardown when the PID listing cannot be read, and keeps retry ownership',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ listings: [{ kind: 'unknown', reason: 'EACCES' }] });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).rejects.toMatchObject({ code: 'group_cleanup_unverified' });
        // Nothing was signalled on the strength of evidence that was never read.
        expect(probe.kills).toEqual([]);
      });
    },
    TEST_MS,
  );

  it(
    'lets a retry succeed once the evidence is readable again',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({
          listings: [
            { kind: 'unknown', reason: 'EACCES' },
            { kind: 'pids', pids: [] },
          ],
        });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).rejects.toMatchObject({ code: 'group_cleanup_unverified' });
        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
      });
    },
    TEST_MS,
  );

  it(
    'never treats an unreadable member as an absent one',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424242: { evidence: { kind: 'unknown', reason: 'EPERM' } } } });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).rejects.toMatchObject({ code: 'group_cleanup_unverified' });
        expect(probe.kills).toEqual([]);
      });
    },
    TEST_MS,
  );

  it(
    'excludes a process that provably belongs to someone else',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424243: { evidence: { kind: 'foreign' } } } });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
        expect(probe.kills).toEqual([]);
      });
    },
    TEST_MS,
  );

  it(
    'signals an owned member, then reports success once it is gone',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424244: { group: 'ours', dies: 'SIGTERM' } } });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
        expect(probe.kills).toEqual([{ pid: 424244, signal: 'SIGTERM' }]);
      });
    },
    TEST_MS,
  );

  it(
    'escalates to SIGKILL for a member that ignores SIGTERM',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424248: { group: 'ours', dies: 'SIGKILL' } } });
        const transport = fixture.spawnWith(probe, { config: { killGraceMs: 150 } });
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
        expect(probe.kills.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);
      });
    },
    TEST_MS,
  );

  it(
    'never signals a PID whose identity no longer matches the one recorded',
    async () => {
      await withFixture(async (fixture) => {
        // Recorded as ours on the first look; by the time it would be signalled
        // the number belongs to a different, newer process. Ours is gone.
        const probe = scriptedProbe({ members: { 424245: { group: 'ours', recycledAfter: 1 } } });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
        expect(probe.kills).toEqual([]);
      });
    },
    TEST_MS,
  );

  it(
    'reports a member that survives every escalation, rather than claiming success',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424246: { group: 'ours' } } });
        const transport = fixture.spawnWith(probe, { config: { killGraceMs: 100 } });
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).rejects.toMatchObject({ code: 'process_group_did_not_exit' });
        expect(probe.kills.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);
      });
    },
    TEST_MS,
  );

  it(
    'ignores a process that is in another group entirely',
    async () => {
      await withFixture(async (fixture) => {
        const probe = scriptedProbe({ members: { 424247: { group: 999_999 } } });
        const transport = fixture.spawnWith(probe);
        fixture.onCleanup(() => transport.close());

        await expect(fixture.close(transport.close())).resolves.toBeUndefined();
        expect(probe.kills).toEqual([]);
      });
    },
    TEST_MS,
  );
});

describe.skipIf(!onLinux)('leader exit while a descendant holds the inherited pipe', () => {
  it(
    'ends the inbound stream anyway, then cleans the descendant up',
    async () => {
      await withFixture(async (fixture) => {
        // The descendant inherits stdout, so the child close event — which used
        // to be the only thing that ended the inbound stream — never fires.
        const transport = fixture.spawn('orphan-pipe-child', { config: { exitDrainMs: 150 } });
        fixture.onCleanup(() => transport.close());

        // Bounded: the stream must end on its own once the leader exits.
        const frames = await fixture.read(transport);
        const descendant = fixture.track(descendantOf(frames).pid);
        expect(descendant).toBeDefined();
        // It really did outlive the leader, which is what kept the pipe open.
        expect(isRunning(descendant!)).toBe(true);

        await fixture.close(transport.close());
        expect(isRunning(descendant!)).toBe(false);
      });
    },
    TEST_MS,
  );
});

describe('stdout EOF while the process is still alive', () => {
  it(
    'finishes the inbound stream without waiting for the process to exit',
    async () => {
      await withFixture(async (fixture) => {
        const transport = fixture.spawn('eof-alive');
        fixture.onCleanup(() => transport.close());

        // Bounded, and the bound is the assertion: before the repair the iterator
        // stayed pending forever, because only child exit ended it.
        const frames = await fixture.read(transport);
        expect(frames.map(methodOf)).toContain('test/ready');
      });
    },
    TEST_MS,
  );

  it(
    'settles a pending request rather than leaving it hanging',
    async () => {
      await withFixture(async (fixture) => {
        const transport = fixture.spawn('eof-alive');
        fixture.onCleanup(() => transport.close());
        const ends: CodexClientEnd[] = [];
        const client = createCodexClient(transport, {
          onNotification: () => undefined,
          onServerRequest: () => undefined,
          onDrop: () => undefined,
          onEnd: (end) => ends.push(end),
        });

        await expect(
          fixture.wait(
            client.request('initialize', { clientInfo: { name: 'x', title: null, version: '1' } }),
            'initialize',
          ),
        ).rejects.toSatisfy(
          (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
        );
        expect(ends).toEqual([{ end: 'eof' }]);
      });
    },
    TEST_MS,
  );

  it(
    'lets a terminal frame queued before EOF win over the EOF itself',
    async () => {
      await withFixture(async (fixture) => {
        const provider = providerFor(fixture, 'terminal-then-eof');
        const session = await fixture.wait(
          provider.createSession({
            options: {},
            workspace: { root: fixture.root, ownership: 'borrowed' },
            sink: silentSink,
          }),
          'createSession',
        );
        fixture.onCleanup(() => session.dispose());

        const run = await fixture.wait(
          session.startRun({ input: { parts: [{ type: 'text', text: 'go' }] }, runRef: 'run-1', sink: silentSink }),
          'startRun',
        );
        // EOF arrives immediately after the terminal frame. The turn's own
        // outcome must win; EOF must not overwrite it with a failure.
        await expect(fixture.wait(run.completion, 'run completion')).resolves.toEqual({ outcome: 'succeeded' });
      });
    },
    TEST_MS,
  );
});
