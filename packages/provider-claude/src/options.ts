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
  readonly model?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
};

export type ClaudeProviderFactory = (options?: ClaudeProviderOptions) => AgentProvider;
