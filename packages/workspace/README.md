# `@relvo-labs/agent-workspace`

Workspace leases and a guarded local-filesystem implementation. This package
owns acquisition and release, depends only on `agent-protocol`, and gives the
runtime a neutral `WorkspaceProvider`. Use it for existing directories or fresh
managed directories; use
[`agent-workspace-git`](https://github.com/relvo-labs/agent-runtime/blob/main/packages/workspace-git/README.md)
when managed acquisition must populate a Git checkout.

## Install

ESM-only; Node `^22.18.0 || ^24.11.0 || ^26.0.0`. No peer dependencies.
The example imports protocol clocks/IDs, so declare protocol directly too.

```bash
pnpm add @relvo-labs/agent-workspace @relvo-labs/agent-protocol
# or
npm install @relvo-labs/agent-workspace @relvo-labs/agent-protocol
```

## Quick start

Borrow the current directory, then create and release a fresh managed directory.
Use an application-owned absolute base path; this example uses a directory under
the operating system's temporary directory. The provider leaves the base itself
in place after release.

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCounterIdFactory, createSystemClock } from '@relvo-labs/agent-protocol';
import { createLocalWorkspaceProvider, validateWorkspaceLease } from '@relvo-labs/agent-workspace';

const workspaces = createLocalWorkspaceProvider({
  baseDirectory: join(tmpdir(), 'relvo-workspace-example'),
  clock: createSystemClock(),
  idFactory: createCounterIdFactory(),
});
try {
  const spec = { kind: 'existing', path: process.cwd() } as const;
  const borrowed = await workspaces.acquire(spec);
  console.log(await validateWorkspaceLease(spec, borrowed));
  console.log((await borrowed.release()).destructiveOperations); // []

  const managed = await workspaces.acquire({ kind: 'managed' });
  console.log(managed.root); // fresh directory below the configured base
  console.log(await managed.release()); // removes only that owned directory
  console.log((await managed.release()).alreadyReleased); // true
} finally {
  await workspaces.releaseAll();
}
```

When composed with the runtime, it acquires a lease on session open and releases
it on close or failed-open rollback. Interrupting a run does not release its lease.

## API overview

| Export                                                                 | Purpose                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `WorkspaceProvider`                                                    | `acquire(spec)` overloads and an attempt-all `releaseAll()` sweep.                       |
| `WorkspaceLease`                                                       | Canonical root, ID, ownership, acquisition time, `describe()` and `release()`.           |
| `BorrowedWorkspaceLease`, `ManagedWorkspaceLease`, `WorkspaceLeaseFor` | Ownership-specific lease types and spec-to-lease type mapping.                           |
| `createLocalWorkspaceProvider`, `LocalWorkspaceProviderOptions`        | Local acquisition with base directory, clock, ID factory and optional test removal seam. |
| `validateWorkspaceLease(spec, lease)`                                  | Async descriptor/live-handle validation, including existing-path canonical realpath.     |
| `checkRemovable(request)`                                              | Return a removal refusal or `undefined`.                                                 |
| `assertRemovable(request)`                                             | Throw a typed ownership error on a refusal.                                              |
| `RemovalRequest`, `RemovalRefusal`                                     | Inputs and diagnostics for removal checks.                                               |
| `isStrictlyInside(parent, child)`                                      | Segment-aware strict path containment.                                                   |
| `resolveRealPath(path)`                                                | Resolve symlinks; lexical resolution only when the path is absent.                       |

`/package.json` is the only additional export path. Workspace specs, descriptors
and release-report schemas/types are exported by `agent-protocol`.

## Ownership and limits

- `existing` means **borrowed**, permanently. Acquisition checks the directory;
  release never removes, resets or destructively cleans it and reports no
  destructive operations. Provider work may still edit it if requested by the host;
  a borrowed lease is an ownership guarantee, not a write sandbox.
- `managed` creates a new directory below the base. A named directory must not
  already exist. Root and ownership are privately captured and exposed through
  frozen views; caller mutation cannot grant removal authority.
- Removal checks canonical paths, managed ownership and unreleased state. It
  refuses the base itself, filesystem roots, shallow paths and symlink escapes.
  The local provider applies these guards only to its privately owned lease root.
- Concurrent release calls share one attempt. Failure leaves cleanup retryable;
  successful release makes later calls report `alreadyReleased: true`.
  `releaseAll()` attempts every tracked lease, retains failures for retry, and
  rejects with `workspace_unavailable`, aggregate causes and attempt/release counts.
- The local provider does not interpret `managed.source` or clone repositories.
  Use the Git provider for seed content from Git.
- Tracking and cleanup are process-local. There is no crash recovery, remote
  provisioning or enforced containment of a trusted provider's filesystem access.

## Related packages and reading

- [Protocol](https://github.com/relvo-labs/agent-runtime/blob/main/packages/protocol/README.md): workspace DTOs and typed errors.
- [Runtime](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md): lifecycle and disposal-before-release ordering.
- [Git workspaces](https://github.com/relvo-labs/agent-runtime/blob/main/packages/workspace-git/README.md): injected Git execution and clone support.
- [Lease ownership (ADR-0008)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0008-workspace-lease-ownership.md) and [foundation architecture](https://github.com/relvo-labs/agent-runtime/blob/main/docs/architecture/foundation-v0.4.md).

Pre-1.0; see [versioning](https://github.com/relvo-labs/agent-runtime/blob/main/docs/versioning.md).
