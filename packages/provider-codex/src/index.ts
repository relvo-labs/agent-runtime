/**
 * `@relvo-labs/agent-provider-codex` — a Codex adapter for the neutral
 * provider SPI.
 *
 * One responsibility: translate between `@relvo-labs/agent-provider` and the
 * official Codex **app-server** protocol over structured stdio JSONL. No PTY,
 * no shell command string, no terminal scraping, no ANSI parsing, and no
 * provider-native identifier in anything it emits.
 *
 * The Codex CLI is not an npm dependency of this package at all: the wire types
 * in `seam.ts` are hand-authored against the pinned protocol, and the host
 * supplies the executable (or its own transport). That keeps the published
 * runtime closure permissive and free of a large platform payload.
 *
 * Pinned against **codex-cli 0.153.4** (`openai/codex@3d2ee51c`, tag
 * `rust-v0.153.4`), **stable** protocol surface only — `initialize` sends
 * `capabilities: null`, which cannot opt into the experimental API.
 */

export {
  createCodexProvider,
  CODEX_PROVIDER_ID,
  CODEX_ADAPTER_VERSION,
  type CodexAbandonedConnectionReport,
  type CodexProvider,
} from './provider.ts';

export {
  createCodexStdioTransport,
  CODEX_APP_SERVER_ARGV,
  CODEX_APP_SERVER_VERSION,
  CODEX_DEFAULT_EXECUTABLE,
  type CodexStdioTransportConfig,
} from './transport.ts';

export {
  CodexSandboxModeSchema,
  CodexSessionOptionsSchema,
  type CodexProviderOptions,
  type CodexProviderFactory,
  type CodexSandboxMode,
  type CodexSessionOptions,
} from './options.ts';

export type {
  CodexClientErrorReply,
  CodexClientMessage,
  CodexClientNotification,
  CodexClientRequest,
  CodexClientResponse,
  CodexRequestId,
  CodexTransport,
  CodexTransportEnd,
  CodexTransportFactory,
  CodexTransportParams,
  CodexWireError,
} from './seam.ts';

/**
 * Adapter status.
 *
 * `live` since the text-run vertical slice: this package executes real Codex
 * turns against an app-server connection. It was `scaffold` in Foundation v0.4,
 * when the package deliberately shipped no integration at all.
 */
export const CODEX_ADAPTER_STATUS = 'live' as const;
