import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  SequenceSchema,
  createCounterIdFactory,
  createFixedClock,
  type CommandId,
  type InteractionId,
  type InteractionRequest,
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
  options: {
    holdReadInteraction?: boolean;
    holdInterrupt?: boolean;
    rejectStart?: boolean;
    rejectResponse?: boolean;
    rejectInterrupt?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'relvo-persistence-window-'));
  roots.push(root);
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });
  let rejectNext: false | 'before' | 'after' = false;
  let skipCommits = 0;
  const interactionRead = deferred<undefined>();
  const interactionReadGate = deferred<undefined>();
  const store: RuntimeStore = {
    get revision() {
      return base.revision;
    },
    commit: (mutate) => {
      if (rejectNext && skipCommits-- <= 0) {
        const phase = rejectNext;
        rejectNext = false;
        if (phase === 'after')
          return base.commit((tx) => {
            mutate(tx);
            throw new Error('injected transient commit failure');
          });
        return Promise.reject(new Error('injected transient commit failure'));
      }
      return base.commit(mutate);
    },
    read: (sessionId) => base.read(sessionId),
    readEvents: (sessionId, from, limit) => base.readEvents(sessionId, from, limit),
    readInteraction: async (sessionId, interactionId) => {
      const snapshot = await base.readInteraction(sessionId, interactionId);
      if (options.holdReadInteraction) {
        interactionRead.resolve(undefined);
        await interactionReadGate.promise;
      }
      return snapshot;
    },
    findReceipt: (commandId) => base.findReceipt(commandId),
    listSessions: () => base.listSessions(),
  };
  const completion = deferred<ProviderRunTermination>();
  const interruptGate = deferred<undefined>();
  let sink: ProviderEventSink | undefined;
  let sessionSink: ProviderEventSink | undefined;
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
    createSession: (init) => {
      sessionSink = init.sink;
      return Promise.resolve({
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
      });
    },
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
    now: () => clock.now(),
    failNextCommit: (phase: 'before' | 'after' = 'before', skip = 0) => {
      rejectNext = phase;
      skipCommits = skip;
    },
    counts: () => ({ starts, responses, interrupts, disposes }),
    completion,
    interactionRead,
    interactionReadGate,
    interruptGate,
    emitInteraction: (request: InteractionRequest = { kind: 'question', prompt: 'Continue?', multiSelect: false }) =>
      sink?.emit({
        payload: {
          type: 'interaction.requested',
          providerRef: 'question',
          request,
        },
      }),
    /** A provider withdrawing a request it raised, on the run's own sink. */
    emitWithdrawal: (providerRef = 'question') =>
      sink?.emit({ payload: { type: 'interaction.withdrawn', providerRef } }),
    /** The same payload on the *session* sink, which owns no run. */
    emitSessionWithdrawal: (providerRef = 'question') =>
      sessionSink?.emit({ payload: { type: 'interaction.withdrawn', providerRef } }),
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

  it('finalizes a retained delivered response before racing provider completion', async () => {
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
    expect(value.counts().responses).toBe(1);

    value.completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();

    await expect(
      value.runtime.respondToInteraction({ ...command, response: { kind: 'question', answer: 'changed' } }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({
      disposition: 'applied',
      result: { type: 'interaction_settled', interactionId },
    });

    const snapshot = await value.runtime.getSession(value.sessionId);
    expect(snapshot?.interactions[0]).toMatchObject({
      status: 'settled',
      settlement: { outcome: 'responded', response: command.response },
    });
    expect(snapshot?.runs[0]).toMatchObject({ state: 'succeeded', pendingInteractionIds: [] });
    expect(value.counts().responses).toBe(1);

    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    expect(value.counts()).toMatchObject({ responses: 1, interrupts: 0, disposes: 1 });
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

/**
 * Provider-originated withdrawal.
 *
 * The runtime owns the settlement's identity and time; the provider only names
 * a reference it was given. These are the adversarial edges: a reference it was
 * never given, a reference whose answer is already a retained logical
 * settlement, and a run-scoped payload emitted where no run owns it.
 */
describe('provider interaction withdrawal', () => {
  it('settles the interaction withdrawn, clears routing and resumes the run', async () => {
    const value = await fixture();
    await start(value);
    const interactionId = await interaction(value);
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('awaiting_interaction');

    value.emitWithdrawal();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const snapshot = await value.runtime.getSession(value.sessionId);
    expect(snapshot?.interactions[0]).toMatchObject({
      status: 'settled',
      settlement: { outcome: 'withdrawn' },
    });
    expect(snapshot?.interactions[0]?.settlement?.response).toBeUndefined();
    expect(snapshot?.runs[0]?.state).toBe('running');
    expect(snapshot?.runs[0]?.pendingInteractionIds).toStrictEqual([]);

    // Routing is gone with it, and the provider was never asked to apply an
    // answer to a question that is no longer being asked.
    const late = await value.runtime.respondToInteraction({
      commandId: value.next(),
      type: 'respond_to_interaction',
      sessionId: value.sessionId,
      interactionId,
      response: { kind: 'question', answer: 'too late' },
    });
    expect(late).toMatchObject({ disposition: 'rejected', error: { code: 'interaction_already_settled' } });
    expect(value.counts().responses).toBe(0);
  });

  it('ignores a withdrawal naming a reference this provider never raised', async () => {
    const value = await fixture();
    await start(value);
    await interaction(value);

    value.emitWithdrawal('some-other-reference');
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const snapshot = await value.runtime.getSession(value.sessionId);
    // Untouched: a provider must not be able to settle by guessing a token.
    expect(snapshot?.interactions[0]?.status).toBe('pending');
    expect(snapshot?.runs[0]?.state).toBe('awaiting_interaction');
  });

  it('keeps a retained settlement ahead of a later withdrawal', async () => {
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

    // The answer reached the provider; only its persistence failed.
    value.failNextCommit();
    await expect(value.runtime.respondToInteraction(command)).rejects.toThrow('injected transient');
    expect(value.counts().responses).toBe(1);

    value.emitWithdrawal();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
    const duringRetention = await value.runtime.getSession(value.sessionId);
    expect(duringRetention?.interactions[0]?.status).toBe('pending');

    // The exact retry still records the answer that was actually delivered.
    const retried = await value.runtime.respondToInteraction(command);
    expect(retried.disposition).toBe('applied');
    const settled = await value.runtime.getSession(value.sessionId);
    expect(settled?.interactions[0]?.settlement).toMatchObject({
      outcome: 'responded',
      response: { kind: 'question', answer: 'yes' },
    });
    expect(value.counts().responses).toBe(1);
  });

  it('records a diagnostic for a withdrawal emitted on the session sink', async () => {
    const value = await fixture();
    await start(value);
    await interaction(value);

    value.emitSessionWithdrawal();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const snapshot = await value.runtime.getSession(value.sessionId);
    expect(snapshot?.interactions[0]?.status).toBe('pending');
    const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0), 1000);
    const diagnostics = page.events.filter((event) => event.payload.type === 'diagnostic');
    expect(JSON.stringify(diagnostics)).toContain('interaction.withdrawn');
  });
});

describe('retained withdrawal persistence', () => {
  for (const phase of ['before', 'after'] as const) {
    for (const finish of ['redelivery', 'completion', 'cleanup'] as const) {
      it(`${phase}-mutation failure: fences answers and materializes on ${finish}`, async () => {
        const value = await fixture();
        await start(value);
        const interactionId = await interaction(value);
        value.failNextCommit(phase);
        value.emitWithdrawal();
        for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
        expect((await value.runtime.getSession(value.sessionId))?.interactions[0]?.status).toBe('pending');
        const afterFailure = value.now();
        const command = {
          commandId: value.next(),
          type: 'respond_to_interaction' as const,
          sessionId: value.sessionId,
          interactionId,
          response: { kind: 'question' as const, answer: 'too late' },
        };
        const rejected = await value.runtime.respondToInteraction(command);
        expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'interaction_already_settled' } });
        expect(await value.runtime.respondToInteraction(command)).toEqual(rejected);
        expect(value.counts().responses).toBe(0);
        if (finish === 'redelivery') {
          value.failNextCommit(phase);
          value.emitWithdrawal();
          for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
          expect((await value.runtime.getSession(value.sessionId))?.interactions[0]?.status).toBe('pending');
          value.emitWithdrawal();
          value.emitWithdrawal();
          for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
          expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('running');
        }
        if (finish === 'cleanup') await value.runtime.shutdown();
        value.completion.resolve({ outcome: 'succeeded' });
        await value.runtime.quiesce();
        const snapshot = await value.runtime.getSession(value.sessionId);
        expect(snapshot?.interactions[0]).toMatchObject({ status: 'settled', settlement: { outcome: 'withdrawn' } });
        expect(snapshot?.runs[0]?.state).toBe(finish === 'cleanup' ? 'interrupted' : 'succeeded');
        expect(Date.parse(snapshot!.interactions[0]!.settlement!.settledAt)).toBeLessThan(Date.parse(afterFailure));
        value.emitWithdrawal();
        await value.runtime.quiesce();
        const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0), 1000);
        expect(page.events.filter((event) => event.payload.type === 'interaction.settled')).toHaveLength(1);
        expect(JSON.stringify(page)).not.toContain('provider_contract_violation');
        await value.runtime.shutdown();
        expect((await value.runtime.getSession(value.sessionId))?.session.state).toBe('closed');
      });
    }
  }
});

