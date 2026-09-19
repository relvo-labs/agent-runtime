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
   * Whether the app-server's command-approval requests are bridged to neutral
   * approval interactions.
   *
   * Defaults to `'none'`, which keeps the current posture exactly: `thread/start`
   * sends `approvalPolicy: 'never'`, the descriptor declares no approval
   * capability, and every server-initiated request is declined. That is the
   * honest reading of a host with no approval surface — a bridged approval
   * nobody answers would park a run, because this adapter imposes no settlement
   * deadline of its own.
   *
   * `'bridge'` sends `approvalPolicy: 'on-request'`, declares
   * `approval = { supported: true, modes: ['once', 'session'], blocking: true }`
   * and raises one `interaction.requested` per
   * `item/commandExecution/requestApproval` on the run that owns the turn. The
   * command only runs after an explicit `approved` response reaches
   * `respondToInteraction`. Every other server request stays declined — see the
   * mapping table in `interaction.ts`.
   *
   * This is provider-level, not a session override: a descriptor is one object
   * for the whole provider, and a capability that varied per session would be a
   * claim the descriptor cannot make truthfully.
   */
  readonly approvals?: 'none' | 'bridge';
  /**
   * Whether the app-server's `item/tool/requestUserInput` requests are bridged
   * to neutral `question_set` interactions.
   *
   * Defaults to `'none'`, which keeps the current posture: the method is
   * declined with `-32601` on its own request id, so a blocking request cannot
   * stall a turn while nobody answers it.
   *
   * `'bridge'` raises one `interaction.requested` per request, on the run that
   * owns `(threadId, turnId)`, and answers the native request with the whole
   * `{ answers: { [questionId]: { answers } } }` map once the host settles it —
   * so the same turn resumes where it paused.
   *
   * **No capability opt-in accompanies this.** `initialize.params.capabilities`
   * stays `null`: `item/tool/requestUserInput` and its parameter types are in
   * the pinned *stable* generated surface for 0.153.4, byte-identical to their
   * `--experimental` counterparts, while genuinely experimental methods such as
   * `thread/queue/*` are absent from that surface. Setting `experimentalApi`
   * would additionally widen `CommandExecutionRequestApprovalParams`, which the
   * approval bridge parses strictly — so opting in would break a shipped
   * feature to gain nothing. See ADR-0018.
   *
   * Provider-level, not a session override, for the same reason `approvals` is.
   */
  readonly questions?: 'none' | 'bridge';
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
