---
'@relvo-labs/agent-provider-codex': minor
---

Activate the Codex adapter: `createCodexProvider()` executes text turns through the neutral provider SPI over the official Codex app-server stdio JSONL protocol.

The package was previously a scaffold that exported only identifiers and a factory type. It is now live, and `CODEX_ADAPTER_STATUS` reports `'live'` instead of `'scaffold'`.

New exports: `createCodexProvider`, `CODEX_PROVIDER_ID`, `CODEX_ADAPTER_VERSION`, `createCodexStdioTransport`, `CODEX_APP_SERVER_ARGV`, `CODEX_APP_SERVER_VERSION`, `CODEX_DEFAULT_EXECUTABLE`, `CodexSandboxModeSchema`, `CodexSessionOptionsSchema`, and the `CodexTransport` seam types.

BREAKING: `CodexProviderOptions` is no longer the `JsonObject` alias it was as a scaffold; it is now a structured options type, and `CODEX_ADAPTER_STATUS` narrows to `'live'`. Code that assigned an arbitrary `JsonObject` to `CodexProviderOptions`, or compared the status against `'scaffold'`, must be updated. Nothing depended on the scaffold at runtime, because it executed nothing.

Scope is deliberately narrow and matches the descriptor: text input, streamed assistant text, per-turn token usage, and a cooperative interrupt. Tool activity, approvals, questions, and recovery are explicitly unsupported, and every server-initiated request is declined rather than left to stall a turn. Pinned to codex-cli 0.153.4 stable protocol surface; compatibility evidence is deterministic and carries no live-model verification.
