/**
 * `@relvo-labs/agent-workspace-git` — git-backed workspaces.
 *
 * Two boundaries are deliberate:
 *
 *  1. **No credential ownership.** This package never reads a token, a
 *     `.netrc`, an SSH agent or a keychain. Authentication is whatever the
 *     injected `runGit` implementation's environment already provides. A
 *     library that quietly discovers credentials is a library that quietly
 *     exfiltrates them.
 *  2. **No git in library code.** Every git invocation goes through the
 *     injected `runGit` seam, so a test can assert the exact argv that *would*
 *     run without a git binary, and so an `existing` workspace can be proven to
 *     receive only read-only commands.
 */

import {
  AgentRuntimeError,
  agentError,
  type Clock,
  type IdFactory,
  type WorkspaceReleaseReport,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';
import { createLocalWorkspaceProvider, type WorkspaceLease, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

export type GitCommand = {
  readonly argv: readonly string[];
  readonly cwd: string;
};

export type GitResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The only way this package touches git. */
export type GitRunner = (command: GitCommand) => Promise<GitResult>;

export type GitWorkspaceProviderOptions = {
  readonly baseDirectory: string;
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly runGit: GitRunner;
  readonly removeDirectory?: (path: string) => Promise<void>;
};

/**
 * Commands permitted against a **borrowed** (`existing`) workspace.
 *
 * Read-only by construction. `checkout`, `clean`, `reset`, `stash`, `fetch` and
 * anything else that mutates the caller's tree is absent on purpose, and
 * `assertReadOnly` enforces it rather than trusting the call sites.
 */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
  'rev-parse',
  'status',
  'log',
  'show',
  'diff',
  'branch',
  'remote',
  'config',
  'ls-files',
];

export function assertReadOnly(argv: readonly string[]): void {
  const subcommand = argv[0];
  if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new AgentRuntimeError(
      agentError(
        'workspace_ownership_violation',
        `\`git ${argv.join(' ')}\` is not permitted against a borrowed workspace`,
        { details: { argv: [...argv], allowed: [...READ_ONLY_GIT_SUBCOMMANDS] } },
      ),
    );
  }
  // `git config --global`/`--system` writes outside the workspace entirely.
  if (subcommand === 'config' && argv.some((arg) => arg === '--global' || arg === '--system')) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', 'refusing to touch global or system git configuration', {
        details: { argv: [...argv] },
      }),
    );
  }
  if (subcommand === 'config') {
    const readOnlyConfigFlags = new Set([
      '--get',
      '--get-all',
      '--get-regexp',
      '--list',
      '--show-origin',
      '--show-scope',
      '--null',
      '-l',
      '-z',
    ]);
    if (argv.slice(1).some((arg) => arg.startsWith('-') && !readOnlyConfigFlags.has(arg))) {
      throw new AgentRuntimeError(
        agentError('workspace_ownership_violation', 'only read-only git config flags are permitted', {
          details: { argv: [...argv] },
        }),
      );
    }
    const hasReadOperation = argv.slice(1).some((arg) => readOnlyConfigFlags.has(arg));
    if (!hasReadOperation) {
      throw new AgentRuntimeError(
        agentError('workspace_ownership_violation', '`git config` requires an explicit read operation', {
          details: { argv: [...argv] },
        }),
      );
    }
  }
  if (subcommand === 'remote') {
    const args = argv.slice(1);
    const readOnlyRemote =
      args.length === 0 ||
      (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) ||
      args[0] === 'get-url' ||
      args[0] === 'show';
    if (!readOnlyRemote) {
      throw new AgentRuntimeError(
        agentError('workspace_ownership_violation', 'only read-only git remote operations are permitted', {
          details: { argv: [...argv] },
        }),
      );
    }
  }
  if (
    subcommand === 'branch' &&
    !(argv.length === 1 || (argv.length === 2 && (argv[1] === '--list' || argv[1] === '--show-current')))
  ) {
    throw new AgentRuntimeError(
      agentError(
        'workspace_ownership_violation',
        '`git branch` may only be used to list against a borrowed workspace',
        {
          details: { argv: [...argv] },
        },
      ),
    );
  }
}

export type GitWorkspaceProvider = WorkspaceProvider & {
  /**
   * Run a git command inside a lease.
   *
   * Borrowed leases are restricted to {@link READ_ONLY_GIT_SUBCOMMANDS}.
   */
  git(lease: WorkspaceLease, argv: readonly string[]): Promise<GitResult>;
};

export function createGitWorkspaceProvider(options: GitWorkspaceProviderOptions): GitWorkspaceProvider {
  const local = createLocalWorkspaceProvider({
    baseDirectory: options.baseDirectory,
    clock: options.clock,
    idFactory: options.idFactory,
    ...(options.removeDirectory === undefined ? {} : { removeDirectory: options.removeDirectory }),
  });

  async function run(lease: WorkspaceLease, argv: readonly string[]): Promise<GitResult> {
    if (lease.ownership === 'borrowed') assertReadOnly(argv);
    const result = await options.runGit({ argv, cwd: lease.root });
    if (result.exitCode !== 0) {
      throw new AgentRuntimeError(
        agentError('workspace_unavailable', `git ${argv.join(' ')} failed with exit code ${String(result.exitCode)}`, {
          details: { argv: [...argv], exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) },
        }),
      );
    }
    return result;
  }

  return {
    async acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
      const lease = await local.acquire(spec);

      try {
        if (spec.kind === 'managed' && spec.source?.kind === 'git') {
          // Only a managed root is ever populated. `--` terminates option parsing
          // so a remote that starts with `-` cannot become a git flag.
          const cloneArgv = ['clone', '--', spec.source.remote, '.'];
          await run(lease, cloneArgv);
          if (spec.source.ref !== undefined) {
            await run(lease, ['checkout', '--detach', spec.source.ref]);
          }
        }
      } catch (error) {
        await lease.release();
        throw error;
      }

      return lease;
    },

    releaseAll(): Promise<readonly WorkspaceReleaseReport[]> {
      return local.releaseAll();
    },

    git: run,
  };
}
