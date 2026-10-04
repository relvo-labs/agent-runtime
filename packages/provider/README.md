# `@relvo-labs/agent-provider`

The neutral provider SPI: capability checks, in-process session/run handles and
deterministic test doubles. It depends on `agent-protocol`; `agent-runtime` consumes
this SPI without importing a concrete adapter. Use it when implementing an adapter
or testing runtime integration. For model execution, the host composes a
[Claude](https://github.com/relvo-labs/agent-runtime/blob/main/packages/provider-claude/README.md)
or [Codex](https://github.com/relvo-labs/agent-runtime/blob/main/packages/provider-codex/README.md)
adapter separately.

## Install

ESM-only; Node `^22.18.0 || ^24.11.0 || ^26.0.0`. No peer dependencies.
Protocol and Zod are runtime dependencies; neither needs a separate install for
this example.

```bash
pnpm add @relvo-labs/agent-provider
# or
npm install @relvo-labs/agent-provider
```

## Quick start

This deterministic double emits only when `controller.drain()` advances it. The
direct SPI example below uses the current directory as its workspace view;
in a runtime integration, the runtime supplies that view from an acquired lease.
No model, credential or network call is involved.

```ts
import { canInterruptRun } from '@relvo-labs/agent-provider';
import { createScriptedProvider } from '@relvo-labs/agent-provider/testing';

const { provider, controller } = createScriptedProvider({
  defaultScript: [{ kind: 'delta', text: 'hello' }, { kind: 'succeed' }],
});
console.log(canInterruptRun(provider.describe()));

const session = await provider.createSession({
  options: {},
  workspace: { root: process.cwd(), ownership: 'borrowed' },
  sink: { emit: (event) => console.log(event.payload.type) },
});
try {
  const run = await session.startRun({
    runRef: 'example-run-1',
    input: { parts: [{ type: 'text', text: 'hello' }] },
    sink: { emit: (event) => console.log(event.payload) },
  });
  await controller.drain();
  console.log((await run.completion).outcome); // succeeded
} finally {
  await session.dispose();
}
```

See the [runtime quick start](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md)
for command receipts, runtime-stamped events and workspace cleanup around this double.

## API overview

| Export                                                   | Purpose                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AgentProvider`                                          | `describe()`, `createSession()` and optional `resumeSession()`.                        |
| `ProviderSession`, `ProviderRun`                         | Native resource handles with run start, response, completion, interrupt and disposal.  |
| `ProviderSessionInit`, `ProviderRunRequest`              | Options/workspace/sink and turn input/run correlation supplied by the runtime.         |
| `ProviderEventSink`, `ProviderWorkspaceView`             | Synchronous semantic output and a root/ownership view without lease-release authority. |
| `ProviderRunTerminationSchema`, `ProviderRunTermination` | Timestamp-free success, failure or interruption completion.                            |
| `ProviderRecoveryRecord`                                 | Re-exported protocol type for versioned JSON-safe opaque provider state.               |
| `ProviderRejection`, `isProviderRejection`               | Definite typed effect rejection and its guard.                                         |
| `defineProviderDescriptor`                               | Parse capabilities with conservative schema defaults and current wire version.         |
| `canInterruptRun`, `interruptPreservesSession`           | Check interrupt availability and session survival.                                     |
| `canRaiseApproval`, `canAskQuestionSet`                  | Check approval mode and multi-question capability/count.                               |
| `canAcceptWorkspace`, `checkWireCompatibility`           | Check ownership acceptance and exact wire compatibility.                               |
| `CapabilityCheck`                                        | Success or a typed `AgentError`, discriminated by `ok`.                                |

The `/testing` subpath exports `createScriptedProvider`, `ScriptStep`,
`ScriptedController` and `ScriptedProviderOptions`. Scripts support deltas, tool
activity, usage, diagnostics, blocking questions/approvals, success and failure.
The controller exposes `drain`, `startedRuns`, `pendingInteractionRefs`,
`disposedSessions` and `interruptedRuns`. `/package.json` exposes metadata.

## Obligations and limits

- An in-process provider is a trusted plugin with host privileges. Capability
  descriptors express provider intent; the runtime does not sandbox the adapter.
- Emit ordinary acyclic `ProviderEventInput` data. The runtime stamps envelope
  identity, sequence and time, synchronously snapshots each emission and stages
  early output behind the owning start. Cycles/non-plain values become diagnostics;
  ingress overflow makes history permanently incomplete. Limits are specified in
  [provider development](https://github.com/relvo-labs/agent-runtime/blob/main/docs/provider-development.md).
- Native handles and identifiers stay private. Recovery `opaque` content is
  interpreted only by its provider; an exported record alone does not enable resume.
- `ProviderRejection` means the effect definitely did not apply. Other failures
  of start, response or interrupt have unknown outcomes: only exact command retry
  calls the provider again. Adapter effects must therefore be idempotent for the
  same run/interaction reference. Disposal must be retryable after rejection.
- Interrupt one run independently of disposal. Providers consume workspace roots;
  they do not acquire or release leases or treat borrowed roots as disposable.
- `/testing` is a runtime test double, not a production model provider or an
  exported adapter conformance suite. No such adapter suite is exported yet.

## Related packages and reading

- [Protocol](https://github.com/relvo-labs/agent-runtime/blob/main/packages/protocol/README.md) and [runtime](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md).
- [Provider development](https://github.com/relvo-labs/agent-runtime/blob/main/docs/provider-development.md): adapter requirements and deterministic evidence.
- [Handles and recovery (ADR-0006)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0006-provider-handle-and-recovery-record.md) and [trust boundary (ADR-0009)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0009-provider-trust-boundary.md).

Pre-1.0. The canonical gate needs no provider credentials; the concrete adapters
have deterministic evidence and no live-model acceptance evidence in this repository.
