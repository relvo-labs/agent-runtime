# ADR-0002: Command receipts and idempotency

Status: Accepted

## Context

Callers retry mutations after transport uncertainty. Retrying an unkeyed mutation can create duplicate work; ignoring key reuse can lose work.

## Decision

Every mutation carries a caller-generated command ID. Store the canonical payload fingerprint and first receipt. Same ID plus same payload returns `duplicate` with the original result and time. Same ID plus another payload returns `command_id_conflict`. Persist rejections as well as success.

## Consequences

Retries converge deterministically. Receipt retention becomes durable-store policy and command IDs must be globally unique within that policy scope.
