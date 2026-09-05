# ADR-0008: Workspace leases carry immutable ownership

Status: Accepted

## Context

A path alone cannot prove who may delete it. Treating caller directories as scratch space risks unrecoverable data loss.

## Decision

`existing` always acquires a borrowed lease and is never destructively cleaned. `managed` creates a fresh owned root under a configured base. Runtime parses every third-party lease descriptor and asynchronously cross-checks its ID, root, timestamp, live ownership, requested ownership, and unreleased state before exposure. For an existing spec, the descriptor and handle root must equal the independently resolved realpath of the requested path; a redirect is quarantined without invoking its release method. An existing-to-managed mismatch is likewise quarantined and never reaches a suspect release method or provider-wide release sweep. Runtime tracks and releases each validated lease directly. Removal requires realpath containment, exact lease-root identity, safe depth, non-root/non-base target, and one atomically memoized release operation. Concurrent releases await that operation and cannot remove a recreated path a second time. A rejected operation clears only its in-flight marker so a later call can retry; successful release remains permanently idempotent. Reports expose destructive operations.

The local implementation keeps root, ownership, ID, and acquisition time in private
immutable authority state. Its frozen public accessors and descriptors are views only;
release authorization and removal never read caller-overwritable public properties.

Borrowed Git commands are validated without serialization hooks: input must be an ordinary
array whose indexed entries are own primitive strings and exactly equal one private
template. Execution receives a detached validated copy. `toJSON`, inherited array
behavior, accessors, proxies, and caller mutation cannot substitute different argv.

## Consequences

Callers cannot promote borrowed paths to managed. Local acquisition runtime-parses the
workspace spec before filesystem effects and checks a managed root's resolved containment
after creation. Git operations accept only lease object identities issued by that Git
provider and consult private captured ownership/root, so forged structural leases or
prototype changes cannot widen borrowed authority. Provisioners must clean newly owned roots
when setup fails. Out-of-tree workspace providers remain trusted in-process code, but
malformed ownership claims fail before an agent provider receives the path.
