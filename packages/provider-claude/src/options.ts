/**
 * Adapter configuration.
 *
 * Two layers, one shape: defaults supplied once when the provider is created,
 * and per-session overrides that arrive as opaque JSON on `open_session`. The
 * override layer is parsed with Zod because it crosses a trust boundary — the
 * runtime forwards whatever the caller sent — so an unknown key is a typed
 * rejection rather than a silently ignored intention.
 */

import { z } from 'zod';
import type { AgentProvider } from '@relvo-labs/agent-provider';

import type { ClaudePermissionMode, ClaudeQuery } from './seam.ts';

export const ClaudePermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

const toolName = z.string().min(1).max(200);

/** Per-session overrides accepted in `open_session`'s `providerOptions`. */
export const ClaudeSessionOptionsSchema = z.strictObject({
  /** Model identifier passed through verbatim; the SDK owns the default. */
  model: z.string().min(1).max(200).optional(),
  /** Upper bound on agent turns for one run. */
  maxTurns: z.int().positive().max(1000).optional(),
  /**
   * Permission posture for the agent process. Provider-declared intent for the
   * SDK, never a sandbox the runtime enforces (ADR-0009).
   */
  permissionMode: ClaudePermissionModeSchema.optional(),
  allowedTools: z.array(toolName).max(200).optional(),
  disallowedTools: z.array(toolName).max(200).optional(),
});

export type ClaudeSessionOptions = z.infer<typeof ClaudeSessionOptionsSchema>;

/**
 * Options for `createClaudeProvider`.
 *
 * `query` is the injection seam. When it is omitted the adapter binds the
 * official `@anthropic-ai/claude-agent-sdk` export at session creation time.
 */
export type ClaudeProviderOptions = {
  readonly query?: ClaudeQuery;
  /**
   * How a turn is bound to the run that submitted it.
   *
   * `'required'` (the default) attributes a frame only to the run its client
   * uuid names. An unstamped frame that no bound turn accounts for is dropped:
   * a background, scheduled or synthetic turn is unstamped for exactly the same
   * reason a legacy producer's reply is, so treating absence as ownership would
   * let another turn's output be published and its result complete this run.
   *
   * `'legacy-unstamped'` restores attribution by position for a producer known
   * not to stamp at all — a pre-`user_message_uuid` CLI, where requiring a stamp
   * that can never arrive would hang every run. Declare it only when the host
   * knows which producer it bound; on a stamping producer it re-opens the
   * misattribution above until the first stamp is observed.
   */
  readonly correlation?: 'required' | 'legacy-unstamped';
  /**
   * Whether tool-permission prompts are bridged to neutral approvals.
   *
   * `'none'` (the default) tells the SDK nobody answers prompts: anything the
   * permission mode, rules and hooks did not already decide is denied at once.
   * The adapter declares no approval capability, which is the honest reading of
   * a host that has no approval surface — a bridged prompt nobody answers would
   * park the run instead, and this adapter imposes no settlement deadline.
   *
   * `'bridge'` installs the SDK's host permission callback and raises a neutral
   * `approval` interaction for each prompt, granted only by an explicit
   * `approved` / `once` response. Declare it only when the host actually
   * settles interactions.
   *
   * This is deliberately not a per-session override: the capability descriptor
   * is provider-level, and a session that behaved differently would make that
   * descriptor untrue.
   */
  readonly approvals?: 'none' | 'bridge';
  /**
   * Whether the SDK's `AskUserQuestion` tool is bridged to neutral
   * `question_set` interactions.
   *
   * `'none'` (the default) leaves today's behaviour exactly: no question is
   * claimed, and an `AskUserQuestion` call that reaches this adapter's callback
   * is denied with a message telling the model to ask in its reply instead.
   *
   * `'bridge'` installs the SDK's host callback and raises one neutral
   * `question_set` per `AskUserQuestion` call, answered by returning the
   * pinned `updatedInput.answers` map — so the same run resumes where it
   * paused. Declare it only when the host actually displays questions and
   * settles interactions: this adapter imposes no settlement deadline, so an
   * unanswered question parks the run.
   *
   * Setting this also installs the callback when `approvals` is `'none'`. That
   * does not widen what the agent may do: every non-question tool prompt
   * reaching the callback is denied, which is the same outcome as the
   * `permissionPrompts: 'none'` posture it replaces.
   *
   * Provider-level, not a session override, for the same reason `approvals` is:
   * the capability descriptor is one object for the whole provider.
   */
  readonly questions?: 'none' | 'bridge';
  readonly model?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
};

export type ClaudeProviderFactory = (options?: ClaudeProviderOptions) => AgentProvider;
