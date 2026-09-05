import { describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  InteractionIdSchema,
  RunIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  WorkspaceLeaseIdSchema,
  createCounterIdFactory,
  createFixedClock,
  type AgentSession,
  type CommandReceipt,
  type EventPayload,
  type Sequence,
} from '@relvo-labs/agent-protocol';

import { createInMemoryStore, type SessionRecord } from '../src/store.ts';

function attemptMutation(mutate: () => void): void {
  try {
    mutate();
  } catch {
    // A frozen boundary may reject the mutation; a cloned boundary may allow
    // it. Either is valid so long as committed state is unchanged.
  }
}

function setup() {
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const store = createInMemoryStore({ clock, idFactory });
  const sessionId = SessionIdSchema.parse(idFactory.next('session'));
  const session: AgentSession = {
    sessionId,
    state: 'opening',
    providerId: 'scripted',
    wireVersion: '0.4',
    workspace: {
      leaseId: WorkspaceLeaseIdSchema.parse(idFactory.next('workspaceLease')),
      ownership: 'borrowed',
      root: '/workspace',
      acquiredAt: clock.now(),
      released: false,
    },
    createdAt: clock.now(),
    sequence: 0 as Sequence,
    turnIds: [],
  };
  return { clock, idFactory, store, sessionId, session };
}

describe('in-memory store mutation isolation', () => {
  it('isolates ingress, transaction views, commit returns, snapshots, and event pages', async () => {
    const value = setup();
    const payload: EventPayload = {
      type: 'session.opened',
      providerId: 'scripted',
      workspace: value.session.workspace,
    };
    let transactionView: SessionRecord | undefined;
    const committed = await value.store.commit((tx) => {
      tx.createSession(value.session);
      tx.emit({ sessionId: value.sessionId, payload });
      transactionView = tx.session(value.sessionId);
      return tx.session(value.sessionId);
    });
    const revision = value.store.revision;

    attemptMutation(() => {
      Reflect.set(value.session.workspace, 'released', true);
    });
    attemptMutation(() => {
      Reflect.set(payload.workspace, 'root', '/caller-mutated');
    });
    const view = transactionView;
    if (view !== undefined) {
      attemptMutation(() => {
        Reflect.set(view.session.workspace, 'root', '/transaction-mutated');
      });
      attemptMutation(() => {
        Reflect.apply(Array.prototype.pop, view.events, []);
      });
    }
    attemptMutation(() => {
      Reflect.set(committed.value.session.workspace, 'root', '/commit-return-mutated');
    });
    attemptMutation(() => {
      Reflect.apply(Array.prototype.pop, committed.events, []);
    });

    const firstSnapshot = await value.store.read(value.sessionId);
    const firstPage = await value.store.readEvents(value.sessionId, 0 as Sequence);
    if (firstSnapshot === undefined) throw new Error('snapshot missing');
    attemptMutation(() => {
      Reflect.set(firstSnapshot.session.workspace, 'root', '/snapshot-mutated');
    });
    attemptMutation(() => {
      Reflect.apply(Array.prototype.push, firstSnapshot.session.turnIds, ['trn_0000000000000001']);
    });
    attemptMutation(() => {
      Reflect.set(firstPage.events[0]?.payload ?? {}, 'providerId', 'mutated-provider');
    });

    const secondSnapshot = await value.store.read(value.sessionId);
    const secondPage = await value.store.readEvents(value.sessionId, 0 as Sequence);
    expect(secondSnapshot?.session.workspace).toMatchObject({ root: '/workspace', released: false });
    expect(secondSnapshot?.turns).toEqual([]);
    expect(secondSnapshot?.session.turnIds).toEqual([]);
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.events[0]?.payload).toMatchObject({ providerId: 'scripted' });
    expect(value.store.revision).toBe(revision);
  });

  it('isolates receipt ingress, transaction lookup, commit returns, and public lookup', async () => {
    const value = setup();
    const commandId = CommandIdSchema.parse('caller-command-receipt');
    const receipt: CommandReceipt = {
      commandId,
      commandType: 'open_session',
      disposition: 'rejected',
      error: { code: 'invalid_request', message: 'canonical', retryable: false },
      acceptedAt: value.clock.now(),
    };
    const committed = await value.store.commit((tx) => {
      tx.recordReceipt(commandId, { fingerprint: 'canonical', receipt });
      return tx.findReceipt(commandId);
    });

    attemptMutation(() => {
      Reflect.set(receipt.error ?? {}, 'message', 'caller-mutated');
    });
    attemptMutation(() => {
      Reflect.set(committed.value?.receipt.error ?? {}, 'message', 'commit-mutated');
    });
    const first = await value.store.findReceipt(commandId);
    attemptMutation(() => {
      Reflect.set(first?.receipt.error ?? {}, 'message', 'lookup-mutated');
    });
    const second = await value.store.findReceipt(commandId);

    expect(second).toMatchObject({ fingerprint: 'canonical', receipt: { error: { message: 'canonical' } } });
  });

  it('isolates interaction lookups and nested interaction snapshots', async () => {
    const value = setup();
    const turnId = TurnIdSchema.parse(value.idFactory.next('turn'));
    const runId = RunIdSchema.parse(value.idFactory.next('run'));
    const interactionId = InteractionIdSchema.parse(value.idFactory.next('interaction'));
    let transactionView: SessionRecord | undefined;
    await value.store.commit((tx) => {
      tx.createSession(value.session);
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'session.opened', providerId: 'scripted', workspace: value.session.workspace },
      });
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'turn.started', turnId, input: { parts: [{ type: 'text', text: 'question' }] } },
      });
      tx.emit({ sessionId: value.sessionId, runId, payload: { type: 'run.started', turnId, attempt: 1 } });
      tx.emit({
        sessionId: value.sessionId,
        runId,
        payload: {
          type: 'interaction.requested',
          interactionId,
          turnId,
          request: { kind: 'question', prompt: 'canonical prompt', multiSelect: false },
        },
      });
      transactionView = tx.session(value.sessionId);
    });

    const view = transactionView;
    if (view !== undefined) {
      attemptMutation(() => {
        view.interactions.clear();
      });
    }
    const interaction = await value.store.readInteraction(value.sessionId, interactionId);
    const snapshot = await value.store.read(value.sessionId);
    attemptMutation(() => {
      Reflect.set(interaction?.request ?? {}, 'prompt', 'lookup-mutated');
    });
    attemptMutation(() => {
      Reflect.set(snapshot?.interactions[0]?.request ?? {}, 'prompt', 'snapshot-mutated');
    });

    expect(await value.store.readInteraction(value.sessionId, interactionId)).toMatchObject({
      request: { prompt: 'canonical prompt' },
    });
    expect((await value.store.read(value.sessionId))?.interactions[0]).toMatchObject({
      request: { prompt: 'canonical prompt' },
    });
  });
});

