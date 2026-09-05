import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  CommandReceiptSchema,
  SessionIdSchema,
  WorkspaceLeaseIdSchema,
  createCounterIdFactory,
  createFixedClock,
  type CommandId,
  type SessionId,
} from '@relvo-labs/agent-protocol';
import {
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderRun,
  type ProviderRunTermination,
  type ProviderRunRequest,
  type ProviderSession,
  type ProviderSessionInit,
} from '@relvo-labs/agent-provider';
import { createLocalWorkspaceProvider, type WorkspaceLease, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

import { createAgentRuntime, type AgentRuntime } from '../src/index.ts';

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type ProviderControl = {
  readonly completion: Deferred<ProviderRunTermination>;
  readonly dispose: Deferred<undefined>;
  readonly start: Deferred<undefined>;
  created: number;
  disposed: number;
  responses: number;
};

function controlledProvider(
  options: {
    readonly emitInteraction?: boolean;
    readonly completeOnResponse?: boolean;
    readonly completeOnInterrupt?: boolean;
    readonly holdDispose?: boolean;
    readonly holdStart?: boolean;
  } = {},
): { readonly provider: AgentProvider; readonly control: ProviderControl } {
  const control: ProviderControl = {
    completion: deferred<ProviderRunTermination>(),
    dispose: deferred<undefined>(),
    start: deferred<undefined>(),
    created: 0,
    disposed: 0,
    responses: 0,
  };
  const descriptor = defineProviderDescriptor({
    providerId: 'controlled',
    providerVersion: '0.1.0',
    displayName: 'Controlled test provider',
    run: {
      interrupt: { mode: 'immediate', deliversPartialOutput: true, sessionRemainsUsable: true },
      streaming: {},
    },
    interaction: { approval: {}, question: { supported: true } },
    workspace: { requires: 'directory' },
    recovery: {},
  });
  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession(_init: ProviderSessionInit): Promise<ProviderSession> {
      control.created += 1;
      return Promise.resolve({
        async startRun(request: ProviderRunRequest): Promise<ProviderRun> {
          if (options.emitInteraction) {
            request.sink.emit({
              payload: {
                type: 'interaction.requested',
                providerRef: 'question',
                request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
              },
            });
          }
          if (options.holdStart) await control.start.promise;
          return {
            completion: control.completion.promise,
            interrupt: (reason?: string) => {
              if (options.completeOnInterrupt !== false) {
                control.completion.resolve({
                  outcome: 'interrupted',
                  ...(reason === undefined ? {} : { reason }),
                });
              }
              return Promise.resolve();
            },
          };
        },
        async respondToInteraction(): Promise<void> {
          control.responses += 1;
          if (options.completeOnResponse) {
            control.completion.resolve({ outcome: 'succeeded' });
            await Promise.resolve();
          }
        },
        async dispose(): Promise<void> {
          control.disposed += 1;
          if (options.holdDispose) await control.dispose.promise;
        },
      });
    },
  };
  return { provider, control };
}

type Fixture = {
  readonly runtime: AgentRuntime;
  readonly borrowed: string;
  next(): CommandId;
};

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: AgentProvider): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-release-blocker-test-'));
  roots.push(root);
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const runtime = createAgentRuntime({
    providers: [provider],
    workspaces: createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory }),
    clock,
    idFactory,
  });
  runtimes.push(runtime);
  let command = 0;
  return {
    runtime,
    borrowed,
    next: () => CommandIdSchema.parse(`blocker-${String(++command).padStart(8, '0')}`),
  };
}

async function open(value: Fixture): Promise<SessionId> {
  const opened = await value.runtime.openSession({
    commandId: value.next(),
    type: 'open_session',
    providerId: 'controlled',
    workspace: { kind: 'existing', path: value.borrowed },
  });
  if (opened.result?.type !== 'session_opened') throw new Error('session did not open');
  return opened.result.sessionId;
}

