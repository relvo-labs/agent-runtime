/**
 * JSON-RPC correlation.
 *
 * The invariant under test is blunt: **every request settles**, and no reply
 * can settle a request it does not name. A pending request that could outlive
 * its connection is a hang, and a reply matched to the wrong request is a
 * silent lie.
 */

import { describe, expect, it, vi } from 'vitest';

import { isProviderRejection } from '@relvo-labs/agent-provider';

import { classifyWireError, createCodexClient, isAuthoritativeRejection, type CodexClientEnd } from '../src/client.ts';
import { FIXTURE_BEARER, createFakeTransport, flush } from './fake-transport.ts';

type Recorder = {
  readonly notifications: { method: string; params: unknown }[];
  readonly serverRequests: string[];
  readonly drops: string[];
  readonly ends: CodexClientEnd[];
};

function recorder(): { handlers: Parameters<typeof createCodexClient>[1]; log: Recorder } {
  const log: Recorder = { notifications: [], serverRequests: [], drops: [], ends: [] };
  return {
    log,
    handlers: {
      onNotification: (method, params) => log.notifications.push({ method, params }),
      onServerRequest: (method) => log.serverRequests.push(method),
      onDrop: (reason) => log.drops.push(reason),
      onEnd: (end) => log.ends.push(end),
    },
  };
}

describe('request correlation', () => {
  it('resolves a request with the reply that names it', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const pending = client.request('initialize', { a: 1 });
    await flush();
    fake.respond('initialize', { userAgent: 'x' });

    await expect(pending).resolves.toEqual({ userAgent: 'x' });
  });

  it('never reuses a request id', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    void client.request('a').catch(() => undefined);
    void client.request('b').catch(() => undefined);
    void client.request('c').catch(() => undefined);
    await flush();

    const ids = fake.sent.filter((message) => 'id' in message).map((message) => (message as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps concurrent requests independent', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const first = client.request('turn/start');
    const second = client.request('turn/interrupt');
    await flush();

    // Answered out of order on purpose.
    fake.respond('turn/interrupt', {});
    fake.respond('turn/start', { turn: { id: 'u' } });

    await expect(second).resolves.toEqual({});
    await expect(first).resolves.toEqual({ turn: { id: 'u' } });
  });

  it('drops a reply that names no pending request', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    createCodexClient(fake.transport, handlers);

    fake.push({ id: 999, result: { forged: true } });
    fake.push({ id: 999, error: { code: -32603, message: 'x' } });
    await flush();

    expect(log.drops).toEqual(['unknown_reply', 'unknown_reply']);
  });

  it('does not let a late reply settle a newer request that reused nothing', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const first = client.request('a');
    await flush();
    fake.respond('a', 'first-answer');
    await expect(first).resolves.toBe('first-answer');

    // The server repeats the retired reply while a new request is in flight.
    const second = client.request('b');
    await flush();
    fake.push({ id: 1, result: 'stale' });
    await flush();
    expect(log.drops).toEqual(['unknown_reply']);

    fake.respond('b', 'second-answer');
    await expect(second).resolves.toBe('second-answer');
  });

  it('rejects with a classification, never the server message text', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const pending = client.request('thread/start');
    await flush();
    fake.respondWithError('thread/start', -32603, `boom at /home/alice/.codex with ${FIXTURE_BEARER}`);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      if (!isProviderRejection(error)) return false;
      const serialized = JSON.stringify(error.agentError);
      return (
        !serialized.includes('/home/alice') &&
        !serialized.includes(FIXTURE_BEARER) &&
        error.agentError.providerCode === 'internal_error'
      );
    });
  });
});

describe('inbound routing', () => {
  it('forwards notifications', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    createCodexClient(fake.transport, handlers);

    fake.push({ method: 'turn/started', params: { threadId: 't' } });
    await flush();

    expect(log.notifications).toEqual([{ method: 'turn/started', params: { threadId: 't' } }]);
  });

  it('declines a server-initiated request once, echoing its id', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    createCodexClient(fake.transport, handlers);

    fake.push({ id: 42, method: 'item/tool/requestUserInput', params: { isBlocking: true } });
    await flush();

    expect(log.serverRequests).toEqual(['item/tool/requestUserInput']);
    expect(fake.sent).toEqual([{ id: 42, error: { code: -32601, message: 'method not supported by this client' } }]);
  });

  it.each([
    'applyPatchApproval',
    'execCommandApproval',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/call',
    'mcpServer/elicitation/request',
    'attestation/generate',
    'account/chatgptAuthTokens/refresh',
  ])('declines the stable server request `%s` rather than hanging it', async (method) => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    createCodexClient(fake.transport, handlers);

    fake.push({ id: 'srv-1', method, params: {} });
    await flush();

    expect(log.serverRequests).toEqual([method]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ id: 'srv-1', error: { code: -32601 } });
  });

  it('drops an unclassifiable frame without disturbing the connection', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    fake.push(42);
    fake.push(null);
    fake.push([1, 2, 3]);
    fake.push({});
    await flush();
    expect(log.drops).toEqual(['unclassifiable', 'unclassifiable', 'unclassifiable', 'unclassifiable']);

    // Still usable afterwards.
    const pending = client.request('initialize');
    await flush();
    fake.respond('initialize', 'ok');
    await expect(pending).resolves.toBe('ok');
  });

  it('never writes a `jsonrpc` member', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    void client.request('initialize', { a: 1 }).catch(() => undefined);
    client.notify('initialized');
    fake.push({ id: 5, method: 'attestation/generate' });
    await flush();

    for (const message of fake.sent) expect(message).not.toHaveProperty('jsonrpc');
  });

  it('sends a notification with no id and no params member when none is given', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    client.notify('initialized');
    await flush();

    expect(fake.sent).toEqual([{ method: 'initialized' }]);
  });
});

