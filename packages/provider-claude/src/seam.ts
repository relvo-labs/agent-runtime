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
 * What the host answers a permission prompt with.
 *
 * Narrower than the SDK's `PermissionResult` on purpose: `updatedPermissions`
 * is still not expressible, because this adapter writes no permission rule and
 * a grant is for the one call that asked.
 *
 * `updatedInput` *is* expressible, and it is the SDK's answer route for
 * `AskUserQuestion`. The pinned declaration
 * (`sdk-tools.d.ts` → `AskUserQuestionInput`) carries
 * `answers?: { [questionText: string]: string }`, described as "User answers
 * collected by the permission component", and the CLI returns the same map as
 * `AskUserQuestionOutput.answers`. Allowing the call with that input is
 * therefore how a question is *answered*, not merely approved — and it is the
 * only way the SDK lets a host supply one. An approval bridge never sets it.
 *
 * `message` on a denial is the text the model is shown so it can adapt. It is
 * the host's own words, and it is never copied into an event or an error.
 */
export type ClaudePermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

/**
 * One option on an `AskUserQuestion` question, mirrored from the pinned
 * `AskUserQuestionInput`.
 *
 * `preview` is declared so the adapter can *detect* it. This adapter never sets
 * `toolConfig.askUserQuestion.previewFormat`, so the pinned CLI does not
 * generate previews; a request that carries one anyway is refused whole rather
 * than rendered without it, because a dropped preview changes what the user
 * believes they are choosing between.
 */
export type ClaudeQuestionOption = {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
};

/** One question on an `AskUserQuestion` call. */
export type ClaudeQuestion = {
  readonly question: string;
  readonly header: string;
  readonly options: readonly ClaudeQuestionOption[];
  readonly multiSelect: boolean;
};

/**
 * The `AskUserQuestion` tool input, as the SDK hands it to `canUseTool`.
 *
 * Mirrors the pinned `AskUserQuestionInput`: 1–4 questions, each with 2–4
 * options, plus the optional answer-carrying fields the host fills in. The
 * adapter validates the whole thing at runtime before raising anything — this
 * type describes the shape it expects, not a shape it trusts.
 */
export type ClaudeAskUserQuestionInput = {
  readonly questions: readonly ClaudeQuestion[];
  /** Question text → answer string. Multi-select answers are `', '`-joined. */
  readonly answers?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, { readonly preview?: string; readonly notes?: string }>>;
  readonly metadata?: { readonly source?: string };
};

/**
 * The per-call context the SDK hands the permission callback.
 *
 * Only the two fields this adapter reads are declared. Everything else the SDK
 * passes — `requestId`, `suggestions`, `blockedPath`, `title`, rule provenance —
 * is deliberately absent: it is either provider-native identity that must not
 * escape, or prompt prose that would end up in a durable event log.
 *
 * `toolUseID` is read for adapter-internal bookkeeping only and never emitted.
 */
export type ClaudeToolPermissionRequest = {
  /** Aborted when the query is torn down while a prompt is outstanding. */
  readonly signal: AbortSignal;
  /** Native id of the tool call being asked about. Never emitted. */
  readonly toolUseID: string;
};

/**
 * The host permission callback, mirroring the SDK's `CanUseTool`.
 *
 * The SDK calls it before running a tool that its mode, rules and hooks did not
 * already decide, and waits for the answer: the prompt has no deadline of its
 * own, so whatever this returns is what happens. This adapter therefore returns
 * a decision or a denial, never `null` — the SDK reads `null` as "the consumer
 * already answered out of band", which would leave the tool blocked forever.
 */
export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  request: ClaudeToolPermissionRequest,
) => Promise<ClaudePermissionResult>;

/**
 * The subset of SDK query options this adapter sets.
 *
 * `permissionPrompts` says who answers a prompt the mode, rules and hooks did
 * not settle. `'none'` — the default posture — means nobody: anything that
 * would prompt is denied immediately, which is what an adapter that bridges no
 * interaction must do rather than hang a run nobody can answer. `'host'` is set
 * only alongside a `canUseTool` that raises a neutral approval interaction, so
 * the two are always consistent.
 */
export type ClaudeQueryOptions = {
  readonly cwd: string;
  readonly abortController: AbortController;
  readonly permissionPrompts: 'host' | 'none';
  readonly canUseTool?: ClaudeCanUseTool;
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
