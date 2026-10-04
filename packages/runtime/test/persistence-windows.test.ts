import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  CommandIdSchema,
  SequenceSchema,
  agentError,
  createCounterIdFactory,
  createFixedClock,
  type CommandId,
  type InteractionId,
  type InteractionRequest,
  type RunId,
  RunIdSchema,
  type SessionId,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRejection,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderEventSink,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';
import { createLocalWorkspaceProvider, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

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

/**
 * A command whose slot commit was rejected before applying returns the session's retryable
 * F fault (issue #43): the store's own error text is never surfaced, and the exact command
 * retry resubmits the unchanged head.
 */
const RETRYABLE_HEAD_FAILURE = { error: { code: 'store_unavailable', retryable: true, details: { fault: 'failure' } } };
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    holdReadInteraction?: boolean;
    holdInterrupt?: boolean;
    holdDispose?: boolean;
    rejectStart?: boolean;
    rejectResponse?: boolean;
    rejectInterrupt?: boolean;
    holdReadEvents?: boolean;
    holdReadAfterEvents?: boolean;
    holdStart?: boolean;
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
  let rejection: Error = new Error('injected transient commit failure');
  let skipCommits = 0;
  const interactionRead = deferred<undefined>();
  const interactionReadGate = deferred<undefined>();
  const eventReadEntered = deferred<undefined>();
  const eventReadGate = deferred<undefined>();
  const finalReadEntered = deferred<undefined>();
  const finalReadGate = deferred<undefined>();
  const commitFailed = deferred<undefined>();
  const textCommitted = deferred<undefined>();
  const terminalCommitted = deferred<undefined>();
  const secondTerminalCommitted = deferred<undefined>();
  let terminalCommits = 0;
  let successfulCommits = 0;
  const commitWaiters: { after: number; resolve(): void }[] = [];
  let heldEventRead = false;
  let holdNextRead = false;
  let eventPageReads = 0;
  let onEventPage: ((sessionId: SessionId) => Promise<void>) | undefined;
  // This wrapper never applies a commit whose promise it rejects ('before' rejects without
  // calling the store; 'after' throws inside the transaction, which discards it) and reads
  // through to the built-in store, so it explicitly declares the strong contract (issue #43).
  const store: RuntimeStore = {
    contract: { version: 1, level: 'strong' },
    get revision() {
      return base.revision;
    },
    commit: (mutate) => {
      if (rejectNext && skipCommits-- <= 0) {
        const phase = rejectNext;
        rejectNext = false;
        const failing =
          phase === 'after'
            ? base.commit((tx) => {
                mutate(tx);
                throw rejection;
              })
            : Promise.reject(rejection);
        return failing.finally(() => commitFailed.resolve(undefined));
      }
      return base.commit(mutate).then((result) => {
        successfulCommits += 1;
        for (const waiter of [...commitWaiters]) {
          if (successfulCommits <= waiter.after) continue;
          commitWaiters.splice(commitWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        if (result.events.some((event) => event.payload.type === 'run.message_delta')) {
          textCommitted.resolve(undefined);
        }
        if (result.events.some((event) => event.payload.type === 'run.finished')) {
          terminalCommits += 1;
          if (terminalCommits === 1) terminalCommitted.resolve(undefined);
          if (terminalCommits === 2) secondTerminalCommitted.resolve(undefined);
        }
        return result;
      });
    },
    read: async (sessionId) => {
      if (holdNextRead) {
        holdNextRead = false;
        finalReadEntered.resolve(undefined);
        await finalReadGate.promise;
      }
      return base.read(sessionId);
    },
    readEvents: async (sessionId, from, limit) => {
      const page = await base.readEvents(sessionId, from, limit);
      eventPageReads += 1;
      if (options.holdReadAfterEvents) holdNextRead = true;
      await onEventPage?.(sessionId);
      if (options.holdReadEvents && !heldEventRead) {
        heldEventRead = true;
        eventReadEntered.resolve(undefined);
        await eventReadGate.promise;
      }
      return page;
    },
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
  const startEntered = deferred<undefined>();
  const startGate = deferred<undefined>();
  const interruptGate = deferred<undefined>();
  const interruptEntered = deferred<undefined>();
  const disposeEntered = deferred<undefined>();
  const disposeGate = deferred<undefined>();
  let sink: ProviderEventSink | undefined;
  const runSinks: ProviderEventSink[] = [];
  let sessionSink: ProviderEventSink | undefined;
  let starts = 0;
  let responses = 0;
  let interrupts = 0;
  let disposes = 0;
  let releases = 0;
  const localWorkspaces = createLocalWorkspaceProvider({ baseDirectory: join(root, 'managed'), clock, idFactory });
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
        startRun: async (request) => {
          starts += 1;
          sink = request.sink;
          runSinks.push(request.sink);
          startEntered.resolve(undefined);
          if (options.holdStart) await startGate.promise;
          if (options.rejectStart) {
            return Promise.reject(new ProviderRejection(agentError('provider_rejected', 'provider rejected start')));
          }
          const runCompletion = starts === 1 ? completion : deferred<ProviderRunTermination>();
          return {
            completion: runCompletion.promise,
            interrupt: async () => {
              interrupts += 1;
              interruptEntered.resolve(undefined);
              if (options.rejectInterrupt) {
                throw new ProviderRejection(agentError('provider_rejected', 'provider rejected interrupt'));
              }
              if (options.holdInterrupt) await interruptGate.promise;
            },
          };
        },
        respondToInteraction: () => {
          responses += 1;
          if (options.rejectResponse) {
            return Promise.reject(new ProviderRejection(agentError('provider_rejected', 'provider rejected response')));
          }
          return Promise.resolve();
        },
        dispose: async () => {
          disposes += 1;
          disposeEntered.resolve(undefined);
          if (options.holdDispose) await disposeGate.promise;
        },
      });
    },
  };
  const runtime = createAgentRuntime({
    workspaces: {
      acquire: (async (spec) => {
        const lease = await localWorkspaces.acquire(spec);
        return {
          leaseId: lease.leaseId,
          ownership: lease.ownership,
          root: lease.root,
          acquiredAt: lease.acquiredAt,
          describe: () => lease.describe(),
          release: async () => {
            releases += 1;
            return lease.release();
          },
        };
      }) as WorkspaceProvider['acquire'],
      releaseAll: () => localWorkspaces.releaseAll(),
    },
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
  const sessionId = opened.result.sessionId;
  return {
    runtime,
    sessionId,
    nextCommit: () =>
      new Promise<void>((resolve) => {
        commitWaiters.push({ after: successfulCommits, resolve });
      }),
    borrowed,
    next,
    now: () => clock.now(),
    failNextCommit: (phase: 'before' | 'after' = 'before', skip = 0, cause?: Error) => {
      rejectNext = phase;
      skipCommits = skip;
      rejection = cause ?? new Error('injected transient commit failure');
    },
    counts: () => ({ starts, responses, interrupts, disposes, releases, eventPageReads, terminalCommits }),
    committedEvents: () => base.readEvents(sessionId, SequenceSchema.parse(0), 2048),
    onEventPage: (callback: (sessionId: SessionId) => Promise<void>) => {
      onEventPage = callback;
    },
    commitDiagnostic: (sessionId: SessionId) =>
      base.commit((tx) => {
        tx.emit({ sessionId, payload: { type: 'diagnostic', level: 'info', message: 'concurrent commit' } });
      }),
    completion,
    interactionRead,
    interactionReadGate,
    eventReadEntered,
    eventReadGate,
    finalReadEntered,
    finalReadGate,
    commitFailed,
    textCommitted,
    terminalCommitted,
    secondTerminalCommitted,
    startEntered,
    startGate,
    interruptGate,
    interruptEntered,
    disposeEntered,
    disposeGate,
    emitInteraction: (request: InteractionRequest = { kind: 'question', prompt: 'Continue?', multiSelect: false }) =>
      sink?.emit({
        payload: {
          type: 'interaction.requested',
          providerRef: 'question',
          request,
        },
      }),
    emitText: (text: string) => sink?.emit({ payload: { type: 'run.message_delta', text } }),
    emitDiagnosticForRun: (index: number, message: string) =>
      runSinks[index]?.emit({ payload: { type: 'diagnostic', level: 'info', message } }),
    emitSessionDiagnostic: (message: string) =>
      sessionSink?.emit({ payload: { type: 'diagnostic', level: 'info', message } }),
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
  const ingested = value.nextCommit();
  value.emitInteraction();
  await ingested;
  const id = (await value.runtime.getSession(value.sessionId))?.interactions[0]?.interactionId;
  if (!id) throw new Error('interaction missing');
  return id;
}

describe('provider ingestion visibility and history races', () => {
  it('reads an unchanged session once while unrelated sessions keep committing', async () => {
    const value = await fixture();
    const other = await value.runtime.openSession({
      commandId: value.next(),
      type: 'open_session',
      providerId: 'fault-provider',
      workspace: { kind: 'existing', path: value.borrowed },
    });
    if (other.result?.type !== 'session_opened') throw new Error('other session missing');
    const otherSessionId = other.result.sessionId;
    let commits = 0;
    value.onEventPage(async () => {
      if (commits++ < 8) await value.commitDiagnostic(otherSessionId);
    });
    const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0));
    expect(page.events).toHaveLength(1);
    expect(value.counts().eventPageReads).toBe(1);
  });

  it('rejects retryably after a bounded number of changing-session history reads', async () => {
    const value = await fixture();
    let commits = 0;
    value.onEventPage(async (sessionId) => {
      if (commits++ < 8) await value.commitDiagnostic(sessionId);
    });
    await expect(value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable', retryable: true },
    });
    expect(value.counts().eventPageReads).toBeLessThanOrEqual(3);
  });

  it('refuses a history page if provider ingestion fails while its store read is held', async () => {
    const value = await fixture({ holdReadEvents: true });
    await start(value);
    const reading = value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0));
    await value.eventReadEntered.promise;
    value.failNextCommit();
    value.emitText('must not be omitted');
    await value.commitFailed.promise;
    await expect(value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
    value.eventReadGate.resolve(undefined);
    await expect(reading).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
  });

  it('refuses a history page if ingestion fails during the final session read', async () => {
    const value = await fixture({ holdReadAfterEvents: true });
    await start(value);
    const reading = value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0));
    await value.finalReadEntered.promise;
    value.failNextCommit();
    value.emitText('lost during final read');
    await value.commitFailed.promise;
    value.finalReadGate.resolve(undefined);
    await expect(reading).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
  });

  it('rereads a held history page when a provider event commits during the read', async () => {
    const value = await fixture({ holdReadEvents: true });
    await start(value);
    const reading = value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0));
    await value.eventReadEntered.promise;
    value.emitText('committed during read');
    await value.textCommitted.promise;
    value.eventReadGate.resolve(undefined);
    const page = await reading;
    expect(page.hasMore).toBe(false);
    expect(page.events.some((event) => event.payload.type === 'run.message_delta')).toBe(true);
  });

  it('rejects unknown and cross-session runs but accepts a known terminal run as a no-op', async () => {
    const value = await fixture();
    const runId = await start(value);
    const second = await value.runtime.openSession({
      commandId: value.next(),
      type: 'open_session',
      providerId: 'fault-provider',
      workspace: { kind: 'existing', path: value.borrowed },
    });
    if (second.result?.type !== 'session_opened') throw new Error('second open failed');
    for (const [sessionId, targetRunId] of [
      [value.sessionId, RunIdSchema.parse('run_AAAAAAAAAAAAAAAA')],
      [second.result.sessionId, runId],
    ] as const) {
      await expect(
        value.runtime.interruptRun({
          commandId: value.next(),
          type: 'interrupt_run',
          sessionId,
          runId: targetRunId,
        }),
      ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'unknown_run' } });
    }
    value.completion.resolve({ outcome: 'succeeded' });
    await value.runtime.quiesce();
    await expect(
      value.runtime.interruptRun({
        commandId: value.next(),
        type: 'interrupt_run',
        sessionId: value.sessionId,
        runId,
      }),
    ).resolves.toMatchObject({ disposition: 'applied', result: { delivered: false } });
    expect(value.counts().interrupts).toBe(0);
  });

  it('records a bounded visible fault after a provider event commit fails, then recovers it on retry', async () => {
    const value = await fixture();
    await start(value);
    value.failNextCommit();
    value.emitText('lost event');
    await value.commitFailed.promise;
    expect(typeof value.runtime.getProviderIngestionFaults).toBe('function');
    value.emitText('another event');
    await expect(value.runtime.quiesce()).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      {
        sessionId: value.sessionId,
        stage: 'event',
        failureCount: 1,
      },
    ]);
    await expect(value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
    const replay = value.runtime.subscribe({ sessionId: value.sessionId, fromSequence: 0 })[Symbol.asyncIterator]();
    await expect(replay.next()).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
    const closeCommand = {
      commandId: value.next(),
      type: 'close_session' as const,
      sessionId: value.sessionId,
      ifRunActive: 'interrupt' as const,
    };
    // Every cleanup effect runs, but no close receipt can be committed ahead of the failed head.
    await expect(value.runtime.closeSession(closeCommand)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.counts()).toMatchObject({ interrupts: 1, disposes: 1, releases: 1 });
    expect(value.runtime.getProviderIngestionFaults()).toHaveLength(1);
    await expect(value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
    // The exact close retry resubmits the unchanged head; nothing is cleaned up twice.
    const close = await value.runtime.closeSession(closeCommand);
    expect(close).toMatchObject({
      disposition: 'applied',
      result: { type: 'session_closed', interruptedActiveRun: true },
    });
    expect(value.counts()).toMatchObject({ interrupts: 1, disposes: 1, releases: 1 });
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
    const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0));
    expect(
      page.events.flatMap((event) => (event.payload.type === 'run.message_delta' ? [event.payload.text] : [])),
    ).toEqual(['lost event', 'another event']);
  });

  it.each([
    ['long message', new Error('x'.repeat(3000))],
    [
      'large details',
      new AgentRuntimeError(
        agentError('provider_unavailable', 'commit failed', {
          details: { payload: 'x'.repeat(100_000) },
        }),
      ),
    ],
  ] as const)('records a bounded ingestion fault for %s without rejecting supervision', async (_name, cause) => {
    const value = await fixture();
    await start(value);
    value.failNextCommit('before', 0, cause);
    value.emitText('lost event');
    await value.commitFailed.promise;
    value.completion.resolve({ outcome: 'succeeded' });
    await expect(value.runtime.quiesce()).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    const [fault] = value.runtime.getProviderIngestionFaults();
    expect(fault).toMatchObject({ sessionId: value.sessionId, stage: 'event', failureCount: 1 });
    // The public fault is the runtime's fixed classification; the store's error is never copied.
    expect(fault?.error.code).toBe('store_unavailable');
    expect(fault?.error.message).not.toContain('xxx');
    expect(fault?.error.message).not.toContain('commit failed');
    expect(fault?.error.message.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(fault).length).toBeLessThan(2500);
    // Supervision kept the completion: once the head is retried, the run terminal commits.
    await value.runtime.retryProviderIngestion(value.sessionId);
    await value.runtime.quiesce();
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('succeeded');
  });

  it('records a lost terminal commit without inventing a terminal projection', async () => {
    const value = await fixture();
    const runId = await start(value);
    value.failNextCommit();
    value.completion.resolve({ outcome: 'succeeded' });
    await expect(value.runtime.quiesce()).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      {
        sessionId: value.sessionId,
        runId,
        stage: 'completion',
        failureCount: 1,
      },
    ]);
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.termination).toBeUndefined();
    await expect(value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0))).rejects.toMatchObject({
      error: { code: 'store_unavailable' },
    });
  });

  it('reports a failed interaction request without installing a provider route', async () => {
    const value = await fixture();
    await start(value);
    value.failNextCommit();
    value.emitInteraction();
    await value.commitFailed.promise;
    await expect(value.runtime.quiesce()).rejects.toMatchObject({ error: { code: 'store_unavailable' } });
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      {
        sessionId: value.sessionId,
        stage: 'event',
        failureCount: 1,
      },
    ]);
    expect((await value.runtime.getSession(value.sessionId))?.interactions).toEqual([]);
  });

  it('counts repeated failures of the same head in one per-session fault record', async () => {
    const value = await fixture();
    await start(value);
    value.failNextCommit();
    value.emitText('first event');
    value.emitText('second event');
    await value.commitFailed.promise;
    await expect(value.runtime.quiesce()).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId: value.sessionId, stage: 'event', failureCount: 1 },
    ]);
    // A retry resubmits the same head; it fails again, so the one record counts 2.
    value.failNextCommit();
    await expect(value.runtime.retryProviderIngestion(value.sessionId)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.runtime.getProviderIngestionFaults()).toMatchObject([
      { sessionId: value.sessionId, stage: 'event', failureCount: 2 },
    ]);
    // Shutdown resumes the proven-absent head, drains, closes, and leaves no fault.
    await value.runtime.shutdown();
    expect(value.runtime.getProviderIngestionFaults()).toEqual([]);
    expect(
      (await value.committedEvents()).events.flatMap((event) =>
        event.payload.type === 'run.message_delta' ? [event.payload.text] : [],
      ),
    ).toEqual(['first event', 'second event']);
  });
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
    await expect(value.runtime.submitTurn(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    ).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    await expect(value.runtime.submitTurn(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    await expect(value.runtime.respondToInteraction(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    await expect(value.runtime.respondToInteraction(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.counts().responses).toBe(1);

    // The completion is observed, but its terminal waits behind the delivered response's slot.
    value.completion.resolve({ outcome: 'succeeded' });
    await expect(value.runtime.quiesce()).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect((await value.runtime.getSession(value.sessionId))?.runs[0]?.state).toBe('awaiting_interaction');

    await expect(
      value.runtime.respondToInteraction({ ...command, response: { kind: 'question', answer: 'changed' } }),
    ).resolves.toMatchObject({ disposition: 'rejected', error: { code: 'command_id_conflict' } });
    await expect(value.runtime.respondToInteraction(command)).resolves.toMatchObject({
      disposition: 'applied',
      result: { type: 'interaction_settled', interactionId },
    });
    await value.runtime.quiesce();

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
    await expect(value.runtime.respondToInteraction(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    await expect(value.runtime.interruptRun(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    ).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    await value.runtime.shutdown();
    expect(value.counts()).toMatchObject({ interrupts: 1, disposes: 1 });
  });

  it('does not redeliver a rejected interrupt when receipt persistence retries', async () => {
    const value = await fixture({ rejectInterrupt: true });
    const runId = await start(value);
    const command = { commandId: value.next(), type: 'interrupt_run' as const, sessionId: value.sessionId, runId };
    value.failNextCommit();
    await expect(value.runtime.interruptRun(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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
    await value.interruptEntered.promise;
    // The fence is installed synchronously, before the provider interrupt settles: the
    // request is demoted at acceptance and ordered behind the interrupt's reserved slot.
    value.emitInteraction();
    expect((await value.runtime.getSession(value.sessionId))?.interactions).toEqual([]);
    value.interruptGate.resolve(undefined);
    await interrupting;
    let events = await value.runtime.readEvents(value.sessionId, 0 as never);
    for (
      let attempt = 0;
      attempt < 50 && !events.events.some((event) => event.payload.type === 'diagnostic');
      attempt += 1
    ) {
      events = await value.runtime.readEvents(value.sessionId, 0 as never);
    }
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
    // A validation rejection has no session FIFO: its receipt-only commit fails with the store's own error.
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

    const ingested = value.nextCommit();
    value.emitWithdrawal();
    await ingested;

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

    const ingested = value.nextCommit();
    value.emitWithdrawal('some-other-reference');
    await ingested;

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
    await expect(value.runtime.respondToInteraction(command)).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
    expect(value.counts().responses).toBe(1);

    // The withdrawal is ordered behind the delivered response's failed slot: nothing commits.
    value.emitWithdrawal();
    await expect(value.runtime.quiesce()).rejects.toMatchObject(RETRYABLE_HEAD_FAILURE);
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

    const ingested = value.nextCommit();
    value.emitSessionWithdrawal();
    await ingested;

    const snapshot = await value.runtime.getSession(value.sessionId);
    expect(snapshot?.interactions[0]?.status).toBe('pending');
    const page = await value.runtime.readEvents(value.sessionId, SequenceSchema.parse(0), 1000);
    const diagnostics = page.events.filter((event) => event.payload.type === 'diagnostic');
    expect(JSON.stringify(diagnostics)).toContain('interaction.withdrawn');
  });
});

describe('prototype-named answers through Runtime', () => {
  it.each([['constructor'], ['toString'], ['ordinary', 'constructor', 'toString']])(
    'returns a replayable invalid_request for missing %j and applies present answers',
    async (...keys) => {
      const value = await fixture();
      await start(value);
      const ingested = value.nextCommit();
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
      await ingested;
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

describe('maximum-size missing question answers', () => {
  it('returns a replayable bounded rejection before any provider effect and keeps the same run answerable', async () => {
    const value = await fixture();
    const runId = await start(value);
    const keys = Array.from({ length: 32 }, (_, index) => `q${String(index).padStart(2, '0')}`.padEnd(64, 'x'));
    const ingested = value.nextCommit();
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
    await ingested;
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