describe('prototype-named answers through Runtime', () => {
  it.each([['constructor'], ['toString'], ['ordinary', 'constructor', 'toString']])(
    'returns a replayable invalid_request for missing %j and applies present answers',
    async (...keys) => {
      const value = await fixture();
      await start(value);
      value.emitInteraction({
        kind: 'question_set',
        questions: keys.map((key) => ({
          key,
          prompt: 'Answer explicitly',
          choices: [{ value: 'yes', label: 'Yes' }],
          multiSelect: false,
          allowFreeText: false,
          sensitive: false,
        })),
      });
      for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
      const interactionId = (await value.runtime.getSession(value.sessionId))!.interactions[0]!.interactionId;
      const command = {
        commandId: value.next(),
        type: 'respond_to_interaction' as const,
        sessionId: value.sessionId,
        interactionId,
        response: { kind: 'question_set' as const, answers: {} },
      };
      const rejected = await value.runtime.respondToInteraction(command);
      expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
      expect(await value.runtime.respondToInteraction(command)).toEqual(rejected);
      expect(value.counts().responses).toBe(0);
      const answers = Object.fromEntries(keys.map((key) => [key, { type: 'selection' as const, values: ['yes'] }]));
      if (keys.length > 1) {
        const partial = { ...answers };
        Reflect.deleteProperty(partial, 'toString');
        expect(
          await value.runtime.respondToInteraction({
            ...command,
            commandId: value.next(),
            response: { kind: 'question_set', answers: partial },
          }),
        ).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
      }
      expect(
        await value.runtime.respondToInteraction({
          ...command,
          commandId: value.next(),
          response: { kind: 'question_set', answers },
        }),
      ).toMatchObject({ disposition: 'applied' });
      expect(value.counts().responses).toBe(1);
    },
  );
});

