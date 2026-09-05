# ADR-0008: Workspace leases carry immutable ownership

Status: Accepted

## Context

A path alone cannot prove who may delete it. Treating caller directories as scratch space risks unrecoverable data loss.

## Decision

`existing` always acquires a borrowed lease and is never destructively cleaned. `managed` creates a fresh owned root under a configured base. Removal requires realpath containment, exact lease-root identity, safe depth, non-root/non-base target, and first release. Reports expose destructive operations; release is idempotent.

## Consequences

Callers cannot promote borrowed paths to managed. Provisioners must clean newly owned roots when setup fails.
