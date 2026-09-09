/**
 * The production transport: `codex app-server --stdio` over pipes.
 *
 * Structural rules, all of them load-bearing:
 *
 *   - **No shell.** The binary is spawned with an argv *array* and
 *     `shell: false`. There is no command string anywhere in this module, so
 *     there is nothing for prompt text, a workspace path or an option value to
 *     be interpolated into. Nothing from a turn ever reaches argv or env.
 *   - **No PTY, no scraping.** stdout is parsed as bounded JSONL and nothing
 *     else. stderr is drained — so a chatty child can never deadlock on a full
 *     pipe — but it is never parsed, never correlated, and never published.
 *   - **The executable is host configuration**, not run input. It defaults to
 *     `codex` on `PATH` and can only be changed by the host that constructs the
 *     provider.
 *
 * Exit and EOF both end the inbound iterable, and everything still pending
 * settles. That is deliberate — the bounded protocol surface has no shutdown
 * handshake, so waiting for a polite goodbye would wait forever (research,
 * "Interrupt and shutdown"). They are nonetheless *separate facts*, and this
 * module keeps them separate:
 *
 *   - **stdout EOF** ends the inbound stream. A live process whose output
 *     stream is closed can never send another frame, so continuing to wait on
 *     it is a hang, not patience.
 *   - **process exit** is what teardown waits for, and it is observed on
 *     `exit`, not `close`: a descendant holding an inherited pipe open must not
 *     be able to hide the leader's exit.
 *   - **owned-group cleanup** is verified separately again, because a leader
 *     that exits cleanly says nothing about the commands and MCP servers it
 *     started.
 *
 * Only when all three are satisfied does `close()` report success.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';

import { createJsonlDecoder, type JsonlDropReason } from './protocol.ts';
import type { CodexClientMessage, CodexTransport, CodexTransportParams } from './seam.ts';

/** Subcommand and flag, exactly as the pinned CLI documents them. */
export const CODEX_APP_SERVER_ARGV: readonly string[] = ['app-server', '--stdio'];

/** The default executable looked up on `PATH`. */
export const CODEX_DEFAULT_EXECUTABLE = 'codex';

/** The upstream release this transport and the seam types were pinned against. */
export const CODEX_APP_SERVER_VERSION = '0.153.4';

/** How long a closing connection may take to exit on its own before SIGTERM. */
export const DEFAULT_CLOSE_GRACE_MS = 2_000;
/** How long SIGTERM is given before SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** How often the owned process group is re-checked while it drains. */
const GROUP_POLL_MS = 25;
/** How long buffered stdout is still drained after the leader has exited. */
export const DEFAULT_EXIT_DRAIN_MS = 250;

export type CodexStdioTransportConfig = {
  /**
   * Absolute path to, or `PATH` name of, the Codex executable. Host
   * configuration only.
   */
  readonly executable?: string;
  /** Extra leading arguments, before `app-server --stdio`. Host configuration. */
  readonly extraArgs?: readonly string[];
  /**
   * Environment for the child. Defaults to this process's environment, because
   * the app-server reads its own auth and config from `CODEX_HOME`/`HOME`. This
   * adapter neither reads, manages, nor forwards credentials of its own.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly closeGraceMs?: number;
  readonly killGraceMs?: number;
  /**
   * How long buffered stdout may still be read after the leader exits, before
   * the inbound stream is ended regardless.
   *
   * This only matters when a descendant inherited the pipe and keeps it open:
   * without a bound, the stream — and every request waiting on it — would stay
   * open behind a process that can no longer answer.
   */
  readonly exitDrainMs?: number;
  /**
   * Put the child in its own process group and tear that group down with it, so
   * commands and MCP servers it spawned do not outlive the connection. POSIX
   * only, and defaults on everywhere except Windows.
   *
   * What this does and does not promise:
   *
   *   - while the leader is alive, the group is signalled as a group, which is
   *     unambiguous because the leader still holds the group id;
   *   - after the leader exits, members are only ever signalled by exact PID,
   *     with their recorded start time re-read immediately beforehand. A PID
   *     that no longer matches is not signalled at all. The remaining
   *     stat-then-kill window cannot be closed with `process.kill` and is not
   *     claimed to be;
   *   - attribution needs `/proc`. Without it there is no post-exit sweep and
   *     no descendant-containment claim, rather than a guess;
   *   - a descendant that deliberately detaches into its own group leaves the
   *     group and is outside any guarantee this adapter makes.
   *
   * Cleanup that cannot be verified fails `close()` and keeps its retry
   * ownership; it is never reported as a success.
   */
  readonly useProcessGroup?: boolean;
  /** Reported when a frame had to be discarded. */
  readonly onDrop?: (reason: JsonlDropReason) => void;
};

