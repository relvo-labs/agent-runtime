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
 * Exit and EOF are the same event as far as the rest of the adapter is
 * concerned: the inbound iterable ends, and everything still pending settles.
 * That is deliberate — the bounded protocol surface has no shutdown handshake,
 * so waiting for a polite goodbye would wait forever (research, "Interrupt and
 * shutdown").
 */

import { spawn, type ChildProcess } from 'node:child_process';

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
   * Put the child in its own process group and signal the group on teardown, so
   * commands and MCP servers it spawned are torn down with it. POSIX only.
   *
   * This reduces orphan risk; it does not eliminate it. A descendant that
   * deliberately detaches itself is outside any guarantee this adapter makes.
   */
  readonly useProcessGroup?: boolean;
  /** Reported when a frame had to be discarded. */
  readonly onDrop?: (reason: JsonlDropReason) => void;
};

type Waiter = {
  readonly resolve: (result: IteratorResult<unknown, void>) => void;
  readonly reject: (reason: unknown) => void;
};

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

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const result = decoder.push(chunk);
    for (const value of result.values) queue.push(value);
    for (const reason of result.drops) config.onDrop?.(reason);
    wake();
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
        child.off('close', onClose);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      function onClose(): void {
        clearTimeout(timer);
        resolve(true);
      }
      child.once('close', onClose);
    });
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
        try {
          // Closing stdin is the documented client-side disconnect: the server
          // treats stdin EOF as connection close.
          child.stdin?.end();
          if (await whenExited(config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS)) return;
          signal('SIGTERM');
          if (await whenExited(config.killGraceMs ?? DEFAULT_KILL_GRACE_MS)) return;
          signal('SIGKILL');
          if (!(await whenExited(config.killGraceMs ?? DEFAULT_KILL_GRACE_MS))) {
            throw new CodexTransportError('child_did_not_exit');
          }
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
