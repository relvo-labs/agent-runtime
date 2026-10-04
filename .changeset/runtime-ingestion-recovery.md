---
'@relvo-labs/agent-runtime': minor
---

BREAKING: `interrupt_run` now rejects unknown or cross-session run IDs with `unknown_run`, and history reads, replaying subscriptions, and `quiesce()` reject after a provider ingestion fault. Inspect `getProviderIngestionFaults()` to identify the affected session.

Provider ingestion failures leave a bounded queryable fault; recovery, retry and cleanup semantics are described in the ingestion queue changeset. Filtered subscriptions stay bounded, close retries preserve the original interruption fact, and history reads use at most three session-scoped page reads before a retryable contention error.