type Waiter = {
  readonly resolve: (result: IteratorResult<unknown, void>) => void;
  readonly reject: (reason: unknown) => void;
};

/**
 * What the operating system will tell us about a process.
 *
 * The distinction that matters is between **"provably not there"** and
 * **"we could not find out"**. Collapsing the second into the first is how a
 * teardown ends up reporting success over a process it never even looked at,
 * so every probe result is one of four explicit answers and `unknown` is
 * never treated as absence.
 */
export type CodexProcessEvidence =
  /** Read successfully. */
  | { readonly kind: 'stat'; readonly pgid: number; readonly starttime: string }
  /** No such process: the PID is genuinely unused. */
  | { readonly kind: 'gone' }
  /** Exists, but provably cannot be ours (different owning uid). */
  | { readonly kind: 'foreign' }
  /** Exists or may exist; attribution could not be established. */
  | { readonly kind: 'unknown'; readonly reason: string };

export type CodexPidListing =
  { readonly kind: 'pids'; readonly pids: readonly number[] } | { readonly kind: 'unknown'; readonly reason: string };

/**
 * The operating-system facts this transport needs, behind one seam.
 *
 * Injectable so the dangerous paths — evidence that goes missing, a PID that
 * has been reused, a member that refuses to die — can be characterised exactly
 * without signalling any real process the test does not own.
 */
export type CodexProcessProbe = {
  /** Whether this platform can attribute processes at all. */
  readonly canAttribute: boolean;
  listPids(): CodexPidListing;
  statOf(pid: number): CodexProcessEvidence;
  /** Deliver a signal to one exact PID. May throw; the caller treats that as a race. */
  kill(pid: number, signal: NodeJS.Signals): void;
};

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * The real `/proc`-backed probe.
 *
 * `comm` is unquoted and may itself contain spaces and parentheses, so every
 * field is read from after the *final* `)`. State is field 3 there, making
 * field N the token at index N-3: `pgrp` is field 5, `starttime` field 22.
 *
 * An unreadable entry is only downgraded to `foreign` when the `/proc/<pid>`
 * directory is owned by a different uid, because a child this process spawned
 * runs under this process's own uid. Anything else unreadable stays `unknown`
 * and will fail a teardown rather than pass it.
 */
const procfsProbe: CodexProcessProbe = {
  canAttribute: process.platform === 'linux',

  listPids(): CodexPidListing {
    try {
      const pids: number[] = [];
      for (const entry of readdirSync('/proc')) {
        if (/^\d+$/u.test(entry)) pids.push(Number(entry));
      }
      return { kind: 'pids', pids };
    } catch (error) {
      return { kind: 'unknown', reason: errnoOf(error) };
    }
  },

  statOf(pid: number): CodexProcessEvidence {
    let raw: string;
    try {
      raw = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' };
      // Hardened `/proc` mounts hide other users' processes. Those cannot be
      // descendants of a child we spawned, so they are excluded on evidence
      // rather than assumed away.
      try {
        const owner = statSync(`/proc/${String(pid)}`).uid;
        if (owner !== process.getuid?.()) return { kind: 'foreign' };
      } catch (ownerError) {
        if (errnoOf(ownerError) === 'ENOENT') return { kind: 'gone' };
      }
      return { kind: 'unknown', reason: code };
    }
    const close = raw.lastIndexOf(')');
    if (close === -1) return { kind: 'unknown', reason: 'unparsable' };
    const fields = raw
      .slice(close + 1)
      .trim()
      .split(/\s+/u);
    const pgid = Number(fields[2]);
    const starttime = fields[19];
    if (!Number.isInteger(pgid) || starttime === undefined) return { kind: 'unknown', reason: 'unparsable' };
    return { kind: 'stat', pgid, starttime };
  },

  kill(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  },
};

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** A transport failure that carries an allowlisted cause, never child output. */
class CodexTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`codex app-server transport failed (${code})`);
    this.name = 'CodexTransportError';
    this.code = code;
  }
}

