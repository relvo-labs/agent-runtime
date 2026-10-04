import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  WorkspaceLeaseIdSchema,
  createCounterIdFactory,
  createFixedClock,
  isAgentRuntimeError,
  type CommandId,
  type ExistingWorkspaceSpec,
  type ManagedWorkspaceSpec,
  type SessionId,
  type WorkspaceReleaseReport,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';
import {
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderRun,
  type ProviderRunRequest,
  type ProviderSession,
} from '@relvo-labs/agent-provider';
import type {
  BorrowedWorkspaceLease,
  ManagedWorkspaceLease,
  WorkspaceLease,
  WorkspaceProvider,
} from '@relvo-labs/agent-workspace';

import {
  coordinationEntryCountForTesting,
  createAgentRuntime,
  retainedCloseCountForTesting,
  type AgentRuntime,
} from '../src/runtime.ts';
import { createInMemoryStore, type RuntimeStore, type StoreTransaction } from '../src/store.ts';

type CleanupControl = {
  disposeAttempts: number;
  disposeFailuresRemaining: number;
  interruptAttempts: number;
  interruptFailuresRemaining: number;
  releaseAttempts: number;
  releaseFailuresRemaining: number;
};

type CleanupFixture = {
  readonly runtime: AgentRuntime;
  readonly control: CleanupControl;
  readonly borrowed: string;
  next(): CommandId;
};

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cleanupFixture(
  disposeFailures: number,
  releaseFailures: number,
  interruptFailures = 0,
): Promise<CleanupFixture> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-cleanup-failure-test-'));
  roots.push(root);
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const clock = createFixedClock();
  const ids = createCounterIdFactory();
  const control: CleanupControl = {
    disposeAttempts: 0,
    disposeFailuresRemaining: disposeFailures,
    interruptAttempts: 0,
    interruptFailuresRemaining: interruptFailures,
    releaseAttempts: 0,
    releaseFailuresRemaining: releaseFailures,
  };

  let released = false;
  const lease: BorrowedWorkspaceLease = {
    leaseId: WorkspaceLeaseIdSchema.parse(ids.next('workspaceLease')),
    ownership: 'borrowed',
    root: borrowed,
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
      control.releaseAttempts += 1;
      if (control.releaseFailuresRemaining > 0) {
        control.releaseFailuresRemaining -= 1;
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
  function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
    return spec.kind === 'existing'
      ? Promise.resolve(lease)
      : Promise.reject(new Error('managed workspaces are not used by this fixture'));
  }
  const workspaces: WorkspaceProvider = {
    acquire,
    releaseAll: () => Promise.reject(new Error('runtime must release only its validated lease')),
  };

  const completion = new Promise<never>(() => undefined);
  const descriptor = defineProviderDescriptor({
    providerId: 'cleanup-test',
    providerVersion: '0.1.0',
    displayName: 'Cleanup failure test provider',
    run: {
      interrupt: { mode: 'immediate', deliversPartialOutput: false, sessionRemainsUsable: false },
      streaming: {},
    },
    interaction: { approval: {}, question: {} },
    workspace: { requires: 'directory' },
    recovery: {},
  });
  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession(): Promise<ProviderSession> {
      return Promise.resolve({
        startRun(_request: ProviderRunRequest): Promise<ProviderRun> {
          return Promise.resolve({
            completion,
            interrupt(): Promise<void> {
              control.interruptAttempts += 1;
              if (control.interruptFailuresRemaining > 0) {
                control.interruptFailuresRemaining -= 1;
                return Promise.reject(new Error('run interrupt failed'));
              }
              return Promise.resolve();
            },
          });
        },
        respondToInteraction: () => Promise.resolve(),
        dispose(): Promise<void> {
          control.disposeAttempts += 1;
          if (control.disposeFailuresRemaining > 0) {
            control.disposeFailuresRemaining -= 1;
            return Promise.reject(new Error('provider dispose failed'));
          }
          return Promise.resolve();
        },
      });
    },
  };

  const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory: ids });
  runtimes.push(runtime);
  let command = 0;
  return {
    runtime,
    control,
    borrowed,
    next: () => CommandIdSchema.parse(`cleanup-${String(++command).padStart(8, '0')}`),
  };
}

async function openAndStart(value: CleanupFixture): Promise<SessionId> {
  const opened = await value.runtime.openSession({
    commandId: value.next(),
    type: 'open_session',
    providerId: 'cleanup-test',
    workspace: { kind: 'existing', path: value.borrowed },
  });
  if (opened.result?.type !== 'session_opened') throw new Error('session did not open');
  await value.runtime.submitTurn({
    commandId: value.next(),
    type: 'submit_turn',
    sessionId: opened.result.sessionId,
    input: { parts: [{ type: 'text', text: 'hold the run open' }] },
  });
  return opened.result.sessionId;
}

