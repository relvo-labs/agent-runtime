/**
 * A deterministic in-memory stand-in for the SDK's `query`.
 *
 * No process, no network, no credentials, no timers used for ordering: a test
 * pushes exactly the messages it wants to characterize and calls `flush()` to
 * reach a defined quiescent point.
 */

import type {
  ClaudePromptMessage,
  ClaudeQuery,
  ClaudeQueryHandle,
  ClaudeQueryMessage,
  ClaudeQueryParams,
} from '../src/seam.ts';

type Waiter = (result: IteratorResult<ClaudeQueryMessage, void>) => void;
type Failer = (reason: unknown) => void;

export type FakeQuery = {
  readonly query: ClaudeQuery;
  readonly calls: readonly ClaudeQueryParams[];
  /** User messages the adapter pushed into streaming input, in order. */
  readonly prompts: readonly ClaudePromptMessage[];
  readonly interruptCalls: number;
  readonly returnCalls: number;
  push(message: ClaudeQueryMessage): void;
  /** End the message stream the way a finished SDK generator would. */
  end(): void;
  /** Make the message stream throw, the way a dead CLI process would. */
  fail(reason: unknown): void;
  /** Make `interrupt()` reject once, to exercise the retry path. */
  failNextInterrupt(reason: unknown): void;
  /** Make `return()` reject once, to exercise a failed disposal. */
  failNextReturn(reason: unknown): void;
};

/** Drain the microtask queue; a macrotask boundary is a definite settle point. */
export async function flush(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function createFakeQuery(): FakeQuery {
  const calls: ClaudeQueryParams[] = [];
  const prompts: ClaudePromptMessage[] = [];
  const pending: ClaudeQueryMessage[] = [];
  const waiters: Waiter[] = [];
  const failers: Failer[] = [];
  let finished = false;
  let failure: { reason: unknown } | undefined;
  let interruptCalls = 0;
  let returnCalls = 0;
  let nextInterruptFailure: { reason: unknown } | undefined;
  let nextReturnFailure: { reason: unknown } | undefined;

  function wake(): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      const failer = failers.shift();
      if (failure !== undefined) {
        failer?.(failure.reason);
        continue;
      }
      const next = pending.shift();
      if (next !== undefined) {
        waiter?.({ done: false, value: next });
        continue;
      }
      if (finished) {
        waiter?.({ done: true, value: undefined });
        continue;
      }
      // Nothing to deliver: put the waiter back and stop.
      if (waiter !== undefined) waiters.unshift(waiter);
      if (failer !== undefined) failers.unshift(failer);
      return;
    }
  }

  const handle: ClaudeQueryHandle = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (failure !== undefined) throw failure.reason;
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finished) return;
        const result = await new Promise<IteratorResult<ClaudeQueryMessage, void>>((resolve, reject) => {
          waiters.push(resolve);
          failers.push(reject);
        });
        if (result.done === true) return;
        yield result.value;
      }
    },
    interrupt(): Promise<unknown> {
      interruptCalls += 1;
      const rejection = nextInterruptFailure;
      if (rejection !== undefined) {
        nextInterruptFailure = undefined;
        return Promise.reject(
          rejection.reason instanceof Error ? rejection.reason : new Error(String(rejection.reason)),
        );
      }
      return Promise.resolve(undefined);
    },
    return(): Promise<unknown> {
      returnCalls += 1;
      const rejection = nextReturnFailure;
      if (rejection !== undefined) {
        nextReturnFailure = undefined;
        return Promise.reject(
          rejection.reason instanceof Error ? rejection.reason : new Error(String(rejection.reason)),
        );
      }
      finished = true;
      wake();
      return Promise.resolve(undefined);
    },
  };

  return {
    query(params: ClaudeQueryParams): ClaudeQueryHandle {
      calls.push(params);
      void (async () => {
        for await (const message of params.prompt) prompts.push(message);
      })();
      return handle;
    },
    calls,
    prompts,
    get interruptCalls() {
      return interruptCalls;
    },
    get returnCalls() {
      return returnCalls;
    },
    push(message: ClaudeQueryMessage): void {
      pending.push(message);
      wake();
    },
    end(): void {
      finished = true;
      wake();
    },
    fail(reason: unknown): void {
      failure = { reason };
      wake();
    },
    failNextInterrupt(reason: unknown): void {
      nextInterruptFailure = { reason };
    },
    failNextReturn(reason: unknown): void {
      nextReturnFailure = { reason };
    },
  };
}