describe('retained withdrawals survive cleanup rollback', () => {
  it.each(['before', 'after'] as const)(
    '%s-mutation cleanup failure retries the exact close truthfully',
    async (phase) => {
      const value = await fixture();
      await start(value);
      await interaction(value);
      value.failNextCommit(phase);
      value.emitWithdrawal();
      for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
      const close = {
        commandId: value.next(),
        type: 'close_session' as const,
        sessionId: value.sessionId,
        ifRunActive: 'interrupt' as const,
      };
      // Closing-state commit succeeds; terminal fallback rolls back.
      value.failNextCommit(phase, 1);
      await expect(value.runtime.closeSession(close)).rejects.toThrow('injected transient');
      expect((await value.runtime.getSession(value.sessionId))?.interactions[0]?.status).toBe('pending');
      expect(await value.runtime.closeSession(close)).toMatchObject({ disposition: 'applied' });
      value.completion.resolve({ outcome: 'succeeded' });
      value.emitWithdrawal();
      await value.runtime.quiesce();
      const snapshot = await value.runtime.getSession(value.sessionId);
      expect(snapshot?.session.state).toBe('closed');
      expect(snapshot?.interactions[0]?.settlement?.outcome).toBe('withdrawn');
      expect(snapshot?.runs[0]?.state).toBe('interrupted');
      const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0), 1000);
      expect(page.events.filter((event) => event.payload.type === 'interaction.settled')).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain('provider_contract_violation');
    },
  );
});

