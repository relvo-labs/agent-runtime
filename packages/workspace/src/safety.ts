/**
 * Removal guards.
 *
 * Every destructive filesystem call in this repository goes through
 * `assertRemovable` first. The function is exported and independently tested
 * because "we checked the path before deleting" is only credible if the check
 * is a named thing with its own adversarial tests, not three inline `if`s that
 * someone will refactor away.
 *
 * There is deliberately no `force` option.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { AgentRuntimeError, agentError, type WorkspaceOwnership } from '@relvo-labs/agent-protocol';

export type RemovalRequest = {
  /** The directory a caller wants to remove. */
  readonly target: string;
  /** The provider-configured directory that managed workspaces live under. */
  readonly baseDirectory: string;
  readonly ownership: WorkspaceOwnership;
  readonly alreadyReleased: boolean;
};

/** Segment-aware containment: `/a/b` contains `/a/b/c` but not `/a/bc`. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  if (relativePath === '' || relativePath === '.') return false;
  if (isAbsolute(relativePath)) return false;
  return !relativePath.split(sep).includes('..');
}

/**
 * Resolve symlinks before comparing.
 *
 * A managed root that is a symlink to somewhere outside the base directory
 * would otherwise pass a naive string check and delete the target. Falls back
 * to a lexical resolve when the path does not exist, which is the correct
 * behaviour for an already-removed directory.
 */
export async function resolveRealPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return resolve(candidate);
    }
    throw new AgentRuntimeError(agentError('workspace_unavailable', `cannot resolve workspace path \`${candidate}\``), {
      cause: error,
    });
  }
}

export type RemovalRefusal = { readonly reason: string; readonly details: Record<string, unknown> };

/**
 * Decide whether a removal may proceed. Returns the refusal instead of
 * throwing so callers can log it or convert it, and so tests can enumerate
 * every refusal reason.
 */
export async function checkRemovable(request: RemovalRequest): Promise<RemovalRefusal | undefined> {
  const { ownership, alreadyReleased } = request;

  if (ownership !== 'managed') {
    return {
      reason: 'a borrowed workspace is never removed',
      details: { ownership, target: request.target },
    };
  }

  if (alreadyReleased) {
    return { reason: 'the lease has already been released', details: { target: request.target } };
  }

  const target = await resolveRealPath(request.target);
  const base = await resolveRealPath(request.baseDirectory);

  if (!isAbsolute(target) || !isAbsolute(base)) {
    return { reason: 'both the target and the base directory must be absolute', details: { target, base } };
  }

  if (target === parse(target).root) {
    return { reason: 'refusing to remove a filesystem root', details: { target } };
  }

  const targetDepth = target.split(sep).filter(Boolean).length;
  if (targetDepth <= 1) {
    return { reason: 'the target path is too shallow to remove safely', details: { target, targetDepth } };
  }

  if (target === base) {
    return { reason: 'refusing to remove the managed base directory itself', details: { target, base } };
  }

  if (!isStrictlyInside(base, target)) {
    return {
      reason: 'the target resolves outside the managed base directory',
      details: { target, base },
    };
  }

  return undefined;
}

/** Throwing form used at the actual call site of a destructive operation. */
export async function assertRemovable(request: RemovalRequest): Promise<void> {
  const refusal = await checkRemovable(request);
  if (refusal) {
    throw new AgentRuntimeError(
      agentError('workspace_ownership_violation', `refusing to remove workspace: ${refusal.reason}`, {
        details: refusal.details,
      }),
    );
  }
}
