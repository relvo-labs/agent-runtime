/**
 * Server-side enforcement of "one active session at a time".
 *
 * The SDK itself places no such limit — a runtime can hold many concurrent
 * sessions. This app's own product policy is narrower, and that policy has
 * to be enforced here, synchronously, before a second `open_session` command
 * ever reaches the runtime — otherwise two concurrent HTTP requests racing
 * each other could both succeed.
 *
 * The one property this module must never break: an exact retry (the same
 * `commandId`, whether or not a session is already open under it) always
 * still reaches the runtime, so the runtime's own idempotent receipt handling
 * is what answers it. This module only ever blocks a *new, distinct* attempt
 * to open a second session; it never intercepts a retry of the one already in
 * flight or already open.
 */

import type { SessionId, SessionSnapshot } from '@relvo-labs/agent-protocol';
import { SESSION_TERMINAL_STATES } from '@relvo-labs/agent-protocol';

type AdmissionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly commandId: string }
  | { readonly kind: 'active'; readonly sessionId: SessionId; readonly commandId: string };

export type BeginOpenResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'another_open_in_flight' | 'session_already_open';
      readonly sessionId?: SessionId;
    };

export type SessionAdmission = {
  /**
   * Call before dispatching `open_session` for `commandId`. Synchronous and
   * side-effecting: on `{ ok: true }` the slot is now reserved for this
   * `commandId` (if it was not already active/pending under it), and the
   * caller must call `settleOpen` exactly once afterwards, whatever the
   * outcome, including a thrown error.
   */
  beginOpen(commandId: string): BeginOpenResult;
  /** Record the outcome of the `open_session` call `beginOpen` admitted. */
  settleOpen(commandId: string, outcome: { readonly sessionId: SessionId } | undefined): void;
  /** Call after any `close_session` outcome for the tracked session. */
  noteCloseOutcome(sessionId: SessionId, closed: boolean): void;
  /**
   * Self-heal: if the currently tracked *active* session has independently
   * reached a terminal state (closed or failed, without going through this
   * module's `noteCloseOutcome` — e.g. a runtime-driven failure), free the
   * slot. Call before evaluating a `beginOpen` for a *new* `commandId`.
   */
  refresh(getSession: (id: SessionId) => Promise<SessionSnapshot | undefined>): Promise<void>;
  /** For tests: the current state, without mutating it. */
  readonly debugState: AdmissionState;
};

export function createSessionAdmission(): SessionAdmission {
  let state: AdmissionState = { kind: 'idle' };

  return {
    beginOpen(commandId: string): BeginOpenResult {
      if (state.kind === 'idle') {
        state = { kind: 'pending', commandId };
        return { ok: true };
      }
      if (state.kind === 'pending') {
        if (state.commandId === commandId) return { ok: true }; // concurrent retry of the same open
        return { ok: false, reason: 'another_open_in_flight' };
      }
      // state.kind === 'active'
      if (state.commandId === commandId) return { ok: true }; // exact retry against the open session
      return { ok: false, reason: 'session_already_open', sessionId: state.sessionId };
    },

    settleOpen(commandId: string, outcome: { readonly sessionId: SessionId } | undefined): void {
      if (outcome !== undefined) {
        state = { kind: 'active', sessionId: outcome.sessionId, commandId };
        return;
      }
      // The attempt this `commandId` represents did not produce an open
      // session (rejected receipt, or a thrown transport error). Free the
      // slot only if it is still exactly the one we reserved — a concurrent
      // exact retry that already transitioned the slot to `active` must not
      // be clobbered back to `idle` by a stale caller's failure path.
      if (state.kind === 'pending' && state.commandId === commandId) {
        state = { kind: 'idle' };
      }
    },

    noteCloseOutcome(sessionId: SessionId, closed: boolean): void {
      if (closed && state.kind === 'active' && state.sessionId === sessionId) {
        state = { kind: 'idle' };
      }
    },

    async refresh(getSession: (id: SessionId) => Promise<SessionSnapshot | undefined>): Promise<void> {
      if (state.kind !== 'active') return;
      const snapshot = await getSession(state.sessionId);
      const terminal =
        snapshot === undefined || (SESSION_TERMINAL_STATES as readonly string[]).includes(snapshot.session.state);
      if (terminal) state = { kind: 'idle' };
    },

    get debugState(): AdmissionState {
      return state;
    },
  };
}