describe('withdrawal races an answer store read', () => {
  it.each(['before', 'after'] as const)(
    '%s-mutation failure fences an answer that already passed its first guard',
    async (phase) => {
      const value = await fixture({ holdReadInteraction: true });
      await start(value);
      const interactionId = await interaction(value);
      const answering = value.runtime.respondToInteraction({
        commandId: value.next(),
        type: 'respond_to_interaction',
        sessionId: value.sessionId,
        interactionId,
        response: { kind: 'question', answer: 'late' },
      });
      await value.interactionRead.promise;
      value.failNextCommit(phase);
      value.emitWithdrawal();
      for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
      value.interactionReadGate.resolve(undefined);
      expect(await answering).toMatchObject({
        disposition: 'rejected',
        error: { code: 'interaction_already_settled' },
      });
      expect(value.counts().responses).toBe(0);
      value.completion.resolve({ outcome: 'succeeded' });
      await value.runtime.quiesce();
      const snapshot = await value.runtime.getSession(value.sessionId);
      expect(snapshot?.interactions[0]?.settlement?.outcome).toBe('withdrawn');
      expect(snapshot?.runs[0]?.state).toBe('succeeded');
    },
  );
});

describe('maximum-size missing question answers', () => {
  it('returns a replayable bounded rejection before any provider effect and keeps the same run answerable', async () => {
    const value = await fixture();
    const runId = await start(value);
    const keys = Array.from({ length: 32 }, (_, index) => `q${String(index).padStart(2, '0')}`.padEnd(64, 'x'));
    value.emitInteraction({
      kind: 'question_set',
      questions: keys.map((key) => ({
        key,
        prompt: 'Answer explicitly',
        multiSelect: false,
        allowFreeText: false,
        sensitive: false,
      })),
    });
    for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
    const interactionId = (await value.runtime.getSession(value.sessionId))!.interactions[0]!.interactionId;
    const command = {
      commandId: value.next(),
      type: 'respond_to_interaction' as const,
      sessionId: value.sessionId,
      interactionId,
      response: { kind: 'question_set' as const, answers: {} },
    };
    const rejected = await value.runtime.respondToInteraction(command);
    expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
    expect(rejected.error!.message.length).toBeLessThanOrEqual(2000);
    expect(await value.runtime.respondToInteraction(command)).toEqual(rejected);
    expect(value.counts().responses).toBe(0);
    expect((await value.runtime.getSession(value.sessionId))?.interactions[0]?.status).toBe('pending');
    const corrected = await value.runtime.respondToInteraction({
      ...command,
      commandId: value.next(),
      response: {
        kind: 'question_set',
        answers: Object.fromEntries(keys.map((key) => [key, { type: 'text' as const, text: 'provided' }])),
      },
    });
    expect(corrected.disposition).toBe('applied');
    expect(value.counts().responses).toBe(1);
    value.completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]).toMatchObject({ runId, state: 'succeeded' });
  });
});
