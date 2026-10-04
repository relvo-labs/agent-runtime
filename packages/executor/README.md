# `@relvo-labs/agent-executor`

The consumer-facing execution contract and a framework-independent conformance kit.
This package depends only on `agent-protocol` and contains no executor implementation.
Use it to type a host integration or implement an alternative executor; use
[`agent-runtime`](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md)
to compose the supplied in-process implementation.

## Install

ESM-only; Node `^22.18.0 || ^24.11.0 || ^26.0.0`. No peer dependencies.
`agent-protocol` is installed as a dependency; declare it directly if you import it.

```bash
pnpm add @relvo-labs/agent-executor @relvo-labs/agent-protocol
# or
npm install @relvo-labs/agent-executor @relvo-labs/agent-protocol
```

## Quick start

A host can accept any `AgentExecutor`, including the value returned by
`createAgentRuntime`. This helper replays an existing session through `caught_up`
and releases its subscription. Supply the session ID from an open-session receipt.

```ts
import type { AgentExecutor } from '@relvo-labs/agent-executor';
import type { SessionId } from '@relvo-labs/agent-protocol';

export async function replaySession(executor: AgentExecutor, sessionId: SessionId): Promise<void> {
  const subscription = executor.subscribe({ sessionId, fromSequence: 0 });
  try {
    for await (const message of subscription) {
      if (message.type === 'event') {
        console.log(message.event.sequence, message.event.payload.type);
      }
      if (message.type === 'caught_up' || message.type === 'closed') break;
      if (message.type === 'overflow') throw new Error(`Resume from ${message.resumeCursor}`);
    }
  } finally {
    await subscription.close();
  }
}
```

For executor implementations, run each entry in `EXECUTOR_CONFORMANCE_CASES` with
a **fresh** `ConformanceHarness` and call `harness.dispose()` in `finally`.
The harness supplies a deterministic provider, unique command IDs, an existing
borrowed directory, and a `settle()` function that waits for observable work.
See the [runtime harness](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/test/runtime.test.ts).

## API overview

| Export                       | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `AgentExecutor`              | Command, projection, subscription, provider-listing and shutdown interface. |
| `EventSubscription`          | Async iterable of protocol subscription messages with explicit `close()`.   |
| `EXECUTOR_CONFORMANCE_CASES` | Executable acceptance cases with stable IDs.                                |
| `conformanceCase(id)`        | Look up a case; throws `ConformanceFailure` for an unknown ID.              |
| `ConformanceFailure`         | Assertion failure reported by the kit.                                      |
| `ConformanceCase`            | Case ID, title, acceptance IDs and `run(harness)` signature.                |
| `ConformanceHarness`         | Executor and deterministic setup, settlement and disposal hooks.            |

`AgentExecutor` methods are `openSession`, `submitTurn`, `interruptRun`,
`respondToInteraction`, `closeSession`, `dispatch`, `getSession`, `readEvents`,
`listProviders`, `subscribe` and `shutdown`. All mutations return command receipts;
run completion arrives through events and projections, not a streaming mutation call.
The only additional export path is `/package.json` for package metadata.

## Contract and limits

- Commands carry a caller-generated `commandId`. Exact successful retries return
  the original result as `duplicate`; exact rejected retries replay the rejected
  receipt. Changed payload under the same ID is `command_id_conflict`.
- Interrupt ends one run; close releases a session's provider and workspace.
  Shutdown stops mutation admission and retries failed cleanup on a later call.
- `fromSequence` is exclusive; zero requests all history. Subscriptions carry
  `event`, `caught_up`, `overflow` and `closed` messages. Handle the message union
  and use the overflow cursor to resume from stored history.
- This interface and its tests do not provide storage, crash recovery, a network
  transport or distributed locking. The supplied runtime is process-local and
  offers no crash-durable or exactly-once effect guarantee.
- The executor kit tests an executor. It is not a provider-adapter or persistent
  store conformance suite.

## Related packages and reading

- [Protocol](https://github.com/relvo-labs/agent-runtime/blob/main/packages/protocol/README.md): commands, receipts and subscription messages.
- [Runtime quick start](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md): concrete composition and cleanup.
- [Reference app](https://github.com/relvo-labs/agent-runtime/blob/main/examples/reference-app/README.md): HTTP/SSE host integration.
- [Command receipts and idempotency (ADR-0002)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0002-command-receipts-and-idempotency.md) and [foundation architecture](https://github.com/relvo-labs/agent-runtime/blob/main/docs/architecture/foundation-v0.4.md).

Pre-1.0; see [versioning](https://github.com/relvo-labs/agent-runtime/blob/main/docs/versioning.md).