export function createCodexStdioTransport(
  params: CodexTransportParams,
  config: CodexStdioTransportConfig = {},
): CodexTransport {
  return spawnCodexStdioTransport(params, config, procfsProbe);
}

/**
 * The transport, with its operating-system dependency injected.
 *
 * Not exported from the package entry point: this exists so the ownership and
 * teardown paths can be driven deterministically in tests, including the cases
 * where the OS refuses to answer. Hosts use `createCodexStdioTransport`.
 */
export function spawnCodexStdioTransport(
  params: CodexTransportParams,
  config: CodexStdioTransportConfig,
  probe: CodexProcessProbe,
): CodexTransport {
  const executable = config.executable ?? CODEX_DEFAULT_EXECUTABLE;
  const argv = [...(config.extraArgs ?? []), ...CODEX_APP_SERVER_ARGV];
  const useProcessGroup = config.useProcessGroup ?? process.platform !== 'win32';

  const queue: unknown[] = [];
  const waiters: Waiter[] = [];
  let finished = false;
  let failure: Error | undefined;
  let exited = false;

  const decoder = createJsonlDecoder();

  function wake(): void {
    while (waiters.length > 0) {
      if (failure !== undefined) {
        waiters.shift()?.reject(failure);
        continue;
      }
      // `queue` can legitimately hold `null` (a JSON null frame), so emptiness
      // is decided by length, never by the shifted value.
      if (queue.length > 0) {
        waiters.shift()?.resolve({ done: false, value: queue.shift() });
        continue;
      }
      if (finished) {
        waiters.shift()?.resolve({ done: true, value: undefined });
        continue;
      }
      return;
    }
  }

  function fail(error: Error): void {
    if (failure !== undefined || finished) return;
    failure = error;
    wake();
  }

  function finish(): void {
    if (finished || failure !== undefined) return;
    // Flush a trailing frame the child wrote without a final newline.
    const flushed = decoder.end();
    for (const value of flushed.values) queue.push(value);
    for (const reason of flushed.drops) config.onDrop?.(reason);
    finished = true;
    wake();
  }

  let child: ChildProcess;
  try {
    child = spawn(executable, argv, {
      cwd: params.cwd,
      // Three separate pipes. Never inherit, never share a terminal.
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell: argv is a real vector, so nothing is ever word-split or
      // interpolated. This is the property `check-static` enforces.
      shell: false,
      detached: useProcessGroup,
      windowsHide: true,
      ...(config.env === undefined ? {} : { env: config.env }),
    });
  } catch {
    // `spawn` can throw synchronously on an unusable argument vector. Surface it
    // as an ordinary failed stream so callers have exactly one failure path.
    const spawnFailure = new CodexTransportError('spawn_failed');
    return {
      send: () => undefined,
      incoming: {
        [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
          next: (): Promise<IteratorResult<unknown>> => Promise.reject(spawnFailure),
        }),
      },
      close: () => Promise.resolve(),
    };
  }

  // ---------------------------------------------------------------------
  // Ownership evidence
  // ---------------------------------------------------------------------
  //
  // The group id *is* the leader's PID, because the child was spawned
  // `detached`. That identity is captured now, in the same synchronous tick as
  // the spawn, while the leader is certainly alive and its PID therefore
  // certainly not reusable.

  const leaderPid = child.pid;
  /** Whether this platform and configuration can attribute descendants at all. */
  const groupClaimed = useProcessGroup && probe.canAttribute && leaderPid !== undefined;
  const leaderIdentity = groupClaimed ? probe.statOf(leaderPid) : undefined;
  const leaderStarttime = leaderIdentity?.kind === 'stat' ? leaderIdentity.starttime : undefined;

  /**
   * Descendants this transport is responsible for: exact PID → exact start
   * time. Membership is only ever recorded from evidence gathered while the
   * group provably belonged to us.
   */
  const owned = new Map<number, string>();
  /**
   * Why the group has not been fully accounted for.
   *
   * This is deliberately **not** per-attempt state. A scan that could not be
   * completed leaves a real question — is something still running? — and
   * starting another `close()` does not answer it. Forgetting the doubt at the
   * top of an attempt is exactly how an empty retained-identity map turns into
   * a false claim of emptiness. It is therefore cleared by one thing only: a
   * later scan that actually reads the group and attributes everything it
   * finds.
   */
  let discoveryIncomplete: string | undefined;

  /**
   * Re-read one owned member and decide what to do with it.
   *
   * `gone` covers three cases that are all equivalent for cleanup: no such
   * process, a PID whose start time no longer matches the one recorded (so the
   * process we owned has exited and something else now holds the number), and
   * a process that has left our group. Crucially, a PID that fails this check
   * is never signalled — that is the whole point of recording start times.
   */
  function recheck(pid: number, starttime: string): 'alive' | 'gone' | 'unknown' {
    const evidence = probe.statOf(pid);
    switch (evidence.kind) {
      case 'gone':
      case 'foreign':
        return 'gone';
      case 'unknown':
        return 'unknown';
      case 'stat':
        if (evidence.starttime !== starttime) return 'gone';
        if (leaderPid === undefined || evidence.pgid !== leaderPid) return 'gone';
        return 'alive';
    }
  }

  /** Whether any already-owned member still answers with its recorded identity. */
  function hasLivingMember(): boolean {
    for (const [pid, starttime] of owned) {
      if (recheck(pid, starttime) === 'alive') return true;
    }
    return false;
  }

  /** What one scan of the group established. */
  type Discovery = {
    /** Every candidate was readable, so the listing can be believed. */
    readonly complete: boolean;
    /** Processes in this group id that could not be attributed to us. */
    readonly unattributable: number;
  };

  /**
   * Look at the group, and record only the members that are provably ours.
   *
   * **Looking and adopting are different rights.** Looking is always allowed:
   * finding *nothing* in the group id is a sound conclusion however that id
   * came to be free, and it is what lets a later attempt resolve an earlier
   * doubt. Adopting — taking responsibility for a PID, and therefore being
   * willing to signal it — needs a reason to believe the group id is still
   * ours, and only these are accepted:
   *
   *   - `leader_alive` — the leader still holds its PID, so the group id it
   *     names cannot have been reused by anything. Unconditional.
   *   - `group_continuous` — at least one member recorded earlier is still
   *     alive. A process group id cannot be recycled while any member of it
   *     exists, so the group is provably the same one.
   *   - `leader_exiting` — the synchronous reap window, and only that window.
   *     The leader has just gone, so the id has had no realistic opportunity to
   *     be reissued; its start time additionally excludes anything older.
   *
   * `post_exit_probe` — an arbitrary later attempt — is deliberately **not** on
   * that list. By then the group id may have been released and reissued, and a
   * process in a recycled group is newer than our leader too, so a start-time
   * filter cannot tell the two apart. Such a scan therefore observes without
   * adopting: anything it finds is counted unattributable, which keeps the
   * teardown unverified rather than signalling a stranger.
   */
  function discoverGroup(
    provenance: 'leader_alive' | 'group_continuous' | 'leader_exiting' | 'post_exit_probe',
  ): Discovery | undefined {
    // `groupClaimed` already established that the leader PID is known.
    if (!groupClaimed) return undefined;
    // Continuity is a claim about the present, so it is checked here rather
    // than trusted from the call site: without a living member, the group id
    // could already have been released and reused.
    if (provenance === 'group_continuous' && !hasLivingMember()) return undefined;

    const listing = probe.listPids();
    if (listing.kind === 'unknown') return { complete: false, unattributable: 0 };

    const leaderStarted = leaderStarttime === undefined ? undefined : Number(leaderStarttime);
    // Adoption rights, per the provenance rules above. The reap window still
    // needs the leader's start time to exclude anything older than the group.
    const mayAdopt =
      provenance === 'leader_alive' ||
      provenance === 'group_continuous' ||
      (provenance === 'leader_exiting' && leaderStarted !== undefined);

    let complete = true;
    let unattributable = 0;
    for (const pid of listing.pids) {
      // An already-owned member is accounted for by `owned`, not by this scan.
      if (pid === leaderPid || pid === process.pid || owned.has(pid)) continue;
      const evidence = probe.statOf(pid);
      if (evidence.kind === 'gone' || evidence.kind === 'foreign') continue;
      if (evidence.kind === 'unknown') {
        // Cannot prove this is not one of ours, so nothing may later claim the
        // group is empty on the strength of this scan.
        complete = false;
        continue;
      }
      if (evidence.pgid !== leaderPid) continue;
      if (!mayAdopt) {
        unattributable += 1;
        continue;
      }
      // A member cannot predate its own group leader; one that does belongs to
      // a recycled group id, so it is neither adopted nor signalled — but its
      // presence still means this group is not provably empty.
      if (leaderStarted !== undefined && Number.isFinite(leaderStarted) && Number(evidence.starttime) < leaderStarted) {
        unattributable += 1;
        continue;
      }
      owned.set(pid, evidence.starttime);
    }
    return { complete, unattributable };
  }

  /**
   * Fold one scan into the standing question of whether the group is accounted
   * for.
   *
   * Only a scan that read everything *and* attributed everything it found may
   * clear the doubt. A scan that was skipped changes nothing, and an incomplete
   * one keeps — or creates — the doubt for every later attempt.
   */
  function scanGroup(provenance: 'leader_alive' | 'group_continuous' | 'leader_exiting' | 'post_exit_probe'): void {
    const result = discoverGroup(provenance);
    if (result === undefined) return;
    if (result.complete && result.unattributable === 0) {
      discoveryIncomplete = undefined;
      return;
    }
    discoveryIncomplete ??= result.complete ? `${provenance}_unattributable` : `${provenance}_unreadable`;
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const result = decoder.push(chunk);
    for (const value of result.values) queue.push(value);
    for (const reason of result.drops) config.onDrop?.(reason);
    wake();
  });
  // EOF on stdout ends the inbound stream on its own. The process may still be
  // alive and may still hold resources — that is `close()`'s problem, not the
  // stream's — but it can never send another frame, so anything waiting on one
  // is waiting forever.
  child.stdout?.on('end', () => {
    finish();
  });
  child.stdout?.on('error', () => {
    fail(new CodexTransportError('stdout_error'));
  });

  // Drained and discarded.
  //
  // Draining is mandatory: an undrained pipe fills and blocks the child, which
  // would deadlock a turn behind the child's own logging. Discarding is a
  // decision — stderr is arbitrary upstream prose that can hold credentials,
  // paths and prompt text, so it must never reach a durable DTO, and holding a
  // buffer nobody can read would only be a leak waiting for a future accessor.
  // A host that wants raw diagnostics supplies its own transport.
  child.stderr?.resume();
  child.stderr?.on('error', () => undefined);

  // A stdin that closes early (child gone) must not raise an unhandled error.
  child.stdin?.on('error', () => undefined);

  child.on('error', () => {
    exited = true;
    fail(new CodexTransportError('spawn_failed'));
  });

  // `exit` fires when the leader itself is gone. `close` additionally waits for
  // every stdio stream to close, which a descendant holding an inherited pipe
  // can delay indefinitely — so neither teardown nor the inbound stream may
  // depend on it.
  child.on('exit', () => {
    exited = true;
    // Taken synchronously, inside the reap window: the one moment after the
    // leader is gone where adopting what is still in its group is sound.
    scanGroup('leader_exiting');
    if (finished || failure !== undefined) return;
    // Buffered stdout is still worth reading: a child that answered and then
    // exited must not lose its last frames. But the wait is bounded, because a
    // descendant holding the inherited pipe would otherwise keep the stream —
    // and every request waiting on it — open forever. The leader is gone, so
    // nothing further can legitimately arrive on it either way.
    const drain = setTimeout(() => {
      if (finished || failure !== undefined) return;
      child.stdout?.destroy();
      finish();
    }, config.exitDrainMs ?? DEFAULT_EXIT_DRAIN_MS);
    drain.unref();
  });

  child.on('close', () => {
    exited = true;
    // Exit is EOF: whatever was still pending settles through the normal
    // end-of-stream path rather than through a special case.
    finish();
  });

  let closing: Promise<void> | undefined;
  let closed = false;

  function signal(sig: NodeJS.Signals): void {
    if (exited) return;
    try {
      const pid = child.pid;
      if (useProcessGroup && pid !== undefined) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone, or the group no longer exists. Either way there is
      // nothing left to signal.
    }
  }

  function whenExited(timeoutMs: number): Promise<boolean> {
    if (exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      function onExit(): void {
        clearTimeout(timer);
        resolve(true);
      }
      // Deliberately `exit`, not `close`: see the handler above.
      child.once('exit', onExit);
    });
  }

  type GroupState = { readonly alive: number; readonly unresolved: number };

  /**
   * Re-examine every owned member once.
   *
   * Members proven gone are forgotten. While at least one is still alive the
   * group id cannot have been recycled, so this is also the only moment at
   * which it is sound to adopt members that appeared after the leader exited —
   * a descendant that forked another descendant.
   */
  function surveyOwned(): GroupState {
    let alive = 0;
    let unresolved = 0;
    for (const [pid, starttime] of [...owned]) {
      const state = recheck(pid, starttime);
      if (state === 'gone') {
        owned.delete(pid);
        continue;
      }
      if (state === 'unknown') {
        // Still owned, still unreadable: the attempt cannot succeed, and the
        // member stays in `owned` so a later attempt rechecks it.
        unresolved += 1;
        continue;
      }
      alive += 1;
    }
    if (alive > 0) scanGroup('group_continuous');
    return { alive, unresolved };
  }

  /**
   * Signal the owned members, revalidating identity immediately before each one.
   *
   * A PID whose recorded start time no longer matches is *not* signalled: the
   * process this transport owned has exited, and the number now belongs to
   * something else. A PID whose state cannot be read is not signalled either.
   * Only a member that still answers with the exact identity recorded for it
   * receives anything.
   *
   * The check and the signal are two separate system calls, so a process that
   * exits between them can still, in principle, have its PID reused before the
   * signal lands. That window cannot be closed with `process.kill`, and this
   * adapter does not claim otherwise; it is narrowed to a single stat/kill pair
   * and never widened by signalling a group id or a stale scan result.
   */
  function signalOwned(sig: NodeJS.Signals): void {
    for (const [pid, starttime] of [...owned]) {
      const state = recheck(pid, starttime);
      if (state === 'gone') {
        owned.delete(pid);
        continue;
      }
      if (state === 'unknown') {
        // Never signal what cannot be identified. The survey that follows
        // counts it as unresolved, so the attempt still fails.
        continue;
      }
      try {
        probe.kill(pid, sig);
      } catch {
        // Exited between the recheck and the signal. Nothing to do.
      }
    }
  }

  async function drainOwned(timeoutMs: number): Promise<GroupState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = surveyOwned();
      if (state.alive === 0 || Date.now() >= deadline) return state;
      await delay(GROUP_POLL_MS);
    }
  }

  /**
   * Terminate what the leader left behind.
   *
   * The leader exiting cleanly proves nothing about the commands and MCP
   * servers it started: those stay in the group with `PPID` reparented to
   * `init`. Two outcomes are failures, not successes:
   *
   *   - a member that is still alive after SIGKILL (`process_group_did_not_exit`);
   *   - ownership evidence that could not be read at all
   *     (`group_cleanup_unverified`) — an unreadable `/proc`, an unparsable
   *     entry, or a member whose state is unknown.
   *
   * Both leave `closed` false, so a later attempt still owns the teardown and
   * can succeed once the evidence is available again.
   */
  async function sweepOwnedGroup(killGraceMs: number): Promise<void> {
    if (!groupClaimed) return;

    // Fresh discovery, every attempt. An empty retained-identity map only means
    // the group is gone if a scan actually looked — and succeeded — now. A
    // previous attempt's blindness is resolved by reading again, never by
    // starting a new attempt.
    //
    // Once the leader has gone this is evidence only. Continuity-based adoption
    // still happens, but through `surveyOwned`, which first proves a retained
    // member is alive.
    scanGroup(exited ? 'post_exit_probe' : 'leader_alive');

    let state = surveyOwned();
    if (state.alive > 0) {
      signalOwned('SIGTERM');
      state = await drainOwned(killGraceMs);
    }
    if (state.alive > 0) {
      signalOwned('SIGKILL');
      state = await drainOwned(killGraceMs);
    }
    if (state.alive > 0) throw new CodexTransportError('process_group_did_not_exit');
    if (state.unresolved > 0 || discoveryIncomplete !== undefined) {
      throw new CodexTransportError('group_cleanup_unverified');
    }
  }

  /** Stop the leader itself, escalating only as far as it has to. */
  async function terminateLeader(closeGraceMs: number, killGraceMs: number): Promise<void> {
    // Closing stdin is the documented client-side disconnect: the server
    // treats stdin EOF as connection close.
    child.stdin?.end();
    if (await whenExited(closeGraceMs)) return;
    signal('SIGTERM');
    if (await whenExited(killGraceMs)) return;
    signal('SIGKILL');
    if (!(await whenExited(killGraceMs))) throw new CodexTransportError('child_did_not_exit');
  }

  return {
    send(message: CodexClientMessage): void {
      if (closed || exited) return;
      try {
        // Serialise from a typed object, never by string concatenation, and
        // terminate with exactly one newline: that is the whole framing rule.
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // A failed write is reported by the stream ending, not by throwing into
        // the caller's control flow.
      }
    },

    incoming: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (failure !== undefined) throw failure;
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (finished) return;
          const result = await new Promise<IteratorResult<unknown, void>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
          if (result.done === true) return;
          yield result.value;
        }
      },
    },

    async close(): Promise<void> {
      if (closed) return;
      if (closing !== undefined) return closing;

      const attempt = (async () => {
        // Yield before touching the child, so a synchronous throw below cannot
        // run the `finally` that clears the shared attempt before this scope has
        // assigned it — which would cache a rejected promise as the permanent
        // answer to every later close.
        await Promise.resolve();
        const killGraceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        try {
          // The strongest provenance available: the leader still holds its PID,
          // so the group id names our group and nothing else. Anything already
          // running is recorded here, before that certainty is lost.
          if (!exited) scanGroup('leader_alive');
          await terminateLeader(config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, killGraceMs);
          // The leader is gone. That is not the same as "nothing it started is
          // still running", so the owned group is verified independently before
          // this teardown may claim success.
          await sweepOwnedGroup(killGraceMs);
        } finally {
          closing = undefined;
        }
      })();

      closing = attempt;
      await attempt;
      // Only a teardown that actually completed may retire the connection; a
      // rejected attempt above leaves `closed` false so a retry still owns it.
      closed = true;
      finish();
    },
  };
}
