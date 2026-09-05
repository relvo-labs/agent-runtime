# ADR-0002: Command receipts and idempotency

Status: Accepted

## Context

Callers retry mutations after transport uncertainty. Retrying an unkeyed mutation can create duplicate work; ignoring key reuse can lose work.

## Decision

Every mutation carries a caller-generated command ID. Store the canonical payload
fingerprint and first receipt. Same ID plus same payload returns `duplicate` with the
original result and time. Same ID plus another payload returns `command_id_conflict`.
Persist rejections as well as success.

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
