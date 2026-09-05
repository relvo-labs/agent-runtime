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

import { coordinationEntryCountForTesting, createAgentRuntime, type AgentRuntime } from '../src/runtime.ts';

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

describe('close cleanup failures', () => {
  it.each([
    ['dispose-only', 1, 0, 'provider_unavailable', ['provider_dispose']],
    ['release-only', 0, 1, 'workspace_unavailable', ['workspace_release']],
    ['simultaneous', 1, 1, 'provider_unavailable', ['provider_dispose', 'workspace_release']],
  ] as const)(
    'keeps a %s failure retryable without claiming closure',
    async (_name, disposeFailures, releaseFailures, code, phases) => {
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
      expect(value.control.disposeAttempts).toBe(1);
      expect(value.control.releaseAttempts).toBe(1);
      expect((await value.runtime.getSession(sessionId))?.session.state).toBe('closing');
      const afterFailure = await value.runtime.readEvents(sessionId, 0 as never);
      expect(afterFailure.events.filter((event) => event.payload.type === 'session.closed')).toHaveLength(0);

      const retried = await value.runtime.closeSession(command);
      expect(retried).toMatchObject({ disposition: 'applied', result: { type: 'session_closed' } });
      expect(value.control.disposeAttempts).toBe(2);
      expect(value.control.releaseAttempts).toBe(2);
      const duplicate = await value.runtime.closeSession(command);
      expect(duplicate.disposition).toBe('duplicate');
      expect(value.control.disposeAttempts).toBe(2);
      expect(value.control.releaseAttempts).toBe(2);

      const events = await value.runtime.readEvents(sessionId, 0 as never);
      expect(events.events.filter((event) => event.payload.type === 'run.finished')).toHaveLength(1);
      expect(events.events.filter((event) => event.payload.type === 'turn.settled')).toHaveLength(1);
      expect(events.events.filter((event) => event.payload.type === 'session.closed')).toHaveLength(1);
      expect(value.control.interruptAttempts).toBe(1);
      expect(coordinationEntryCountForTesting(value.runtime)).toEqual({ commands: 0, sessions: 0 });
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
    expect(value.control.releaseAttempts).toBe(1);

    let subscriptionSettled = false;
    const terminalEvent = iterator.next().then((result) => {
      subscriptionSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRetry = subscriptionSettled;
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

    const retry = value.runtime.shutdown();
    const isNewAttempt = retry !== first;
    await retry;
    expect(settledBeforeRetry).toBe(false);
    expect(rejectedAdmission).toMatchObject({ error: { code: 'session_closed' } });
    expect(isNewAttempt).toBe(true);
    expect(value.control.disposeAttempts).toBe(2);
    expect(value.control.releaseAttempts).toBe(2);
    await expect(terminalEvent).resolves.toMatchObject({ value: { type: 'event', event: { sequence: 8 } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'unsubscribed' } });
    expect(coordinationEntryCountForTesting(value.runtime)).toEqual({ commands: 0, sessions: 0 });
  });
});