async function rollbackFixture(
  releaseFailures: number,
  options: {
    readonly failOpenCommit?: boolean;
    readonly disposeFailures?: number;
    /** Declare the strong store contract on the wrapper (it never applies a rejected commit). */
    readonly declareStrong?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'relvo-open-rollback-test-'));
  roots.push(root);
  const borrowed = join(root, 'borrowed');
  await mkdir(borrowed);
  const clock = createFixedClock();
  const ids = createCounterIdFactory();
  let acquireAttempts = 0;
  let createAttempts = 0;
  let disposeAttempts = 0;
  let disposeFailuresRemaining = options.disposeFailures ?? 0;
  let releaseAttempts = 0;
  let failuresRemaining = releaseFailures;
  let released = false;
  const lease: BorrowedWorkspaceLease = {
    leaseId: WorkspaceLeaseIdSchema.parse(ids.next('workspaceLease')),
    ownership: 'borrowed',
    root: borrowed,
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
      releaseAttempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return Promise.reject(new Error('rollback release failed'));
      }
      released = true;
      return Promise.resolve({
        leaseId: this.leaseId,
        ownership: this.ownership,
        alreadyReleased: false,
        destructiveOperations: [],
        releasedAt: clock.now(),
      });
    },
  };
  function acquire(_spec: ExistingWorkspaceSpec): Promise<BorrowedWorkspaceLease>;
  function acquire(_spec: ManagedWorkspaceSpec): Promise<ManagedWorkspaceLease>;
  function acquire(_spec: WorkspaceSpec): Promise<WorkspaceLease>;
  function acquire(spec: WorkspaceSpec): Promise<WorkspaceLease> {
    acquireAttempts += 1;
    return spec.kind === 'existing'
      ? Promise.resolve(lease)
      : Promise.reject(new Error('managed workspaces are not used by this fixture'));
  }
  const workspaces: WorkspaceProvider = {
    acquire,
    releaseAll: () => Promise.reject(new Error('runtime must use retained rollback cleanup')),
  };
  const descriptor = defineProviderDescriptor({
    providerId: 'rollback-test',
    providerVersion: '0.1.0',
    displayName: 'Rollback test provider',
    run: { interrupt: { mode: 'unsupported' }, streaming: {} },
    interaction: { approval: {}, question: {} },
    workspace: { requires: 'directory' },
    recovery: {},
  });
  const provider: AgentProvider = {
    describe: () => descriptor,
    createSession(): Promise<ProviderSession> {
      createAttempts += 1;
      if (!options.failOpenCommit) return Promise.reject(new Error('provider startup failed'));
      return Promise.resolve({
        startRun: () => Promise.reject(new Error('run is not used by this fixture')),
        respondToInteraction: () => Promise.reject(new Error('interaction is not used by this fixture')),
        dispose(): Promise<void> {
          disposeAttempts += 1;
          if (disposeFailuresRemaining > 0) {
            disposeFailuresRemaining -= 1;
            return Promise.reject(new Error('rollback dispose failed'));
          }
          return Promise.resolve();
        },
      });
    },
  };
  const baseStore = createInMemoryStore({ clock, idFactory: ids });
  let rejectNextCommit = options.failOpenCommit === true;
  const store: RuntimeStore = {
    ...(options.declareStrong === true ? { contract: { version: 1, level: 'strong' } as const } : {}),
    get revision() {
      return baseStore.revision;
    },
    commit<T>(mutate: (tx: StoreTransaction) => T) {
      if (rejectNextCommit) {
        rejectNextCommit = false;
        return Promise.reject(new Error('open commit failed'));
      }
      return baseStore.commit(mutate);
    },
    read: (sessionId) => baseStore.read(sessionId),
    readEvents: (sessionId, fromSequence, limit) => baseStore.readEvents(sessionId, fromSequence, limit),
    readInteraction: (sessionId, interactionId) => baseStore.readInteraction(sessionId, interactionId),
    findReceipt: (commandId) => baseStore.findReceipt(commandId),
    listSessions: () => baseStore.listSessions(),
  };
  const runtime = createAgentRuntime({ workspaces, providers: [provider], clock, idFactory: ids, store });
  runtimes.push(runtime);
  return {
    runtime,
    borrowed,
    counts: () => ({ acquireAttempts, createAttempts, disposeAttempts, releaseAttempts }),
  };
}

