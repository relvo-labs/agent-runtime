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

/** Detached documentation catalog. Enforcement uses private immutable templates. */
export const READ_ONLY_GIT_COMMANDS: readonly (readonly string[])[] = Object.freeze(
  ENFORCED_READ_ONLY_GIT_COMMANDS.map((argv) => Object.freeze([...argv])),
);

export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = Object.freeze(
  ENFORCED_READ_ONLY_GIT_COMMANDS.flatMap((argv) => argv.slice(0, 1)),
);

function primitiveArgvSnapshot(argv: readonly string[]): readonly string[] | undefined {
  try {
    if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype) return undefined;
    const length = argv.length;
    if (!Number.isSafeInteger(length) || length < 1) return undefined;
    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
      if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
        return undefined;
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function validateReadOnly(argv: readonly string[]): readonly string[] {
  const snapshot = primitiveArgvSnapshot(argv);
  if (
    snapshot !== undefined &&
    ENFORCED_READ_ONLY_GIT_COMMANDS.some(
      (template) => template.length === snapshot.length && template.every((value, index) => snapshot[index] === value),
    )
  ) {
    return snapshot;
  }
  throw new AgentRuntimeError(
    agentError('workspace_ownership_violation', 'git argv is not permitted against a borrowed workspace', {
      details: { argv: snapshot ?? [], allowed: [...READ_ONLY_GIT_SUBCOMMANDS] },
    }),
  );
}

export function assertReadOnly(argv: readonly string[]): void {
  validateReadOnly(argv);
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

const GIT_LEASE_PROTOTYPE = Object.freeze({});

type GitLeaseAuthority = {
  readonly lease: WorkspaceLease;
  readonly ownership: 'borrowed' | 'managed';
  readonly root: string;
  state: 'active' | 'releasing' | 'released';
  releasePromise?: Promise<WorkspaceReleaseReport>;
  releaseReport?: WorkspaceReleaseReport;
};

type ReleaseFailure = {
  readonly leaseId: string;
  readonly cause: unknown;
};

/**
 * The truthful outcome of a partially failed sweep. A sweep must not resolve as
 * a success when authorities remain outstanding, and must not reduce several
 * independent causes to whichever one happened to be attempted first.
 */
function releaseAllFailure(
  attempted: number,
  released: number,
  failures: readonly ReleaseFailure[],
): AgentRuntimeError {
  return new AgentRuntimeError(
    agentError(
      'workspace_unavailable',
      `releaseAll could not release ${String(failures.length)} of ${String(attempted)} workspace lease(s)`,
      { details: { attempted, released, failed: failures.map((failure) => failure.leaseId) } },
    ),
    {
      cause: new AggregateError(
        failures.map((failure) => failure.cause),
        'workspace releaseAll failed',
      ),
    },
  );
}

export function createGitWorkspaceProvider(options: GitWorkspaceProviderOptions): GitWorkspaceProvider {
  const local = createLocalWorkspaceProvider({
    baseDirectory: options.baseDirectory,
    clock: options.clock,
    idFactory: options.idFactory,
    ...(options.removeDirectory === undefined ? {} : { removeDirectory: options.removeDirectory }),
  });
  const authorities = new WeakMap<WorkspaceLease, GitLeaseAuthority>();
  const issuedAuthorities = new Set<GitLeaseAuthority>();

  function releaseAuthority(authority: GitLeaseAuthority): Promise<WorkspaceReleaseReport> {
    if (authority.state === 'released') {
      if (authority.releaseReport === undefined) {
        return Promise.reject(new Error('released Git lease has no release report'));
      }
      return Promise.resolve(structuredClone({ ...authority.releaseReport, alreadyReleased: true }));
    }
    if (authority.state === 'releasing') {
      if (authority.releasePromise === undefined) {
        return Promise.reject(new Error('releasing Git lease has no release operation'));
      }
      return authority.releasePromise.then((report) => structuredClone({ ...report, alreadyReleased: true }));
    }

    // Revoke Git admission before the destructive operation can yield. The
    // authority stays tracked so releaseAll can coalesce with this attempt.
    authority.state = 'releasing';
    let underlying: Promise<WorkspaceReleaseReport>;
    try {
      underlying = authority.lease.release();
    } catch (error) {
      authority.state = 'active';
      return Promise.reject(
        error instanceof Error ? error : new Error('workspace release threw a non-Error value', { cause: error }),
      );
    }
    const operation = underlying.then(
      (report) => {
        authority.releaseReport = structuredClone(report);
        authority.state = 'released';
        delete authority.releasePromise;
        issuedAuthorities.delete(authority);
        return structuredClone(report);
      },
      (error: unknown) => {
        authority.state = 'active';
        delete authority.releasePromise;
        // A failed release did not consume the lease or its cleanup duty.
        issuedAuthorities.add(authority);
        throw error;
      },
    );
    authority.releasePromise = operation;
    return operation;
  }

  async function run(lease: WorkspaceLease, argv: readonly string[]): Promise<GitResult> {
    const authority = authorities.get(lease);
    if (authority?.state !== 'active') {
      throw new AgentRuntimeError(
        agentError(
          'workspace_ownership_violation',
          'workspace lease is not an active lease issued by this Git provider',
        ),
      );
    }
    const validatedArgv = authority.ownership === 'borrowed' ? validateReadOnly(argv) : [...argv];
    const hardenedArgv =
      authority.ownership === 'borrowed' ? ['--no-pager', '--no-optional-locks', ...validatedArgv] : [...validatedArgv];
    const result = await options.runGit({ argv: hardenedArgv, cwd: authority.root });
    if (result.exitCode !== 0) {
      throw new AgentRuntimeError(
        agentError('workspace_unavailable', `git command failed with exit code ${String(result.exitCode)}`, {
          details: { argv: [...validatedArgv], exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) },
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
    const descriptor = lease.describe();
    const authority: GitLeaseAuthority = {
      lease,
      ownership: descriptor.ownership,
      root: descriptor.root,
      state: 'active',
    };
    const issued = Object.create(GIT_LEASE_PROTOTYPE) as WorkspaceLease;
    Object.defineProperties(issued, {
      leaseId: { value: descriptor.leaseId, enumerable: true },
      ownership: { value: descriptor.ownership, enumerable: true },
      root: { value: descriptor.root, enumerable: true },
      acquiredAt: { value: descriptor.acquiredAt, enumerable: true },
      describe: {
        value: () => ({ ...descriptor, released: authority.state === 'released' }),
      },
      release: {
        value: () => releaseAuthority(authority),
      },
    });
    Object.freeze(issued);
    authorities.set(issued, authority);
    issuedAuthorities.add(authority);

    try {
      if (spec.kind === 'managed' && spec.source?.kind === 'git') {
        // Only a managed root is ever populated. `--` terminates option parsing
        // so a remote that starts with `-` cannot become a git flag.
        const cloneArgv = ['clone', '--', spec.source.remote, '.'];
        await run(issued, cloneArgv);
        if (spec.source.ref !== undefined) {
          await run(issued, ['checkout', '--detach', spec.source.ref]);
        }
      }
    } catch (error) {
      await issued.release();
      authorities.delete(issued);
      issuedAuthorities.delete(authority);
      throw error;
    }

    return issued;
  }

  return {
    acquire,

    async releaseAll(): Promise<readonly WorkspaceReleaseReport[]> {
      const reports: WorkspaceReleaseReport[] = [];
      const failures: ReleaseFailure[] = [];
      // Snapshot the live set. Successful releases delete themselves from the
      // source set; releases already in flight are coalesced by authority state.
      const snapshot = [...issuedAuthorities];
      // Attempt every authority even when an earlier one rejects: a single
      // unreleasable workspace must not starve the cleanup of the rest. A
      // failed attempt restores its own `active` state and tracking, so it
      // remains retryable by a later sweep.
      for (const authority of snapshot) {
        try {
          reports.push(await releaseAuthority(authority));
        } catch (error) {
          failures.push({ leaseId: authority.lease.leaseId, cause: error });
        }
      }
      if (failures.length > 0) throw releaseAllFailure(snapshot.length, reports.length, failures);
      return reports;
    },

    git: run,
  };
}
