/**
 * Event → state fold.
 *
 * This is the only place projected state is written. Keeping it a pure function
 * of `(record, event)` is what makes the store's atomicity claim checkable: if
 * you can rebuild the projection by replaying the log, then the projection can
 * never be ahead of the log.
 *
 * Event envelopes are validated by the closed protocol schema before they
 * reach this fold. A new event variant therefore requires a new pre-1.0 wire
 * minor; this function makes no same-line forward-compatibility claim.
 */

import {
  AgentRuntimeError,
  RUN_STATE_TABLE,
  SESSION_STATE_TABLE,
  TURN_STATE_TABLE,
  agentError,
  canTransition,
  isTerminal,
  type AgentRun,
  type AgentTurn,
  type EventEnvelope,
  type RunId,
} from '@relvo-labs/agent-protocol';
import type { SessionRecord } from './store.ts';

function violation(message: string): never {
  throw new AgentRuntimeError(agentError('illegal_state_transition', `event replay rejected: ${message}`));
}

function requireRun(record: SessionRecord, runId: RunId | undefined, eventType: string): AgentRun {
  if (runId === undefined) violation(`${eventType} has no run id`);
  const run = record.runs.get(runId);
  if (run === undefined) violation(`${eventType} references an unknown run`);
  return run;
}

function requireTurn(record: SessionRecord, turnId: AgentTurn['turnId'], eventType: string): AgentTurn {
  const turn = record.turns.get(turnId);
  if (turn === undefined) violation(`${eventType} references an unknown turn`);
  return turn;
}

function updateRun(record: SessionRecord, runId: RunId, patch: (run: AgentRun) => AgentRun): void {
  const existing = record.runs.get(runId);
  if (existing === undefined) violation(`event references unknown run ${runId}`);
  record.runs.set(runId, patch(existing));
}

function updateTurn(record: SessionRecord, turnId: AgentTurn['turnId'], patch: (turn: AgentTurn) => AgentTurn): void {
  const existing = record.turns.get(turnId);
  if (existing === undefined) violation(`event references unknown turn ${turnId}`);
  record.turns.set(turnId, patch(existing));
}