describe('projection transition validation', () => {
  it('rejects mismatched from-states, late interactions, and terminal rewrites atomically', async () => {
    const value = setup();
    const turnId = TurnIdSchema.parse(value.idFactory.next('turn'));
    const runId = RunIdSchema.parse(value.idFactory.next('run'));
    await value.store.commit((tx) => {
      tx.createSession(value.session);
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'session.opened', providerId: 'scripted', workspace: value.session.workspace },
      });
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'turn.started', turnId, input: { parts: [{ type: 'text', text: 'transition' }] } },
      });
      tx.emit({ sessionId: value.sessionId, runId, payload: { type: 'run.started', turnId, attempt: 1 } });
    });

    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          payload: { type: 'session.state_changed', from: 'opening', to: 'failed' },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });
    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          payload: { type: 'turn.state_changed', turnId, from: 'accepted', to: 'failed' },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });

    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          runId,
          payload: { type: 'run.state_changed', from: 'awaiting_interaction', to: 'interrupting' },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });
    expect((await value.store.read(value.sessionId))?.runs[0]?.state).toBe('running');

    await value.store.commit((tx) => {
      tx.emit({
        sessionId: value.sessionId,
        runId,
        payload: { type: 'run.state_changed', from: 'running', to: 'interrupting' },
      });
    });
    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          runId,
          payload: {
            type: 'interaction.requested',
            interactionId: InteractionIdSchema.parse(value.idFactory.next('interaction')),
            turnId,
            request: { kind: 'question', prompt: 'late', multiSelect: false },
          },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });

    await value.store.commit((tx) => {
      tx.emit({
        sessionId: value.sessionId,
        runId,
        payload: {
          type: 'run.finished',
          turnId,
          termination: { outcome: 'interrupted', at: value.clock.now() },
        },
      });
    });
    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          runId,
          payload: { type: 'run.state_changed', from: 'interrupted', to: 'running' },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });
    expect((await value.store.read(value.sessionId))?.runs[0]).toMatchObject({
      state: 'interrupted',
      termination: { outcome: 'interrupted' },
    });
  });

  it('rejects interaction ownership and repeat-settlement violations', async () => {
    const value = setup();
    const turnId = TurnIdSchema.parse(value.idFactory.next('turn'));
    const otherTurnId = TurnIdSchema.parse(value.idFactory.next('turn'));
    const runId = RunIdSchema.parse(value.idFactory.next('run'));
    const interactionId = InteractionIdSchema.parse(value.idFactory.next('interaction'));
    await value.store.commit((tx) => {
      tx.createSession(value.session);
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'session.opened', providerId: 'scripted', workspace: value.session.workspace },
      });
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'turn.started', turnId, input: { parts: [{ type: 'text', text: 'one' }] } },
      });
      tx.emit({
        sessionId: value.sessionId,
        payload: { type: 'turn.started', turnId: otherTurnId, input: { parts: [{ type: 'text', text: 'two' }] } },
      });
      tx.emit({ sessionId: value.sessionId, runId, payload: { type: 'run.started', turnId, attempt: 1 } });
    });
    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          runId,
          payload: {
            type: 'interaction.requested',
            interactionId,
            turnId: otherTurnId,
            request: { kind: 'question', prompt: 'wrong owner', multiSelect: false },
          },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });

    await value.store.commit((tx) => {
      tx.emit({
        sessionId: value.sessionId,
        runId,
        payload: {
          type: 'interaction.requested',
          interactionId,
          turnId,
          request: { kind: 'question', prompt: 'valid', multiSelect: false },
        },
      });
      tx.emit({
        sessionId: value.sessionId,
        runId,
        payload: {
          type: 'interaction.settled',
          interactionId,
          turnId,
          settlement: { outcome: 'cancelled', settledAt: value.clock.now() },
        },
      });
    });
    await expect(
      value.store.commit((tx) => {
        tx.emit({
          sessionId: value.sessionId,
          runId,
          payload: {
            type: 'interaction.settled',
            interactionId,
            turnId,
            settlement: { outcome: 'cancelled', settledAt: value.clock.now() },
          },
        });
      }),
    ).rejects.toMatchObject({ error: { code: 'illegal_state_transition' } });
  });
});
