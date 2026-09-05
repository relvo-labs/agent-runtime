# `@relvo-labs/agent-workspace`

Workspace SPI and guarded local implementation. Existing directories are borrowed and never removed; third-party descriptors are validated and cross-checked; managed directories are newly created, ownership-bound, and released through one concurrency-idempotent operation. Concurrent release callers coalesce, failed attempts remain retryable, and success is permanently idempotent.
