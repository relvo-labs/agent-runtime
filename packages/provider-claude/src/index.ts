/**
 * `@relvo-labs/agent-provider-claude` — a Claude adapter for the neutral
 * provider SPI.
 *
 * One responsibility: translate between `@relvo-labs/agent-provider` and the
 * official Claude Agent SDK's structured `query()` surface. No PTY, no terminal
 * scraping, no ANSI parsing, and no provider-native identifier in anything it
 * emits.
 *
 * The SDK itself is an optional peer dependency resolved at runtime — see
 * `binding.ts` for why — so a host may either install it and let the adapter
 * bind it, or supply its own `query` through `ClaudeProviderOptions`.
 */

export {
  createClaudeProvider,
  CLAUDE_PROVIDER_ID,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_AGENT_SDK_VERSION,
} from './provider.ts';

export { CLAUDE_AGENT_SDK_PACKAGE } from './binding.ts';

export {
  ClaudePermissionModeSchema,
  ClaudeSessionOptionsSchema,
  type ClaudeProviderOptions,
  type ClaudeProviderFactory,
  type ClaudeSessionOptions,
} from './options.ts';

export type {
  ClaudeInterruptReceipt,
  ClaudeMessageUuid,
  ClaudePermissionMode,
  ClaudePromptMessage,
  ClaudeQuery,
  ClaudeQueryHandle,
  ClaudeQueryMessage,
  ClaudeQueryOptions,
  ClaudeQueryParams,
} from './seam.ts';

/**
 * Adapter status.
 *
 * `live` since the text-run vertical slice: this package executes real Claude
 * turns when a `query` binding is available. It was `scaffold` in Foundation
 * v0.4, when the package deliberately shipped no integration at all.
 */
export const CLAUDE_ADAPTER_STATUS = 'live' as const;
