/**
 * Issue #43, surface 4: the public runtime routes every command, provider
 * callback, cleanup and shutdown through the ingestion driver.
 *
 * Every test drives `createAgentRuntime` (the shipped composition root) with a
 * controllable provider, workspace lease and store. Ordering is controlled with
 * deferred promises. "Promptly" means the promise settles within a bounded
 * number of microtask turns while a named provider promise is still held; no
 * timer, sleep or elapsed-time assertion is used.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  CommandIdSchema,
  ProviderEventInputSchema,
  SequenceSchema,
  SessionIdSchema,
  WorkspaceLeaseIdSchema,
  agentError,
  createCounterIdFactory,
  createFixedClock,
  type CommandId,
  type CommandReceipt,
  type EventEnvelope,
  type ExistingWorkspaceSpec,
  type InteractionId,
  type InteractionResponse,
  type ManagedWorkspaceSpec,
  type ProviderEventInput,
  type RunId,
  type SessionId,
  type SubscriptionMessage,
  type WorkspaceReleaseReport,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRejection,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderEventSink,
  type ProviderRun,
  type ProviderRunRequest,
  type ProviderRunTermination,
  type ProviderSession,
} from '@relvo-labs/agent-provider';
import type {
  BorrowedWorkspaceLease,
  ManagedWorkspaceLease,
  WorkspaceLease,
  WorkspaceProvider,
} from '@relvo-labs/agent-workspace';

import { coordinationEntryCountForTesting, createAgentRuntime, type AgentRuntime } from '../src/runtime.ts';
import { createInMemoryStore, type CommitResult, type RuntimeStore, type StoreTransaction } from '../src/store.ts';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Observed = { state(): 'pending' | 'fulfilled' | 'rejected' };

function observe(promise: Promise<unknown>): Observed {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );
  return { state: () => state };
}

/** Yield microtasks (never timers) a bounded number of times until the promise settles. */
async function settlesPromptly(promise: Promise<unknown>): Promise<'fulfilled' | 'rejected' | 'pending'> {
  const observed = observe(promise);
  for (let turn = 0; turn < 2000 && observed.state() === 'pending'; turn += 1) await Promise.resolve();
  return observed.state();
}

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentRuntimeError) return error;
    throw new Error(`expected an AgentRuntimeError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the promise to reject');
}

const UNKNOWN_OUTCOME = 'the provider outcome of this command is unknown; retry the same command to deliver it again';

const delta = (text: string): ProviderEventInput => ({ payload: { type: 'run.message_delta', text } });
const note = (message: string): ProviderEventInput => ({ payload: { type: 'diagnostic', level: 'info', message } });
const question = (providerRef: string): ProviderEventInput =>
  ProviderEventInputSchema.parse({
    payload: {
      type: 'interaction.requested',
      providerRef,
      request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
    },
  });
const yes: InteractionResponse = { kind: 'question', answer: 'yes' };

// ---------------------------------------------------------------------------
// Store: the built-in in-memory store behind a controllable wrapper
// ---------------------------------------------------------------------------

type FailMode = 'before' | 'apply-then-reject' | 'delayed-write';

/**
 * Wraps the built-in store. Its `contract` member is set only when `declaration`
 * is given, so a test chooses between an undeclared (unverified) adapter and an
 * explicit public declaration.
 */
function controlledStore(base: RuntimeStore, declaration?: { readonly value: unknown } | 'throwing-getter') {
  let failures: { mode: FailMode; remaining: number } | undefined;
  let holdingAcks = false;
  const heldAcks: (() => void)[] = [];
  const ackWaiters: (() => void)[] = [];
  const delayedWrites: (() => Promise<unknown>)[] = [];
  let readGate: { entered: Deferred<undefined>; open: Deferred<undefined> } | undefined;
  let commits = 0;

  async function gated<T>(read: () => Promise<T>): Promise<T> {
    const gate = readGate;
    if (gate !== undefined) {
      gate.entered.resolve(undefined);
      await gate.open.promise;
    }
    return read();
  }

  const store: RuntimeStore = {
    get revision() {
      return base.revision;
    },
    commit<T>(mutate: (tx: StoreTransaction) => T): Promise<{ value: T } & CommitResult> {
      commits += 1;
      const failing = failures;
      if (failing !== undefined && failing.remaining > 0) {
        failing.remaining -= 1;
        if (failing.mode === 'before') return Promise.reject(new Error('injected commit failure before applying'));
        if (failing.mode === 'apply-then-reject') {
          return base.commit(mutate).then((): never => {
            throw new Error('injected rejection after the transaction applied');
          });
        }
        delayedWrites.push(() => base.commit(mutate));
        return Promise.reject(new Error('injected adapter timeout before its delayed write'));
      }
      if (!holdingAcks) return base.commit(mutate);
      return base.commit(mutate).then(
        (result) =>
          new Promise<{ value: T } & CommitResult>((resolve) => {
            heldAcks.push(() => {
              resolve(result);
            });
            for (const waiter of ackWaiters.splice(0)) waiter();
          }),
      );
    },
    read: (sessionId) => gated(() => base.read(sessionId)),
    readEvents: (sessionId, from, limit) => gated(() => base.readEvents(sessionId, from, limit)),
    readInteraction: (sessionId, interactionId) => base.readInteraction(sessionId, interactionId),
    findReceipt: (commandId) => gated(() => base.findReceipt(commandId)),
    listSessions: () => base.listSessions(),
  };
  if (declaration === 'throwing-getter') {
    Object.defineProperty(store, 'contract', {
      enumerable: true,
      get(): never {
        throw new Error('hostile contract getter');
      },
    });
  } else if (declaration !== undefined) {
    Object.defineProperty(store, 'contract', { enumerable: true, value: declaration.value });
  }

  return {
    store,
    commits: () => commits,
    failNext(mode: FailMode, count = 1): void {
      failures = { mode, remaining: count };
    },
    stopFailing(): void {
      failures = undefined;
    },
    holdAcks(on: boolean): void {
      holdingAcks = on;
    },
    ackHeld: (): Promise<void> =>
      heldAcks.length > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            ackWaiters.push(resolve);
          }),
    releaseAcks(): void {
      for (const release of heldAcks.splice(0)) release();
    },
    gateReads(): { entered: Promise<undefined>; release(): void } {
      const gate = { entered: deferred<undefined>(), open: deferred<undefined>() };
      readGate = gate;
      return {
        entered: gate.entered.promise,
        release: () => {
          readGate = undefined;
          gate.open.resolve(undefined);
        },
      };
    },
    applyDelayedWrites: async (): Promise<void> => {
      for (const write of delayedWrites.splice(0)) await write();
    },
  };
}

const STRONG = { value: { version: 1, level: 'strong' } } as const;

// ---------------------------------------------------------------------------
// Provider and workspace
// ---------------------------------------------------------------------------

type InterruptMode = 'resolve' | 'complete' | 'hold' | 'reject-typed' | 'reject-untyped';

type RunControl = {
  readonly request: ProviderRunRequest;
  readonly completion: Deferred<ProviderRunTermination>;
  readonly interrupts: string[];
  readonly heldInterrupts: Deferred<undefined>[];
  interruptMode: InterruptMode;
  interruptFailures: number;
};

type StartCall = { readonly request: ProviderRunRequest; readonly result: Deferred<ProviderRun>; run?: RunControl };

type ResponseCall = { readonly providerRef: string; readonly result: Deferred<undefined> };

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(
  options: {
    readonly declaration?: { readonly value: unknown } | 'throwing-getter';
    readonly holdStarts?: boolean;
    readonly holdResponses?: boolean;
    readonly disposeFailures?: number;
    readonly releaseFailures?: number;
    readonly interruptMode?: InterruptMode;
    readonly interruptFailures?: number;
  } = {},
) {
  const workspacePath = await tempDirectory();
  const clock = createFixedClock();
  const idFactory = createCounterIdFactory();
  const base = createInMemoryStore({ clock, idFactory });
  const control = controlledStore(base, options.declaration);
  const log: string[] = [];
  const starts: StartCall[] = [];
  const runs: RunControl[] = [];
  const responses: ResponseCall[] = [];
  let sessionSink: ProviderEventSink | undefined;
  let holdStarts = options.holdStarts === true;
  let disposeFailures = options.disposeFailures ?? 0;
  let releaseFailures = options.releaseFailures ?? 0;
  let disposeGate: Deferred<undefined> | undefined;
  let disposes = 0;
  let releases = 0;

  function makeRun(request: ProviderRunRequest): ProviderRun & { control: RunControl } {
    const run: RunControl = {
      request,
      completion: deferred<ProviderRunTermination>(),
      interrupts: [],
      heldInterrupts: [],
      interruptMode: options.interruptMode ?? 'resolve',
      interruptFailures: options.interruptFailures ?? 0,
    };
    runs.push(run);
    return {
      control: run,
      completion: run.completion.promise,
      interrupt(reason?: string): Promise<void> {
        run.interrupts.push(reason ?? '');
        log.push(`interrupt:${reason ?? ''}`);
        if (run.interruptFailures > 0) {
          run.interruptFailures -= 1;
          return Promise.reject(new Error('run interrupt failed'));
        }
        switch (run.interruptMode) {
          case 'complete':
            run.completion.resolve({ outcome: 'interrupted', ...(reason === undefined ? {} : { reason }) });
            return Promise.resolve();
          case 'hold': {
            const held = deferred<undefined>();
            run.heldInterrupts.push(held);
            return held.promise;
          }
          case 'reject-typed':
            return Promise.reject(new ProviderRejection(agentError('provider_rejected', 'interrupt refused')));
          case 'reject-untyped':
            return Promise.reject(new Error('transport reset'));
          default:
            return Promise.resolve();
        }
      },
    };
  }

  const descriptor = defineProviderDescriptor({
    providerId: 'cutover',
    providerVersion: '0.1.0',
    displayName: 'Cutover provider',
    run: { interrupt: { mode: 'immediate' }, streaming: {} },
    interaction: { approval: {}, question: { supported: true } },
    workspace: { requires: 'directory' },
    recovery: {},
  });
  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession(init): Promise<ProviderSession> {
      sessionSink = init.sink;
      return Promise.resolve({
        startRun(request: ProviderRunRequest): Promise<ProviderRun> {
          log.push('start');
          const call: StartCall = { request, result: deferred<ProviderRun>() };
          starts.push(call);
          if (!holdStarts) {
            const run = makeRun(request);
            call.run = run.control;
            call.result.resolve(run);
          }
          return call.result.promise;
        },
        respondToInteraction(providerRef: string): Promise<void> {
          log.push(`respond:${providerRef}`);
          const call: ResponseCall = { providerRef, result: deferred<undefined>() };
          responses.push(call);
          if (options.holdResponses !== true) call.result.resolve(undefined);
          return call.result.promise;
        },
        async dispose(): Promise<void> {
          disposes += 1;
          log.push('dispose');
          if (disposeGate !== undefined) await disposeGate.promise;
          if (disposeFailures > 0) {
            disposeFailures -= 1;
            throw new Error('provider dispose failed');
          }
        },
      });
    },
  };

  let released = false;
  const lease: BorrowedWorkspaceLease = {
    leaseId: WorkspaceLeaseIdSchema.parse(idFactory.next('workspaceLease')),
    ownership: 'borrowed',
    root: workspacePath,
    acquiredAt: clock.now(),
    describe() {
      return {
        leaseId: this.leaseId,
        ownership: this.ownership,
        root: this.root,
        acquiredAt: this.acquiredAt,
        released,
      };
    },
    release(): Promise<WorkspaceReleaseReport> {
      releases += 1;
      log.push('release');
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        return Promise.reject(new Error('workspace release failed'));
      }
      const alreadyReleased = released;
      released = true;
      return Promise.resolve({
        leaseId: this.leaseId,
        ownership: this.ownership,
        alreadyReleased,
        destructiveOperations: [],
        releasedAt: clock.now(),
      });
    },
  };
  function acquire(_spec: ExistingWorkspaceSpec): Promise<BorrowedWorkspaceLease>;
  function acquire(_spec: ManagedWorkspaceSpec): Promise<ManagedWorkspaceLease>;
  function acquire(_spec: WorkspaceSpec): Promise<WorkspaceLease>;
  function acquire(): Promise<WorkspaceLease> {
    return Promise.resolve(lease);
  }
  const workspaces: WorkspaceProvider = {
    acquire,
    releaseAll: () => Promise.reject(new Error('runtime must release only its validated lease')),
  };

  const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory, store: control.store });
  runtimes.push(runtime);
  let commandCount = 0;
  const next = (label = 'cmd'): CommandId =>
    CommandIdSchema.parse(`cutover-${String(++commandCount).padStart(6, '0')}-${label}`);

  async function open(): Promise<SessionId> {
    const receipt = await runtime.openSession({
      commandId: next('open'),
      type: 'open_session',
      providerId: 'cutover',
      workspace: { kind: 'existing', path: workspacePath },
    });
    if (receipt.result?.type !== 'session_opened') throw new Error(`open failed: ${JSON.stringify(receipt)}`);
    return receipt.result.sessionId;
  }

  function submitCommand(sessionId: SessionId, text = 'go') {
    return {
      commandId: next('submit'),
      type: 'submit_turn' as const,
      sessionId,
      input: { parts: [{ type: 'text' as const, text }] },
    };
  }

  function closeCommand(sessionId: SessionId, ifRunActive: 'interrupt' | 'reject' = 'interrupt') {
    return { commandId: next('close'), type: 'close_session' as const, sessionId, ifRunActive };
  }

  /** Submit with a held provider start and wait (bounded microtasks) until `startRun` was called. */
  async function submitHeld(sessionId: SessionId) {
    const command = submitCommand(sessionId);
    const expected = starts.length + 1;
    const submitting = runtime.submitTurn(command);
    submitting.catch(() => undefined);
    await until(() => starts.length >= expected);
    return { command, submitting };
  }

  async function startRun(sessionId: SessionId, text = 'go'): Promise<{ runId: RunId; receipt: CommandReceipt }> {
    const receipt = await runtime.submitTurn(submitCommand(sessionId, text));
    if (receipt.result?.type !== 'turn_accepted') throw new Error(`submit failed: ${JSON.stringify(receipt)}`);
    return { runId: receipt.result.runId, receipt };
  }

  /** The authoritative log, read past every runtime guard. */
  async function history(sessionId: SessionId): Promise<readonly EventEnvelope[]> {
    return (await base.readEvents(sessionId, SequenceSchema.parse(0), 4096)).events;
  }

  async function types(sessionId: SessionId): Promise<string[]> {
    return (await history(sessionId)).map((event) => {
      const payload = event.payload;
      if (payload.type === 'session.state_changed') return `session:${payload.to}`;
      if (payload.type === 'run.state_changed') return `run:${payload.to}`;
      if (payload.type === 'run.finished') return `run.finished:${payload.termination.outcome}`;
      if (payload.type === 'interaction.settled') return `settled:${payload.settlement.outcome}`;
      return payload.type;
    });
  }

  return {
    runtime,
    base,
    control,
    log,
    starts,
    runs,
    responses,
    next,
    open,
    submitCommand,
    closeCommand,
    submitHeld,
    startRun,
    history,
    types,
    sessionSink: (): ProviderEventSink => {
      if (sessionSink === undefined) throw new Error('no session sink');
      return sessionSink;
    },
    holdStarts(on: boolean): void {
      holdStarts = on;
    },
    resolveStart(index = 0): RunControl {
      const call = starts[index];
      if (call === undefined) throw new Error(`no start call ${String(index)}`);
      const run = makeRun(call.request);
      call.run = run.control;
      call.result.resolve(run);
      return run.control;
    },
    holdDispose(): Deferred<undefined> {
      disposeGate = deferred<undefined>();
      return disposeGate;
    },
    counts: () => ({ starts: starts.length, disposes, releases, responses: responses.length }),
    async interactionId(sessionId: SessionId): Promise<InteractionId> {
      for (let turn = 0; turn < 200; turn += 1) {
        const found = (await base.read(sessionId))?.interactions.find((item) => item.status === 'pending');
        if (found !== undefined) return found.interactionId;
        await Promise.resolve();
      }
      throw new Error('no pending interaction was committed');
    },
  };
}

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-cutover-'));
  roots.push(root);
  return root;
}

/** Yield microtasks (never timers) a bounded number of times until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000 && !done(); turn += 1) await Promise.resolve();
  if (!done()) throw new Error('condition did not hold within the bounded microtask turns');
}

async function receiptOf(value: Harness, commandId: CommandId): Promise<CommandReceipt | undefined> {
  return (await value.base.findReceipt(commandId))?.receipt;
}

// ---------------------------------------------------------------------------
// A5: a pending start never blocks close or shutdown
// ---------------------------------------------------------------------------

describe('S4-A5 close and shutdown while a provider start is unresolved', () => {
  it('a never-settling start makes close and shutdown return retryable results promptly, with no release', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    expect(value.starts).toHaveLength(1);

    const close = value.closeCommand(sessionId);
    const first = value.runtime.closeSession(close);
    expect(await settlesPromptly(first)).toBe('rejected');
    expect((await rejection(first)).error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { sessionId, pending: 'start' },
    });
    // The exact retry stays promptly retryable, as does shutdown.
    const again = value.runtime.closeSession(close);
    expect(await settlesPromptly(again)).toBe('rejected');
    const shutdown = value.runtime.shutdown();
    expect(await settlesPromptly(shutdown)).toBe('rejected');
    expect((await rejection(shutdown)).error).toMatchObject({ retryable: true });

    expect(value.counts()).toMatchObject({ disposes: 0, releases: 0 });
    expect(value.log).toEqual(['start']);
    // Nothing was committed after `session.opened`: not the start, not `closing`, not `session.closed`.
    expect(await value.types(sessionId)).toEqual(['session.opened']);
    expect(await receiptOf(value, close.commandId)).toBeUndefined();
    expect(observe(submitting).state()).toBe('pending');
  });

  it('a late successful start commits before closing, then is interrupted, disposed and released in order', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    // Output staged while the start is pending stays behind the start.
    value.starts[0]?.request.sink.emit(delta('staged before the handle'));

    const close = value.closeCommand(sessionId);
    expect((await rejection(value.runtime.closeSession(close))).error).toMatchObject({ details: { pending: 'start' } });
    // Closing is not committed ahead of the pending start.
    expect(await value.types(sessionId)).toEqual(['session.opened']);

    value.resolveStart(0);
    expect(await submitting).toMatchObject({ disposition: 'applied', result: { type: 'turn_accepted' } });
    await value.runtime.quiesce();

    expect(value.log).toEqual(['start', 'interrupt:session closing', 'dispose', 'release']);
    expect(await value.types(sessionId)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.message_delta',
      'session:closing',
      'run:interrupting',
      'run.finished:interrupted',
      'turn.settled',
      'session.closed',
    ]);
    // The close's own receipt was committed by the continuation; its exact retry replays it.
    expect(await value.runtime.closeSession(close)).toMatchObject({
      disposition: 'duplicate',
      result: { type: 'session_closed', interruptedActiveRun: true },
    });
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
  });

  it('a late start with a permanently ambiguous store head still interrupts, disposes and releases, with no close receipt', async () => {
    // Undeclared custom store: every commit rejection is a permanent A.
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    const close = value.closeCommand(sessionId);
    await rejection(value.runtime.closeSession(close));

    value.control.failNext('before', Number.POSITIVE_INFINITY);
    const commitsBefore = value.control.commits();
    value.resolveStart(0);
    expect((await rejection(submitting)).error).toMatchObject({ code: 'store_unavailable', retryable: false });
    await until(() => value.counts().releases === 1);

    // Safe cleanup was not starved by the stuck head.
    expect(value.log).toEqual(['start', 'interrupt:session closing', 'dispose', 'release']);
    // The ambiguous head was submitted once and never resubmitted.
    expect(value.control.commits() - commitsBefore).toBe(1);
    const retried = await rejection(value.runtime.closeSession(close));
    expect(retried.error).toMatchObject({ code: 'store_unavailable', retryable: false });
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    expect(await receiptOf(value, close.commandId)).toBeUndefined();
    expect(await value.types(sessionId)).toEqual(['session.opened']);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { code: 'store_unavailable', retryable: false, details: { fault: 'ambiguous' } } },
    ]);
    await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
      error: { retryable: false },
    });
    expect(value.control.commits() - commitsBefore).toBe(1);
  });

  it('a late start rejection discards only that run staging, keeps session output, then disposes and releases', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    value.starts[0]?.request.sink.emit(delta('provisional run output'));
    value.sessionSink().emit(note('session output survives'));
    const close = value.closeCommand(sessionId);
    await rejection(value.runtime.closeSession(close));

    value.starts[0]?.result.reject(new ProviderRejection(agentError('provider_rejected', 'start refused')));
    expect(await submitting).toMatchObject({ disposition: 'rejected', error: { message: 'start refused' } });
    await value.runtime.quiesce();

    expect(value.log).toEqual(['start', 'dispose', 'release']);
    expect(await value.types(sessionId)).toEqual(['session.opened', 'diagnostic', 'session:closing', 'session.closed']);
    expect(await value.runtime.closeSession(close)).toMatchObject({
      disposition: 'duplicate',
      result: { interruptedActiveRun: false },
    });
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
  });

  it('ifRunActive reject stays truthful for a starting run and records its rejection once', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    const close = value.closeCommand(sessionId, 'reject');
    const rejected = await value.runtime.closeSession(close);
    expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
    expect(await value.runtime.closeSession(close)).toEqual(rejected);
    expect(value.counts()).toMatchObject({ disposes: 0, releases: 0 });

    value.resolveStart(0);
    expect(await submitting).toMatchObject({ disposition: 'applied' });
    expect(await value.types(sessionId)).toEqual(['session.opened', 'turn.started', 'run.started']);
  });
});

// ---------------------------------------------------------------------------
// A3/A5: unresolved responses and unknown interrupts
// ---------------------------------------------------------------------------

describe('S4 close with unresolved provider effects', () => {
  it('a response in flight makes close retryable; disposal waits for it, then cleanup continues', async () => {
    const value = await harness({ holdResponses: true });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    value.runs[0]?.request.sink.emit(question('q1'));
    const interactionId = await value.interactionId(sessionId);
    const respond = {
      commandId: value.next('respond'),
      type: 'respond_to_interaction' as const,
      sessionId,
      interactionId,
      response: yes,
    };
    const responding = value.runtime.respondToInteraction(respond);
    await until(() => value.responses.length === 1);
    expect(value.responses).toHaveLength(1);

    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    expect(await settlesPromptly(closing)).toBe('rejected');
    expect((await rejection(closing)).error).toMatchObject({ retryable: true, details: { pending: 'response' } });
    expect(value.counts()).toMatchObject({ disposes: 0, releases: 0 });

    value.responses[0]?.result.resolve(undefined);
    expect(await responding).toMatchObject({ disposition: 'applied' });
    await value.runtime.quiesce();
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    const kinds = await value.types(sessionId);
    // The delivered response settles before the close-selected terminal.
    expect(kinds.indexOf('settled:responded')).toBeLessThan(kinds.indexOf('run.finished:interrupted'));
    expect(kinds.at(-1)).toBe('session.closed');
    expect(await value.runtime.closeSession(close)).toMatchObject({ disposition: 'duplicate' });
  });

  it('an unknown interrupt does not block disposal or release; only its owner can resolve the close', async () => {
    const value = await harness({ interruptMode: 'reject-untyped' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const interrupt = {
      commandId: value.next('interrupt'),
      type: 'interrupt_run' as const,
      sessionId,
      runId,
      reason: 'stop',
    };
    expect((await rejection(value.runtime.interruptRun(interrupt))).error).toMatchObject({
      code: 'provider_unavailable',
      message: UNKNOWN_OUTCOME,
    });

    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    expect(await settlesPromptly(closing)).toBe('rejected');
    expect((await rejection(closing)).error).toMatchObject({ retryable: true, details: { pending: 'interrupt' } });
    // Cleanup was not blocked: the provider was disposed and the lease released.
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    // The close never re-issued the owner's interrupt.
    expect(value.runs[0]?.interrupts).toEqual(['stop']);

    // The owner's exact retry resolves the interrupt; the close then completes.
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    run.interruptMode = 'resolve';
    expect(await value.runtime.interruptRun(interrupt)).toMatchObject({
      disposition: 'applied',
      result: { delivered: true },
    });
    const closed = await value.runtime.closeSession(close);
    expect(closed.result).toMatchObject({ type: 'session_closed', interruptedActiveRun: true });
    expect(['applied', 'duplicate']).toContain(closed.disposition);
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    const kinds = await value.types(sessionId);
    expect(kinds.filter((kind) => kind.startsWith('run.finished'))).toEqual(['run.finished:interrupted']);
    expect(kinds.at(-1)).toBe('session.closed');
  });
});

// ---------------------------------------------------------------------------
// A4: a submitted terminal is never reordered behind closing
// ---------------------------------------------------------------------------

describe('S4-A4 close ordering against the run terminal', () => {
  it('a submitted completion terminal with a held acknowledgement stays ahead of closing', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    value.control.holdAcks(true);
    value.runs[0]?.completion.resolve({ outcome: 'succeeded' });
    await value.control.ackHeld();

    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    value.control.holdAcks(false);
    value.control.releaseAcks();
    const receipt = await closing;
    expect(receipt).toMatchObject({
      disposition: 'applied',
      result: { type: 'session_closed', interruptedActiveRun: false },
    });
    expect(value.log).toEqual(['start', 'dispose', 'release']);
    expect(await value.types(sessionId)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.finished:succeeded',
      'turn.settled',
      'session:closing',
      'session.closed',
    ]);
  });

  it('a placed but unsubmitted completion terminal carries closing first in its own bundle', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    // A delta applies but its acknowledgement is held: the head stays in flight.
    value.control.holdAcks(true);
    value.runs[0]?.request.sink.emit(delta('in flight'));
    await value.control.ackHeld();
    // The completion's terminal is placed behind it but cannot be submitted yet.
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    run.completion.resolve({ outcome: 'succeeded' });
    // The driver's completion handler was registered first, so it has run once this resumes.
    await run.completion.promise;
    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    // Close is admitted (its cleanup has started) while the delta's acknowledgement is still held.
    await until(() => value.log.includes('dispose'));
    value.control.holdAcks(false);
    value.control.releaseAcks();
    expect(await closing).toMatchObject({ disposition: 'applied', result: { interruptedActiveRun: false } });
    const events = await value.history(sessionId);
    expect(events.map((event) => event.payload.type)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.message_delta',
      'session.state_changed',
      'run.finished',
      'turn.settled',
      'session.closed',
    ]);
    // `closing` was committed in the same bundle as the terminal (one revision apart from the delta).
    const closingEvent = events[4];
    const finished = events[5];
    expect(closingEvent?.payload).toMatchObject({ type: 'session.state_changed', to: 'closing' });
    expect(finished?.payload).toMatchObject({ type: 'run.finished', termination: { outcome: 'succeeded' } });
    expect(value.log).toEqual(['start', 'dispose', 'release']);
  });

  it('a close-selected terminal follows the start and closing, exactly once', async () => {
    const value = await harness({ interruptMode: 'complete' });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    value.runs[0]?.request.sink.emit(delta('before close'));
    // The run stays active (quiesce would wait for its completion): wait for the delta instead.
    let committed = false;
    for (let turn = 0; turn < 200 && !committed; turn += 1) {
      committed = (await value.types(sessionId)).includes('run.message_delta');
    }
    expect(committed).toBe(true);
    const receipt = await value.runtime.closeSession(value.closeCommand(sessionId));
    expect(receipt).toMatchObject({ disposition: 'applied', result: { interruptedActiveRun: true } });
    expect(await value.types(sessionId)).toEqual([
      'session.opened',
      'turn.started',
      'run.started',
      'run.message_delta',
      'session:closing',
      'run:interrupting',
      'run.finished:interrupted',
      'turn.settled',
      'session.closed',
    ]);
    const finished = (await value.history(sessionId)).find((event) => event.payload.type === 'run.finished');
    expect(finished?.payload).toMatchObject({ termination: { outcome: 'interrupted', reason: 'session closing' } });
  });
});

// ---------------------------------------------------------------------------
// A8: truthful cleanup receipts, failed-phase-only retries, dispose before release
// ---------------------------------------------------------------------------

describe('S4-A8 cleanup phases and truthful receipts', () => {
  it('retries only failed phases and never releases before a confirmed disposal', async () => {
    const value = await harness({ interruptFailures: 2, disposeFailures: 1, releaseFailures: 1 });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const close = value.closeCommand(sessionId);

    // Attempt 1: interrupt fails, disposal (independent) fails, release is not attempted.
    const first = await rejection(value.runtime.closeSession(close));
    expect(first.error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { failures: [{ phase: 'run_interrupt' }, { phase: 'provider_dispose' }] },
    });
    expect(value.log).toEqual(['start', 'interrupt:session closing', 'dispose']);

    // Attempt 2: both failed phases are retried; disposal succeeds; release fails.
    const second = await rejection(value.runtime.closeSession(close));
    expect(second.error).toMatchObject({
      code: 'workspace_unavailable',
      details: { failures: [{ phase: 'workspace_release' }] },
    });
    expect(value.log).toEqual([
      'start',
      'interrupt:session closing',
      'dispose',
      'interrupt:session closing',
      'dispose',
      'release',
    ]);

    // Attempt 3: only the release is retried; nothing observed as successful repeats.
    const closed = await value.runtime.closeSession(close);
    expect(closed).toMatchObject({ disposition: 'applied', result: { interruptedActiveRun: true } });
    expect(value.log.slice(6)).toEqual(['release']);
    const kinds = await value.types(sessionId);
    expect(kinds.filter((kind) => kind === 'run.finished:interrupted')).toHaveLength(1);
    expect(kinds.at(-1)).toBe('session.closed');
  });

  it('a permanent overflow still allows a truthful successful cleanup receipt, and O outlives the close', async () => {
    const value = await harness();
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const sink = value.runs[0]?.request.sink;
    if (sink === undefined) throw new Error('no run sink');
    // 1,024 synchronous emissions cross the 1,023-operation budget before any commit.
    for (let index = 0; index < 1024; index += 1) sink.emit(delta(String(index)));
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { code: 'store_unavailable', retryable: false, details: { fault: 'overflow' } } },
    ]);
    // Retry drains the accepted prefix and still reports O.
    await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
      error: { retryable: false, details: { fault: 'overflow' } },
    });
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.message_delta')).toHaveLength(
      1023,
    );

    const close = value.closeCommand(sessionId);
    const receipt = await value.runtime.closeSession(close);
    expect(receipt).toMatchObject({ disposition: 'applied', result: { type: 'session_closed' } });
    expect((await value.base.read(sessionId))?.session.state).toBe('closed');
    // History stays uncertified after a successful close.
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([{ sessionId, error: { retryable: false } }]);
    await expect(value.runtime.readEvents(sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
    const replay = value.runtime.subscribe({ sessionId, fromSequence: 0 })[Symbol.asyncIterator]();
    await expect(replay.next()).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
    await expect(value.runtime.quiesce()).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
    await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
      error: { retryable: false, details: { fault: 'overflow' } },
    });
    // Shutdown succeeds: O alone does not block cleanup success.
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    expect(value.runtime.getProviderIngestionFaults()).toHaveLength(1);
  });

  it('a recoverable head failure blocks the close receipt until retry, without repeating any cleanup effect', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    value.control.failNext('before');
    value.runs[0]?.request.sink.emit(delta('lost once'));
    await expect(value.runtime.quiesce()).rejects.toMatchObject({ error: { retryable: true } });

    const close = value.closeCommand(sessionId);
    const first = await rejection(value.runtime.closeSession(close));
    expect(first.error).toMatchObject({ code: 'store_unavailable', retryable: true, details: { fault: 'failure' } });
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    expect(await receiptOf(value, close.commandId)).toBeUndefined();

    await value.runtime.retryProviderIngestion();
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
    expect(await value.runtime.closeSession(close)).toMatchObject({ disposition: 'duplicate' });
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    const page = await value.runtime.readEvents(sessionId, SequenceSchema.parse(0));
    expect(page.events.map((event) => event.payload.type)).toContain('run.message_delta');
    expect(page.events.at(-1)?.payload.type).toBe('session.closed');
  });
});

// ---------------------------------------------------------------------------
// A7: public fault mapping, retry, read guards and idle subscribers
// ---------------------------------------------------------------------------

describe('S4-A7 public ingestion faults and retry', () => {
  it('an idle live subscriber wakes and rejects on a fault before the held reconciliation read resolves', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const iterator = value.runtime.subscribe({ sessionId, fromSequence: 0 })[Symbol.asyncIterator]();
    for (;;) {
      const message: IteratorResult<SubscriptionMessage> = await iterator.next();
      if (message.done === true || message.value.type === 'caught_up') break;
    }
    const waiting = iterator.next();
    const reads = value.control.gateReads();
    value.control.failNext('apply-then-reject');
    value.runs[0]?.request.sink.emit(delta('applied then rejected'));
    await reads.entered;
    // A is already visible and the idle subscriber already rejected, while the read is held.
    expect(await settlesPromptly(waiting)).toBe('rejected');
    expect((await rejection(waiting)).error).toMatchObject({ code: 'store_unavailable' });
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { retryable: false, details: { fault: 'ambiguous' } } },
    ]);
    reads.release();
    await until(() => value.runtime.getProviderIngestionFaults().length === 0);
    // Read-back proved the write applied: one stored delta, A cleared, history readable.
    const page = await value.runtime.readEvents(sessionId, SequenceSchema.parse(0));
    expect(page.events.filter((event) => event.payload.type === 'run.message_delta')).toHaveLength(1);
  });

  it('maps A over O over F, never resubmits under A, and reports F then O on retry', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const sink = value.runs[0]?.request.sink;
    if (sink === undefined) throw new Error('no run sink');
    // F: a pre-apply rejection of the head, then O while that head is blocked.
    value.control.failNext('before', 2);
    sink.emit(delta('head'));
    await expect(value.runtime.quiesce()).rejects.toMatchObject({ error: { retryable: true } });
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, stage: 'event', failureCount: 1, error: { retryable: true, details: { fault: 'failure' } } },
    ]);
    for (let index = 0; index < 1023; index += 1) sink.emit(delta(String(index)));
    // F + O reports O, non-retryable.
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { retryable: false, details: { fault: 'overflow' } } },
    ]);
    // Retry reports the still-failing head (F, retryable) first ...
    expect((await rejection(value.runtime.retryProviderIngestion(sessionId))).error).toMatchObject({
      retryable: true,
      details: { fault: 'failure' },
    });
    // ... and O once the prefix drains.
    expect((await rejection(value.runtime.retryProviderIngestion(sessionId))).error).toMatchObject({
      retryable: false,
      details: { fault: 'overflow' },
    });
    const committed = (await value.history(sessionId)).filter((event) => event.payload.type === 'run.message_delta');
    // The failed head plus 1,022 accepted bodies: 1,023 operations, the 1,024th was refused.
    expect(committed).toHaveLength(1023);
  });

  it('A outranks O and F and is never resubmitted by any retry', async () => {
    const value = await harness();
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const sink = value.runs[0]?.request.sink;
    if (sink === undefined) throw new Error('no run sink');
    value.control.failNext('delayed-write');
    sink.emit(delta('ambiguous'));
    for (let index = 0; index < 1023; index += 1) sink.emit(delta(String(index)));
    await value.runtime.quiesce().catch(() => undefined);
    const commits = value.control.commits();
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { retryable: false, details: { fault: 'ambiguous', permanent: true } } },
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
        error: { retryable: false, details: { fault: 'ambiguous' } },
      });
      await expect(value.runtime.retryProviderIngestion()).rejects.toMatchObject({ error: { retryable: false } });
    }
    await value.control.applyDelayedWrites();
    expect(value.control.commits()).toBe(commits);
    const stored = (await value.history(sessionId)).filter((event) => event.payload.type === 'run.message_delta');
    expect(stored).toHaveLength(1);
  });

  it('global retry attempts every faulted session in sorted order, continues past failures, and no-ops when healthy', async () => {
    const value = await harness({ declaration: STRONG });
    const first = await value.open();
    const second = await value.open();
    await expect(value.runtime.retryProviderIngestion()).resolves.toBeUndefined();
    await expect(value.runtime.retryProviderIngestion(first)).resolves.toBeUndefined();
    await expect(
      value.runtime.retryProviderIngestion(SessionIdSchema.parse('ses_ZZZZZZZZZZZZZZZZ')),
    ).rejects.toMatchObject({ error: { code: 'unknown_session' } });

    value.control.failNext('before', 2);
    value.sessionSink().emit(note('first session event'));
    await value.runtime.quiesce().catch(() => undefined);
    // The fixture's session sink belongs to the most recently opened session.
    const faulted = value.runtime.getProviderIngestionFaults().map((fault) => fault.sessionId);
    expect(faulted).toEqual([second]);
    // The retry fails once more (F), and reports that session deterministically.
    const failed = await rejection(value.runtime.retryProviderIngestion());
    expect(failed.error).toMatchObject({
      code: 'store_unavailable',
      retryable: true,
      details: { failures: [{ sessionId: second }] },
    });
    await expect(value.runtime.retryProviderIngestion()).resolves.toBeUndefined();
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
    expect(value.counts().starts).toBe(0);
  });

  it('global retry continues past a permanently faulted session and recovers the next one', async () => {
    const value = await harness({ declaration: STRONG });
    const overflowed = await value.open();
    // The first (lower) session overflows on its session sink: permanent O.
    for (let index = 0; index < 1024; index += 1) value.sessionSink().emit(note(String(index)));
    await expect(value.runtime.retryProviderIngestion(overflowed)).rejects.toMatchObject({
      error: { retryable: false, details: { fault: 'overflow' } },
    });
    const recoverable = await value.open();
    value.control.failNext('before');
    value.sessionSink().emit(note('recoverable'));
    await value.runtime.quiesce().catch(() => undefined);
    expect(value.runtime.getProviderIngestionFaults().map((fault) => fault.sessionId)).toEqual([
      overflowed,
      recoverable,
    ]);
    const failed = await rejection(value.runtime.retryProviderIngestion());
    expect(failed.error).toMatchObject({
      code: 'store_unavailable',
      retryable: false,
      details: { failures: [{ sessionId: overflowed, error: { details: { fault: 'overflow' } } }] },
    });
    // The later session was still attempted and recovered.
    expect(value.runtime.getProviderIngestionFaults().map((fault) => fault.sessionId)).toEqual([overflowed]);
    expect((await value.history(recoverable)).filter((event) => event.payload.type === 'diagnostic')).toHaveLength(1);
  });

  it('retry never redelivers a provider or workspace effect', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    const submit = value.submitCommand(sessionId);
    value.control.failNext('before');
    expect((await rejection(value.runtime.submitTurn(submit))).error).toMatchObject({ retryable: true });
    await value.runtime.retryProviderIngestion(sessionId);
    expect(await value.runtime.submitTurn(submit)).toMatchObject({ disposition: 'duplicate' });
    expect(value.counts()).toMatchObject({ starts: 1, disposes: 0, releases: 0 });
  });
});

// ---------------------------------------------------------------------------
// A9: retirement and bounded bookkeeping
// ---------------------------------------------------------------------------

describe('S4-A9 retirement', () => {
  it('many successful turns with interactions leave constant bookkeeping', async () => {
    const value = await harness();
    const sessionId = await value.open();
    for (let turn = 0; turn < 40; turn += 1) {
      await value.startRun(sessionId, `turn ${String(turn)}`);
      value.runs[turn]?.request.sink.emit(question(`q${String(turn)}`));
      const interactionId = await value.interactionId(sessionId);
      await value.runtime.respondToInteraction({
        commandId: value.next('respond'),
        type: 'respond_to_interaction',
        sessionId,
        interactionId,
        response: yes,
      });
      value.runs[turn]?.completion.resolve({ outcome: 'succeeded' });
      await value.runtime.quiesce();
      expect(coordinationEntryCountForTesting(value.runtime)).toEqual({
        commands: 0,
        sessions: 0,
        pendingSubmits: 0,
        commandAttempts: 0,
        interactionRoutes: 0,
        withdrawals: 0,
        runs: 0,
        waiters: 0,
        invocations: 0,
        lifecycleClaims: 0,
        retiredMarkers: 0,
        liveSessions: 1,
      });
    }
    await value.runtime.closeSession(value.closeCommand(sessionId));
    expect(coordinationEntryCountForTesting(value.runtime)).toMatchObject({
      runs: 0,
      lifecycleClaims: 0,
      liveSessions: 0,
    });
  });

  it('a failed submit receipt plus close never revives the start; new close ids are refused without retention', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    const submit = value.submitCommand(sessionId);
    value.control.failNext('before');
    await rejection(value.runtime.submitTurn(submit));
    expect(value.counts().starts).toBe(1);

    const close = value.closeCommand(sessionId);
    const first = await rejection(value.runtime.closeSession(close));
    expect(first.error).toMatchObject({ retryable: true });
    // A second close id while the first is unresolved is refused, retryable, and leaves nothing behind.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const other = value.closeCommand(sessionId);
      const busy = await rejection(value.runtime.closeSession(other));
      expect(busy.error).toMatchObject({ code: 'illegal_state_transition', retryable: true });
      expect(await receiptOf(value, other.commandId)).toBeUndefined();
    }
    expect(coordinationEntryCountForTesting(value.runtime)).toMatchObject({ lifecycleClaims: 1 });

    expect(await value.runtime.closeSession(close)).toMatchObject({ disposition: 'applied' });
    expect(await value.runtime.submitTurn(submit)).toMatchObject({ disposition: 'duplicate' });
    expect(value.counts().starts).toBe(1);
    expect(value.log.filter((entry) => entry === 'start')).toHaveLength(1);
    expect(coordinationEntryCountForTesting(value.runtime)).toMatchObject({ lifecycleClaims: 0, runs: 0 });
  });
});

describe('S4-A9 stale sinks and shared drains', () => {
  it('after close every sink of the session is cut off and only a permanent overflow marker remains', async () => {
    const value = await harness();
    const healthy = await value.open();
    await value.startRun(healthy);
    const staleRunSink = value.runs[0]?.request.sink;
    const staleSessionSink = value.sessionSink();
    await value.runtime.closeSession(value.closeCommand(healthy));
    const before = (await value.history(healthy)).length;
    expect(() => staleRunSink?.emit(delta('after close'))).not.toThrow();
    expect(() => staleSessionSink.emit(note('after close'))).not.toThrow();
    // A retired session's sink keeps no route to the session: it does not even inspect its
    // input. Any capture would reflect on the value (prototype, keys, descriptors).
    let inspected = 0;
    const probe = new Proxy(
      { payload: { type: 'run.message_delta', text: 'probe' } },
      {
        getPrototypeOf(target) {
          inspected += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          inspected += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          inspected += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          inspected += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    ) as ProviderEventInput;
    staleRunSink?.emit(probe);
    staleSessionSink.emit(probe);
    expect(inspected).toBe(0);
    await value.runtime.quiesce();
    expect(await value.history(healthy)).toHaveLength(before);
    expect(coordinationEntryCountForTesting(value.runtime)).toMatchObject({
      runs: 0,
      retiredMarkers: 0,
      liveSessions: 0,
    });

    // A session whose history overflowed keeps exactly one small marker after close.
    const other = await harness();
    const overflowed = await other.open();
    await other.startRun(overflowed);
    const sink = other.runs[0]?.request.sink;
    for (let index = 0; index < 1024; index += 1) sink?.emit(delta(String(index)));
    await other.runtime.closeSession(other.closeCommand(overflowed));
    expect(coordinationEntryCountForTesting(other.runtime)).toMatchObject({
      runs: 0,
      lifecycleClaims: 0,
      retiredMarkers: 1,
    });
    expect(() => sink?.emit(delta('after close'))).not.toThrow();
    expect(other.runtime.getProviderIngestionFaults().map((fault) => fault.sessionId)).toEqual([overflowed]);
  });

  it('concurrent retries of one session share a single drain and resubmit the head once', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    value.control.failNext('before');
    value.sessionSink().emit(note('retried once'));
    await value.runtime.quiesce().catch(() => undefined);
    const commits = value.control.commits();
    await Promise.all([
      value.runtime.retryProviderIngestion(sessionId),
      value.runtime.retryProviderIngestion(sessionId),
      value.runtime.retryProviderIngestion(),
    ]);
    expect(value.control.commits() - commits).toBe(1);
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'diagnostic')).toHaveLength(1);
  });
});

describe('S4-A5 overflow ownership across a rejected late start', () => {
  it('a rejected start rolls back an overflow caused only by its own staging', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    for (let index = 0; index < 257; index += 1) value.starts[0]?.request.sink.emit(delta(String(index)));
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { details: { fault: 'overflow', permanent: false } } },
    ]);
    value.starts[0]?.result.reject(new ProviderRejection(agentError('provider_rejected', 'start refused')));
    expect(await submitting).toMatchObject({ disposition: 'rejected' });
    await value.runtime.quiesce();
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.message_delta')).toEqual([]);
  });

  it('an independent session-sink overflow survives the rejection of a pending start', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    for (let index = 0; index < 256; index += 1) value.starts[0]?.request.sink.emit(delta(String(index)));
    // The session sink is not owned by the pending run: crossing the budget there is real loss.
    for (let index = 0; index < 800; index += 1) value.sessionSink().emit(note(String(index)));
    value.starts[0]?.result.reject(new ProviderRejection(agentError('provider_rejected', 'start refused')));
    expect(await submitting).toMatchObject({ disposition: 'rejected' });
    await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
      error: { retryable: false, details: { fault: 'overflow', permanent: true } },
    });
    expect((await value.history(sessionId)).filter((event) => event.payload.type === 'run.message_delta')).toEqual([]);
  });
});

describe('S4-A5 shutdown fences every session at once', () => {
  it('closes healthy sessions while reporting only the session whose start is unresolved', async () => {
    const value = await harness({ holdStarts: true });
    const healthy = await value.open();
    const blocked = await value.open();
    const { submitting } = await value.submitHeld(blocked);
    const shutdown = value.runtime.shutdown();
    // Both sessions are fenced synchronously: a new command is refused at once.
    await expect(value.runtime.submitTurn(value.submitCommand(healthy))).rejects.toMatchObject({
      error: { code: 'session_closed' },
    });
    expect(await settlesPromptly(shutdown)).toBe('rejected');
    const failure = await rejection(shutdown);
    expect(failure.error).toMatchObject({
      retryable: true,
      details: { failures: [{ sessionId: blocked, error: { details: { pending: 'start' } } }] },
    });
    expect((await value.base.read(healthy))?.session.state).toBe('closed');
    expect((await value.base.read(blocked))?.session.state).toBe('ready');

    value.resolveStart(0);
    expect(await submitting).toMatchObject({ disposition: 'applied' });
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    expect((await value.base.read(blocked))?.session.state).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Store contract declaration (public, additive)
// ---------------------------------------------------------------------------

describe('S4 store contract declaration', () => {
  it.each([
    ['undeclared', undefined],
    ['baseline', { value: { version: 1, level: 'baseline' } }],
    ['an unknown version', { value: { version: 2, level: 'strong' } }],
    ['a malformed value', { value: 'strong' }],
    ['a throwing getter', 'throwing-getter'],
  ] as const)(
    'a custom store with %s declaration is unverified: a pre-apply rejection is permanent A',
    async (_name, declaration) => {
      const value = await harness(declaration === undefined ? {} : { declaration });
      const sessionId = await value.open();
      value.control.failNext('before');
      value.sessionSink().emit(note('rejected once'));
      await value.runtime.quiesce().catch(() => undefined);
      expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
        { sessionId, error: { retryable: false, details: { fault: 'ambiguous', permanent: true } } },
      ]);
      const commits = value.control.commits();
      await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
        error: { retryable: false },
      });
      expect(value.control.commits()).toBe(commits);
    },
  );

  it('a custom store declaring the strong contract is reconciled: a pre-apply rejection is retryable F', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    value.control.failNext('before');
    value.sessionSink().emit(note('rejected once'));
    await value.runtime.quiesce().catch(() => undefined);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { retryable: true, details: { fault: 'failure' } } },
    ]);
    await value.runtime.retryProviderIngestion(sessionId);
    const notes = (await value.history(sessionId)).filter((event) => event.payload.type === 'diagnostic');
    expect(notes).toHaveLength(1);
  });

  it('a modified built-in store is unverified unless the host explicitly declares the contract', async () => {
    for (const declared of [false, true]) {
      const clock = createFixedClock();
      const idFactory = createCounterIdFactory();
      const store = createInMemoryStore({ clock, idFactory });
      const original = store.commit.bind(store);
      let failNext = false;
      Object.defineProperty(store, 'commit', {
        value: <T>(mutate: (tx: StoreTransaction) => T) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('host wrapper failed before applying'));
          }
          return original(mutate);
        },
        writable: true,
        configurable: true,
      });
      if (declared) Object.defineProperty(store, 'contract', { value: { version: 1, level: 'strong' } });
      let sink: ProviderEventSink | undefined;
      const provider: AgentProvider = {
        describe: () =>
          defineProviderDescriptor({
            providerId: 'modified-store',
            providerVersion: '0.1.0',
            displayName: 'Modified store provider',
            run: { interrupt: { mode: 'immediate' }, streaming: {} },
            interaction: { approval: {}, question: {} },
            workspace: { requires: 'directory' },
            recovery: {},
          }),
        createSession(init) {
          sink = init.sink;
          return Promise.resolve({
            startRun: () => Promise.reject(new Error('unused')),
            respondToInteraction: () => Promise.resolve(),
            dispose: () => Promise.resolve(),
          });
        },
      };
      const path = await tempDirectory();
      const leaseId = WorkspaceLeaseIdSchema.parse(idFactory.next('workspaceLease'));
      const acquiredAt = clock.now();
      const lease: BorrowedWorkspaceLease = {
        leaseId,
        ownership: 'borrowed',
        root: path,
        acquiredAt,
        describe: () => ({ leaseId, ownership: 'borrowed', root: path, acquiredAt, released: false }),
        release: () =>
          Promise.resolve({
            leaseId,
            ownership: 'borrowed',
            alreadyReleased: false,
            destructiveOperations: [],
            releasedAt: clock.now(),
          }),
      };
      function acquireLease(_spec: ExistingWorkspaceSpec): Promise<BorrowedWorkspaceLease>;
      function acquireLease(_spec: ManagedWorkspaceSpec): Promise<ManagedWorkspaceLease>;
      function acquireLease(_spec: WorkspaceSpec): Promise<WorkspaceLease>;
      function acquireLease(): Promise<WorkspaceLease> {
        return Promise.resolve(lease);
      }
      const runtime: AgentRuntime = createAgentRuntime({
        workspaces: { acquire: acquireLease, releaseAll: () => Promise.resolve([]) },
        providers: [provider],
        clock,
        idFactory,
        store,
      });
      runtimes.push(runtime);
      const opened = await runtime.openSession({
        commandId: CommandIdSchema.parse(`modified-store-open-${String(declared)}`),
        type: 'open_session',
        providerId: 'modified-store',
        workspace: { kind: 'existing', path },
      });
      if (opened.result?.type !== 'session_opened') throw new Error('open failed');
      failNext = true;
      sink?.emit(note('wrapped commit'));
      await runtime.quiesce().catch(() => undefined);
      expect(runtime.getProviderIngestionFaults()).toMatchObject([
        { error: { retryable: declared, details: { fault: declared ? 'failure' : 'ambiguous' } } },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Activation overflow replaces the old warning tail
// ---------------------------------------------------------------------------

describe('S4 activation overflow through the public runtime', () => {
  it('257 pre-activation run events commit 256, mark history permanently incomplete and add no warning tail', async () => {
    const value = await harness({ holdStarts: true });
    const sessionId = await value.open();
    const { submitting } = await value.submitHeld(sessionId);
    for (let index = 0; index < 257; index += 1) value.starts[0]?.request.sink.emit(delta(String(index)));
    value.resolveStart(0);
    expect(await submitting).toMatchObject({ disposition: 'applied' });
    // Retry drains the accepted prefix, then still reports the permanent overflow.
    await expect(value.runtime.retryProviderIngestion(sessionId)).rejects.toMatchObject({
      error: { retryable: false, details: { fault: 'overflow' } },
    });
    const events = await value.history(sessionId);
    expect(events.filter((event) => event.payload.type === 'run.message_delta')).toHaveLength(256);
    expect(events.filter((event) => event.payload.type === 'diagnostic')).toEqual([]);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId, error: { retryable: false, details: { fault: 'overflow', permanent: true } } },
    ]);
    // The deferred overflow interrupt reached the provider once its handle existed.
    expect(value.runs[0]?.interrupts).toEqual(['provider event history overflowed']);
    await expect(value.runtime.readEvents(sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
  });
});

// ---------------------------------------------------------------------------
// S4 review repair (F1–F4): owner recovery during shutdown, interrupt outcome
// sharing at invocation time, close under commit uncertainty, retired run sinks
// ---------------------------------------------------------------------------

/** A value whose every reflection throws and is counted: any capture would touch it. */
function reflectionTrap(): { readonly value: ProviderEventInput; inspections(): number } {
  let inspections = 0;
  const touched = (): never => {
    inspections += 1;
    throw new Error('a retired sink inspected its input');
  };
  const value = new Proxy(
    {},
    { getPrototypeOf: touched, ownKeys: touched, getOwnPropertyDescriptor: touched, get: touched, has: touched },
  ) as ProviderEventInput;
  return { value, inspections: () => inspections };
}

async function microtasks(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

describe('S4 review F1: shutdown fences new work but admits exact owner recovery', () => {
  it('an unknown interrupt fails shutdown retryably; the owner exact retry resolves it and shutdown then succeeds', async () => {
    const value = await harness({ interruptMode: 'reject-untyped' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const interrupt = { commandId: value.next('interrupt'), type: 'interrupt_run' as const, sessionId, runId };
    expect((await rejection(value.runtime.interruptRun(interrupt))).error).toMatchObject({
      code: 'provider_unavailable',
      message: UNKNOWN_OUTCOME,
    });

    expect((await rejection(value.runtime.shutdown())).error).toMatchObject({ retryable: true });
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });

    // New work stays fenced: a new interrupt id, a fresh submit and a fresh open.
    expect(
      (await rejection(value.runtime.interruptRun({ ...interrupt, commandId: value.next('interrupt') }))).error,
    ).toMatchObject({ code: 'session_closed' });
    expect((await rejection(value.runtime.submitTurn(value.submitCommand(sessionId)))).error).toMatchObject({
      code: 'session_closed',
    });
    // A changed payload under the unresolved id is a conflict, never a delivery.
    expect(await value.runtime.interruptRun({ ...interrupt, reason: 'changed' })).toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    expect(value.runs[0]?.interrupts).toHaveLength(1);

    // The owner's exact retry is admitted and delivers the same interrupt once more.
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    run.interruptMode = 'resolve';
    expect(await value.runtime.interruptRun(interrupt)).toMatchObject({
      disposition: 'applied',
      result: { delivered: true },
    });
    expect(run.interrupts).toHaveLength(2);

    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    // Cleanup was never repeated, and the run ended exactly once before the session closed.
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    const kinds = await value.types(sessionId);
    expect(kinds.filter((kind) => kind.startsWith('run.finished'))).toEqual(['run.finished:interrupted']);
    expect(kinds.at(-1)).toBe('session.closed');
    // Once nothing is unresolved, the same id is fenced like any other.
    expect((await rejection(value.runtime.interruptRun(interrupt))).error).toMatchObject({ code: 'session_closed' });
  });
});

describe('S4 review F2: interrupt outcome sharing is decided at invocation, before any queue', () => {
  it('a new-ID interrupt invoked during an in-flight interrupt mirrors its definite rejection; a later one calls again', async () => {
    const value = await harness({ interruptMode: 'hold' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    const owner = { commandId: value.next('interrupt'), type: 'interrupt_run' as const, sessionId, runId };
    const first = value.runtime.interruptRun(owner);
    await until(() => run.heldInterrupts.length === 1);
    const follower = { ...owner, commandId: value.next('interrupt') };
    const following = value.runtime.interruptRun(follower);
    await microtasks(100);
    run.interruptMode = 'resolve';
    run.heldInterrupts[0]?.reject(new ProviderRejection(agentError('provider_rejected', 'definite rejection')));

    const refused = { disposition: 'rejected', error: { code: 'provider_rejected', message: 'definite rejection' } };
    expect(await first).toMatchObject(refused);
    expect(await following).toMatchObject(refused);
    expect(run.interrupts).toHaveLength(1);
    expect(await receiptOf(value, follower.commandId)).toMatchObject(refused);
    expect(await value.runtime.interruptRun(follower)).toMatchObject(refused);
    expect(run.interrupts).toHaveLength(1);

    // Decision A is unchanged: an interrupt invoked after the rejection calls the provider again.
    expect(await value.runtime.interruptRun({ ...owner, commandId: value.next('interrupt') })).toMatchObject({
      disposition: 'applied',
      result: { delivered: true },
    });
    expect(run.interrupts).toHaveLength(2);
  });

  it('a concurrent exact retry shares an unknown interrupt outcome; only a later exact retry delivers again', async () => {
    const value = await harness({ interruptMode: 'hold' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    const owner = { commandId: value.next('interrupt'), type: 'interrupt_run' as const, sessionId, runId };
    const first = value.runtime.interruptRun(owner);
    first.catch(() => undefined);
    await until(() => run.heldInterrupts.length === 1);
    const concurrent = value.runtime.interruptRun(owner);
    concurrent.catch(() => undefined);
    await microtasks(100);
    run.interruptMode = 'resolve';
    run.heldInterrupts[0]?.reject(new Error('transport'));

    for (const attempt of [first, concurrent]) {
      expect((await rejection(attempt)).error).toMatchObject({
        code: 'provider_unavailable',
        message: UNKNOWN_OUTCOME,
      });
    }
    expect(run.interrupts).toHaveLength(1);

    // An exact retry invoked after the unknown outcome is the owner's recovery: it delivers again.
    expect(await value.runtime.interruptRun(owner)).toMatchObject({
      disposition: 'applied',
      result: { delivered: true },
    });
    expect(run.interrupts).toHaveLength(2);
  });

  it('a new-ID interrupt invoked during an in-flight interrupt mirrors its unknown outcome without calling the provider', async () => {
    const value = await harness({ interruptMode: 'hold' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    const owner = { commandId: value.next('interrupt'), type: 'interrupt_run' as const, sessionId, runId };
    const first = value.runtime.interruptRun(owner);
    first.catch(() => undefined);
    await until(() => run.heldInterrupts.length === 1);
    const follower = { ...owner, commandId: value.next('interrupt') };
    const following = value.runtime.interruptRun(follower);
    following.catch(() => undefined);
    await microtasks(100);
    run.interruptMode = 'resolve';
    run.heldInterrupts[0]?.reject(new Error('transport'));

    for (const attempt of [first, following]) {
      expect((await rejection(attempt)).error).toMatchObject({
        code: 'provider_unavailable',
        message: UNKNOWN_OUTCOME,
      });
    }
    expect(run.interrupts).toHaveLength(1);

    // Only the owner resolves it; the follower then mirrors the observed success without a call.
    expect(await value.runtime.interruptRun(owner)).toMatchObject({
      disposition: 'applied',
      result: { delivered: true },
    });
    expect(await value.runtime.interruptRun(follower)).toMatchObject({ result: { delivered: true } });
    expect(run.interrupts).toHaveLength(2);
  });

  it('a changed payload under an in-flight interrupt id conflicts and never reaches the provider', async () => {
    const value = await harness({ interruptMode: 'hold' });
    const sessionId = await value.open();
    const { runId } = await value.startRun(sessionId);
    const run = value.runs[0];
    if (run === undefined) throw new Error('no run');
    const owner = { commandId: value.next('interrupt'), type: 'interrupt_run' as const, sessionId, runId };
    const first = value.runtime.interruptRun(owner);
    await until(() => run.heldInterrupts.length === 1);
    const changed = value.runtime.interruptRun({ ...owner, reason: 'changed' });
    await microtasks(100);
    run.heldInterrupts[0]?.resolve(undefined);
    expect(await first).toMatchObject({ disposition: 'applied', result: { delivered: true } });
    expect(await changed).toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    expect(run.interrupts).toHaveLength(1);
  });

  it('a concurrent exact response retry shares an unknown delivery outcome without redelivery', async () => {
    const value = await harness({ holdResponses: true });
    const sessionId = await value.open();
    await value.startRun(sessionId);
    value.runs[0]?.request.sink.emit(question('q-1'));
    const interactionId = await value.interactionId(sessionId);
    const respond = {
      commandId: value.next('respond'),
      type: 'respond_to_interaction' as const,
      sessionId,
      interactionId,
      response: yes,
    };
    const first = value.runtime.respondToInteraction(respond);
    first.catch(() => undefined);
    await until(() => value.responses.length === 1);
    const concurrent = value.runtime.respondToInteraction(respond);
    concurrent.catch(() => undefined);
    await microtasks(100);
    value.responses[0]?.result.reject(new Error('transport'));
    expect((await rejection(first)).error).toMatchObject({ code: 'provider_unavailable', message: UNKNOWN_OUTCOME });
    await microtasks(100);
    // The concurrent retry shared the first delivery; it did not deliver again.
    expect(value.responses).toHaveLength(1);
    expect((await rejection(concurrent)).error).toMatchObject({
      code: 'provider_unavailable',
      message: UNKNOWN_OUTCOME,
    });
    expect(value.responses).toHaveLength(1);

    const again = value.runtime.respondToInteraction(respond);
    await until(() => value.responses.length === 2);
    value.responses[1]?.result.resolve(undefined);
    expect(await again).toMatchObject({ disposition: 'applied' });
    expect(value.responses).toHaveLength(2);
  });
});

describe('S4 review F3: close resolves retained ownership before receipt shortcuts', () => {
  it('an undeclared applied-then-rejected close stays fail-closed for its exact retry and for any other close id', async () => {
    const value = await harness();
    const sessionId = await value.open();
    const gate = value.holdDispose();
    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    closing.catch(() => undefined);
    await until(() => value.counts().disposes === 1);
    await microtasks(100);
    expect((await value.base.read(sessionId))?.session.state).toBe('closing');
    value.control.failNext('apply-then-reject');
    gate.resolve(undefined);

    const permanent = { code: 'store_unavailable', retryable: false, details: { fault: 'ambiguous' } };
    expect((await rejection(closing)).error).toMatchObject(permanent);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([{ sessionId, error: permanent }]);
    // The unverified store did apply the bundle, receipt included; the runtime does not trust it.
    expect((await value.base.read(sessionId))?.session.state).toBe('closed');
    expect(await receiptOf(value, close.commandId)).toMatchObject({ disposition: 'applied' });

    expect((await rejection(value.runtime.closeSession(close))).error).toMatchObject(permanent);
    const other = value.closeCommand(sessionId);
    expect((await rejection(value.runtime.closeSession(other))).error).toMatchObject(permanent);
    expect(await receiptOf(value, other.commandId)).toBeUndefined();
    // A changed payload under the retained id is still a conflict.
    expect(await value.runtime.closeSession({ ...close, ifRunActive: 'reject' })).toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    // No cleanup effect was repeated, and the bundle was never resubmitted.
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    expect((await value.types(sessionId)).filter((kind) => kind === 'session.closed')).toHaveLength(1);
    expect((await rejection(value.runtime.shutdown())).error).toMatchObject({ retryable: false });
  });

  it('a declared strong closed bundle reconciles once, then answers its exact retry without repeating cleanup', async () => {
    const value = await harness({ declaration: STRONG });
    const sessionId = await value.open();
    const gate = value.holdDispose();
    const close = value.closeCommand(sessionId);
    const closing = value.runtime.closeSession(close);
    closing.catch(() => undefined);
    await until(() => value.counts().disposes === 1);
    await microtasks(100);
    value.control.failNext('apply-then-reject');
    gate.resolve(undefined);
    await closing.catch(() => undefined);
    await until(() => value.runtime.getProviderIngestionFaults().length === 0);
    expect(await value.runtime.closeSession(close)).toMatchObject({
      disposition: 'duplicate',
      result: { type: 'session_closed' },
    });
    expect(value.counts()).toMatchObject({ disposes: 1, releases: 1 });
    expect((await value.types(sessionId)).filter((kind) => kind === 'session.closed')).toHaveLength(1);
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe('S4 review F4: a retired run sink inspects nothing while its session stays open', () => {
  it('discards hostile input before capture, and a later run still captures its own output', async () => {
    const value = await harness();
    const sessionId = await value.open();
    await value.startRun(sessionId);
    const finished = value.runs[0];
    if (finished === undefined) throw new Error('no run');
    finished.completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();
    const before = (await value.history(sessionId)).length;

    const trap = reflectionTrap();
    expect(() => {
      finished.request.sink.emit(trap.value);
    }).not.toThrow();
    expect(trap.inspections()).toBe(0);
    await value.runtime.quiesce();
    expect(await value.history(sessionId)).toHaveLength(before);
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);

    // A newer run of the same session: the old sink stays inert, the new one is live.
    await value.startRun(sessionId);
    const current = value.runs[1];
    if (current === undefined) throw new Error('no second run');
    finished.request.sink.emit(trap.value);
    expect(trap.inspections()).toBe(0);
    current.request.sink.emit(delta('second run output'));
    current.completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();
    const texts = (await value.history(sessionId)).flatMap((event) =>
      event.payload.type === 'run.message_delta' ? [event.payload.text] : [],
    );
    expect(texts).toEqual(['second run output']);

    // Session retirement keeps the zero-inspection guarantee for both sink kinds.
    const sessionSink = value.sessionSink();
    await value.runtime.closeSession(value.closeCommand(sessionId));
    current.request.sink.emit(trap.value);
    sessionSink.emit(trap.value);
    expect(trap.inspections()).toBe(0);
  });
});
