/**
 * Session / Turn / Run state machines.
 *
 * These four identities have genuinely different lifetimes, and collapsing any
 * two of them is the mistake this module exists to prevent:
 *
 *   Session      one provider conversation bound to one workspace lease.
 *   Turn         one caller request within a session. Owns >= 1 runs.
 *   Run          one provider execution attempt for a turn. Exactly one
 *                terminal outcome, ever.
 *   Interaction  one correlated question/approval raised during a run.
 *                Settled exactly once. (See interaction.ts.)
 *
 * The transition tables below are the normative source for
 * docs/architecture/foundation-v0.4.md; the doc quotes them, it does not
 * redefine them.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.enum([
  /** Workspace lease and provider session are being acquired. */
  'opening',
  /** Accepting turns. */
  'ready',
  /** A close was requested; in-flight work is being wound down. */
  'closing',
  /** Terminal. Provider disposed, lease released. */
  'closed',
  /** Terminal. Opening or operating failed; lease released. */
  'failed',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SESSION_TERMINAL_STATES: readonly SessionState[] = ['closed', 'failed'];

const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  opening: ['ready', 'failed'],
  ready: ['closing', 'failed'],
  closing: ['closed', 'failed'],
  closed: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export const TurnStateSchema = z.enum([
  /** Accepted by the runtime, no run started yet. */
  'accepted',
  /** A run is in flight for this turn. */
  'running',
  /** Terminal. A run succeeded. */
  'completed',
  /** Terminal. A run failed and the turn will not be retried. */
  'failed',
  /** Terminal. The caller interrupted and did not retry. */
  'cancelled',
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

export const TURN_TERMINAL_STATES: readonly TurnState[] = ['completed', 'failed', 'cancelled'];

const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  accepted: ['running', 'cancelled', 'failed'],
  // A turn returns to `running` when a new run is started after an interrupt,
  // which is precisely why Turn and Run are separate identities.
  running: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStateSchema = z.enum([
  /** Admitted by the runtime, not yet handed to the provider. */
  'queued',
  /** Handed to the provider, awaiting first activity. */
  'starting',
  /** Provider is producing output. */
  'running',
  /** Blocked on at least one unsettled interaction. */
  'awaiting_interaction',
  /** Interrupt requested; awaiting the provider's terminal acknowledgement. */
  'interrupting',
  /** Terminal. Completed normally. */
  'succeeded',
  /** Terminal. Ended with an error. */
  'failed',
  /** Terminal. Ended because the caller interrupted it. */
  'interrupted',
]);
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * A run reaches exactly one of these, exactly once. This is the invariant that
 * makes an event log safe to project: a consumer counting terminal run events
 * can never double-count or miss a completion.
 */
export const RUN_TERMINAL_STATES: readonly RunState[] = ['succeeded', 'failed', 'interrupted'];

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['starting', 'interrupting', 'failed', 'interrupted'],
  starting: ['running', 'interrupting', 'failed'],
  running: ['awaiting_interaction', 'interrupting', 'succeeded', 'failed'],
  awaiting_interaction: ['running', 'interrupting', 'failed'],
  // An interrupt in flight may still lose the race with a natural completion;
  // both outcomes are legal, but only one of them happens.
  interrupting: ['interrupted', 'succeeded', 'failed'],
  succeeded: [],
  failed: [],
  interrupted: [],
};

// ---------------------------------------------------------------------------
// Shared transition helpers
// ---------------------------------------------------------------------------

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const SESSION_STATE_TABLE: TransitionTable<SessionState> = SESSION_TRANSITIONS;
export const TURN_STATE_TABLE: TransitionTable<TurnState> = TURN_TRANSITIONS;
export const RUN_STATE_TABLE: TransitionTable<RunState> = RUN_TRANSITIONS;

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function isTerminal<S extends string>(table: TransitionTable<S>, state: S): boolean {
  return table[state].length === 0;
}

export function nextStates<S extends string>(table: TransitionTable<S>, from: S): readonly S[] {
  return table[from];
}

// ---------------------------------------------------------------------------
// Command admissibility
// ---------------------------------------------------------------------------

/**
 * Which caller commands are legal against a session in a given state.
 *
 * This is the published table referenced by LC-01. `interrupt_run` is listed
 * separately from `close_session` on purpose: interrupting a run is a
 * *within-session* operation that leaves the session usable, whereas closing a
 * session disposes the provider and releases the workspace lease. Conflating
 * them is the defect this table prevents.
 */
export const SESSION_COMMAND_MATRIX: Readonly<
  Record<SessionState, readonly ('submit_turn' | 'interrupt_run' | 'respond_to_interaction' | 'close_session')[]>
> = {
  opening: [],
  ready: ['submit_turn', 'interrupt_run', 'respond_to_interaction', 'close_session'],
  // A closing session still settles in-flight interactions and honours an
  // interrupt, but will not admit new work.
  closing: ['interrupt_run', 'respond_to_interaction'],
  closed: [],
  failed: [],
};

export type SessionCommandKind = (typeof SESSION_COMMAND_MATRIX)[SessionState][number];

export function isCommandAdmissible(state: SessionState, command: SessionCommandKind): boolean {
  return SESSION_COMMAND_MATRIX[state].includes(command);
}
