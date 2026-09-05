import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  createCounterIdFactory,
  createFixedClock,
  type CommandId,
  type InteractionId,
  type RunId,
} from '@relvo-labs/agent-protocol';
import {
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderEventSink,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';

import { createAgentRuntime, type AgentRuntime } from '../src/runtime.ts';
import { createInMemoryStore, type RuntimeStore } from '../src/store.ts';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: { holdInterrupt?: boolean; rejectStart?: boolean; rejectResponse?: boolean; rejectInterrupt?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'relvo-persistence-window-'));
  roots.push(root);
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });
  let rejectNext = false;
  const store: RuntimeStore = {
    get revision() {
      return base.revision;
    },
    commit: (mutate) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('injected transient commit failure'));
      }
      return base.commit(mutate);
    },
    read: (sessionId) => base.read(sessionId),
    readEvents: (sessionId, from, limit) => base.readEvents(sessionId, from, limit),
    readInteraction: (sessionId, interactionId) => base.readInteraction(sessionId, interactionId),
    findReceipt: (commandId) => base.findReceipt(commandId),
    listSessions: () => base.listSessions(),
  };
  const completion = deferred<ProviderRunTermination>();
  const interruptGate = deferred<undefined>();
  let sink: ProviderEventSink | undefined;
  let starts = 0;
  let responses = 0;
  let interrupts = 0;
  let disposes = 0;
  const descriptor = defineProviderDescriptor({
    providerId: 'fault-provider',
    providerVersion: '0.1.0',
    displayName: 'Fault provider',
    run: { interrupt: { mode: 'immediate' }, streaming: {} },
    interaction: { approval: {}, question: { supported: true } },
    workspace: { requires: 'directory' },
    recovery: {},
  });
  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession: () =>
      Promise.resolve({
        startRun: (request) => {
          starts += 1;
          sink = request.sink;
          if (options.rejectStart) return Promise.reject(new Error('provider rejected start'));
          return Promise.resolve({
            completion: completion.promise,
            interrupt: async () => {
              interrupts += 1;
              if (options.rejectInterrupt) throw new Error('provider rejected interrupt');
              if (options.holdInterrupt) await interruptGate.promise;
            },
          });
        },
        respondToInteraction: () => {
          responses += 1;
          if (options.rejectResponse) return Promise.reject(new Error('provider rejected response'));
          return Promise.resolve();
        },
        dispose: () => {
          disposes += 1;
          return Promise.resolve();
        },
      }),
  };
  const runtime = createAgentRuntime({
    workspaces: createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory }),
    providers: [provider],
    clock,
    idFactory,
    store,
  });
  runtimes.push(runtime);
  let id = 0;
  const next = (): CommandId => CommandIdSchema.parse(`window-${String(++id).padStart(8, '0')}`);
  const opened = await runtime.openSession({
    commandId: next(),
    type: 'open_session',
    providerId: 'fault-provider',
    workspace: { kind: 'existing', path: borrowed },
  });
  if (opened.result?.type !== 'session_opened') throw new Error('open failed');
  return {
    runtime,
    sessionId: opened.result.sessionId,
    next,
    failNextCommit: () => {
      rejectNext = true;
    },
    counts: () => ({ starts, responses, interrupts, disposes }),
    completion,
    interruptGate,
    emitInteraction: () =>
      sink?.emit({
        payload: {
          type: 'interaction.requested',
          providerRef: 'question',
          request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
        },
      }),
  };
}

async function start(value: Awaited<ReturnType<typeof fixture>>): Promise<RunId> {
  const result = await value.runtime.submitTurn({
    commandId: value.next(),
    type: 'submit_turn',
    sessionId: value.sessionId,
    input: { parts: [{ type: 'text', text: 'start' }] },
  });
  if (result.result?.type !== 'turn_accepted') throw new Error('turn failed');
  return result.result.runId;
}

async function interaction(value: Awaited<ReturnType<typeof fixture>>): Promise<InteractionId> {
  value.emitInteraction();
  for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
  const id = (await value.runtime.getSession(value.sessionId))?.interactions[0]?.interactionId;
  if (!id) throw new Error('interaction missing');
  return id;
}