export function applyEvent(record: SessionRecord, envelope: EventEnvelope): void {
  const { payload } = envelope;

  switch (payload.type) {
    case 'session.opened':
      // The session record already exists; `session.opened` marks it ready.
      if (record.session.state !== 'opening' || !canTransition(SESSION_STATE_TABLE, 'opening', 'ready')) {
        violation(`session.opened cannot apply from ${record.session.state}`);
      }
      if (
        payload.providerId !== record.session.providerId ||
        payload.workspace.leaseId !== record.session.workspace.leaseId
      ) {
        violation('session.opened ownership does not match the session record');
      }
      record.session = { ...record.session, state: 'ready' };
      return;

    case 'session.state_changed':
      if (record.session.state !== payload.from || !canTransition(SESSION_STATE_TABLE, payload.from, payload.to)) {
        violation(`session.state_changed ${payload.from} -> ${payload.to} does not match ${record.session.state}`);
      }
      record.session = { ...record.session, state: payload.to };
      return;

    case 'session.closed': {
      const target = payload.reason === 'failed' ? 'failed' : 'closed';
      if (!canTransition(SESSION_STATE_TABLE, record.session.state, target)) {
        violation(`session.closed cannot apply ${record.session.state} -> ${target}`);
      }
      if (
        payload.workspaceRelease.leaseId !== record.session.workspace.leaseId ||
        payload.workspaceRelease.ownership !== record.session.workspace.ownership
      ) {
        violation('session.closed release report does not own the projected workspace');
      }
      record.session = {
        ...record.session,
        state: target,
        workspace: { ...record.session.workspace, released: true },
        ...(payload.error === undefined ? {} : { error: payload.error }),
      };
      return;
    }

    case 'turn.started': {
      if (record.session.state !== 'ready')
        violation(`turn.started cannot apply while session is ${record.session.state}`);
      if (record.turns.has(payload.turnId)) violation(`turn.started duplicates turn ${payload.turnId}`);
      record.turns.set(payload.turnId, {
        turnId: payload.turnId,
        sessionId: envelope.sessionId,
        state: 'accepted',
        input: payload.input,
        createdAt: envelope.occurredAt,
        runIds: [],
      });
      record.session = { ...record.session, turnIds: [...record.session.turnIds, payload.turnId] };
      return;
    }

    case 'turn.state_changed': {
      const turn = requireTurn(record, payload.turnId, payload.type);
      if (turn.state !== payload.from || !canTransition(TURN_STATE_TABLE, payload.from, payload.to)) {
        violation(`turn.state_changed ${payload.from} -> ${payload.to} does not match ${turn.state}`);
      }
      updateTurn(record, payload.turnId, (turn) => ({ ...turn, state: payload.to }));
      return;
    }

    case 'turn.settled': {
      const turn = requireTurn(record, payload.turnId, payload.type);
      if (!isTerminal(TURN_STATE_TABLE, payload.state) || !canTransition(TURN_STATE_TABLE, turn.state, payload.state)) {
        violation(`turn.settled cannot apply ${turn.state} -> ${payload.state}`);
      }
      updateTurn(record, payload.turnId, (turn) => ({
        ...turn,
        state: payload.state,
        ...(payload.output === undefined ? {} : { output: payload.output }),
        ...(payload.error === undefined ? {} : { error: payload.error }),
      }));
      return;
    }

    case 'run.started': {
      if (envelope.runId === undefined) violation('run.started has no run id');
      const runId = envelope.runId;
      if (record.runs.has(runId)) violation(`run.started duplicates run ${runId}`);
      const turn = requireTurn(record, payload.turnId, payload.type);
      if (!canTransition(TURN_STATE_TABLE, turn.state, 'running')) {
        violation(`run.started cannot apply while turn is ${turn.state}`);
      }
      record.runs.set(runId, {
        runId,
        sessionId: envelope.sessionId,
        turnId: payload.turnId,
        attempt: payload.attempt,
        state: 'running',
        startedAt: envelope.occurredAt,
        pendingInteractionIds: [],
      });
      updateTurn(record, payload.turnId, (turn) => ({
        ...turn,
        state: 'running',
        runIds: [...turn.runIds, runId],
      }));
      return;
    }

    case 'run.state_changed': {
      const run = requireRun(record, envelope.runId, payload.type);
      if (run.state !== payload.from || !canTransition(RUN_STATE_TABLE, payload.from, payload.to)) {
        violation(`run.state_changed ${payload.from} -> ${payload.to} does not match ${run.state}`);
      }
      updateRun(record, run.runId, (run) => ({ ...run, state: payload.to }));
      return;
    }

    case 'run.message_delta': {
      const run = requireRun(record, envelope.runId, payload.type);
      if (isTerminal(RUN_STATE_TABLE, run.state)) violation(`${payload.type} cannot follow terminal run ${run.runId}`);
      updateTurn(record, run.turnId, (turn) => ({ ...turn, output: (turn.output ?? '') + payload.text }));
      return;
    }

    case 'run.usage': {
      const run = requireRun(record, envelope.runId, payload.type);
      if (isTerminal(RUN_STATE_TABLE, run.state)) violation(`${payload.type} cannot follow terminal run ${run.runId}`);
      updateRun(record, run.runId, (run) => ({ ...run, usage: payload.usage }));
      return;
    }

    case 'run.finished': {
      const run = requireRun(record, envelope.runId, payload.type);
      if (run.turnId !== payload.turnId) violation('run.finished turn ownership does not match its run');
      if (
        run.pendingInteractionIds.length > 0 ||
        [...record.interactions.values()].some(
          (interaction) => interaction.runId === run.runId && interaction.status === 'pending',
        )
      ) {
        violation('run.finished requires every interaction owned by the run to be settled first');
      }
      if (run.termination !== undefined || !canTransition(RUN_STATE_TABLE, run.state, payload.termination.outcome)) {
        violation(`run.finished cannot apply ${run.state} -> ${payload.termination.outcome}`);
      }
      updateRun(record, run.runId, (run) => ({
        ...run,
        state: payload.termination.outcome,
        pendingInteractionIds: [],
        termination: payload.termination,
      }));
      return;
    }

    case 'interaction.requested': {
      const run = requireRun(record, envelope.runId, payload.type);
      requireTurn(record, payload.turnId, payload.type);
      if (run.turnId !== payload.turnId) violation('interaction.requested turn ownership does not match its run');
      if (run.state !== 'running' && run.state !== 'awaiting_interaction') {
        violation(`interaction.requested cannot apply while run is ${run.state}`);
      }
      if (record.interactions.has(payload.interactionId)) {
        violation(`interaction.requested duplicates interaction ${payload.interactionId}`);
      }
      record.interactions.set(payload.interactionId, {
        interactionId: payload.interactionId,
        sessionId: envelope.sessionId,
        turnId: payload.turnId,
        runId: run.runId,
        status: 'pending',
        request: payload.request,
        requestedAt: envelope.occurredAt,
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      });
      updateRun(record, run.runId, (run) => ({
        ...run,
        state:
          run.state === 'running' && canTransition(RUN_STATE_TABLE, run.state, 'awaiting_interaction')
            ? 'awaiting_interaction'
            : run.state,
        pendingInteractionIds: [...run.pendingInteractionIds, payload.interactionId],
      }));
      return;
    }

    case 'interaction.settled': {
      const existing = record.interactions.get(payload.interactionId);
      if (existing === undefined) violation('interaction.settled references an unknown interaction');
      const run = requireRun(record, envelope.runId, payload.type);
      if (
        existing.status !== 'pending' ||
        existing.runId !== run.runId ||
        existing.turnId !== payload.turnId ||
        run.turnId !== payload.turnId ||
        !run.pendingInteractionIds.includes(payload.interactionId) ||
        isTerminal(RUN_STATE_TABLE, run.state)
      ) {
        violation('interaction.settled does not match a pending interaction owned by the run');
      }
      if (payload.settlement.outcome === 'responded' && run.state !== 'awaiting_interaction') {
        violation(`a response cannot settle an interaction while run is ${run.state}`);
      }
      record.interactions.set(payload.interactionId, {
        ...existing,
        status: 'settled',
        settlement: payload.settlement,
      });
      updateRun(record, run.runId, (run) => {
        const pending = run.pendingInteractionIds.filter((id) => id !== payload.interactionId);
        if (pending.length === 0 && run.state === 'awaiting_interaction') {
          if (!canTransition(RUN_STATE_TABLE, run.state, 'running')) {
            violation(`interaction.settled cannot resume run from ${run.state}`);
          }
        }
        return {
          ...run,
          pendingInteractionIds: pending,
          state: pending.length === 0 && run.state === 'awaiting_interaction' ? 'running' : run.state,
        };
      });
      return;
    }

    case 'run.tool_activity': {
      const run = requireRun(record, envelope.runId, payload.type);
      if (isTerminal(RUN_STATE_TABLE, run.state)) violation(`${payload.type} cannot follow terminal run ${run.runId}`);
      return;
    }
    case 'diagnostic':
      // Observational only; nothing in the read model depends on them.
      return;
  }
}
