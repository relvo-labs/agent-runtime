/**
 * A deterministic in-memory stand-in for a Codex app-server connection.
 *
 * No process, no network, no credentials, no timers used for ordering: a test
 * pushes exactly the frames it wants to characterize and calls `flush()` to
 * reach a defined quiescent point. Hostile frames are pushed as raw `unknown`,
 * because that is precisely what the real transport hands the client.
 */

import type { CodexClientMessage, CodexRequestId, CodexTransport } from '../src/seam.ts';

type Waiter = {
  readonly resolve: (result: IteratorResult<unknown, void>) => void;
  readonly reject: (reason: unknown) => void;
};

/** Answers a request by method name. Return `undefined` to stay silent. */
export type Responder = (params: unknown, id: CodexRequestId) => unknown;

export type FakeTransport = {
  readonly transport: CodexTransport;
  /** Everything the adapter wrote, in order. */
  readonly sent: readonly CodexClientMessage[];
  readonly closeCalls: number;
  /** Requests the adapter sent, in order, filtered by method. */
  requests(method: string): readonly { readonly id: CodexRequestId; readonly params: unknown }[];
  /** Push one raw inbound frame. Anything at all — this is untrusted input. */
  push(value: unknown): void;
  /** Answer a request the adapter already sent. */
  respond(method: string, result: unknown, occurrence?: number): void;
  /** Fail a request the adapter already sent. */
  respondWithError(method: string, code: number, message?: string, occurrence?: number): void;
  /** End the inbound stream the way a closed stdout would. */
  end(): void;
  /** Make the inbound stream throw, the way a dead child process would. */
  fail(reason: unknown): void;
  /** Make the next `close()` reject asynchronously. */
  failNextClose(reason: unknown): void;
  /** Make the next `close()` throw *synchronously*, before returning a promise. */
  throwOnNextClose(reason: unknown): void;
  /** Hold `close()` unresolved so a concurrent disposal can be observed. */
  holdNextClose(): () => void;
  /** Install or replace a responder after construction. */
  setResponder(method: string, responder: Responder): void;
};