describe('open rollback cleanup failures', () => {
  it('retains failed rollback cleanup for an exact retry without reacquiring', async () => {
    const value = await rollbackFixture(1);
    const command = {
      commandId: CommandIdSchema.parse('open-rollback-transient'),
      type: 'open_session' as const,
      providerId: 'rollback-test',
      workspace: { kind: 'existing' as const, path: value.borrowed },
    };

    await expect(value.runtime.openSession(command)).rejects.toMatchObject({
      error: { code: 'workspace_unavailable', details: { failures: [{ phase: 'workspace_release' }] } },
    });
    await expect(value.runtime.openSession({ ...command, providerOptions: { changed: true } })).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 1 });

    await expect(value.runtime.openSession(command)).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'internal' },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 2 });
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
  });

  it('keeps persistent rollback cleanup visible to shutdown and its retries', async () => {
    const value = await rollbackFixture(Number.POSITIVE_INFINITY);
    const command = {
      commandId: CommandIdSchema.parse('open-rollback-persistent'),
      type: 'open_session' as const,
      providerId: 'rollback-test',
      workspace: { kind: 'existing' as const, path: value.borrowed },
    };

    await expect(value.runtime.openSession(command)).rejects.toMatchObject({
      error: { code: 'workspace_unavailable' },
    });
    await expect(value.runtime.shutdown()).rejects.toMatchObject({
      error: { code: 'workspace_unavailable' },
    });
    await expect(value.runtime.shutdown()).rejects.toMatchObject({
      error: { code: 'workspace_unavailable' },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 3 });
  });

  it('retries a recoverable open commit failure unchanged instead of rolling the session back', async () => {
    const value = await rollbackFixture(0, { failOpenCommit: true, declareStrong: true });
    const command = {
      commandId: CommandIdSchema.parse('open-commit-transient'),
      type: 'open_session' as const,
      providerId: 'rollback-test',
      workspace: { kind: 'existing' as const, path: value.borrowed },
    };

    await expect(value.runtime.openSession(command)).rejects.toMatchObject({
      error: { code: 'store_unavailable', retryable: true, details: { fault: 'failure' } },
    });
    await expect(value.runtime.openSession({ ...command, providerOptions: { changed: true } })).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 0 });
    await expect(value.runtime.openSession(command)).resolves.toMatchObject({
      disposition: 'applied',
      result: { type: 'session_opened' },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 0 });
    await expect(value.runtime.shutdown()).resolves.toBeUndefined();
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 1, releaseAttempts: 1 });
  });

  it('cleans up an open whose commit outcome is unknown, disposing before releasing, without certifying it', async () => {
    const value = await rollbackFixture(1, { failOpenCommit: true, disposeFailures: 1 });
    const command = {
      commandId: CommandIdSchema.parse('open-commit-ambiguous'),
      type: 'open_session' as const,
      providerId: 'rollback-test',
      workspace: { kind: 'existing' as const, path: value.borrowed },
    };
    // The wrapper declares no store contract: its rejection may have applied (permanent A).
    await expect(value.runtime.openSession(command)).rejects.toMatchObject({
      error: { code: 'store_unavailable', retryable: false, details: { fault: 'ambiguous', permanent: true } },
    });
    await expect(value.runtime.openSession(command)).rejects.toMatchObject({ error: { retryable: false } });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 0, releaseAttempts: 0 });

    // Shutdown 1: disposal fails, so the lease is not released.
    await expect(value.runtime.shutdown()).rejects.toMatchObject({
      error: {
        code: 'provider_unavailable',
        details: { failures: [{ error: { details: { failures: [{ phase: 'provider_dispose' }] } } }] },
      },
    });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 1, releaseAttempts: 0 });
    // Shutdown 2: disposal succeeds, release fails.
    await expect(value.runtime.shutdown()).rejects.toMatchObject({ error: { code: 'workspace_unavailable' } });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 2, releaseAttempts: 1 });
    // Shutdown 3: release succeeds; history stays uncertified, so shutdown still cannot succeed.
    await expect(value.runtime.shutdown()).rejects.toMatchObject({
      error: { code: 'store_unavailable', retryable: false },
    });
    await expect(value.runtime.shutdown()).rejects.toMatchObject({ error: { retryable: false } });
    expect(value.counts()).toEqual({ acquireAttempts: 1, createAttempts: 1, disposeAttempts: 2, releaseAttempts: 2 });
  });
});

