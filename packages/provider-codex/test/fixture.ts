/**
 * Bounded, self-cleaning fixtures for the tests that spawn a real process.
 *
 * Two rules, both learned the hard way:
 *
 *  1. **Every wait is finite, and the bound is ours.** A test that waits on a
 *     frame, an EOF, a request or a process exit uses a deadline well below the
 *     framework's own timeout. If the framework is the thing that stops a test,
 *     the test's cleanup never runs — and a fixture child outlives the suite.
 *  2. **Cleanup signals exact identities, or nothing.** Everything this fixture
 *     creates is recorded as a `(pid, start time)` pair by the process that
 *     created it. Cleanup only ever signals a PID whose start time still
 *     matches, and then verifies it is gone. It never matches on a command
 *     line, never signals a process group, and never touches anything it did
 *     not create.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodexTransport } from '../src/seam.ts';
import {
  createCodexStdioTransport,
  spawnCodexStdioTransport,
  type CodexProcessProbe,
  type CodexStdioTransportConfig,
} from '../src/transport.ts';

/**
 * Time bounds, and why each one is what it is.
 *
 * | Bound              |    ms | Covers                                        |
 * | ------------------ | ----- | --------------------------------------------- |
 * | `WAIT_MS`          | 6 000 | one await: a frame, an EOF, a request, a run   |
 * | `CLOSE_WAIT_MS`    | 8 000 | one `close()`/`dispose()`, which may escalate  |
 * | `CLEANUP_STAGE_MS` | 1 000 | one stage of the force-cleanup escape          |
 * | `TEST_MS`          | 30000 | the Vitest deadline — never reached on purpose |
 *
 * `CLOSE_WAIT_MS` is the largest because a legitimate teardown can spend the
 * close grace (300 ms) plus two signal graces (5 s + 5 s in the worst
 * configured case) before it gives up. The realistic worst case for a single
 * test is one `WAIT_MS`, one `CLOSE_WAIT_MS` and both cleanup stages — about
 * 16 s, comfortably inside `TEST_MS`, so a hung fixture always fails *inside*
 * the test body where this file's cleanup still runs.
 */
export const WAIT_MS = 6_000;
export const CLOSE_WAIT_MS = 8_000;
export const CLEANUP_STAGE_MS = 1_000;
export const TEST_MS = 30_000;

/** How often a dying process is re-checked during the cleanup escape. */
const CLEANUP_POLL_MS = 25;

export const onLinux = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/**
 * A process identity that survives PID reuse.
 *
 * `starttime` (field 22 of `/proc/<pid>/stat`) is the kernel's own tiebreaker:
 * a recycled PID gets a different one, so this can prove *this* process is
 * gone rather than that *some* process with that number is.
 */
export type Owned = { readonly pid: number; readonly starttime: string };

function readStat(pid: number): { readonly pgid: number; readonly starttime: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  // `comm` may itself contain spaces and parentheses, so fields are read from
  // after the final ')'. State is field 3, so field N is token N-3.
  const tail = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const pgid = Number(tail[2]);
  const starttime = tail[19];
  if (!Number.isInteger(pgid) || starttime === undefined) return undefined;
  return { pgid, starttime };
}

/** The process group a live PID belongs to, for attribution assertions. */
export function pgidOf(pid: number): number | undefined {
  return readStat(pid)?.pgid;
}

/** Capture an identity for a PID that is alive right now. */
export function identify(pid: number): Owned | undefined {
  const stat = readStat(pid);
  return stat === undefined ? undefined : { pid, starttime: stat.starttime };
}

/** True only if the *same* process — same PID and same start time — still runs. */
export function isRunning(identity: Owned): boolean {
  return readStat(identity.pid)?.starttime === identity.starttime;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Wait for one identity to disappear, up to a bound.
 *
 * Returns whether it is gone, so the caller can escalate or report rather than
 * assume.
 */
async function waitGone(identity: Owned, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!isRunning(identity)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(CLEANUP_POLL_MS);
  }
}

/**
 * The cleanup escape: SIGTERM, verify, SIGKILL, verify.
 *
 * Only ever called with an identity this fixture recorded, and every signal is
 * preceded by an identity re-check, so a PID that has already been reused is
 * never signalled.
 */
