---
'@relvo-labs/agent-provider-codex': minor
---

Activate the Codex adapter: `createCodexProvider()` executes text turns through the neutral provider SPI over the official Codex app-server stdio JSONL protocol.

The package was previously a scaffold that exported only identifiers and a factory type. It is now live, and `CODEX_ADAPTER_STATUS` reports `'live'` instead of `'scaffold'`.

New exports: `createCodexProvider`, `CODEX_PROVIDER_ID`, `CODEX_ADAPTER_VERSION`, `createCodexStdioTransport`, `CODEX_APP_SERVER_ARGV`, `CODEX_APP_SERVER_VERSION`, `CODEX_DEFAULT_EXECUTABLE`, `CodexSandboxModeSchema`, `CodexSessionOptionsSchema`, and the `CodexTransport` seam types.

BREAKING: `CodexProviderOptions` is no longer the `JsonObject` alias it was as a scaffold; it is now a structured options type, and `CODEX_ADAPTER_STATUS` narrows to `'live'`. Code that assigned an arbitrary `JsonObject` to `CodexProviderOptions`, or compared the status against `'scaffold'`, must be updated. Nothing depended on the scaffold at runtime, because it executed nothing.

One provider session owns one app-server connection and one workspace-bound thread; each Runtime run owns exactly one correlated turn on that thread. The conversation is not reset per run and no process is respawned per run.

`descriptor.workspace.writes` is always `true`, including under `sandboxMode: 'read-only'`: that policy constrains Codex's own file tools but does not isolate MCP servers, hooks or plugins from the user's configuration. No side-effect-free behaviour is claimed, and `descriptor.extensions.isolatesConfiguredTooling` is `false`.

Scope is deliberately narrow and matches the descriptor: text input, streamed assistant text, per-turn token usage, and a cooperative interrupt. Tool activity, approvals, questions, and recovery are explicitly unsupported, and every server-initiated request is declined rather than left to stall a turn. Pinned to codex-cli 0.153.4 stable protocol surface; compatibility evidence is deterministic and carries no live-model verification.
