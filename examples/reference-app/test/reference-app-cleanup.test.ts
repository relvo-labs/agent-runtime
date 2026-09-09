/**
 * Cleanup-failure retry, shutdown with an open SSE connection, and the
 * "missing real-provider setup — no silent fallback" requirement.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { commandId, openScriptedSession, startTestApp, type JsonRecord } from './helpers.ts';

describe('reference-app: cleanup, shutdown, and honest provider setup failure', () => {
  it('retries a failed cleanup with the same commandId until it actually succeeds', async () => {
    let failNext = true;
    const started = await startTestApp(
      {},
      {
        removeDirectory: async (path) => {
          if (failNext) {
            failNext = false;
            throw new Error('simulated cleanup failure (test only; never a real filesystem error)');
          }
          const { rm } = await import('node:fs/promises');
          await rm(path, { recursive: true, force: true });
        },
      },
    );
    try {
      const sessionId = await openScriptedSession(started);
      const snapshot = await started.call(`/api/sessions/${sessionId}`);
      const root = ((snapshot.body.snapshot as JsonRecord).session as JsonRecord).workspace as JsonRecord;

      const closeId = commandId('close');
      const firstAttempt = await started.call(`/api/sessions/${sessionId}/close`, {
        method: 'POST',
        body: { commandId: closeId },
      });
      // The cleanup failure must be visible, not hidden behind a false
      // success. `closeSession` rejects its *promise* rather than persisting
      // a receipt exactly so the same commandId can retry the same logical
      // attempt (see `AgentExecutor#closeSession`'s own doc comment); this
      // app surfaces that as a typed, retryable JSON error, not a silent 200.
      expect(firstAttempt.status).toBe(503);
      const firstError = firstAttempt.body.error as JsonRecord;
      expect(firstError.code).toBe('workspace_unavailable');
      expect(firstError.retryable).toBe(true);
      expect(existsSync(root.root as string)).toBe(true); // nothing was falsely reported as removed

      // The exact same commandId, retried, actually finishes the job — it is
      // not treated as a brand-new close, and it is not silently dropped.
      const retry = await started.call(`/api/sessions/${sessionId}/close`, {
        method: 'POST',
        body: { commandId: closeId },
      });
      expect(retry.status).toBe(200);
      const retryReceipt = retry.body.receipt as JsonRecord;
      expect(retryReceipt.disposition).toBe('applied');
      expect(existsSync(root.root as string)).toBe(false);
    } finally {
      await started.teardown();
    }
  });

  it('shuts down cleanly with an open SSE connection, ending the stream rather than hanging', async () => {
    const started = await startTestApp();
    const sessionId = await openScriptedSession(started);

    const controller = new AbortController();
    const response = await fetch(`${started.baseUrl}/api/sessions/${sessionId}/subscribe?fromSequence=0`, {
      headers: { 'x-relvo-reference-app': '1' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // establish the stream

    const closeDeadline = Promise.race([
      started.app.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    expect(await closeDeadline).toBe('closed');

    // The stream itself ended rather than hanging forever.
    const drained = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return 'ended' as const;
        }
      })(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    expect(drained).toBe('ended');

    const { rmSync } = await import('node:fs');
    rmSync(started.workspaceBase, { recursive: true, force: true });
  });

  it('surfaces a missing Codex executable as a clean setup failure, never a silent fallback', async () => {
    const started = await startTestApp({
      enableCodex: true,
      codexExecutable: '/no/such/executable/relvo-reference-app-test',
    });
    try {
      const providers = (await started.call('/api/providers')).body.providers as JsonRecord[];
      expect(providers.some((p) => p.providerId === 'codex')).toBe(true);

      const opened = await started.call('/api/sessions', {
        method: 'POST',
        body: { commandId: commandId('open'), providerId: 'codex' },
      });
      expect(opened.status).toBe(200);
      const receipt = opened.body.receipt as JsonRecord;
      // A setup failure is a rejected receipt naming the real cause — never a
      // 200 that quietly opened a scripted session instead.
      expect(receipt.disposition).toBe('rejected');
      const error = receipt.error as JsonRecord;
      expect(typeof error.message).toBe('string');
      expect((error.message as string).length).toBeGreaterThan(0);

      // Confirm no scripted-demo session was opened behind the caller's back.
      const providersAfter = (await started.call('/api/providers')).body.providers as JsonRecord[];
      expect(providersAfter).toEqual(providers);
    } finally {
      await started.teardown();
    }
  });

  it('surfaces a missing Claude SDK peer as a clean, retryable setup failure, never a silent fallback', async () => {
    const started = await startTestApp({ enableClaude: true });
    try {
      const providers = (await started.call('/api/providers')).body.providers as JsonRecord[];
      expect(providers.some((p) => p.providerId === 'claude')).toBe(true);

      const opened = await started.call('/api/sessions', {
        method: 'POST',
        body: { commandId: commandId('open'), providerId: 'claude' },
      });
      expect(opened.status).toBe(200);
      const receipt = opened.body.receipt as JsonRecord;
      expect(receipt.disposition).toBe('rejected');
      const error = receipt.error as JsonRecord;
      expect(error.code).toBe('provider_unavailable');
      expect(error.retryable).toBe(true);
      // Names the actual missing package — never a guess, never invented text.
      expect(error.message as string).toContain('@anthropic-ai/claude-agent-sdk');
    } finally {
      await started.teardown();
    }
  });
});
