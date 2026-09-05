# Provider development

A provider adapter implements the neutral `AgentProvider` SPI. It is a trusted in-process plugin, not sandboxed code.

1. Describe real capabilities structurally. Unsupported or lossy behavior is explicit; adapters must not fake symmetry.
2. Emit only `ProviderEventInput`. The runtime owns event/session/run identity, time, and sequence. Each synchronous `emit()` snapshots and validates its input before returning, so reusing or mutating an object cannot rewrite an earlier emission. Emission during `createSession()` or `startRun()` is allowed: Runtime stages at most the first 256 captured results in order and flushes them only after the owning start event. A deterministic tail beyond that bound is rejected with a warning diagnostic in the durable event log.
3. Resolve `ProviderRun.completion` with `ProviderRunTerminationSchema`: providers choose the outcome and typed error/reason, while Runtime validates it and stamps time. Rejection, malformed data, or an outcome impossible from the projected run state becomes one failed provider-contract outcome.
4. Keep native threads, conversations, child processes, file descriptors, and checkpoints inside `ProviderSession` and `ProviderRun`.
5. Export recovery only as the versioned `ProviderRecoveryRecord` with JSON-safe opaque data.
6. Interrupt one run independently of session disposal when supported. Declare `unsupported` when it is not.
7. Apply each correlated interaction response at most once. Raise a new interaction only while its run is `running` or `awaiting_interaction`; a request emitted during interruption or after termination is rejected with a diagnostic.
8. Make `ProviderSession.dispose()` idempotent and safe to retry after rejection; Runtime does not declare a session closed until provider disposal and workspace release both succeed.
9. Consume a workspace lease root; never acquire, release, reset, or delete it.
10. Use structured APIs. PTYs, terminal scraping, and ANSI parsing do not belong in core or the SPI.

The Codex and Claude packages in v0.4 are package boundaries only. A future live adapter must pass the provider and executor conformance tests without credentials in the canonical gate; provider-specific live tests belong outside that gate.
