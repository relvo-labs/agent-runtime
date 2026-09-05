import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  type CommandId,
  type ProviderEventInput,
  type SessionId,
  createCounterIdFactory,
  createFixedClock,
} from '@relvo-labs/agent-protocol';
import type {
  AgentProvider,
  ProviderEventSink,
  ProviderRun,
  ProviderRunTermination,
  ProviderRunRequest,
  ProviderSession,
  ProviderSessionInit,
} from '@relvo-labs/agent-provider';
import { createScriptedProvider, type ScriptedController } from '@relvo-labs/agent-provider/testing';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';

import { coordinationEntryCountForTesting, createAgentRuntime, type AgentRuntime } from '../src/runtime.ts';

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type RuntimeFixture = {
  readonly runtime: AgentRuntime;
  readonly borrowedWorkspacePath: string;
  nextCommandId(): CommandId;
};

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeFixture(provider: AgentProvider): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-runtime-activation-test-'));
  roots.push(root);
  const borrowedWorkspacePath = join(root, 'borrowed');
  await mkdir(borrowedWorkspacePath);
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const workspaces = createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory });
  const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory });
  runtimes.push(runtime);
  let command = 0;
  return {
    runtime,
    borrowedWorkspacePath,
    nextCommandId: () => CommandIdSchema.parse(`activation-${String(++command).padStart(8, '0')}`),
  };
}

async function open(value: RuntimeFixture): Promise<SessionId> {
  const receipt = await value.runtime.openSession({
    commandId: value.nextCommandId(),
    type: 'open_session',
    providerId: 'scripted',
    workspace: { kind: 'existing', path: value.borrowedWorkspacePath },
  });
  if (receipt.result?.type !== 'session_opened') throw new Error('test session did not open');
  return receipt.result.sessionId;
}

function synchronousProvider(options: {
  readonly sessionEvents?: readonly ProviderEventInput[];
  readonly runEvents?: readonly ProviderEventInput[];
  readonly holdFirstRun?: Deferred<undefined>;
  readonly onInteractionResponse?: () => void;
}): { readonly provider: AgentProvider; readonly controller: ScriptedController; readonly startCount: () => number } {
  const scripted = createScriptedProvider({
    supportsRecovery: false,
    defaultScript: [
      { kind: 'ask', ref: 'question', request: { kind: 'question', prompt: 'Continue?', multiSelect: false } },
      { kind: 'succeed' },
    ],
  });
  let starts = 0;

  const provider: AgentProvider = {
    describe: () => scripted.provider.describe(),
    async createSession(init: ProviderSessionInit): Promise<ProviderSession> {
      for (const event of options.sessionEvents ?? []) init.sink.emit(event);
      const session = await scripted.provider.createSession(init);
      return {
        async startRun(request: ProviderRunRequest): Promise<ProviderRun> {
          starts += 1;
          for (const event of options.runEvents ?? []) request.sink.emit(event);
          const run = await session.startRun(request);
          if (starts === 1 && options.holdFirstRun !== undefined) await options.holdFirstRun.promise;
          return run;
        },
        async respondToInteraction(providerRef, response): Promise<void> {
          options.onInteractionResponse?.();
          await session.respondToInteraction(providerRef, response);
        },
        dispose: () => session.dispose(),
      };
    },
  };

  return { provider, controller: scripted.controller, startCount: () => starts };
}

