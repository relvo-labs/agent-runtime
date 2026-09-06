/**
 * Claude adapter package boundary.
 *
 * Foundation v0.4 intentionally ships no live Claude integration. Consumers
 * can depend on this package name and its factory contract without mistaking a
 * placeholder for a working provider.
 */

import type { JsonObject } from '@relvo-labs/agent-protocol';
import type { AgentProvider } from '@relvo-labs/agent-provider';

export const CLAUDE_PROVIDER_ID = 'claude' as const;
export const CLAUDE_ADAPTER_STATUS = 'scaffold' as const;

export type ClaudeProviderOptions = JsonObject;
export type ClaudeProviderFactory = (options?: ClaudeProviderOptions) => AgentProvider;
