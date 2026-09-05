# Architecture Foundation v0.4

Status: accepted for the pre-1.0 foundation.

## Product boundary

The SDK embeds structured agent execution in a host. The host supplies providers, workspace provisioning, storage policy, clock, and IDs. Core supplies a neutral contract, lifecycle coordination, durable command receipts, projections, and event subscriptions. Control paths are No-PTY.

Production provider adapters, control planes, schedulers, remote executors, queues, tenancy, RBAC, workflow DAGs, and product integrations are outside this foundation.

## Identity and lifecycle

| Entity      | Meaning                                                | Lifetime                                    |
| ----------- | ------------------------------------------------------ | ------------------------------------------- |
| Session     | One provider conversation bound to one workspace lease | Open through close/failure                  |
| Turn        | One caller request                                     | Accepted through completed/failed/cancelled |
| Run         | One provider attempt for one turn                      | Queued through exactly one terminal outcome |
| Interaction | One correlated provider question or approval           | Pending through exactly one settlement      |

IDs use distinct runtime-validated prefixes (`ses_`, `trn_`, `run_`, `int_`) and branded TypeScript types. Provider-native identity never appears in these DTOs.

Session transitions are `opening → ready|failed`, `ready → closing|failed`, and `closing → closed|failed`. Turn transitions are `accepted → running|cancelled|failed`, `running → running|completed|failed|cancelled`. Run transitions are `queued → starting|interrupting|failed|interrupted`, `starting → running|interrupting|failed`, `running → awaiting_interaction|interrupting|succeeded|failed`, `awaiting_interaction → running|interrupting|failed`, and `interrupting → interrupted|succeeded|failed`. Terminal states have no outgoing transitions.

At most one run is active in a session in v0.4. A run emits one `run.finished` event and records one matching termination. Interrupt ends a run; close disposes the provider session and releases its lease. Closing with active work either rejects or first terminates the work according to the command.

## Commands, receipts, and idempotency

Every mutation carries a caller-generated `commandId`. The store records the canonical payload fingerprint and first receipt. Repeating the same ID and payload returns the original result with `duplicate`; the effect is not repeated. Reusing the ID with a different payload returns `command_id_conflict`. Rejections are recorded too, so identical retries remain deterministic.

Command receipts report `applied`, `duplicate`, or `rejected`, the first acceptance time, and the highest event sequence committed by the command when applicable.

## Interactions

Question and approval requests and responses are separately discriminated. Responses must match request kind, permitted choices, selection cardinality, and approval mode. A pending interaction is settled once as responded, cancelled, expired, or withdrawn. A repeated identical command is handled by command idempotency; a new command targeting a settled interaction is stale and rejected. Run termination cancels any still-pending interaction.

## Events, replay, and backpressure

The runtime stamps event ID, session/run identity, timestamp, wire version, and a gapless 1-based per-session sequence. `fromSequence` is an exclusive durable position; zero means all history. A subscriber is attached before history is read, but retains only a constant-space published-sequence high-water mark until iteration begins and while replay is active. It drains durable events through that mark, atomically switches to bounded live buffering, emits `caught_up`, then receives live events without a gap, duplicate, or reordering. Closing the subscription or returning its iterator unregisters it idempotently, including before the first `next()` call.

Each live subscriber has a bounded buffer. Overflow is explicit and includes the first undelivered sequence, count, buffer size, timestamp, and cursor that resumes from durable storage. `signal_and_close` ends the stream; `signal_and_skip` continues after acknowledging the gap. Durable events remain in the store.

## Atomic persistence

One store commit allocates sequences, appends event envelopes, folds projections, and records command receipts against one revision. A failed mutation swaps no state. Durable implementations must preserve this atomic boundary; they may not independently update the event log and projection.

## Providers and recovery

Capabilities are structured descriptors for interrupt behavior, streaming, interactions, workspace needs, and recovery. Differences are facts, not booleans hidden by false equivalence. Runtime depends only on the neutral SPI and registers concrete adapters from the host.

Provider sessions and runs are non-serializable in-process handles. Optional recovery crosses persistence only as `{ providerId, providerVersion, wireVersion, opaque: JsonValue }`. The opaque member is interpreted only by its provider. Resume is unavailable unless explicitly described and implemented.

An in-process adapter is trusted with host privileges. Approval metadata is advisory intent for UX and audit, not a sandbox guarantee.

## Workspace ownership

An `existing` spec creates an immutable borrowed lease: runtime may neither create nor destructively clean it. A `managed` spec creates a fresh root inside the provider's configured base. Removal is allowed only for that realpath-resolved owned root, strictly below the base, never for the base or a filesystem root, and only once. Release reports every destructive operation.

Workspace-Git sends commands through an injected seam. Borrowed trees allow read-only inspection only. Managed clone failure releases the newly owned root. Credentials remain the host's concern.

## Compatibility and packaging

Wire version `0.4` is independent of npm versions. Generated schema `$id` values include the wire line. Packages are ESM-only with explicit exports and inferred declarations. tsdown is the current build implementation, not part of the public contract; ADR-0007 defines replacement constraints.

The package DAG is acyclic: protocol at L0; executor/provider/workspace at L1; provider scaffolds and workspace-git at L2; runtime at L3. Runtime may never import a concrete provider adapter.