/** Drain the microtask queue; a macrotask boundary is a definite settle point. */
export async function flush(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Credential-shaped fixtures, assembled at runtime.
 *
 * Never write one of these as a source literal: `tools/repo/check-static.ts`
 * scans every tracked file for committed secrets, and a test fixture that
 * matches is indistinguishable from a real leak.
 */
export const FIXTURE_BEARER = ['sk', 'ant', 'A'.repeat(28)].join('-');
export const FIXTURE_GITHUB_TOKEN = ['ghp', 'B'.repeat(30)].join('_');
export const FIXTURE_AWS_KEY = `AKIA${'C'.repeat(16)}`;

export const FAKE_THREAD_ID = 'thread-0199a0b1-0000-7000-8000-000000000001';
export const FAKE_TURN_ID = 'turn-0199a0b1-0000-7000-8000-000000000002';

/**
 * The responses a healthy 0.153.4 app-server gives for the bounded surface.
 * Shapes follow the pinned stable TypeScript exactly.
 */
export function defaultResponders(): Record<string, Responder> {
  return {
    initialize: () => ({
      userAgent: 'codex-test-agent',
      codexHome: '/home/example/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    }),
    'thread/start': () => ({
      thread: { id: FAKE_THREAD_ID, cwd: '/workspace', turns: [] },
      model: 'gpt-5-codex',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: '/workspace',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      reasoningEffort: null,
    }),
    'turn/start': () => ({
      turn: { id: FAKE_TURN_ID, items: [], itemsView: 'complete', status: 'inProgress', error: null },
    }),
    'turn/interrupt': () => ({}),
  };
}

export type FakeTransportOptions = {
  /** Method → responder. Omit a method to leave its request unanswered. */
  readonly responders?: Record<string, Responder>;
};

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const sent: CodexClientMessage[] = [];
  const queue: unknown[] = [];
  const waiters: Waiter[] = [];
  const responders = new Map<string, Responder>(Object.entries(options.responders ?? defaultResponders()));

  let finished = false;
  let failure: { reason: unknown } | undefined;
  let closeCalls = 0;
  let nextCloseFailure: { reason: unknown } | undefined;
  let nextCloseThrow: { reason: unknown } | undefined;
  let heldClose: (() => void) | undefined;
  const release: { close?: (() => void) | undefined } = {};

  function wake(): void {
    while (waiters.length > 0) {
      if (failure !== undefined) {
        waiters.shift()?.reject(failure.reason);
        continue;
      }
      if (queue.length > 0) {
        waiters.shift()?.resolve({ done: false, value: queue.shift() });
        continue;
      }
      if (finished) {
        waiters.shift()?.resolve({ done: true, value: undefined });
        continue;
      }
      return;
    }
  }

  function push(value: unknown): void {
    queue.push(value);
    wake();
  }

  function sentRequests(method: string): { readonly id: CodexRequestId; readonly params: unknown }[] {
    const found: { id: CodexRequestId; params: unknown }[] = [];
    for (const message of sent) {
      if (!('method' in message) || message.method !== method) continue;
      if (!('id' in message)) continue;
      found.push({ id: message.id, params: 'params' in message ? message.params : undefined });
    }
    return found;
  }

  const transport: CodexTransport = {
    send(message: CodexClientMessage): void {
      sent.push(message);
      if (!('method' in message) || !('id' in message)) return;
      const responder = responders.get(message.method);
      if (responder === undefined) return;
      const id = message.id;
      const params = 'params' in message ? message.params : undefined;
      // Answer on a later microtask, the way a real connection would.
      queueMicrotask(() => {
        if (finished || failure !== undefined) return;
        const result = responder(params, id);
        if (result === undefined) return;
        push({ id, result });
      });
    },

    incoming: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (failure !== undefined) throw failure.reason;
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (finished) return;
          const result = await new Promise<IteratorResult<unknown, void>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
          if (result.done === true) return;
          yield result.value;
        }
      },
    },

    async close(): Promise<void> {
      closeCalls += 1;
      const synchronous = nextCloseThrow;
      if (synchronous !== undefined) {
        nextCloseThrow = undefined;
        // Deliberately thrown before the first await, so the caller sees a
        // synchronous throw rather than a rejected promise.
        throw synchronous.reason instanceof Error ? synchronous.reason : new Error(String(synchronous.reason));
      }
      const gate = heldClose;
      if (gate !== undefined) {
        heldClose = undefined;
        await new Promise<void>((resolve) => {
          release.close = resolve;
        });
      }
      const rejection = nextCloseFailure;
      if (rejection !== undefined) {
        nextCloseFailure = undefined;
        throw rejection.reason instanceof Error ? rejection.reason : new Error(String(rejection.reason));
      }
      finished = true;
      wake();
    },
  };

  return {
    transport,
    sent,
    get closeCalls() {
      return closeCalls;
    },
    requests: sentRequests,
    push,
    respond(method: string, result: unknown, occurrence = 0): void {
      const request = sentRequests(method)[occurrence];
      if (request === undefined) throw new Error(`the adapter never sent \`${method}\` #${String(occurrence)}`);
      push({ id: request.id, result });
    },
    respondWithError(method: string, code: number, message = 'rejected', occurrence = 0): void {
      const request = sentRequests(method)[occurrence];
      if (request === undefined) throw new Error(`the adapter never sent \`${method}\` #${String(occurrence)}`);
      push({ id: request.id, error: { code, message } });
    },
    end(): void {
      finished = true;
      wake();
    },
    fail(reason: unknown): void {
      failure = { reason };
      wake();
    },
    failNextClose(reason: unknown): void {
      nextCloseFailure = { reason };
    },
    throwOnNextClose(reason: unknown): void {
      nextCloseThrow = { reason };
    },
    holdNextClose(): () => void {
      heldClose = () => undefined;
      return () => {
        release.close?.();
        release.close = undefined;
      };
    },
    setResponder(method: string, responder: Responder): void {
      responders.set(method, responder);
    },
  };
}

// ---------------------------------------------------------------------------
// Frame builders — shapes taken from the pinned stable TypeScript
// ---------------------------------------------------------------------------

export function agentMessageDelta(delta: string, correlation?: { threadId?: string; turnId?: string }): unknown {
  return {
    method: 'item/agentMessage/delta',
    params: {
      threadId: correlation?.threadId ?? FAKE_THREAD_ID,
      turnId: correlation?.turnId ?? FAKE_TURN_ID,
      itemId: 'item-1',
      delta,
    },
  };
}

export function turnCompleted(
  status: string,
  extra?: { threadId?: string; turnId?: string; error?: unknown },
): unknown {
  return {
    method: 'turn/completed',
    params: {
      threadId: extra?.threadId ?? FAKE_THREAD_ID,
      turn: {
        id: extra?.turnId ?? FAKE_TURN_ID,
        items: [],
        itemsView: 'complete',
        status,
        error: extra?.error ?? null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    },
  };
}

export function tokenUsage(
  last: Record<string, number>,
  correlation?: { threadId?: string; turnId?: string },
): unknown {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: correlation?.threadId ?? FAKE_THREAD_ID,
      turnId: correlation?.turnId ?? FAKE_TURN_ID,
      tokenUsage: {
        total: {
          totalTokens: 999,
          inputTokens: 999,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: { cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, ...last },
        modelContextWindow: 400_000,
      },
    },
  };
}
