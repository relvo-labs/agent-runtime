---
'@relvo-labs/agent-protocol': minor
'@relvo-labs/agent-executor': minor
'@relvo-labs/agent-provider': minor
'@relvo-labs/agent-provider-codex': minor
'@relvo-labs/agent-provider-claude': minor
'@relvo-labs/agent-runtime': minor
'@relvo-labs/agent-workspace': minor
'@relvo-labs/agent-workspace-git': minor
---

BREAKING: establish the initial pre-1.0 Architecture Foundation v0.4 contract; provider
completion is timestamp-free and validated, workspace leases are ownership-typed, and
borrowed Git accepts only fixed query argv.

The foundation includes provider-neutral wire schemas,
executor and provider contracts, deterministic runtime behavior, safe workspace leases,
explicit adapter scaffolds, and publishability validation. Runtime also preserves bounded
synchronous provider emissions behind their owning start events and coordinates command
idempotency per command and session without blocking unrelated sessions. Store views are
mutation-isolated, provider emissions are snapshotted at each call, projection replay rejects
impossible transitions and ownership, completion/interaction races settle once, and
cleanup-aware shutdown coalesces concurrent attempts while preserving retry after provider or
workspace failure. Line-bound wire documents enforce exact v0.4 in Zod and JSON Schema, and
the borrowed-Git catalog cannot mutate its private enforcement policy. Zod/JSON Schema safety
refinements have executable parity evidence. No package publication or live provider
integration is included.
