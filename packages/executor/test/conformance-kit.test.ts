import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { CommandId, CommandReceipt, Timestamp } from '@relvo-labs/agent-protocol';
import {
  ConformanceFailure,
  EXECUTOR_CONFORMANCE_CASES,
  conformanceCase,
  type AgentExecutor,
  type ConformanceHarness,
} from '../src/index.ts';

/**
 * The conformance kit is the only behaviour this package ships. Its contract is
 * that an out-of-tree implementor can run it under any runner and get a typed
 * `ConformanceFailure` describing what their executor got wrong — so the kit's
 * own identity, lookup and failure reporting are what there is to test here.
 */

function unexpected(method: string): never {
  throw new Error(`conformance case called ${method} on a harness that should have failed earlier`);
}

/** An executor that rejects the very first command a case issues. */
function rejectingExecutor(): AgentExecutor {
  const receipt: CommandReceipt = {
    commandId: 'conformance-probe' as CommandId,
    commandType: 'open_session',
    disposition: 'rejected',
    error: { code: 'invalid_request', message: 'refused by the probe', retryable: false },
    acceptedAt: '2026-01-01T00:00:00.000Z' as Timestamp,
  };
  return {
    openSession: () => Promise.resolve(receipt),
    submitTurn: () => unexpected('submitTurn'),
    interruptRun: () => unexpected('interruptRun'),
    respondToInteraction: () => unexpected('respondToInteraction'),
    closeSession: () => unexpected('closeSession'),
    dispatch: () => unexpected('dispatch'),
    getSession: () => unexpected('getSession'),
    readEvents: () => unexpected('readEvents'),
    listProviders: () => unexpected('listProviders'),
    subscribe: () => unexpected('subscribe'),
    shutdown: () => unexpected('shutdown'),
  };
}

function probeHarness(): ConformanceHarness {
  let counter = 0;
  return {
    executor: rejectingExecutor(),
    nextCommandId: () => {
      counter += 1;
      return `probe-${String(counter)}` as CommandId;
    },
    providerId: 'probe',
    borrowedWorkspacePath: '/tmp/relvo-conformance-probe',
    settle: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

describe('executor conformance kit', () => {
  it('publishes at least one case, each with a stable id and acceptance evidence', () => {
    expect(EXECUTOR_CONFORMANCE_CASES.length).toBeGreaterThan(0);
    for (const testCase of EXECUTOR_CONFORMANCE_CASES) {
      expect(testCase.id, JSON.stringify(testCase.id)).toMatch(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/u);
      expect(testCase.title.length).toBeGreaterThan(0);
      expect(testCase.acceptanceIds.length).toBeGreaterThan(0);
      for (const acceptanceId of testCase.acceptanceIds) {
        expect(acceptanceId, `${testCase.id} acceptance id`).toMatch(/^[A-Z]{2}-\d{2}$/u);
      }
      expect(typeof testCase.run).toBe('function');
    }
  });

  it('keeps case ids unique so an allow-list cannot silently select two cases', () => {
    const ids = EXECUTOR_CONFORMANCE_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a case up by id and rejects an unknown id with a typed failure', () => {
    for (const testCase of EXECUTOR_CONFORMANCE_CASES) {
      expect(conformanceCase(testCase.id)).toBe(testCase);
    }
    expect(() => conformanceCase('store/no-such-case')).toThrow(ConformanceFailure);
    expect(() => conformanceCase('store/no-such-case')).toThrow('store/no-such-case');
  });

  it('reports a non-conforming executor as a ConformanceFailure, not a raw error', async () => {
    const failure = await conformanceCase('identity/distinct-ids')
      .run(probeHarness())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ConformanceFailure);
    expect((failure as ConformanceFailure).name).toBe('ConformanceFailure');
    expect((failure as ConformanceFailure).message).toContain('open_session');
  });

  it('stays framework-agnostic so an out-of-tree implementor can run it under any runner', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/conformance.ts', import.meta.url)), 'utf8');
    for (const runner of ['vitest', 'jest', 'node:test', 'mocha', 'chai']) {
      expect(source, `conformance kit must not import ${runner}`).not.toContain(`from '${runner}'`);
    }
  });
});
