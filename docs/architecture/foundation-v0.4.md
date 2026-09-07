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

At most one run is active in a session in v0.4. A run emits one `run.finished` event and records one matching termination. Every pending interaction owned by the run must receive an explicit settlement before that terminal event; replay rejects the terminal event otherwise. Interrupt ends a run; close disposes the provider session and releases its lease. Closing with active work either rejects or first terminates the work according to the command. Disposal and release are both attempted once per close attempt. Either failure rejects with ordered phase diagnostics, leaves the session live in `closing`, and persists no close receipt; the same command ID and exact payload may retry. The failed attempt's fingerprint remains reserved, so changed payload is a conflict. Only successful cleanup emits `session.closed` and removes the live session.

## Commands, receipts, and idempotency

Every mutation carries a caller-generated `commandId`. The store records the canonical payload fingerprint and first receipt. Repeating the same ID and payload returns the original successful result with `duplicate`; the effect is not repeated. An identical rejected command replays the original schema-valid `rejected` receipt unchanged. Reusing the ID with a different payload returns `command_id_conflict`. Raw input without a valid command ID and known command discriminant fails with a typed validation exception rather than manufacturing false receipt identity.

Command receipts report `applied`, `duplicate`, or `rejected`, the first acceptance time, and the highest event sequence committed by the command when applicable.

One Runtime instance coordinates active work first by command ID and then by session. This makes the receipt check and effect atomic in-process, admits at most one competing interaction response, and does not serialize unrelated sessions. Entries exist only while work or waiters remain, except a provider effect followed by failed persistence retains its fingerprint, acceptance time, generated identities, and logical result until exact retry or shutdown cleanup. Retry never repeats that provider effect. Validation rejections also reserve a safely inspectable command ID against corrected reuse. Multiple Runtime processes require a host-provided single-writer boundary and durable transactional command claim before provider side effects; the in-memory coordination and attempt maps are not crash durability or distributed locking.

Shutdown closes mutation admission before draining work. Concurrent callers share one cleanup-attempt promise. Internal close does not consult caller receipts or caller-owned command IDs. Shutdown also retries retained failed-open rollback cleanup. If any live session or rollback cannot clean up, shutdown rejects without closing subscriptions or entering the fully shut-down state; a later `shutdown()` call retries cleanup while admission remains closed.

## Interactions

Question and approval requests and responses are separately discriminated. Responses must match request kind, permitted choices, selection cardinality, and approval mode. A pending interaction is settled once as responded, cancelled, expired, or withdrawn. Response commands and provider completion finalization share the per-session transition coordinator and re-check pending state inside the commit, so a completion race cannot append a second settlement. A response already delivered to the provider remains a retained logical settlement if its first store commit fails; completion materializes that response before validating the terminal outcome, and exact retry records the original applied result without redelivery. Otherwise provider termination is validated against the pre-settlement run state; cancelling an awaiting interaction cannot retroactively make provider success legal. A repeated identical command is handled by command idempotency; a new command targeting a settled interaction is stale and rejected.

## Events, replay, and backpressure

The runtime stamps event ID, session/run identity, timestamp, wire version, and a gapless 1-based per-session sequence. `fromSequence` is an exclusive durable position; zero means all history. A subscriber is attached before history is read, but retains only a constant-space published-sequence high-water mark until iteration begins and while replay is active. It drains durable events through that mark, atomically switches to bounded live buffering, emits `caught_up`, then receives live events without a gap, duplicate, or reordering. A historical terminal event is remembered during replay, followed by `closed` and immediate unregister after `caught_up`. Closing the subscription or returning its iterator unregisters it idempotently, including before the first `next()` call.

Each live subscriber has a bounded buffer. Overflow is explicit and includes the first undelivered sequence, count, buffer size, timestamp, and cursor that resumes from durable storage. `signal_and_close` ends the stream; `signal_and_skip` continues after acknowledging the gap. Durable events remain in the store.

## Atomic persistence

One store commit allocates sequences, appends event envelopes, folds projections, and records command receipts against one revision. Projection replay rejects a state event unless its declared `from` equals current state and the normative table permits the transition; terminal and interaction events must match their projected run/turn ownership and pending status. A failed mutation swaps no state, so an out-of-order event cannot rewrite a terminal projection. The in-memory store deep-clones ingress and returns isolated frozen transaction views, commit returns, snapshots, event pages, interactions, and receipt records; caller mutation cannot change committed state or revision. Durable implementations must preserve this atomic, fail-closed transition, and mutation-isolation boundary; they may not independently update the event log and projection.

