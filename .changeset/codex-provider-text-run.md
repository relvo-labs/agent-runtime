---
'@relvo-labs/agent-provider-codex': minor
---

Activate the Codex adapter: `createCodexProvider()` executes text turns through the neutral provider SPI over the official Codex app-server stdio JSONL protocol.

The package was previously a scaffold that exported only identifiers and a factory type. It is now live, and `CODEX_ADAPTER_STATUS` reports `'live'` instead of `'scaffold'`.

New exports: `createCodexProvider`, `CODEX_PROVIDER_ID`, `CODEX_ADAPTER_VERSION`, `createCodexStdioTransport`, `CODEX_APP_SERVER_ARGV`, `CODEX_APP_SERVER_VERSION`, `CODEX_DEFAULT_EXECUTABLE`, `CodexSandboxModeSchema`, `CodexSessionOptionsSchema`, the `CodexTransport` seam types, and the `CodexProvider` / `CodexAbandonedConnectionReport` cleanup types.

`createCodexProvider()` now returns `CodexProvider`, a narrowing of `AgentProvider` that adds `releaseAbandonedConnections()` and `abandonedConnectionCount`. This is additive — the value is still an `AgentProvider` everywhere one is expected, and the neutral provider SPI is unchanged. When a handshake fails _and_ tearing its connection down also fails, the connection is retained on the provider and the rejection reports `providerCode: 'handshake_cleanup_pending'`; `releaseAbandonedConnections()` retries every retained connection attempt-all and reports `{ attempted, released, pending }`. Previously that teardown failure was swallowed, which could leave a child process running with no owner and no evidence.

Teardown is now truthful about three separate facts. The inbound stream ends as soon as the child's stdout closes, so a live process with a closed output stream can no longer hang an admitted run. Leader exit also ends it, after a bounded `exitDrainMs` (new config field, default 250 ms) so that a descendant holding an inherited pipe cannot keep the stream — and every request waiting on it — open forever, while buffered final frames are still not truncated. And `close()` reports success only after verifying that the process group the adapter owns is empty.

Ownership evidence is tri-state, so "we could not find out" is never recorded as "nothing is there": `ENOENT`/`ESRCH` means genuinely gone, a different owning uid means provably not ours, and anything else — denied, unparsable, an unreadable listing — fails teardown with `group_cleanup_unverified` and keeps retry ownership. Members are recorded as exact `(PID, start time)` pairs while the group provably belongs to the transport, and that identity is re-read immediately before every signal, so a reused PID is never signalled. The remaining stat-then-kill window is documented rather than claimed away. Attribution needs `/proc`: elsewhere there is no post-exit sweep and no descendant-containment claim at all.

A `turn/start` whose outcome is unknown — a deadline, a connection lost mid-request, or a success carrying an unusable turn id — now fences the session: further runs are refused with `providerCode: 'session_fenced'` until it is disposed. A lost reply is not a rejection, and a retry could otherwise steer the first native turn or attribute it to a second Runtime run. An authoritative server rejection is unchanged and still leaves the session usable.

Early turn traffic that arrives before the `turn/start` reply can no longer discard the frame that ends the turn: streamed output is bounded and its loss is reported, while a terminal frame is admitted by evicting output instead. An implausible flood of unattributable terminal frames fails the run closed, fences the session and interrupts the native turn rather than dropping frames silently.

Server-controlled request metadata no longer reaches durable events: an unrecognised server-initiated request method is reported by a constant, and only methods on the pinned stable `ServerRequest` allowlist are named.

BREAKING: `CodexProviderOptions` is no longer the `JsonObject` alias it was as a scaffold; it is now a structured options type, and `CODEX_ADAPTER_STATUS` narrows to `'live'`. Code that assigned an arbitrary `JsonObject` to `CodexProviderOptions`, or compared the status against `'scaffold'`, must be updated. Nothing depended on the scaffold at runtime, because it executed nothing.

One provider session owns one app-server connection and one workspace-bound thread; each Runtime run owns exactly one correlated turn on that thread. The conversation is not reset per run and no process is respawned per run.

`descriptor.workspace.writes` is always `true`, including under `sandboxMode: 'read-only'`: that policy constrains Codex's own file tools but does not isolate MCP servers, hooks or plugins from the user's configuration. No side-effect-free behaviour is claimed, and `descriptor.extensions.isolatesConfiguredTooling` is `false`.

Scope is deliberately narrow and matches the descriptor: text input, streamed assistant text, per-turn token usage, and a cooperative interrupt. Tool activity, approvals, questions, and recovery are explicitly unsupported, and every server-initiated request is declined rather than left to stall a turn. Pinned to codex-cli 0.153.4 stable protocol surface; compatibility evidence is deterministic and carries no live-model verification.