describe('close cleanup failures', () => {
  it('refuses another close id while the first is unresolved and keeps the first close interruption', async () => {
    const value = await cleanupFixture(1, 0);
    const sessionId = await openAndStart(value);
    const first = {
      commandId: value.next(),
      type: 'close_session' as const,
      sessionId,
      ifRunActive: 'interrupt' as const,
    };
    const second = { ...first, commandId: value.next() };
    await expect(value.runtime.closeSession(first)).rejects.toMatchObject({ error: { code: 'provider_unavailable' } });
    expect(retainedCloseCountForTesting(value.runtime)).toBe(1);
    // A second close id cannot take over the unresolved close; nothing is recorded for it.
    await expect(value.runtime.closeSession(second)).rejects.toMatchObject({
      error: { code: 'illegal_state_transition', retryable: true, details: { reason: 'close-in-progress' } },
    });
    expect(value.control.disposeAttempts).toBe(1);
    const recovered = await value.runtime.closeSession(first);
    expect(recovered).toMatchObject({ disposition: 'applied', result: { interruptedActiveRun: true } });
    expect(retainedCloseCountForTesting(value.runtime)).toBe(0);
    expect(await value.runtime.closeSession(first)).toMatchObject({
      disposition: 'duplicate',
      result: { interruptedActiveRun: true },
    });
    // The other id now closes an already closed session: an applied no-op that interrupted nothing.
    expect(await value.runtime.closeSession(second)).toMatchObject({
      disposition: 'applied',
      result: { interruptedActiveRun: false },
    });
  });
  // Release is attempted only after a confirmed disposal, and a retry repeats only the
  // phases that failed (issue #43): `attempts` are the cumulative dispose/release counts
  // after each failed attempt, and `final` after the successful one.
  it.each([
    ['dispose-only', 1, 0, 'provider_unavailable', ['provider_dispose'], [[1, 0]], [2, 1]],
    ['release-only', 0, 1, 'workspace_unavailable', ['workspace_release'], [[1, 1]], [1, 2]],
    [
      'dispose-then-release',
      1,
      1,
      'provider_unavailable',
      ['provider_dispose'],
      [
        [1, 0],
        [2, 1],
      ],
      [2, 2],
    ],
  ] as const)(
    'keeps a %s failure retryable without claiming closure',
    async (_name, disposeFailures, releaseFailures, code, phases, attempts, final) => {
      const value = await cleanupFixture(disposeFailures, releaseFailures);
      const sessionId = await openAndStart(value);
      const command = {
        commandId: value.next(),
        type: 'close_session' as const,
        sessionId,
        ifRunActive: 'interrupt' as const,
      };

      const first = await value.runtime.closeSession(command).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(first).toMatchObject({
        error: {
          code,
          retryable: true,
          details: { failures: phases.map((phase) => ({ phase })) },
        },
      });
      expect(isAgentRuntimeError(first)).toBe(true);
      if (!isAgentRuntimeError(first)) throw new Error('cleanup failure was not typed');
      expect(first.cause).toBeInstanceOf(AggregateError);
      for (const [index, [disposes, releases]] of attempts.entries()) {
        if (index > 0) {
          await expect(value.runtime.closeSession(command)).rejects.toMatchObject({ error: { retryable: true } });
        }
        expect(value.control.disposeAttempts).toBe(disposes);
        expect(value.control.releaseAttempts).toBe(releases);
        expect((await value.runtime.getSession(sessionId))?.session.state).toBe('closing');
        const afterFailure = await value.runtime.readEvents(sessionId, 0 as never);
        expect(afterFailure.events.filter((event) => event.payload.type === 'session.closed')).toHaveLength(0);
      }

      const retried = await value.runtime.closeSession(command);
      expect(retried).toMatchObject({
        disposition: 'applied',
        result: { type: 'session_closed', interruptedActiveRun: true },
      });
      expect(value.control.disposeAttempts).toBe(final[0]);
      expect(value.control.releaseAttempts).toBe(final[1]);
      const duplicate = await value.runtime.closeSession(command);
      expect(duplicate.disposition).toBe('duplicate');
      expect(duplicate.result).toMatchObject({ type: 'session_closed', interruptedActiveRun: true });
      expect(value.control.disposeAttempts).toBe(final[0]);
      expect(value.control.releaseAttempts).toBe(final[1]);

      const events = await value.runtime.readEvents(sessionId, 0 as never);
      expect(events.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
      expect(events.events.filter((event) => event.payload.type === 'turn.settled')).toHaveLength(1);
      expect(events.events.filter((event) => event.payload.type === 'session.closed')).toHaveLength(1);
      expect(value.control.interruptAttempts).toBe(1);
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
        liveSessions: 0,
      });
    },
  );

  it('retains a run when interrupt and disposal both fail, then terminalizes it once on retry', async () => {
    const value = await cleanupFixture(1, 0, 1);
    const sessionId = await openAndStart(value);
    const command = {
      commandId: value.next(),
      type: 'close_session' as const,
      sessionId,
      ifRunActive: 'interrupt' as const,
    };

    const failure = await value.runtime.closeSession(command).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      error: {
        code: 'provider_unavailable',
        details: { failures: [{ phase: 'run_interrupt' }, { phase: 'provider_dispose' }] },
      },
    });
    const failedEvents = await value.runtime.readEvents(sessionId, 0 as never);
    expect(failedEvents.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(0);
    expect((await value.runtime.getSession(sessionId))?.runs[0]?.state).toBe('running');

    await expect(value.runtime.closeSession(command)).resolves.toMatchObject({ disposition: 'applied' });
    const events = await value.runtime.readEvents(sessionId, 0 as never);
    expect(events.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
    expect(events.events.filter((event) => event.payload.type === 'turn.settled')).toHaveLength(1);
    expect(events.events.filter((event) => event.payload.type === 'session.closed')).toHaveLength(1);
    expect(value.control.interruptAttempts).toBe(2);
    expect(value.control.disposeAttempts).toBe(2);
    // Release was not attempted while disposal had failed.
    expect(value.control.releaseAttempts).toBe(1);
  });

  it('reserves the failed close fingerprint and rejects a changed retry before cleanup', async () => {
    const value = await cleanupFixture(1, 1);
    const sessionId = await openAndStart(value);
    const command = {
      commandId: value.next(),
      type: 'close_session' as const,
      sessionId,
      ifRunActive: 'interrupt' as const,
    };

    await expect(value.runtime.closeSession(command)).rejects.toMatchObject({
      error: { code: 'provider_unavailable' },
    });
    await expect(value.runtime.closeSession({ ...command, ifRunActive: 'reject' })).resolves.toMatchObject({
      disposition: 'rejected',
      error: { code: 'command_id_conflict' },
    });
    expect(value.control.disposeAttempts).toBe(1);
    expect(value.control.releaseAttempts).toBe(0);

    // Disposal now succeeds; the release fails once.
    await expect(value.runtime.closeSession(command)).rejects.toMatchObject({
      error: { code: 'workspace_unavailable' },
    });
    await expect(value.runtime.closeSession(command)).resolves.toMatchObject({ disposition: 'applied' });
    expect(value.control.disposeAttempts).toBe(2);
    expect(value.control.releaseAttempts).toBe(2);
  });
});

