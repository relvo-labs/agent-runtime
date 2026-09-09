/**
 * The one place this app turns an unknown thrown value into something safe
 * to write to a server-side log.
 *
 * `console.error(label, error)` on a native `Error` prints far more than its
 * own `message`: Node's default formatting recurses into `.cause` and, for an
 * `AggregateError`, into every entry of `.errors` — and this codebase's own
 * cleanup paths deliberately retain the *original* failure there (see
 * `packages/workspace/src/local.ts`'s `releaseAllFailure`, whose
 * `AggregateError` cause carries each raw per-lease failure, and
 * `@relvo-labs/agent-provider-codex`'s `releaseAbandonedConnections()`,
 * documented to do the same). A raw provider-thrown `Error` can contain
 * upstream error prose, a native id, a path, or a credential — exactly what
 * `.agents/skills/provider-adapter-development/SKILL.md` requires mapping to
 * a closed classification instead of logging verbatim. Never pass the raw
 * `error` object to `console.error`/`console.log` anywhere in this app;
 * always go through this function first.
 */

import { isAgentRuntimeError } from '@relvo-labs/agent-protocol';

/**
 * A bounded, safe-to-log summary. Never includes `.cause`, `.stack`, or a
 * nested `AggregateError`'s `.errors` — only a closed classification.
 */
export function safeDiagnostic(error: unknown): string {
  if (isAgentRuntimeError(error)) {
    // `AgentError.message` is documented as "safe to log" (see
    // `packages/protocol/src/errors.ts`) — a closed, non-raw classification,
    // never upstream prose.
    return `${error.error.code}: ${error.error.message}`;
  }
  if (error instanceof Error) {
    // Deliberately not `error.message` — for an error this app itself did not
    // construct as an `AgentRuntimeError`, the message's provenance is
    // unknown, and printing it here is exactly the leak this function exists
    // to prevent. The constructor name alone (`Error`, `TypeError`,
    // `AggregateError`, …) is enough to start a local investigation.
    return `unexpected internal error (${error.constructor.name})`;
  }
  return 'unexpected internal error';
}
