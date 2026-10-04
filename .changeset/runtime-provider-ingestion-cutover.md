---
'@relvo-labs/agent-runtime': minor
'@relvo-labs/agent-provider': minor
---

BREAKING: `AgentRuntime` has a new required method, `retryProviderIngestion(sessionId?: SessionId): Promise<void>`, so code that implements `AgentRuntime` structurally must add it (or obtain the runtime from `createAgentRuntime`). Provider adapters: only a thrown `ProviderRejection` is still a definite rejection. Any other failure of `startRun`, `respondToInteraction` or `ProviderRun.interrupt` is now an unknown outcome that only an exact command retry delivers again. Those calls must therefore be idempotent for the same `runRef`, interaction reference and run.

Provider events, command effects, run terminals, close and shutdown now go through one ordered ingestion queue per session (issue #43).

- **Faults.** A failed history commit keeps its operation for an unchanged retry. `getProviderIngestionFaults()` reports at most one entry per session: an unknown commit outcome (never resubmitted), a permanent overflow, or a retryable failure, with `error.details.fault` naming it.
- **Close and shutdown.**
  - They never wait on an unresolved provider start or response. Instead they fence the session, return a retryable error at once, and finish cleanup when it settles.
  - The workspace is released only after a confirmed provider disposal, and a retry repeats only the cleanup phases that failed.
  - A second close command ID is refused while one close is unresolved.
  - A close receipt commits only after the accepted history and the run terminal.
  - BREAKING (behaviour): they never wait on an unacknowledged store commit either. After cleanup, if `session.closed` or earlier history is still being persisted, they return a retryable `store_unavailable` with `details.pending: 'persistence'`. Call the same close (or `shutdown()`) again to confirm it; no cleanup effect is repeated. With a store whose commits settle asynchronously this can require a retry where the call used to wait.
- **Interrupts (BREAKING behaviour).** An `interrupt_run` with a new command ID now chooses its outcome when it is admitted, not when it is invoked. It mirrors the run's interrupt that is in flight, unknown or already successful while the run can still be interrupted; after a definite rejection it interrupts again; on a run already terminal it is the `delivered: false` no-op, whose receipt is persisted in queue order after the run's terminal (and can report the session's ingestion fault). While the terminal is not yet persisted, a close is in progress or the session has a fault, it returns the retryable or fault error and records nothing. To observe one interrupt's outcome, retry its exact command ID instead of issuing a new one.
- **Overflow.** Crossing the 256-event pre-activation bound or the 1,023-operation session bound marks history permanently incomplete instead of appending a warning diagnostic.
- **Store contract (additive).** `RuntimeStore` has an optional `contract?: RuntimeStoreContract` (`{ version: 1, level: 'baseline' | 'strong' }`). Only a declared `strong` contract lets a custom store's rejected commit be reconciled and retried. An undeclared custom store leaves that session's history permanently uncertified after any commit rejection.
