---
'@relvo-labs/agent-runtime': minor
---

BREAKING: `interrupt_run` now rejects unknown or cross-session run IDs with `unknown_run`, and history reads, replaying subscriptions, and `quiesce()` reject after a provider ingestion fault. Inspect `getProviderIngestionFaults()` to identify the affected session.

Provider ingestion failures leave a bounded queryable fault without retaining event bodies. Close and shutdown still complete cleanup and keep their normal receipts. Filtered subscriptions stay bounded, close retries preserve the original interruption fact, and history reads use at most three session-scoped page reads before a retryable contention error.