describe('stream end settles everything', () => {
  it('rejects every pending request on EOF', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const first = client.request('a');
    const second = client.request('b');
    await flush();
    fake.end();

    await expect(first).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );
    await expect(second).rejects.toThrow();
    expect(log.ends).toEqual([{ end: 'eof' }]);
    expect(client.ended).toBe(true);
  });

  it('rejects every pending request when the stream fails', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const pending = client.request('a');
    await flush();
    fake.fail(Object.assign(new Error('pipe died'), { code: 'EPIPE' }));

    await expect(pending).rejects.toThrow();
    expect(log.ends).toEqual([{ end: 'failed', cause: 'EPIPE' }]);
  });

  it('reports the end exactly once', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers, log } = recorder();
    createCodexClient(fake.transport, handlers);

    fake.end();
    await flush();
    fake.end();
    await flush();

    expect(log.ends).toHaveLength(1);
  });

  it('rejects a request made after the stream ended, rather than hanging it', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    fake.end();
    await flush();

    await expect(client.request('a')).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );
  });

  it('does not throw when notifying after the stream ended', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    fake.end();
    await flush();

    expect(() => client.notify('initialized')).not.toThrow();
  });
});

/**
 * R2 — "the server said no" and "we never heard back" are different facts.
 *
 * Only the first proves nothing was admitted. Everything else, including
 * anything this layer cannot classify at all, must fail safe as uncertain.
 */
describe('authoritative rejection versus uncertain admission', () => {
  it('classifies a server error reply as authoritative', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const pending = client.request('turn/start');
    await flush();
    fake.respondWithError('turn/start', -32600, 'ownership');

    const error = await pending.catch((reason: unknown) => reason);
    expect(isProviderRejection(error)).toBe(true);
    expect(isAuthoritativeRejection(error)).toBe(true);
  });

  it('classifies an unanswered request as uncertain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fake = createFakeTransport({ responders: {} });
      const { handlers } = recorder();
      const client = createCodexClient(fake.transport, handlers, { requestTimeoutMs: 1000 });

      const pending = client.request('turn/start');
      const settled = pending.catch((reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(1001);

      expect(isAuthoritativeRejection(await settled)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a connection that died mid-request as uncertain', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    const pending = client.request('turn/start');
    await flush();
    fake.end();

    expect(isAuthoritativeRejection(await pending.catch((reason: unknown) => reason))).toBe(false);
  });

  it('classifies a request refused before it was ever written as authoritative', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    fake.end();
    await flush();

    const error = await client.request('turn/start').catch((reason: unknown) => reason);
    expect(isAuthoritativeRejection(error)).toBe(true);
  });

  it('treats an unrecognised thrown value as uncertain rather than assuming rejection', () => {
    expect(isAuthoritativeRejection(new Error('who knows'))).toBe(false);
    expect(isAuthoritativeRejection(undefined)).toBe(false);
  });
});

describe('request deadline', () => {
  it('rejects a request the peer never answers', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeTransport({ responders: {} });
      const { handlers } = recorder();
      const client = createCodexClient(fake.transport, handlers, { requestTimeoutMs: 1000 });

      const pending = client.request('turn/start');
      const assertion = expect(pending).rejects.toSatisfy(
        (error: unknown) => isProviderRejection(error) && error.agentError.providerCode === 'request_timeout',
      );
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a deadline for a request that was answered', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeTransport({ responders: {} });
      const { handlers } = recorder();
      const client = createCodexClient(fake.transport, handlers, { requestTimeoutMs: 1000 });

      const pending = client.request('initialize');
      await vi.advanceTimersByTimeAsync(1);
      fake.respond('initialize', 'ok');
      await vi.advanceTimersByTimeAsync(5000);

      await expect(pending).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('wire error classification', () => {
  it.each([
    [-32001, 'overloaded', true],
    [-32600, 'invalid_request', false],
    [-32601, 'method_not_found', false],
    [-32602, 'invalid_params', false],
    [-32603, 'internal_error', true],
    [-32700, 'parse_error', false],
    [12345, 'unclassified', false],
  ])('maps %i to %s', (code, classification, retryable) => {
    expect(classifyWireError(code)).toEqual({ classification, retryable });
  });
});

describe('close', () => {
  it('delegates to the transport', async () => {
    const fake = createFakeTransport({ responders: {} });
    const { handlers } = recorder();
    const client = createCodexClient(fake.transport, handlers);

    await client.close();
    expect(fake.closeCalls).toBe(1);
  });
});
