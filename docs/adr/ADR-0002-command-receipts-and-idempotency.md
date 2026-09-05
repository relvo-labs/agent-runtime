# ADR-0002: Command receipts and idempotency

Status: Accepted

## Context

Callers retry mutations after transport uncertainty. Retrying an unkeyed mutation can create duplicate work; ignoring key reuse can lose work.

## Decision

Every mutation carries a caller-generated command ID. Store the canonical payload
fingerprint and first receipt. Same ID plus same payload returns `duplicate` with the
original result and time. Same ID plus another payload returns `command_id_conflict`.
Persist rejections as well as success. Validation rejection participates in the same rule
when the submitted value has a safely inspectable, schema-valid primitive command ID.
Runtime fingerprints the original raw input without invoking accessors and persists the
rejection; correcting the payload under that ID is therefore a conflict. Inputs whose
identity cannot be inspected safely cannot reserve an untrusted identity.

An external effect that fails before a receipt can be committed retains its first
fingerprint and acceptance time. Only the exact command may retry that effect or its
cleanup; the same ID with changed payload returns `command_id_conflict`. Successful
completion replaces the attempt reservation with the canonical receipt. In-memory
reservations last for the Runtime instance; a durable implementation must persist the
claim before invoking the effect. For `submit_turn`, `respond_to_interaction`, and
`interrupt_run`, a successful provider call followed by transient commit failure retains
the parsed command, original acceptance time, generated identities, and provider
handle/result needed to finish the same logical operation. Exact retry commits it without
calling the provider again. This is bounded by outstanding commands/sessions and is not
crash durability.

Within one Runtime instance, an active command-ID coordinator makes the receipt check and
effect one critical section. A separate per-session coordinator serializes state-changing
commands for one session, including competing interaction settlements, while unrelated
sessions proceed independently. Queue entries are removed after their final waiter
settles, so coordination state is bounded by in-flight work.

These maps are not a distributed lock. A durable deployment with multiple Runtime
processes must provide a single writer per session and command-ID scope, or extend its
store boundary with a transactional command claim/unique constraint before invoking an
external provider effect. The in-memory store guarantees only one Runtime instance.

## Consequences

Retries converge deterministically and one interaction response reaches the provider.
Receipt retention becomes durable-store policy and command IDs must be globally unique
within that policy scope. Multi-writer admission remains the durable host's responsibility.