## Providers and recovery

Capabilities are structured descriptors for interrupt behavior, streaming, interactions, workspace needs, and recovery. Differences are facts, not booleans hidden by false equivalence. Registration parses and deep-freezes one descriptor snapshot; listing and capability checks never call mutable `describe()` again. Runtime depends only on the neutral SPI and registers concrete adapters from the host.

Provider sessions and runs are non-serializable in-process handles. Provider completion omits runtime-owned time, is parsed before use, and becomes exactly one stamped terminal outcome. Rejection, malformed completion, or a terminal outcome impossible from the projected run state becomes a typed failed provider-contract outcome. Optional recovery crosses persistence only as `{ providerId, providerVersion, wireVersion, opaque: JsonValue }`. The opaque member is interpreted only by its provider. Resume is unavailable unless explicitly described and implemented.

Provider sinks may emit synchronously before `createSession()` or `startRun()` returns. Each `emit()` synchronously applies the shared JSON graph guard, then parses, clones, and freezes a point-in-time result; cyclic or non-plain input is captured as a typed `provider_contract_violation` diagnostic rather than staged as event data, and cannot mutate into validity later. Self-cyclic and mutually cyclic object/array graphs are rejected, while repeated references in an acyclic graph are accepted. Runtime stages the first 256 captured results in order, commits the owning start event first, then drains them before making the sink live. It records a durable warning diagnostic with the exact rejected count if the deterministic tail exceeds the staging bound. Active ingress uses the same snapshot timing. A provider interaction is accepted only for its owning run while that run is `running` or `awaiting_interaction`; a late request during interruption or after termination becomes a diagnostic and never reverses state.

An in-process adapter is trusted with host privileges. Approval metadata is advisory intent for UX and audit, not a sandbox guarantee.

## Workspace ownership

An `existing` spec creates an immutable borrowed lease: runtime may neither create nor destructively clean it. Local leases keep canonical root and ownership in private immutable state, expose frozen accessors, and never authorize release from caller-mutable fields. Runtime parses and independently cross-checks every third-party descriptor against the live lease, requested ownership, and canonical realpath requested by the caller. It never invokes release on a mismatch or redirect. Git providers additionally require nominally issued lease identity and consult only private captured root/ownership. A `managed` spec is runtime-validated before filesystem effects and creates a fresh root whose realpath is checked inside the provider's configured base. Removal is allowed only for that owned root, strictly below the base, never for the base or a filesystem root, and through one memoized in-flight operation. Concurrent calls coalesce; rejection permits a later retry, while success remains permanently idempotent. Release reports every destructive operation.

Workspace-Git sends commands through an injected seam. Borrowed trees accept only ordinary arrays of own primitive string elements exactly matching private fixed query templates and force no-pager/no-optional-lock behavior. The runner receives a detached validated copy; serialization hooks, custom prototypes, accessors, proxies, and later mutation cannot change execution. The exported documentation catalog is a deeply frozen detached snapshot and cannot widen enforcement. Output, external diff/textconv, config injection, and arbitrary options fail before execution. Managed clone failure releases the newly owned root. Credentials remain the host's concern.

## Compatibility and packaging

Wire version `0.4` is independent of npm versions. Pre-1.0 compatibility is exact by wire minor: line-bound event envelopes, sessions, snapshots, event pages, subscription events, and provider recovery records require `wireVersion: "0.4"` in both Zod and generated JSON Schema. The provider descriptor remains a separate negotiation input and is checked explicitly for compatibility at registration. Strict-object fields and closed-union members require a new minor after publication. Generated schema `$id` values include the wire line and describe accepted input, so Zod defaulted fields are optional in both Zod and Ajv. An Ajv Draft 2020-12 corpus proves safety-refinement parity for parsed JSON instances. Object identity, cycles, getters, extra array properties, and proxies exist only at the in-process JavaScript boundary; exported Zod validation rejects these without throwing while JSON Schema makes no graph-identity claim. Packages are ESM-only with explicit exports and inferred declarations. tsdown is the current build implementation, not part of the public contract; ADR-0007 defines replacement constraints.

The package DAG is acyclic: protocol at L0; executor/provider/workspace at L1; concrete provider adapters and workspace-git at L2; runtime at L3. Runtime may never import a concrete provider adapter.
