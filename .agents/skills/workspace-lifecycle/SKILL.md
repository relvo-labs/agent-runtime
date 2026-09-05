---
name: workspace-lifecycle
description: Acquire, lease and release agent workspaces so that borrowed directories are never destructively mutated and managed cleanup stays ownership-bound and idempotent.
version: 1.0.0
stability: stable
tags: [workspace, lease, cleanup, filesystem-safety]
---

# Workspace lifecycle

## Trigger

Use this skill when a change touches any of:

- `packages/workspace/src/` or `packages/workspace-git/src/`
- anything that acquires, releases, cleans or deletes a directory
- the `WorkspaceSpec`, `WorkspaceLease` or release-report shapes
- git clone / worktree provisioning

## Counter-trigger

Do not use this skill when:

- the change is only the Zod shape of a workspace DTO — coordinate with
  `runtime-contract-evolution`, which owns schema classification
- the change is credential handling for a git remote — **out of scope**; this repository
  does not own credentials
- the change is which package may import the workspace SPI — use `package-architecture`

## Owns

- `packages/workspace/src` — workspace SPI, lease and ownership model
- `packages/workspace-git/src` — git-backed workspace provider
- `docs/adr/ADR-0008-workspace-lease-ownership.md` — the ownership decision record

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/provider/src` — owned by `provider-adapter-development`

## Relationships

- `depends-on` → `runtime-contract-evolution` — workspace DTOs are protocol types.
- `boundary-with` → `provider-adapter-development` — a provider _consumes_ a lease root; it never acquires or releases the lease itself.

## Procedure

1. **Ownership is decided at acquisition and is immutable.**

   | Spec kind  | Ownership  | Runtime may create | Runtime may delete       |
   | ---------- | ---------- | ------------------ | ------------------------ |
   | `existing` | `borrowed` | no                 | **never**                |
   | `managed`  | `managed`  | yes                | only the root it created |

   There is no promotion from `borrowed` to `managed`. A caller cannot opt a borrowed
   directory into cleanup.

2. **Never write a destructive call that is not guarded.** Every removal must pass
   `assertRemovable()`, which requires _all_ of:
   - the lease exists and its `ownership === 'managed'`
   - the target is exactly the lease's own `root`
   - `root` resolves (after `realpath`) inside the provider's configured base directory
   - `root` is not the base directory itself, not `/`, and has depth > 1
   - the lease has not already been released

   If you are tempted to add a `force` flag that bypasses this, stop.

3. **Release is idempotent and reports what it did.** `release()` returns a
   `WorkspaceReleaseReport` containing `destructiveOperations: string[]`. For a borrowed
   lease this array must be empty — that is a tested invariant, not a convention. Calling
   `release()` twice returns `{ alreadyReleased: true }` and performs nothing.

4. **Do not follow symlinks out of the base directory.** Resolve with `fs.realpath`
   before comparing paths, and compare on path segments (`a/b` is not inside `a/bc`).

5. **git workspaces:** `managed` git workspaces are provisioned into a fresh directory
   under the configured base. `existing` git workspaces are _inspected only_ — no
   `checkout`, `clean`, `reset`, `stash` or branch mutation. Shell out through the
   injected `runGit` seam so tests can assert the exact argv that would run; never call
   git directly from library code.

6. **Leases outlive runs, not sessions.** A lease is acquired when a session opens and
   released when the session closes or fails. Interrupting a run must not touch the
   workspace.

## Verification

```bash
pnpm --filter @relvo-labs/agent-workspace test
pnpm --filter @relvo-labs/agent-workspace-git test
pnpm gate
```

The workspace suites include negative tests that assert a borrowed release performs zero
destructive operations and that an escape attempt (`root` symlinked outside the base) is
refused. A change that makes those tests pass by weakening the assertion is rejected.

## Provenance

- Source: independent — authored for this repository against the Node `fs`/`fs.promises`
  documentation (`realpath`, `rm`) and `git-worktree(1)`.
