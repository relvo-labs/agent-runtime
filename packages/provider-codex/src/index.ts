/**
 * Codex adapter package boundary.
 *
 * Foundation v0.4 intentionally ships no live Codex integration. Consumers
 * can depend on this package name and its factory contract without mistaking a
 * placeholder for a working provider.
 */

import type { JsonObject } from '@relvo-labs/agent-protocol';
import type { AgentProvider } from '@relvo-labs/agent-provider';

export const CODEX_PROVIDER_ID = 'codex' as const;
export const CODEX_ADAPTER_STATUS = 'scaffold' as const;

export type CodexProviderOptions = JsonObject;
export type CodexProviderFactory = (options?: CodexProviderOptions) => AgentProvider;
