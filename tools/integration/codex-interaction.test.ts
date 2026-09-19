/** Consumer-level composition: no Runtime -> concrete adapter package edge. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandIdSchema, createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
import { createCodexProvider } from '@relvo-labs/agent-provider-codex';
import {
  createAgentRuntime,
  createInMemoryStore,
  type AgentRuntime,
  type RuntimeStore,
} from '@relvo-labs/agent-runtime';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';
import {
  createFakeTransport,
  FAKE_THREAD_ID,
  FAKE_TURN_ID,
  flush,
  turnCompleted,
} from '../../packages/provider-codex/test/fake-transport.ts';

const cleanups: { runtime: AgentRuntime; root: string }[] = [];
afterEach(async () => {
  for (const { runtime, root } of cleanups.splice(0)) {
    // Never swallow a shutdown/store failure. The directory is owned by this fixture.
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relvo-codex-interaction-'));
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });
  const fake = createFakeTransport();
  const nativeReplies = () => fake.sent.filter((frame) => 'id' in frame && frame.id === 501 && !('method' in frame));
  let failSettlement = false;
  let failedCommits = 0;
  const store: RuntimeStore = {
    ...base,
    get revision() {
      return base.revision;
    },
    commit: (mutate) => {
      if (failSettlement) {
        failSettlement = false;
        // The observable provider effect must precede this injected store failure.
        expect(nativeReplies()).toEqual([{ id: 501, result: { decision: 'accept' } }]);
        failedCommits += 1;
        return Promise.reject(new Error('injected Codex settlement commit failure'));
      }
      return base.commit(mutate);
    },
  };
  const runtime = createAgentRuntime({
    clock,
    idFactory,
    store,
    workspaces: createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory }),
    providers: [createCodexProvider({ approvals: 'bridge', transport: () => fake.transport })],
  });
  cleanups.push({ runtime, root });
  let sequence = 0;
  const next = () => CommandIdSchema.parse(`codex-r1-${String(++sequence).padStart(8, '0')}`);
  const opened = await runtime.openSession({
    commandId: next(),
    type: 'open_session',
    providerId: 'codex',
    workspace: { kind: 'existing', path: root },
  });
  if (opened.result?.type !== 'session_opened') throw new Error('session did not open');
  const sessionId = opened.result.sessionId;
  const started = await runtime.submitTurn({
    commandId: next(),
    type: 'submit_turn',
    sessionId,
    input: { parts: [{ type: 'text', text: 'request approval' }] },
  });
  if (started.result?.type !== 'turn_accepted') throw new Error('turn was not accepted');
  fake.push({
    id: 501,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: FAKE_THREAD_ID,
      turnId: FAKE_TURN_ID,
      itemId: 'private-item',
      startedAtMs: 1700000000000,
      kind: 'command',
      environmentId: null,
      command: 'rm -rf ./build',
      cwd: root,
    },
  });
  await flush();
  // Prove ingress committed before arming the failure; an ingestion failure cannot pass.
  const snapshot = await runtime.getSession(sessionId);
  if (snapshot === undefined) throw new Error('session snapshot was not persisted');
  expect(snapshot.interactions).toHaveLength(1);
  const interaction = snapshot.interactions[0];
  if (!interaction) throw new Error('requested interaction was not persisted');
  expect(interaction.status).toBe('pending');
  expect(snapshot.runs[0]?.state).toBe('awaiting_interaction');
  return {
    runtime,
    fake,
    store,
    sessionId,
    runId: started.result.runId,
    next,
    nativeReplies,
    interactionId: interaction.interactionId,
    failSettlement: () => {
      failSettlement = true;
    },
    failedCommits: () => failedCommits,
  };
}

describe('concrete Runtime + Codex approval settlement', () => {
  it('exposes a commit failure after one native callback, conflicts changed command and commits exact retry', async () => {
    const value = await fixture();
    const command = {
      commandId: value.next(),
      type: 'respond_to_interaction' as const,
      sessionId: value.sessionId,
      interactionId: value.interactionId,
      response: { kind: 'approval' as const, decision: 'approved' as const, mode: 'once' as const },
    };
    value.failSettlement();
    await expect(value.runtime.respondToInteraction(command)).rejects.toThrow(
      'injected Codex settlement commit failure',
    );
    expect(value.failedCommits()).toBe(1);
    expect(value.nativeReplies()).toEqual([{ id: 501, result: { decision: 'accept' } }]);
    expect((await value.runtime.getSession(value.sessionId))?.interactions[0]?.status).toBe('pending');
    expect(await value.store.findReceipt(command.commandId)).toBeUndefined();
    await expect(
      value.runtime.respondToInteraction({ ...command, response: { kind: 'approval', decision: 'denied' } }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({
      disposition: 'applied',
      result: { type: 'interaction_settled', interactionId: value.interactionId },
    });
    expect((await value.runtime.getSession(value.sessionId))?.interactions[0]).toMatchObject({
      status: 'settled',
      settlement: { outcome: 'responded', response: command.response },
    });
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({ disposition: 'duplicate' });
    expect(value.nativeReplies()).toHaveLength(1);
    value.fake.push(turnCompleted('completed'));
    await value.runtime.quiesce();
  });

  it('rejects a real Runtime late response after interrupt acknowledgement and before terminal notification', async () => {
    const value = await fixture();
    await expect(
      value.runtime.interruptRun({
        commandId: value.next(),
        type: 'interrupt_run',
        sessionId: value.sessionId,
        runId: value.runId,
      }),
    ).resolves.toMatchObject({ disposition: 'applied' });
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('interrupting');
    await expect(
      value.runtime.respondToInteraction({
        commandId: value.next(),
        type: 'respond_to_interaction',
        sessionId: value.sessionId,
        interactionId: value.interactionId,
        response: { kind: 'approval', decision: 'approved', mode: 'once' },
      }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'unknown_interaction' } });
    expect(value.nativeReplies()).toEqual([{ id: 501, result: { decision: 'decline' } }]);
    value.fake.push(turnCompleted('interrupted'));
    await value.runtime.quiesce();
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('interrupted');
  });
});