describe('schema-valid command outcomes', () => {
  it('throws a typed validation error for an unknown dispatch discriminant', async () => {
    const { provider } = controlledProvider();
    const value = await fixture(provider);
    await expect(
      value.runtime.dispatch({ commandId: value.next(), type: 'unknown-command' } as never),
    ).rejects.toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('replays a rejected command deterministically as a valid rejected receipt', async () => {
    const { provider } = controlledProvider();
    const value = await fixture(provider);
    const command = {
      commandId: value.next(),
      type: 'submit_turn' as const,
      sessionId: SessionIdSchema.parse('ses_0000000000000001'),
      input: { parts: [{ type: 'text' as const, text: 'missing session' }] },
    };
    const first = await value.runtime.submitTurn(command);
    const duplicate = await value.runtime.submitTurn(command);
    expect(first.disposition).toBe('rejected');
    expect(duplicate).toEqual(first);
    expect(CommandReceiptSchema.safeParse(first).success).toBe(true);
    expect(CommandReceiptSchema.safeParse(duplicate).success).toBe(true);
  });
});

describe('interaction and completion finalization', () => {
  it('records exactly one settlement when response completion races the command', async () => {
    const { provider, control } = controlledProvider({ emitInteraction: true, completeOnResponse: true });
    const value = await fixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.next(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'race' }] },
    });
    const interactionId = (await value.runtime.getSession(sessionId))?.interactions[0]?.interactionId;
    if (interactionId === undefined) throw new Error('interaction missing');
    const receipt = await value.runtime.respondToInteraction({
      commandId: value.next(),
      type: 'respond_to_interaction',
      sessionId,
      interactionId,
      response: { kind: 'question', answer: 'yes' },
    });
    await value.runtime.quiesce();

    const events = await value.runtime.readEvents(sessionId, 0 as never);
    expect(receipt.disposition).toBe('applied');
    expect(control.responses).toBe(1);
    expect(events.events.filter((event) => event.payload.type === 'interaction.settled')).toHaveLength(1);
    expect((await value.runtime.getSession(sessionId))?.interactions[0]?.settlement?.outcome).toBe('responded');
  });

  it.each(['rejected', 'malformed'] as const)(
    'maps a %s provider completion to one typed failed outcome',
    async (mode) => {
      const { provider, control } = controlledProvider();
      const value = await fixture(provider);
      const sessionId = await open(value);
      await value.runtime.submitTurn({
        commandId: value.next(),
        type: 'submit_turn',
        sessionId,
        input: { parts: [{ type: 'text', text: mode }] },
      });
      if (mode === 'rejected') control.completion.reject(new Error('native provider failure'));
      else control.completion.resolve({ outcome: 'not-terminal' } as never);
      await value.runtime.quiesce();

      const snapshot = await value.runtime.getSession(sessionId);
      const page = await value.runtime.readEvents(sessionId, 0 as never);
      const finished = page.events.filter((event) => event.payload.type === 'run.finished');
      expect(finished).toHaveLength(1);
      expect(snapshot?.runs[0]).toMatchObject({
        state: 'failed',
        termination: { outcome: 'failed', error: { code: 'provider_contract_violation' } },
      });
    },
  );

  it('maps a semantically impossible provider interruption to one contract failure', async () => {
    const { provider, control } = controlledProvider();
    const value = await fixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.next(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'unexpected interruption' }] },
    });
    control.completion.resolve({ outcome: 'interrupted', reason: 'not requested' });
    await value.runtime.quiesce();

    const snapshot = await value.runtime.getSession(sessionId);
    const page = await value.runtime.readEvents(sessionId, 0 as never);
    expect(snapshot?.runs[0]).toMatchObject({
      state: 'failed',
      termination: { outcome: 'failed', error: { code: 'provider_contract_violation' } },
    });
    expect(page.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
  });
});

