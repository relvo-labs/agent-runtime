/**
 * Event → state fold.
 *
 * This is the only place projected state is written. Keeping it a pure function
 * of `(record, event)` is what makes the store's atomicity claim checkable: if
 * you can rebuild the projection by replaying the log, then the projection can
 * never be ahead of the log.
 *
 * Unknown event types are ignored rather than rejected — a consumer of an older
 * build must tolerate an event it does not model, and so must this fold.
 */

import type { AgentRun, AgentTurn, EventEnvelope, RunId } from '@relvo-labs/agent-protocol';
import type { SessionRecord } from './store.ts';

function updateRun(record: SessionRecord, runId: RunId, patch: (run: AgentRun) => AgentRun): void {
  const existing = record.runs.get(runId);
  if (existing) record.runs.set(runId, patch(existing));
}

function updateTurn(record: SessionRecord, turnId: AgentTurn['turnId'], patch: (turn: AgentTurn) => AgentTurn): void {
  const existing = record.turns.get(turnId);
  if (existing) record.turns.set(turnId, patch(existing));
}

export function applyEvent(record: SessionRecord, envelope: EventEnvelope): void {
  const { payload } = envelope;

  switch (payload.type) {
    case 'session.opened':
      // The session record already exists; `session.opened` marks it ready.
      record.session = { ...record.session, state: 'ready' };
      return;

    case 'session.state_changed':
      record.session = { ...record.session, state: payload.to };
      return;

    case 'session.closed':
      record.session = {
        ...record.session,
        state: payload.reason === 'failed' ? 'failed' : 'closed',
        workspace: { ...record.session.workspace, released: true },
        ...(payload.error === undefined ? {} : { error: payload.error }),
      };
      return;

    case 'turn.started': {
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

    case 'turn.state_changed':
      updateTurn(record, payload.turnId, (turn) => ({ ...turn, state: payload.to }));
      return;

    case 'turn.settled':
      updateTurn(record, payload.turnId, (turn) => ({
        ...turn,
        state: payload.state,
        ...(payload.output === undefined ? {} : { output: payload.output }),
        ...(payload.error === undefined ? {} : { error: payload.error }),
      }));
      return;

    case 'run.started': {
      if (envelope.runId === undefined) return;
      const runId = envelope.runId;
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

    case 'run.state_changed':
      if (envelope.runId === undefined) return;
      updateRun(record, envelope.runId, (run) => ({ ...run, state: payload.to }));
      return;

    case 'run.message_delta': {
      if (envelope.runId === undefined) return;
      const run = record.runs.get(envelope.runId);
      if (!run) return;
      updateTurn(record, run.turnId, (turn) => ({ ...turn, output: (turn.output ?? '') + payload.text }));
      return;
    }

    case 'run.usage':
      if (envelope.runId === undefined) return;
      updateRun(record, envelope.runId, (run) => ({ ...run, usage: payload.usage }));
      return;

    case 'run.finished':
      if (envelope.runId === undefined) return;
      updateRun(record, envelope.runId, (run) => ({
        ...run,
        state: payload.termination.outcome,
        pendingInteractionIds: [],
        termination: payload.termination,
      }));
      return;

    case 'interaction.requested': {
      if (envelope.runId === undefined) return;
      record.interactions.set(payload.interactionId, {
        interactionId: payload.interactionId,
        sessionId: envelope.sessionId,
        turnId: payload.turnId,
        runId: envelope.runId,
        status: 'pending',
        request: payload.request,
        requestedAt: envelope.occurredAt,
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      });
      updateRun(record, envelope.runId, (run) => ({
        ...run,
        state: 'awaiting_interaction',
        pendingInteractionIds: [...run.pendingInteractionIds, payload.interactionId],
      }));
      return;
    }

    case 'interaction.settled': {
      const existing = record.interactions.get(payload.interactionId);
      if (existing) {
        record.interactions.set(payload.interactionId, {
          ...existing,
          status: 'settled',
          settlement: payload.settlement,
        });
      }
      if (envelope.runId === undefined) return;
      updateRun(record, envelope.runId, (run) => {
        const pending = run.pendingInteractionIds.filter((id) => id !== payload.interactionId);
        return {
          ...run,
          pendingInteractionIds: pending,
          state: pending.length === 0 && run.state === 'awaiting_interaction' ? 'running' : run.state,
        };
      });
      return;
    }

    case 'run.tool_activity':
    case 'diagnostic':
      // Observational only; nothing in the read model depends on them.
      return;
  }
}
