/**
 * The typed query seam.
 *
 * This adapter never imports the Claude Agent SDK statically. It talks to a
 * *structural* description of the single SDK entry point it uses —
 * `query({ prompt, options })` — declared here.
 *
 * Two consequences, both deliberate:
 *
 *  1. Every test can hand the adapter a deterministic in-memory `ClaudeQuery`,
 *     so the canonical gate never needs Anthropic credentials, a network call
 *     or a child process.
 *  2. The official SDK's `query` is assignable to `ClaudeQuery` without a cast,
 *     so the production default (see `binding.ts`) is the same code path the
 *     tests exercise — not a parallel one.
 *
 * The shapes below are narrow on purpose: they describe only the fields this
 * adapter reads or writes, mirrored from `@anthropic-ai/claude-agent-sdk`
 * 0.3.259. Anything the SDK adds is carried through as `unknown` and validated
 * at runtime, because an external process is untrusted input even when it is
 * first-party.
 */

/**
 * Permission posture handed to the SDK.
 *
 * This is provider-declared *intent* for the agent process, not a sandbox the
 * runtime enforces. See `docs/adr/ADR-0009-provider-trust-boundary.md`.
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * A client message identifier.
 *
 * Shaped like the SDK's `UUID` (from `node:crypto`) so a stamped prompt stays
 * assignable to `SDKUserMessage`.
 */
export type ClaudeMessageUuid = `${string}-${string}-${string}-${string}-${string}`;

/**
 * One user message pushed into the SDK's streaming input.
 *
 * `uuid` is the *client* message id. Stamping it is what makes a turn
 * attributable: the SDK echoes it back as `user_message_uuid` on the turn's
 * first reply frame and on its result, and lists it in an interrupt receipt's
 * `still_queued` when the message survived the stop. An unstamped message runs
 * but can never be correlated or listed, so this adapter always stamps one.
 * The value is generated per run and never leaves the adapter.
 */
export type ClaudePromptMessage = {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly uuid?: ClaudeMessageUuid;
};

/**
 * The subset of SDK query options this adapter sets.
 *
 * `permissionPrompts: 'none'` is not configurable: this adapter declares no
 * interaction capability, so a prompt that nobody can answer must fail closed
 * rather than hang a run forever.
 */
export type ClaudeQueryOptions = {
  readonly cwd: string;
  readonly abortController: AbortController;
  readonly permissionPrompts: 'none';
  readonly model?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: string[];
  readonly disallowedTools?: string[];
  readonly allowDangerouslySkipPermissions?: boolean;
};

/**
 * One message produced by the SDK.
 *
 * Only `type` is known statically. Everything this adapter reads is `unknown`
 * and is narrowed by the translator, so a message shape that changes upstream
 * degrades to "ignored", never to a crash or a malformed event.
 */
export type ClaudeQueryMessage = {
  readonly type: string;
  readonly subtype?: string;
  readonly message?: unknown;
  readonly usage?: unknown;
  readonly is_error?: boolean;
  readonly error?: unknown;
  readonly errors?: unknown;
  readonly session_id?: string;
  /**
   * Client uuid of the user message that triggered this turn. Present on the
   * turn's first reply frame and on its result; absent on later frames, on
   * synthetic/scheduled turns, and on turns submitted without a client uuid.
   */
  readonly user_message_uuid?: string;
  /** Every client uuid this turn consumed, when a batch was coalesced. */
  readonly user_message_uuids?: unknown;
  /** Non-null on a subagent frame of the turn that is already bound. */
  readonly parent_tool_use_id?: unknown;
};

/**
 * The value an interrupt resolves with on a CLI advertising
 * `interrupt_receipt_v1`. Older CLIs resolve with `undefined`.
 *
 * `still_queued` lists client uuids that **survived** the stop and will still
 * run. The public `interrupt()` takes no arguments in the pinned SDK, so
 * `cancel_queued` cannot be requested and a survivor cannot be recalled — this
 * adapter therefore reports the stop as not applied rather than claiming a run
 * was interrupted while its input is still going to execute.
 */
export type ClaudeInterruptReceipt = {
  readonly still_queued?: unknown;
  readonly cancelled?: unknown;
};

/**
 * The live query.
 *
 * Methods are declared with method syntax so the SDK's `Query` (an
 * `AsyncGenerator`) stays assignable to this type.
 */
export type ClaudeQueryHandle = AsyncIterable<ClaudeQueryMessage> & {
  /** Cooperative stop for the current turn. Does not end the session. */
  interrupt(): Promise<unknown>;
  /** Present on the SDK's generator; used to tear the query down on dispose. */
  return?(value?: unknown): Promise<unknown>;
};

export type ClaudeQueryParams = {
  readonly prompt: AsyncIterable<ClaudePromptMessage>;
  readonly options: ClaudeQueryOptions;
};

/**
 * The one SDK function this adapter depends on.
 *
 * `query` from `@anthropic-ai/claude-agent-sdk` satisfies this type as-is.
 */
export type ClaudeQuery = (params: ClaudeQueryParams) => ClaudeQueryHandle;