describe('provider side-effect persistence windows', () => {
  it('retries submit_turn persistence with the same identities and no second provider start', async () => {
    const value = await fixture();
    const commandId = value.next();
    const command = {
      commandId,
      type: 'submit_turn' as const,
      sessionId: value.sessionId,
      input: { parts: [{ type: 'text' as const, text: 'retained' }] },
    };
    value.failNextCommit();
    await expect(value.runtime.submitTurn(command)).rejects.toThrow('injected transient');
    const conflict = await value.runtime.submitTurn({
      ...command,
      input: { parts: [{ type: 'text', text: 'changed' }] },
    });
    expect(conflict).toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    const retried = await value.runtime.submitTurn(command);
    expect(retried).toMatchObject({ disposition: 'applied', acceptedAt: conflict.acceptedAt });
    expect(value.counts().starts).toBe(1);
  });

  it('shutdown cleans a retained provider run after submit persistence fails', async () => {
    const value = await fixture();
    value.failNextCommit();
    await expect(
      value.runtime.submitTurn({
        commandId: value.next(),
        type: 'submit_turn',
        sessionId: value.sessionId,
        input: { parts: [{ type: 'text', text: 'cleanup retained run' }] },
      }),
    ).rejects.toThrow('injected transient');
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    expect(value.counts()).toMatchObject({ starts: 1, interrupts: 1, disposes: 1 });
    expect((await value.runtime.getSession(value.sessionId))?.session.state).toBe('closed');
  });

  it('retains a provider start rejection when persisting that result fails', async () => {
    const value = await fixture({ rejectStart: true });
    const command = {
      commandId: value.next(),
      type: 'submit_turn' as const,
      sessionId: value.sessionId,
      input: { parts: [{ type: 'text' as const, text: 'rejected start' }] },
    };
    value.failNextCommit();
    await expect(value.runtime.submitTurn(command)).rejects.toThrow('injected transient');
    await expect(value.runtime.submitTurn(command)).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'provider_rejected' },
    });
    expect(value.counts().starts).toBe(1);
  });

  it('retains delivered interaction response across commit failure', async () => {
    const value = await fixture();
    await start(value);
    const interactionId = await interaction(value);
    const command = {
      commandId: value.next(),
      type: 'respond_to_interaction' as const,
      sessionId: value.sessionId,
      interactionId,
      response: { kind: 'question' as const, answer: 'yes' },
    };
    value.failNextCommit();
    await expect(value.runtime.respondToInteraction(command)).rejects.toThrow('injected transient');
    await expect(
      value.runtime.respondToInteraction({ ...command, response: { kind: 'question', answer: 'no' } }),
    ).resolves.toMatchObject({ error: { code: 'command_id_conflict' } });
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({ disposition: 'applied' });
    expect(value.counts().responses).toBe(1);
  });

  it('does not redeliver a rejected interaction response when receipt persistence retries', async () => {
    const value = await fixture({ rejectResponse: true });
    await start(value);
    const interactionId = await interaction(value);
    const command = {
      commandId: value.next(),
      type: 'respond_to_interaction' as const,
      sessionId: value.sessionId,
      interactionId,
      response: { kind: 'question' as const, answer: 'yes' },
    };
    value.failNextCommit();
    await expect(value.runtime.respondToInteraction(command)).rejects.toThrow('injected transient');
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({ disposition: 'rejected' });
    expect(value.counts().responses).toBe(1);
  });

  it('retains delivered interrupt across commit failure', async () => {
    const value = await fixture();
    const runId = await start(value);
    const command = {
      commandId: value.next(),
      type: 'interrupt_run' as const,
      sessionId: value.sessionId,
      runId,
      reason: 'one',
    };
    value.failNextCommit();
    await expect(value.runtime.interruptRun(command)).rejects.toThrow('injected transient');
    await expect(value.runtime.interruptRun({ ...command, reason: 'changed' })).resolves.toMatchObject({
      error: { code: 'command_id_conflict' },
    });
    await expect(value.runtime.interruptRun(command)).resolves.toMatchObject({ disposition: 'applied' });
    expect(value.counts().interrupts).toBe(1);
  });

  it('shutdown does not redeliver an interrupt retained after commit failure', async () => {
    const value = await fixture();
    const runId = await start(value);
    value.failNextCommit();
    await expect(
      value.runtime.interruptRun({
        commandId: value.next(),
        type: 'interrupt_run',
        sessionId: value.sessionId,
        runId,
      }),
    ).rejects.toThrow('injected transient');
    await value.runtime.shutdown();
    expect(value.counts()).toMatchObject({ interrupts: 1, disposes: 1 });
  });

  it('does not redeliver a rejected interrupt when receipt persistence retries', async () => {
    const value = await fixture({ rejectInterrupt: true });
    const runId = await start(value);
    const command = { commandId: value.next(), type: 'interrupt_run' as const, sessionId: value.sessionId, runId };
    value.failNextCommit();
    await expect(value.runtime.interruptRun(command)).rejects.toThrow('injected transient');
    await expect(value.runtime.interruptRun(command)).resolves.toMatchObject({ disposition: 'rejected' });
    expect(value.counts().interrupts).toBe(1);
  });

  it('fences interactions synchronously while provider interrupt is pending', async () => {
    const value = await fixture({ holdInterrupt: true });
    const runId = await start(value);
    const interrupting = value.runtime.interruptRun({
      commandId: value.next(),
      type: 'interrupt_run',
      sessionId: value.sessionId,
      runId,
    });
    for (let pass = 0; pass < 4; pass += 1) await Promise.resolve();
    value.emitInteraction();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
    expect((await value.runtime.getSession(value.sessionId))?.interactions).toEqual([]);
    value.interruptGate.resolve(undefined);
    await interrupting;
    const events = await value.runtime.readEvents(value.sessionId, 0 as never);
    expect(events.events.some((event) => event.payload.type === 'interaction.requested')).toBe(false);
    expect(
      events.events.some(
        (event) => event.payload.type === 'diagnostic' && event.payload.message.includes('interaction.requested'),
      ),
    ).toBe(true);
  });

  it('normalizes a throwing provider completion to one terminal contract failure', async () => {
    const value = await fixture();
    await start(value);
    const completion = {};
    Object.defineProperty(completion, 'outcome', {
      enumerable: true,
      get(): never {
        throw new Error('hostile completion');
      },
    });
    value.completion.resolve(completion as never);
    await value.runtime.quiesce();
    const snapshot = await value.runtime.getSession(value.sessionId);
    expect(snapshot?.runs[0]).toMatchObject({
      state: 'failed',
      termination: { error: { code: 'provider_contract_violation' } },
    });
    const events = await value.runtime.readEvents(value.sessionId, 0 as never);
    expect(events.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
  });
});

