/**
 * Adapter configuration.
 *
 * Two layers, one shape: defaults supplied once when the provider is created,
 * and per-session overrides that arrive as opaque JSON on `open_session`. The
 * override layer is parsed with Zod because it crosses a trust boundary — the
 * runtime forwards whatever the caller sent — so an unknown key is a typed
 * rejection rather than a silently ignored intention.
 *
 * Note what a *session* override deliberately cannot set: the executable, the
 * argv, the environment, or the transport. Those are host configuration, not
 * run input; letting a session choose them would turn opaque caller JSON into
 * process-spawning authority.
 */

import { z } from 'zod';
import type { AgentProvider } from '@relvo-labs/agent-provider';

import type { CodexTransportFactory } from './seam.ts';

/**
 * `SandboxMode` from the pinned stable surface
 * (`typescript-stable/v2/SandboxMode.ts`).
 *
 * This is Codex's own execution policy — provider-declared intent that the
 * *app-server* enforces. It is not a sandbox this runtime imposes, and nothing
 * here restricts what the in-process adapter itself may do (ADR-0009).
 */
export const CodexSandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

/** Per-session overrides accepted in `open_session`'s `providerOptions`. */
export const CodexSessionOptionsSchema = z.strictObject({
  /** Model identifier passed through verbatim; Codex owns the default. */
  model: z.string().min(1).max(200).optional(),
  /**
   * Execution policy for the thread. Defaults to `read-only`.
   *
   * `workspace-write` and `danger-full-access` also cause the app-server to
   * mark the project trusted in the user's `config.toml` when a `cwd` is
   * supplied (README, `thread/start`) — a host-config mutation outside the
   * acquired workspace, which is why the conservative value is the default.
   */
  sandboxMode: CodexSandboxModeSchema.optional(),
});

export type CodexSessionOptions = z.infer<typeof CodexSessionOptionsSchema>;

/**
 * Options for `createCodexProvider`.
 *
 * `transport` is the injection seam. Omit it to spawn `codex app-server --stdio`
 * through the production transport, or pass one to run against a host-managed
 * connection or a deterministic double.
 */
export type CodexProviderOptions = {
  readonly transport?: CodexTransportFactory;
  /**
   * Executable path or `PATH` name for the Codex CLI. Host configuration only;
   * never derived from prompt text, turn input or session options.
   *
   * Resolve this to the standalone Codex binary. A Node-based launcher shim on
   * `PATH` is a different program with different process semantics.
   */
  readonly executable?: string;
  /** Extra leading arguments, before `app-server --stdio`. Host configuration. */
  readonly extraArgs?: readonly string[];
  /** Default model, overridable per session. */
  readonly model?: string;
  /** Default execution policy, overridable per session. Defaults to `read-only`. */
  readonly sandboxMode?: CodexSandboxMode;
  /**
   * Client identity sent in `initialize.params.clientInfo.name`. Upstream uses
   * it for compliance-log attribution, so a host with its own registered client
   * name should set it.
   */
  readonly clientName?: string;
  /** Client version reported in `initialize.params.clientInfo.version`. */
  readonly clientVersion?: string;
  /**
   * Deadline for a single RPC round-trip, in milliseconds. Turns are unbounded;
   * round-trips are not, because a live peer that never answers would otherwise
   * hang a run forever.
   */
  readonly requestTimeoutMs?: number;
};

export type CodexProviderFactory = (options?: CodexProviderOptions) => AgentProvider;
