# ADR-0008: Workspace leases carry immutable ownership

Status: Accepted

## Context

A path alone cannot prove who may delete it. Treating caller directories as scratch space risks unrecoverable data loss.

## Decision

`existing` always acquires a borrowed lease and is never destructively cleaned. `managed` creates a fresh owned root under a configured base. Runtime parses every third-party lease descriptor and cross-checks its ID, root, timestamp, live ownership, requested ownership, and unreleased state before exposure. An existing-to-managed mismatch is quarantined: Runtime reports an ownership violation and never invokes the suspect release method or a provider-wide release sweep. Runtime tracks and releases each validated lease directly. Removal requires realpath containment, exact lease-root identity, safe depth, non-root/non-base target, and one atomically memoized release operation. Concurrent releases await that operation and cannot remove a recreated path a second time. A rejected operation clears only its in-flight marker so a later call can retry; successful release remains permanently idempotent. Reports expose destructive operations.

## Consequences

Callers cannot promote borrowed paths to managed. Provisioners must clean newly owned roots when setup fails. Out-of-tree workspace providers remain trusted in-process code, but malformed ownership claims fail before a provider receives the path.
