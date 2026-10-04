# `@relvo-labs/agent-workspace-git`

Git-backed workspace provisioning through an injected command runner. It builds
on `agent-workspace` leases and `agent-protocol` DTOs, adds managed clone/checkout
and restricts queries in borrowed directories. Use it when a session needs a Git
checkout; use the [local workspace provider](https://github.com/relvo-labs/agent-runtime/blob/main/packages/workspace/README.md)
for directories without Git provisioning. The host owns Git execution and credentials.

## Install

ESM-only; Node `^22.18.0 || ^24.11.0 || ^26.0.0`. No peer dependencies or bundled
Git executable. This example requires host-installed `git` on `PATH` and imports
protocol directly; `agent-workspace` is a runtime dependency.

```bash
pnpm add @relvo-labs/agent-workspace-git @relvo-labs/agent-protocol
# or
npm install @relvo-labs/agent-workspace-git @relvo-labs/agent-protocol
```

## Quick start

Run from an existing Git checkout. This runner executes an argv vector without a
shell, keeps stdout/stderr separate and inherits the host's existing environment.
The example borrows the current checkout, runs one permitted query and releases
it without deleting or resetting it.

```ts
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCounterIdFactory, createSystemClock } from '@relvo-labs/agent-protocol';
import { createGitWorkspaceProvider, type GitRunner } from '@relvo-labs/agent-workspace-git';

const runGit: GitRunner = ({ argv, cwd }) =>
  new Promise((resolve, reject) => {
    execFile('git', [...argv], { cwd, shell: false, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        if (typeof error.code !== 'number') {
          reject(error); // spawn/transport failure, not a Git exit code
          return;
        }
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      resolve({ exitCode: 0, stdout, stderr });
    });
  });

const workspaces = createGitWorkspaceProvider({
  baseDirectory: join(tmpdir(), 'relvo-git-example'),
  clock: createSystemClock(),
  idFactory: createCounterIdFactory(),
  runGit,
});
try {
  const lease = await workspaces.acquire({ kind: 'existing', path: process.cwd() });
  console.log((await workspaces.git(lease, ['status', '--short'])).stdout);
  console.log((await lease.release()).destructiveOperations); // []
} finally {
  await workspaces.releaseAll();
}
```

For a managed checkout, pass `kind: 'managed'` with
`source: { kind: 'git', remote: '/absolute/path/to/source-repository', ref: 'main' }`
to `acquire`. The remote may be a host-selected local repository or Git remote;
the ref is optional. The provider creates a fresh owned root, runs
`git clone -- <remote> .`, then `git checkout --detach <ref>` if requested.
No worktree-management API is implemented.

## API overview

| Export                                                      | Purpose                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createGitWorkspaceProvider`, `GitWorkspaceProviderOptions` | Compose local leases with a required `runGit`, base directory, clock and ID factory. |
| `GitWorkspaceProvider`                                      | Workspace SPI plus `git(lease, argv)`.                                               |
| `GitRunner`                                                 | Host-supplied async command execution seam.                                          |
| `GitCommand`, `GitResult`                                   | `argv`/`cwd` request and `exitCode`/`stdout`/`stderr` result.                        |
| `assertReadOnly(argv)`                                      | Validate a complete permitted borrowed-workspace command.                            |
| `READ_ONLY_GIT_COMMANDS`, `READ_ONLY_GIT_SUBCOMMANDS`       | Frozen documentation catalogs; enforcement uses private exact templates.             |

`/package.json` is the only additional export path. Lease types belong to
`agent-workspace`; specs and reports belong to `agent-protocol`.

## Guarantees and limits

- Only active lease **object identities issued by this provider** are accepted
  by `git()`. Forged structural leases and released/releasing leases are refused.
  Authorization reads privately captured root and ownership.
- Borrowed trees accept exactly `['status', '--short']`,
  `['rev-parse', '--verify', 'HEAD']` and `['ls-files', '--cached', '--']`.
  The runner receives `--no-pager` and `--no-optional-locks` prepended to a
  detached validated argv copy. Arbitrary flags, output paths, config injection,
  external diff/textconv and hostile arrays are rejected before execution.
- Acquisition of an existing checkout never checks out, cleans, resets, stashes
  or mutates a branch. Borrowed release performs zero destructive operations.
- Managed roots use the local removal guards. Clone/checkout failure attempts
  release of the newly owned root. Failed release stays tracked for retry;
  `releaseAll()` attempts every outstanding lease before reporting aggregate failure.
- The library never invokes Git itself or discovers tokens, SSH agents, `.netrc`
  or keychains. Authentication is whatever the injected runner's environment
  already provides. The host must keep credentials out of remotes and diagnostics;
  this package does not promise output redaction: a nonzero exit includes up to
  2,000 characters of stderr in error details.
- The injected runner is trusted host code. Managed `git()` permits arbitrary
  argv; ownership guards are not an OS sandbox. Lease tracking is process-local,
  with no crash-durable cleanup or remote executor.

## Related packages and reading

- [Workspace](https://github.com/relvo-labs/agent-runtime/blob/main/packages/workspace/README.md): leases, validation and removal guards.
- [Runtime](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md): compose this provider as `workspaces`.
- [Lease ownership (ADR-0008)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0008-workspace-lease-ownership.md) and [foundation architecture](https://github.com/relvo-labs/agent-runtime/blob/main/docs/architecture/foundation-v0.4.md).

Pre-1.0; see [versioning](https://github.com/relvo-labs/agent-runtime/blob/main/docs/versioning.md).