describe('shutdown boundary', () => {
  it('memoizes cleanup and rejects new mutations once shutdown begins', async () => {
    const { provider, control } = controlledProvider({ holdDispose: true });
    const value = await fixture(provider);
    await open(value);

    const first = value.runtime.shutdown();
    const second = value.runtime.shutdown();
    expect(second).toBe(first);
    await Promise.resolve();
    await expect(
      value.runtime.openSession({
        commandId: value.next(),
        type: 'open_session',
        providerId: 'controlled',
        workspace: { kind: 'existing', path: value.borrowed },
      }),
    ).rejects.toMatchObject({ error: { code: 'session_closed' } });
    expect(() => value.runtime.registerProvider(controlledProvider().provider)).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'session_closed' }) }),
    );
    expect(control.created).toBe(1);

    control.dispose.resolve(undefined);
    await Promise.all([first, second]);
    await expect(
      value.runtime.submitTurn({
        commandId: value.next(),
        type: 'submit_turn',
        sessionId: SessionIdSchema.parse('ses_0000000000000001'),
        input: { parts: [{ type: 'text', text: 'after shutdown' }] },
      }),
    ).rejects.toMatchObject({ error: { code: 'session_closed' } });
    expect(control.disposed).toBe(1);
  });

  it('drains a command admitted before shutdown and then closes its session', async () => {
    const { provider, control } = controlledProvider({ holdStart: true });
    const value = await fixture(provider);
    const sessionId = await open(value);
    const submitted = value.runtime.submitTurn({
      commandId: value.next(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'queued before shutdown' }] },
    });
    for (let pass = 0; pass < 4; pass += 1) await Promise.resolve();
    const shuttingDown = value.runtime.shutdown();
    control.start.resolve(undefined);
    expect((await submitted).disposition).toBe('applied');
    await shuttingDown;
    expect((await value.runtime.getSession(sessionId))?.session.state).toBe('closed');
  });

  it('does not await a provider completion that remains pending after close fallback', async () => {
    const { provider, control } = controlledProvider({ completeOnInterrupt: false });
    const value = await fixture(provider);
    const sessionId = await open(value);
    await value.runtime.submitTurn({
      commandId: value.next(),
      type: 'submit_turn',
      sessionId,
      input: { parts: [{ type: 'text', text: 'never completes' }] },
    });

    let settled = false;
    const shuttingDown = value.runtime.shutdown().then(() => {
      settled = true;
    });
    let state = (await value.runtime.getSession(sessionId))?.session.state;
    for (let pass = 0; pass < 20 && state !== 'closed'; pass += 1) {
      await Promise.resolve();
      state = (await value.runtime.getSession(sessionId))?.session.state;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWithoutProviderCompletion = settled;

    // Always release a pre-repair implementation so a failed assertion cannot
    // strand the test hook on its intentionally unresolved provider promise.
    control.completion.resolve({ outcome: 'succeeded' });
    await shuttingDown;
    expect(state).toBe('closed');
    expect(settledWithoutProviderCompletion).toBe(true);
  });
});

describe('workspace provider boundary', () => {
  it('never releases a lease that promotes an existing workspace to managed ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relvo-workspace-boundary-test-'));
    roots.push(root);
    const borrowed = join(root, 'borrowed');
    await mkdir(borrowed);
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const { provider, control } = controlledProvider();
    let suspectReleases = 0;
    let releaseAllCalls = 0;
    const lease: WorkspaceLease = {
      leaseId: WorkspaceLeaseIdSchema.parse(idFactory.next('workspaceLease')),
      ownership: 'managed',
      root: borrowed,
      acquiredAt: clock.now(),
      describe() {
        return {
          leaseId: this.leaseId,
          ownership: this.ownership,
          root: this.root,
          acquiredAt: this.acquiredAt,
          released: false,
        };
      },
      release() {
        suspectReleases += 1;
        return Promise.reject(new Error('suspect release must not run'));
      },
    };
    const workspaces: WorkspaceProvider = {
      acquire: (() => Promise.resolve(lease)) as WorkspaceProvider['acquire'],
      releaseAll: () => {
        releaseAllCalls += 1;
        return Promise.resolve([]);
      },
    };
    const runtime = createAgentRuntime({ providers: [provider], workspaces, clock, idFactory });
    runtimes.push(runtime);

    const rejected = await runtime.openSession({
      commandId: CommandIdSchema.parse('workspace-mismatch-command'),
      type: 'open_session',
      providerId: 'controlled',
      workspace: { kind: 'existing', path: borrowed },
    });
    expect(rejected).toMatchObject({
      disposition: 'rejected',
      error: { code: 'workspace_ownership_violation' },
    });
    expect(suspectReleases).toBe(0);
    expect(control.created).toBe(0);
    await runtime.shutdown();
    expect(suspectReleases).toBe(0);
    expect(releaseAllCalls).toBe(0);
  });
});
