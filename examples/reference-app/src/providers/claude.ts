/**
 * Opt-in real Claude profile.
 *
 * Registered only when explicitly enabled (see `runtime-factory.ts`); never
 * on by default, and never a fallback for a failed scripted or Codex
 * attempt. `query` is intentionally omitted so the adapter binds the
 * official `@anthropic-ai/claude-agent-sdk`'s own `query()` export at session
 * creation time — an injected `query` would not be a "real" profile.
 *
 * `@anthropic-ai/claude-agent-sdk` is an optional peer dependency, resolved at
 * runtime. If it is not installed on the host, `open_session` rejects with a
 * retryable `provider_unavailable` naming the package (see
 * `packages/provider-claude/README.md`) — a clean setup failure, not a crash
 * and not a silent fallback to the scripted lane.
 *
 * Authentication is entirely host-side and out of this app's control: the SDK
 * itself reads `ANTHROPIC_API_KEY` (or an alternative provider's env flags —
 * Bedrock, the Claude Platform on AWS, Vertex, or Foundry) from this process's
 * own environment. See the live upstream quickstart:
 * https://code.claude.com/docs/en/agent-sdk/quickstart (read during
 * implementation; this file guesses nothing about auth and changes nothing
 * about it — it does not read, set or forward any credential itself).
 */

import { createClaudeProvider } from '@relvo-labs/agent-provider-claude';
import type { AgentProvider } from '@relvo-labs/agent-provider';

export const CLAUDE_REAL_PROVIDER_ID = 'claude';

/**
 * The model id used in this repository's own documented example
 * (`packages/provider-claude/README.md`), not a guess — overridable via
 * `REFERENCE_APP_CLAUDE_MODEL` (see `config.ts`).
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export type ClaudeRealProviderOptions = {
  readonly model?: string;
};

export function createClaudeRealProvider(options: ClaudeRealProviderOptions = {}): AgentProvider {
  return createClaudeProvider({
    model: options.model ?? DEFAULT_CLAUDE_MODEL,
    // Conservative default posture (see the issue's security defaults):
    // never `acceptEdits`/`bypassPermissions`. Provider-declared intent for
    // the SDK, not a runtime-enforced sandbox (ADR-0009).
    permissionMode: 'plan',
  });
}
