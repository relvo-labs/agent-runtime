# Provider development

A provider adapter implements the neutral `AgentProvider` SPI. It is a trusted in-process plugin, not sandboxed code.

1. Describe real capabilities structurally. Unsupported or lossy behavior is explicit; adapters must not fake symmetry.
2. Emit only `ProviderEventInput` as ordinary acyclic data—never cycles, getters, or proxies. The runtime owns event/session/run identity, time, and sequence. Each synchronous `emit()` applies the shared JSON guard, snapshots, and validates its input before returning, so reusing or mutating an object cannot rewrite an earlier emission. Cyclic/non-plain input becomes a typed provider-contract diagnostic and is not staged as event data. Shared references remain valid when the graph is acyclic. Emission during `createSession()` or `startRun()` is allowed: Runtime stages at most the first 256 captured results in order and flushes them only after the owning start event. A deterministic tail beyond that bound is rejected with a warning diagnostic in the durable event log.
3. Resolve `ProviderRun.completion` with `ProviderRunTerminationSchema`: providers choose the outcome and typed error/reason, while Runtime captures/parses it without allowing getters or proxies to throw and stamps time. Rejection, malformed or hostile data, or an outcome impossible from the projected run state becomes one failed provider-contract outcome.
4. Keep native threads, conversations, child processes, file descriptors, and checkpoints inside `ProviderSession` and `ProviderRun`.
5. Export recovery only as the versioned `ProviderRecoveryRecord` with JSON-safe opaque data.
6. Interrupt one run independently of session disposal when supported. Declare `unsupported` when it is not.
7. Apply each correlated interaction response at most once. Raise a new interaction only while its run is `running` or `awaiting_interaction`; Runtime installs the interrupt fence before awaiting provider work, so a request emitted during interruption or after termination is rejected with a diagnostic.
8. Make `ProviderSession.dispose()` idempotent and safe to retry after rejection; Runtime does not declare a session closed until provider disposal and workspace release both succeed.
9. Consume a workspace lease root; never acquire, release, reset, or delete it.
10. Use structured APIs. PTYs, terminal scraping, and ANSI parsing do not belong in core or the SPI.

Two adapters are live, and they illustrate the two shapes a third-party boundary can take.

The Claude package drives the official Claude Agent SDK's structured `query()` API through a typed injection seam. An adapter that depends on a non-permissively licensed SDK declares it as an optional peer dependency and resolves it at runtime, so the published runtime closure stays permissive and the download stays opt-in.

The Codex package speaks the official Codex app-server protocol directly over stdio JSONL. It has **no** Codex dependency: the wire types are hand-authored against a pinned upstream release, and the host supplies the executable. Because it really does spawn a child process, it carries extra structural obligations — an argv vector and never a shell command string, one module that is allowed to spawn, stdout parsed as bounded JSONL and stderr never parsed at all. `tools/repo/check-static.ts` enforces those mechanically.

Both keep the canonical gate credential-free and network-free: Claude through its seam, Codex through its transport seam plus a local stand-in server for the spawning paths a fake cannot exercise. Live provider tests still belong outside that gate, and "wire-compatible with a pinned release" must never be presented as "verified against a live model".

A provider-side execution policy is not an isolation boundary either. Codex's `sandboxMode: 'read-only'` constrains that agent's own file tools; it says nothing about MCP servers, hooks or plugins the user's configuration starts, which run with their own authority. An adapter must not derive a `workspace.writes: false` claim — or any side-effect-free claim — from a policy name it does not enforce. Declare the conservative value and say so in the descriptor.

## Cleanup an adapter owns before a session exists

`ProviderSession.dispose()` is the SPI's retryable cleanup handle, and it only exists once `createSession()` has resolved. An adapter that acquires a real resource _during_ the handshake — a child process, a socket — therefore has a window where a failure leaves something running that the runtime cannot reach: it never received a session, so it has nothing to dispose, and its open-session rollback can only retry what it was handed.

Tearing that resource down inside the failure path is the normal answer. The case that must not be swallowed is when the teardown _itself_ fails. `close().catch(() => undefined)` there converts a live orphaned process into silence: no error, no owner, no evidence. Instead, keep the resource on an object that outlives the rejected call — the adapter instance the host already holds — expose an attempt-all retry that reports what it released and what is still pending, and say plainly in the rejection that cleanup is outstanding. The Codex adapter does this with `releaseAbandonedConnections()` and `abandonedConnectionCount`, which are adapter-specific public API; widening the neutral SPI for it would have been a break for every out-of-tree adapter.

The same honesty applies to what "closed" means. Process exit, input-stream EOF and release of the resources a process owned are three separate facts. An adapter may end its inbound stream the moment the peer's output closes — nothing more can arrive — but it must not report cleanup complete until the things it actually spawned are gone, and it must not claim containment of descendants it cannot verify.
