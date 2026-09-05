import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EXECUTOR_CONFORMANCE_CASES, type ConformanceHarness } from '@relvo-labs/agent-executor';
import {
  CommandIdSchema,
  type CommandId,
  type SessionId,
  createCounterIdFactory,
  createFixedClock,
} from '@relvo-labs/agent-protocol';
import { createScriptedProvider, type ScriptStep } from '@relvo-labs/agent-provider/testing';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';

import { createAgentRuntime, type AgentRuntime } from '../src/index.ts';

type Fixture = {
  readonly harness: ConformanceHarness;
  readonly runtime: AgentRuntime;
  readonly controller: ReturnType<typeof createScriptedProvider>['controller'];
  nextCommandId(): CommandId;
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(script?: readonly ScriptStep[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-runtime-test-'));
  roots.push(root);
  const borrowedWorkspacePath = join(root, 'borrowed');
  await mkdir(borrowedWorkspacePath);

  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const workspaces = createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory });
  const { provider, controller } = createScriptedProvider({
    ...(script === undefined ? {} : { defaultScript: script }),
  });
  const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory });
  let command = 0;

  const nextCommandId = (): CommandId => {
    command += 1;
    return CommandIdSchema.parse(`command-${String(command).padStart(8, '0')}`);
  };

  const harness: ConformanceHarness = {
    executor: runtime,
    nextCommandId,
    providerId: 'scripted',
    borrowedWorkspacePath,
    async settle(): Promise<void> {
      await controller.drain();
      await runtime.quiesce();
    },
    async dispose(): Promise<void> {
      await runtime.shutdown();
    },
  };

  return { harness, runtime, controller, nextCommandId };
}

async function open(value: Fixture): Promise<SessionId> {
  const receipt = await value.runtime.openSession({
    commandId: value.nextCommandId(),
    type: 'open_session',
    providerId: 'scripted',
    workspace: { kind: 'existing', path: value.harness.borrowedWorkspacePath },
  });
  expect(receipt.result?.type).toBe('session_opened');
  if (receipt.result?.type !== 'session_opened') throw new Error('fixture session did not open');
  return receipt.result.sessionId;
}

describe('executor conformance', () => {
  for (const contract of EXECUTOR_CONFORMANCE_CASES) {
    it(`${contract.id}: ${contract.title}`, async () => {
      const value = await fixture();
      try {
        await contract.run(value.harness);
      } finally {
        await value.harness.dispose();
      }
    });
  }
});

describe('runtime lifecycle guards', () => {
  it('admits only one active run per session', async () => {
    const value = await fixture([{ kind: 'delta', text: 'still running' }, { kind: 'succeed' }]);
    const sessionId = await open(value);
    const first = await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'first' }] },
    });
    const second = await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'second' }] },
    });
    expect(first.disposition).toBe('applied');
    expect(second).toMatchObject({ disposition: 'rejected', error: { code: 'illegal_state_transition' } });
    await value.harness.settle();
    await value.runtime.shutdown();
  });

  it('coalesces concurrent retries into one applied effect and one duplicate receipt', async () => {
    const value = await fixture([{ kind: 'succeed' }]);
    const sessionId = await open(value);
    const command = {
      commandId: value.nextCommandId(),
      type: 'submit_turn' as const,
      sessionId,
      input: { parts: [{ type: 'text' as const, text: 'once concurrently' }] },
    };
    const [first, second] = await Promise.all([value.runtime.submitTurn(command), value.runtime.submitTurn(command)]);
    expect(first.disposition).toBe('applied');
    expect(second.disposition).toBe('duplicate');
    expect(second.result).toEqual(first.result);
    expect(second.acceptedAt).toBe(first.acceptedAt);
    await value.harness.settle();
    expect((await value.runtime.getSession(sessionId))?.turns).toHaveLength(1);
    await value.runtime.shutdown();
  });

  it('rejects a new command that targets an already-settled interaction', async () => {
    const value = await fixture([
      { kind: 'ask', ref: 'question-1', request: { kind: 'question', prompt: 'Continue?', multiSelect: false } },
      { kind: 'succeed' },
    ]);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'ask' }] },
    });
    await value.controller.drain();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
    const snapshot = await value.runtime.getSession(sessionId);
    const interactionId = snapshot?.interactions[0]?.interactionId;
    expect(interactionId).toBeDefined();
    if (interactionId === undefined) throw new Error('interaction was not projected');

    const first = await value.runtime.respondToInteraction({
      commandId: value.nextCommandId(),
      type: 'respond_to_interaction',
      sessionId,
      interactionId,
      response: { kind: 'question', answer: 'yes' },
    });
    expect(first.disposition).toBe('applied');
    await value.harness.settle();

    const stale = await value.runtime.respondToInteraction({
      commandId: value.nextCommandId(),
      type: 'respond_to_interaction',
      sessionId,
      interactionId,
      response: { kind: 'question', answer: 'again' },
    });
    expect(stale).toMatchObject({ disposition: 'rejected', error: { code: 'interaction_already_settled' } });
    await value.runtime.shutdown();
  });

  it('closes and settles an active run even when independent interrupt is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-runtime-test-'));
    roots.push(root);
    const borrowedWorkspacePath = join(root, 'borrowed');
    await mkdir(borrowedWorkspacePath);
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const workspaces = createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory });
    const { provider } = createScriptedProvider({
      interruptMode: 'unsupported',
      defaultScript: [
        { kind: 'ask', ref: 'blocked', request: { kind: 'question', prompt: 'Wait?', multiSelect: false } },
      ],
    });
    const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory });
    let command = 0;
    const next = (): CommandId => CommandIdSchema.parse(`close-${String(++command).padStart(8, '0')}`);
    const opened = await runtime.openSession({
      commandId: next(),
      type: 'open_session',
      providerId: 'scripted',
      workspace: { kind: 'existing', path: borrowedWorkspacePath },
    });
    if (opened.result?.type !== 'session_opened') throw new Error('session did not open');
    const sessionId = opened.result.sessionId;
    await runtime.submitTurn({
      commandId: next(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'block' }] },
    });
    const closed = await runtime.closeSession({
      commandId: next(),
      type: 'close_session',
      sessionId,
    });
    expect(closed.disposition).toBe('applied');
    const snapshot = await runtime.getSession(sessionId);
    expect(snapshot?.session.state).toBe('closed');
    expect(snapshot?.runs[0]?.state).toBe('interrupted');
    await runtime.shutdown();
  });
});