async function forceClean(identity: Owned): Promise<boolean> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!isRunning(identity)) return true;
    try {
      process.kill(identity.pid, signal);
    } catch {
      // Exited between the check and the signal.
    }
    if (await waitGone(identity, CLEANUP_STAGE_MS)) return true;
  }
  return !isRunning(identity);
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export class FixtureDeadline extends Error {
  constructor(label: string, ms: number) {
    super(`fixture deadline: ${label} did not settle within ${String(ms)}ms`);
    this.name = 'FixtureDeadline';
  }
}

/** Bound any promise. The underlying work is not cancelled; cleanup handles it. */
export function withDeadline<T>(promise: Promise<T>, label: string, ms: number = WAIT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FixtureDeadline(label, ms));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// The fixture scope
// ---------------------------------------------------------------------------

export type SpawnOptions = {
  readonly config?: Partial<CodexStdioTransportConfig>;
  readonly env?: Record<string, string>;
  /** Defaults to the fixture's own scratch root. */
  readonly cwd?: string;
};

export type Fixture = {
  /** A scratch workspace root, removed with the fixture. */
  readonly root: string;
  /** Spawn the stand-in app-server. Its processes are tracked automatically. */
  spawn(mode: string, options?: SpawnOptions): CodexTransport;
  /** Spawn with an injected process probe, for the ownership-evidence tests. */
  spawnWith(probe: CodexProcessProbe, options?: SpawnOptions): CodexTransport;
  /** Register a teardown for cleanup to await, bounded and failure-tolerant. */
  onCleanup(action: () => Promise<unknown>): void;
  /**
   * Read frames until `until` matches, the stream ends, or the bound expires.
   * Every individual `next()` is bounded, so a stream that goes quiet fails
   * here rather than hanging.
   */
  read(transport: CodexTransport, until?: (value: unknown) => boolean, ms?: number): Promise<unknown[]>;
  /** Bound any other await — a request, a run completion, a disposal. */
  wait<T>(promise: Promise<T>, label: string, ms?: number): Promise<T>;
  /** Bound a teardown, which is allowed to take longer than an ordinary await. */
  close(promise: Promise<unknown>, label?: string): Promise<unknown>;
  /** Record a PID this fixture created, learned from a frame. */
  track(pid: number): Owned | undefined;
  /** Every identity known to belong to this fixture, in creation order. */
  owned(): readonly Owned[];
};

/** Identities a failing test left behind; asserted empty by the suite. */
export const leakedFixtures: string[] = [];

type Scope = {
  readonly fixture: Fixture;
  cleanup(): Promise<readonly Owned[]>;
  dispose(): void;
};

