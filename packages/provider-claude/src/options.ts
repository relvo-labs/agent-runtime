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
  readonly model?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
};

export type ClaudeProviderFactory = (options?: ClaudeProviderOptions) => AgentProvider;