describe('provider event activation', () => {
  it('orders synchronous createSession and startRun emissions after their owning start events', async () => {
    const { provider } = synchronousProvider({
      sessionEvents: [{ payload: { type: 'diagnostic', level: 'info', message: 'session created synchronously' } }],
      runEvents: [
        { payload: { type: 'run.message_delta', text: 'first synchronous delta' } },
        { payload: { type: 'run.message_delta', text: 'second synchronous delta' } },
      ],
    });
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'start' }] },
    });

    const page = await value.runtime.readEvents(sessionId, 0 as never);
    const types = page.events.map((event) => event.payload.type);
    expect(types.indexOf('session.opened')).toBeLessThan(types.indexOf('diagnostic'));
    expect(types.indexOf('run.started')).toBeLessThan(types.indexOf('run.message_delta'));
    expect(
      page.events.flatMap((event) => (event.payload.type === 'run.message_delta' ? [event.payload.text] : [])),
    ).toEqual(['first synchronous delta', 'second synchronous delta']);
  });

  it('bounds pre-activation staging and emits an explicit overflow diagnostic', async () => {
    const runEvents = Array.from({ length: 300 }, (_, index): ProviderEventInput => ({
      payload: { type: 'run.message_delta', text: `synchronous delta ${String(index + 1)}` },
    }));
    const { provider } = synchronousProvider({ runEvents });
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'overflow staging' }] },
    });

    const page = await value.runtime.readEvents(sessionId, 0 as never, 1000);
    const deltas = page.events.filter((event) => event.payload.type === 'run.message_delta');
    const diagnostics = page.events.filter((event) => event.payload.type === 'diagnostic');
    expect(deltas).toHaveLength(256);
    expect(deltas[0]?.payload).toMatchObject({ text: 'synchronous delta 1' });
    expect(deltas.at(-1)?.payload).toMatchObject({ text: 'synchronous delta 256' });
    expect(diagnostics.at(-1)?.payload).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('44 provider events exceeded the 256-event pre-activation buffer'),
    });
  });

  it('snapshots mutable provider emissions at each synchronous emit call', async () => {
    const scripted = createScriptedProvider({
      supportsRecovery: false,
      defaultScript: [{ kind: 'succeed' }],
    });
    const provider: AgentProvider = {
      describe: () => scripted.provider.describe(),
      async createSession(init): Promise<ProviderSession> {
        const session = await scripted.provider.createSession(init);
        return {
          async startRun(request): Promise<ProviderRun> {
            const reused = { payload: { type: 'run.message_delta' as const, text: 'first value' } };
            request.sink.emit(reused);
            reused.payload.text = 'second value';
            request.sink.emit(reused);

            const invalidThenValid = { payload: { type: 'run.message_delta' as const, text: '' } };
            request.sink.emit(invalidThenValid);
            invalidThenValid.payload.text = 'must not become valid';

            const validThenInvalid = { payload: { type: 'run.message_delta' as const, text: 'stable value' } };
            request.sink.emit(validThenInvalid);
            validThenInvalid.payload.text = '';
            return session.startRun(request);
          },
          respondToInteraction: (providerRef, response) => session.respondToInteraction(providerRef, response),
          dispose: () => session.dispose(),
        };
      },
    };
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'snapshot each emission' }] },
    });

    const page = await value.runtime.readEvents(sessionId, 0 as never);
    expect(
      page.events.flatMap((event) => (event.payload.type === 'run.message_delta' ? [event.payload.text] : [])),
    ).toEqual(['first value', 'second value', 'stable value']);
    expect(page.events.filter((event) => event.payload.type === 'diagnostic')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ message: expect.stringContaining('provider emitted an invalid event') }),
      }),
    ]);
  });

  it('rejects cyclic provider graphs before staging while preserving shared acyclic input', async () => {
    const scripted = createScriptedProvider({
      supportsRecovery: false,
      defaultScript: [{ kind: 'succeed' }],
    });
    const provider: AgentProvider = {
      describe: () => scripted.provider.describe(),
      async createSession(init): Promise<ProviderSession> {
        const session = await scripted.provider.createSession(init);
        return {
          async startRun(request): Promise<ProviderRun> {
            const objectCycle: Record<string, unknown> = {};
            objectCycle.self = objectCycle;
            const arrayCycle: unknown[] = [];
            arrayCycle.push(arrayCycle);
            const mutualObject: Record<string, unknown> = {};
            const mutualArray: unknown[] = [mutualObject];
            mutualObject.array = mutualArray;
            for (const [toolName, detail] of [
              ['object-cycle', objectCycle],
              ['array-cycle', { value: arrayCycle }],
              ['mutual-cycle', mutualObject],
            ] as const) {
              request.sink.emit({
                payload: { type: 'run.tool_activity', toolName, phase: 'invoked', detail },
              } as ProviderEventInput);
            }
            const throwingDetail = {};
            Object.defineProperty(throwingDetail, 'value', {
              enumerable: true,
              get(): never {
                throw new Error('hostile getter');
              },
            });
            expect(() =>
              request.sink.emit({
                payload: {
                  type: 'run.tool_activity',
                  toolName: 'throwing-accessor',
                  phase: 'invoked',
                  detail: throwingDetail,
                },
              }),
            ).not.toThrow();
            const throwingProxy = new Proxy(
              { payload: { type: 'run.message_delta' as const, text: 'must not commit' } },
              {
                ownKeys(): never {
                  throw new Error('hostile proxy');
                },
              },
            );
            expect(() => request.sink.emit(throwingProxy)).not.toThrow();

            const shared = { value: 'before mutation' };
            request.sink.emit({
              payload: {
                type: 'run.tool_activity',
                toolName: 'shared-acyclic',
                phase: 'succeeded',
                detail: { left: shared, right: shared },
              },
            });
            shared.value = 'after mutation';
            return session.startRun(request);
          },
          respondToInteraction: (providerRef, response) => session.respondToInteraction(providerRef, response),
          dispose: () => session.dispose(),
        };
      },
    };
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'cyclic provider input' }] },
    });

    const page = await value.runtime.readEvents(sessionId, 0 as never);
    const toolEvents = page.events.filter((event) => event.payload.type === 'run.tool_activity');
    const invalidDiagnostics = page.events.filter(
      (event) =>
        event.payload.type === 'diagnostic' && event.payload.message.includes('provider emitted an invalid event'),
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toMatchObject({
      toolName: 'shared-acyclic',
      detail: { left: { value: 'before mutation' }, right: { value: 'before mutation' } },
    });
    expect(invalidDiagnostics).toHaveLength(5);
    expect(
      invalidDiagnostics.every(
        (event) => event.payload.type === 'diagnostic' && event.payload.detail?.code === 'provider_contract_violation',
      ),
    ).toBe(true);
    expect(
      invalidDiagnostics.flatMap((event) => (event.payload.type === 'diagnostic' ? [event.payload.message] : [])),
    ).toEqual(
      Array.from({ length: 5 }, () => 'provider emitted an invalid event: input is not acyclic plain JSON data'),
    );
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it('uses the same point-in-time snapshot semantics after activation', async () => {
    const scripted = createScriptedProvider({ supportsRecovery: false, defaultScript: [{ kind: 'succeed' }] });
    const completion = deferred<ProviderRunTermination>();
    let runSink: ProviderEventSink | undefined;
    const provider: AgentProvider = {
      describe: () => scripted.provider.describe(),
      async createSession(init): Promise<ProviderSession> {
        const session = await scripted.provider.createSession(init);
        return {
          startRun(request): Promise<ProviderRun> {
            runSink = request.sink;
            return Promise.resolve({ completion: completion.promise, interrupt: () => Promise.resolve() });
          },
          respondToInteraction: (providerRef, response) => session.respondToInteraction(providerRef, response),
          dispose: () => session.dispose(),
        };
      },
    };
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'active snapshots' }] },
    });
    const reused = { payload: { type: 'run.message_delta' as const, text: 'active first' } };
    runSink?.emit(reused);
    reused.payload.text = 'active second';
    runSink?.emit(reused);
    reused.payload.text = 'mutated after both calls';
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const page = await value.runtime.readEvents(sessionId, 0 as never);
    expect(
      page.events.flatMap((event) => (event.payload.type === 'run.message_delta' ? [event.payload.text] : [])),
    ).toEqual(['active first', 'active second']);
  });

  it('rejects a provider interaction emitted after its run starts interrupting', async () => {
    const scripted = createScriptedProvider({ supportsRecovery: false, defaultScript: [{ kind: 'succeed' }] });
    let runSink: ProviderEventSink | undefined;
    const completion = deferred<ProviderRunTermination>();
    const provider: AgentProvider = {
      describe: () => scripted.provider.describe(),
      async createSession(init): Promise<ProviderSession> {
        const session = await scripted.provider.createSession(init);
        return {
          startRun(request): Promise<ProviderRun> {
            runSink = request.sink;
            return Promise.resolve({ completion: completion.promise, interrupt: () => Promise.resolve() });
          },
          respondToInteraction: (providerRef, response) => session.respondToInteraction(providerRef, response),
          dispose: () => session.dispose(),
        };
      },
    };
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    const submitted = await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'interrupt before question' }] },
    });
    if (submitted.result?.type !== 'turn_accepted') throw new Error('run did not start');
    await value.runtime.interruptRun({
      commandId: value.nextCommandId(),
      type: 'interrupt_run',
      sessionId,
      runId: submitted.result.runId,
    });
    runSink?.emit({
      payload: {
        type: 'interaction.requested',
        providerRef: 'late-question',
        request: { kind: 'question', prompt: 'Too late?', multiSelect: false },
      },
    });
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const snapshot = await value.runtime.getSession(sessionId);
    const page = await value.runtime.readEvents(sessionId, 0 as never);
    expect(snapshot?.runs[0]?.state).toBe('interrupting');
    expect(snapshot?.interactions).toEqual([]);
    expect(page.events.some((event) => event.payload.type === 'interaction.requested')).toBe(false);
    expect(page.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'diagnostic',
          message: expect.stringContaining('interaction.requested'),
        }),
      }),
    );

    completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();
    runSink?.emit({
      payload: {
        type: 'interaction.requested',
        providerRef: 'terminal-question',
        request: { kind: 'question', prompt: 'Even later?', multiSelect: false },
      },
    });
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
    const terminalSnapshot = await value.runtime.getSession(sessionId);
    const terminalPage = await value.runtime.readEvents(sessionId, 0 as never);
    expect(terminalSnapshot?.runs[0]?.state).toBe('succeeded');
    expect(terminalSnapshot?.interactions).toEqual([]);
    expect(
      terminalPage.events.filter(
        (event) => event.payload.type === 'diagnostic' && event.payload.message.includes('interaction.requested'),
      ),
    ).toHaveLength(2);
  });
});