describe('invalid command identity', () => {
  it('persists a validation rejection and conflicts corrected reuse of the same ID', async () => {
    const value = await fixture();
    const commandId = value.next();
    const rejected = await value.runtime.submitTurn({
      commandId,
      type: 'submit_turn',
      sessionId: value.sessionId,
      input: { parts: [] },
    } as never);
    expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
    await expect(
      value.runtime.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId: value.sessionId,
        input: { parts: [{ type: 'text', text: 'corrected' }] },
      }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    expect(value.counts().starts).toBe(0);
  });

  it('retains a validation rejection identity across transient receipt persistence failure', async () => {
    const value = await fixture();
    const commandId = value.next();
    const invalid = {
      commandId,
      type: 'submit_turn' as const,
      sessionId: value.sessionId,
      input: { parts: [] },
    };
    value.failNextCommit();
    await expect(value.runtime.submitTurn(invalid as never)).rejects.toThrow('injected transient');
    await expect(
      value.runtime.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId: value.sessionId,
        input: { parts: [{ type: 'text', text: 'corrected after store failure' }] },
      }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    await expect(value.runtime.submitTurn(invalid as never)).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'invalid_request' },
    });
    expect(value.counts().starts).toBe(0);
  });

  it('does not let throwing getters escape command normalization', async () => {
    const value = await fixture();
    const hostile = { commandId: value.next(), type: 'submit_turn', sessionId: value.sessionId } as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostile, 'input', {
      enumerable: true,
      get(): never {
        throw new Error('hostile command getter');
      },
    });
    await expect(value.runtime.submitTurn(hostile as never)).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'invalid_request' },
    });
  });
});
