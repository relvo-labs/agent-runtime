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
- **Overflow.** Crossing the 256-event pre-activation bound or the 1,023-operation session bound marks history permanently incomplete instead of appending a warning diagnostic.
- **Store contract (additive).** `RuntimeStore` has an optional `contract?: RuntimeStoreContract` (`{ version: 1, level: 'baseline' | 'strong' }`). Only a declared `strong` contract lets a custom store's rejected commit be reconciled and retried. An undeclared custom store leaves that session's history permanently uncertified after any commit rejection.