describe('scoped command coordination', () => {
  it('coalesces concurrent same-ID same-payload commands into one provider effect', async () => {
    const { provider, startCount } = synchronousProvider({});
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    const command = {
      commandId: value.nextCommandId(),
      type: 'submit_turn' as const,
      sessionId,
      input: { parts: [{ type: 'text' as const, text: 'same payload' }] },
    };

    const [first, second] = await Promise.all([value.runtime.submitTurn(command), value.runtime.submitTurn(command)]);
    expect([first.disposition, second.disposition]).toEqual(['applied', 'duplicate']);
    expect(second.result).toEqual(first.result);
    expect(second.acceptedAt).toBe(first.acceptedAt);
    expect(startCount()).toBe(1);
  });

  it('rejects concurrent same-ID different-payload reuse after one canonical effect', async () => {
    const { provider, startCount } = synchronousProvider({});
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    const commandId = value.nextCommandId();

    const [first, conflicting] = await Promise.all([
      value.runtime.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'canonical payload' }] },
      }),
      value.runtime.submitTurn({
        commandId,
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: 'conflicting payload' }] },
      }),
    ]);

    expect(first.disposition).toBe('applied');
    expect(conflicting).toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    expect(startCount()).toBe(1);
  });

  it('allows only one of two competing interaction settlements to reach the provider', async () => {
    let providerResponses = 0;
    const { provider, controller } = synchronousProvider({
      onInteractionResponse: () => {
        providerResponses += 1;
      },
    });
    const value = await runtimeFixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'ask' }] },
    });
    await controller.drain();
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
    const interactionId = (await value.runtime.getSession(sessionId))?.interactions[0]?.interactionId;
    if (interactionId === undefined) throw new Error('interaction was not projected');

    const [winner, stale] = await Promise.all([
      value.runtime.respondToInteraction({
        commandId: value.nextCommandId(),
        type: 'respond_to_interaction',
        sessionId,
        interactionId,
        response: { kind: 'question', answer: 'yes' },
      }),
      value.runtime.respondToInteraction({
        commandId: value.nextCommandId(),
        type: 'respond_to_interaction',
        sessionId,
        interactionId,
        response: { kind: 'question', answer: 'no' },
      }),
    ]);

    expect(winner.disposition).toBe('applied');
    expect(stale).toMatchObject({ disposition: 'rejected', error: { code: 'interaction_already_settled' } });
    expect(providerResponses).toBe(1);
  });

  it('does not serialize commands for unrelated sessions', async () => {
    const releaseFirstRun = deferred<undefined>();
    const { provider, startCount } = synchronousProvider({ holdFirstRun: releaseFirstRun });
    const value = await runtimeFixture(provider);
    const firstSessionId = await open(value);
    const secondSessionId = await open(value);

    const first = value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId: firstSessionId,
      input: { parts: [{ type: 'text', text: 'held session' }] },
    });
    for (let pass = 0; pass < 4; pass += 1) await Promise.resolve();
    const second = value.runtime.submitTurn({
      commandId: value.nextCommandId(),
      type: 'submit_turn',
      sessionId: secondSessionId,
      input: { parts: [{ type: 'text', text: 'independent session' }] },
    });
    for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();

    const observedBeforeRelease = startCount();
    releaseFirstRun.resolve(undefined);
    await Promise.all([first, second]);
    expect(observedBeforeRelease).toBe(2);
    expect(coordinationEntryCountForTesting(value.runtime)).toEqual({ commands: 0, sessions: 0 });
  });
});