function createScope(fakeServer: string): Scope {
  const base = mkdtempSync(join(tmpdir(), 'relvo-codex-fixture-'));
  const pidFile = join(base, 'fixture-pids.jsonl');
  const teardowns: (() => Promise<unknown>)[] = [];
  const tracked = new Map<number, Owned>();

  function record(identity: Owned | undefined): Owned | undefined {
    if (identity !== undefined && !tracked.has(identity.pid)) tracked.set(identity.pid, identity);
    return identity;
  }

  /**
   * Identities the fixture children announced for themselves.
   *
   * Written by the creating process at creation time, so the start time is
   * captured while the process is provably the one it claims to be.
   */
  function announced(): readonly Owned[] {
    let raw: string;
    try {
      raw = readFileSync(pidFile, 'utf8');
    } catch {
      return [];
    }
    const entries: Owned[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as { pid?: unknown; starttime?: unknown };
        // Without a start time there is no identity, and without an identity
        // this fixture will not signal anything.
        if (typeof parsed.pid === 'number' && typeof parsed.starttime === 'string' && parsed.starttime !== '') {
          entries.push({ pid: parsed.pid, starttime: parsed.starttime });
        }
      } catch {
        // A partially written line: ignored rather than guessed at.
      }
    }
    return entries;
  }

  const fixture: Fixture = {
    root: base,

    spawn(mode, options = {}): CodexTransport {
      return createCodexStdioTransport(
        { cwd: options.cwd ?? base },
        {
          executable: process.execPath,
          extraArgs: ['-e', fakeServer],
          env: { ...process.env, FAKE_MODE: mode, FIXTURE_PID_FILE: pidFile, ...options.env },
          closeGraceMs: 300,
          killGraceMs: 5_000,
          ...options.config,
        },
      );
    },

    spawnWith(probe, options = {}): CodexTransport {
      return spawnCodexStdioTransport(
        { cwd: options.cwd ?? base },
        {
          executable: process.execPath,
          extraArgs: ['-e', fakeServer],
          env: { ...process.env, FAKE_MODE: 'echo', FIXTURE_PID_FILE: pidFile, ...options.env },
          closeGraceMs: 300,
          killGraceMs: 400,
          ...options.config,
        },
        probe,
      );
    },

    onCleanup(action): void {
      teardowns.push(action);
    },

    async read(transport, until, ms = WAIT_MS): Promise<unknown[]> {
      const iterator = transport.incoming[Symbol.asyncIterator]();
      const deadline = Date.now() + ms;
      const frames: unknown[] = [];
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new FixtureDeadline('reading a frame', ms);
        const result = await withDeadline(iterator.next(), 'reading a frame', remaining);
        if (result.done === true) return frames;
        frames.push(result.value);
        if (until?.(result.value) === true) return frames;
      }
    },

    wait(promise, label, ms = WAIT_MS) {
      return withDeadline(promise, label, ms);
    },

    close(promise, label = 'teardown') {
      return withDeadline(promise, label, CLOSE_WAIT_MS);
    },

    track(pid): Owned | undefined {
      return record(identify(pid));
    },

    owned(): readonly Owned[] {
      const all = new Map(tracked);
      for (const identity of announced()) if (!all.has(identity.pid)) all.set(identity.pid, identity);
      return [...all.values()];
    },
  };

  return {
    fixture,

    /**
     * Graceful teardown first, then the bounded escape, then verification.
     *
     * Never throws: a cleanup failure is reported to the caller as survivors so
     * it can be surfaced without masking whatever the test was really about.
     */
    async cleanup(): Promise<readonly Owned[]> {
      for (const teardown of teardowns.reverse()) {
        try {
          await withDeadline(Promise.resolve(teardown()), 'fixture teardown', CLOSE_WAIT_MS);
        } catch {
          // Expected for tests whose whole point is a teardown that fails.
        }
      }
      const survivors: Owned[] = [];
      for (const identity of fixture.owned()) {
        if (!(await forceClean(identity))) survivors.push(identity);
      }
      return survivors;
    },

    dispose(): void {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Run a test body with a fixture that always cleans up after itself.
 *
 * Cleanup runs on success, on assertion failure and on an internal deadline
 * alike. If it cannot account for something it created, that is a failure in
 * its own right: reported directly when the body succeeded, and recorded for
 * the suite-level check when the body had already failed, so the original
 * error is never masked.
 */
export function makeWithFixture(fakeServer: string) {
  return async function withFixture<T>(body: (fixture: Fixture) => Promise<T>): Promise<T> {
    const scope = createScope(fakeServer);

    // The body's outcome is captured rather than rethrown immediately, so that
    // cleanup runs exactly once on every path — success, assertion failure and
    // internal deadline alike — without a throw inside a `finally` that could
    // mask the original error.
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await body(scope.fixture) };
    } catch (error) {
      outcome = { ok: false, error };
    }

    const survivors = await scope.cleanup();
    scope.dispose();

    if (!outcome.ok) {
      // The test already has a failure worth reading; anything cleanup could
      // not account for is recorded for the suite-level check instead.
      if (survivors.length > 0) leakedFixtures.push(describeAll(survivors));
      throw outcome.error;
    }
    if (survivors.length > 0) {
      throw new Error(`fixture cleanup could not account for: ${describeAll(survivors)}`);
    }
    return outcome.value;
  };
}

function describeAll(identities: readonly Owned[]): string {
  return identities.map((identity) => `${String(identity.pid)}@${identity.starttime}`).join(', ');
}