describe('shutdown cleanup failures', () => {
  it('memoizes one attempt, preserves admission and subscriptions, then permits a shutdown retry', async () => {
    const value = await cleanupFixture(1, 1);
    const sessionId = await openAndStart(value);
    const subscription = value.runtime.subscribe({
      sessionId,
      fromSequence: 0,
      types: ['session.closed'],
    });
    const iterator = subscription[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'caught_up' } });

    const first = value.runtime.shutdown();
    const concurrent = value.runtime.shutdown();
    expect(concurrent).toBe(first);
    const failed = await Promise.allSettled([first, concurrent]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(failed[0]).toMatchObject({
      status: 'rejected',
      reason: { error: { code: 'provider_unavailable', retryable: true } },
    });
    expect(value.control.disposeAttempts).toBe(1);
    // Release is not attempted while disposal has failed.
    expect(value.control.releaseAttempts).toBe(0);

    const terminalEvent = iterator.next();
    const beforeRetry = await value.runtime.readEvents(sessionId, 0 as never);
    expect(beforeRetry.events.some((event) => event.payload.type === 'session.closed')).toBe(false);
    const rejectedAdmission = await value.runtime
      .openSession({
        commandId: value.next(),
        type: 'open_session',
        providerId: 'cleanup-test',
        workspace: { kind: 'existing', path: value.borrowed },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Retry 1: disposal succeeds, the release fails once; admission stays closed.
    const retry = value.runtime.shutdown();
    const isNewAttempt = retry !== first;
    await expect(retry).rejects.toMatchObject({ error: { code: 'workspace_unavailable', retryable: true } });
    expect(value.control.disposeAttempts).toBe(2);
    expect(value.control.releaseAttempts).toBe(1);
    // Retry 2 repeats only the release.
    await value.runtime.shutdown();
    expect(rejectedAdmission).toMatchObject({ error: { code: 'session_closed' } });
    expect(isNewAttempt).toBe(true);
    expect(value.control.disposeAttempts).toBe(2);
    expect(value.control.releaseAttempts).toBe(2);
    await expect(terminalEvent).resolves.toMatchObject({ value: { type: 'event', event: { sequence: 8 } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'unsubscribed' } });
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
      liveSessions: 0,
    });
  });
});
