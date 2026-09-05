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
workspace failure. Cyclic provider/JSON-value graphs are rejected before staging while shared
acyclic references remain valid. Failed external effects reserve their command fingerprint;
failed-open rollback cleanup remains visible to exact retry and shutdown, whose internal close
cannot collide with caller command IDs. Provider completion is validated before interaction
settlement and replay rejects terminal runs with pending interactions. Local lease cleanup uses
private authority state, while borrowed-Git validates primitive argv and executes a detached
copy immune to serialization/prototype tricks. Line-bound wire documents enforce exact v0.4 in
Zod and JSON Schema. Zod/JSON Schema safety refinements have executable parity evidence. No
package publication or live provider integration is included.

Transient persistence failures after submit, response, or interrupt retain one in-memory
logical effect for exact retry without repeating the provider call; validation rejections
reserve safely inspected command IDs, and an interrupt fence rejects concurrent late
interactions. Hostile completion/accessor inputs normalize without throwing. Workspace
acquisition runtime-validates specs, binds borrowed roots to the requested realpath, and Git
operations require nominal provider-issued leases. Generated schemas now describe accepted
Zod input, including conditional behavior after default-filled omissions.
`validateWorkspaceLease` is now asynchronous to perform canonical path validation.
