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
import {
  createLocalWorkspaceProvider,
  type BorrowedWorkspaceLease,
  type ManagedWorkspaceLease,
  type WorkspaceLease,
  type WorkspaceProvider,
} from '@relvo-labs/agent-workspace';

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
 * Read-only by exact template. Arbitrary options are unsafe because apparently
 * observational commands accept output paths, external helpers, configuration,
 * pagers, and lock-taking behavior. Only these complete argv forms pass.
 */
const ENFORCED_READ_ONLY_GIT_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['status', '--short']),
  Object.freeze(['rev-parse', '--verify', 'HEAD']),
  Object.freeze(['ls-files', '--cached', '--']),
]);
const ENFORCED_READ_ONLY_GIT_KEYS: readonly string[] = Object.freeze(
  ENFORCED_READ_ONLY_GIT_COMMANDS.map((argv) => JSON.stringify(argv)),
);

/** Detached documentation catalog. Enforcement uses private immutable keys. */
export const READ_ONLY_GIT_COMMANDS: readonly (readonly string[])[] = Object.freeze(
  ENFORCED_READ_ONLY_GIT_COMMANDS.map((argv) => Object.freeze([...argv])),
);

export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = Object.freeze(
  ENFORCED_READ_ONLY_GIT_COMMANDS.flatMap((argv) => argv.slice(0, 1)),
);

export function assertReadOnly(argv: readonly string[]): void {
  const allowed = ENFORCED_READ_ONLY_GIT_KEYS.includes(JSON.stringify(argv));
  if (!allowed) {
    throw new AgentRuntimeError(
      agentError(
        'workspace_ownership_violation',
        `\`git ${argv.join(' ')}\` is not permitted against a borrowed workspace`,
        { details: { argv: [...argv], allowed: [...READ_ONLY_GIT_SUBCOMMANDS] } },
      ),
    );
  }
}

export type GitWorkspaceProvider = WorkspaceProvider & {
  /**
   * Run a git command inside a lease.
   *
   * Borrowed leases are restricted to {@link READ_ONLY_GIT_COMMANDS}; Runtime
   * prepends no-pager and no-optional-lock global flags before execution.
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
    const hardenedArgv = lease.ownership === 'borrowed' ? ['--no-pager', '--no-optional-locks', ...argv] : [...argv];
    const result = await options.runGit({ argv: hardenedArgv, cwd: lease.root });
    if (result.exitCode !== 0) {
      throw new AgentRuntimeError(
        agentError('workspace_unavailable', `git ${argv.join(' ')} failed with exit code ${String(result.exitCode)}`, {
          details: { argv: [...argv], exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) },
        }),
      );
    }
    return result;
  }

  function acquire(spec: Extract<WorkspaceSpec, { kind: 'existing' }>): Promise<BorrowedWorkspaceLease>;
  function acquire(spec: Extract<WorkspaceSpec, { kind: 'managed' }>): Promise<ManagedWorkspaceLease>;
  function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease>;
  async function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
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
  }

  return {
    acquire,

    releaseAll(): Promise<readonly WorkspaceReleaseReport[]> {
      return local.releaseAll();
    },

    git: run,
  };
}
