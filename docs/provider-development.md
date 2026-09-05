# Provider development

A provider adapter implements the neutral `AgentProvider` SPI. It is a trusted in-process plugin, not sandboxed code.

1. Describe real capabilities structurally. Unsupported or lossy behavior is explicit; adapters must not fake symmetry.
2. Emit only `ProviderEventInput`. The runtime owns event/session/run identity, time, and sequence.
3. Keep native threads, conversations, child processes, file descriptors, and checkpoints inside `ProviderSession` and `ProviderRun`.
4. Export recovery only as the versioned `ProviderRecoveryRecord` with JSON-safe opaque data.
5. Interrupt one run independently of session disposal when supported. Declare `unsupported` when it is not.
6. Apply each correlated interaction response at most once.
7. Consume a workspace lease root; never acquire, release, reset, or delete it.
8. Use structured APIs. PTYs, terminal scraping, and ANSI parsing do not belong in core or the SPI.

The Codex and Claude packages in v0.4 are package boundaries only. A future live adapter must pass the provider and executor conformance tests without credentials in the canonical gate; provider-specific live tests belong outside that gate.
