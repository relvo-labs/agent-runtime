# Provider development

A provider adapter implements the neutral `AgentProvider` SPI. It is a trusted in-process plugin, not sandboxed code.

1. Describe real capabilities structurally. Unsupported or lossy behavior is explicit; adapters must not fake symmetry.
2. Emit only `ProviderEventInput` as ordinary acyclic data—never cycles, getters, or proxies. The runtime owns event/session/run identity, time, and sequence. Each synchronous `emit()` applies the shared JSON guard, snapshots, and validates its input before returning, so reusing or mutating an object cannot rewrite an earlier emission. Cyclic/non-plain input becomes a typed provider-contract diagnostic and is not staged as event data. Shared references remain valid when the graph is acyclic. Emission during `createSession()` or `startRun()` is allowed: Runtime stages at most the first 256 captured results in order and flushes them only after the owning start event. A deterministic tail beyond that bound is rejected with a warning diagnostic in the durable event log.
3. Resolve `ProviderRun.completion` with `ProviderRunTerminationSchema`: providers choose the outcome and typed error/reason, while Runtime captures/parses it without allowing getters or proxies to throw and stamps time. Rejection, malformed or hostile data, or an outcome impossible from the projected run state becomes one failed provider-contract outcome.
4. Keep native threads, conversations, child processes, file descriptors, and checkpoints inside `ProviderSession` and `ProviderRun`.
5. Export recovery only as the versioned `ProviderRecoveryRecord` with JSON-safe opaque data.
6. Interrupt one run independently of session disposal when supported. Declare `unsupported` when it is not.
7. Apply each correlated interaction response at most once. Raise a new interaction only while its run is `running` or `awaiting_interaction`; Runtime installs the interrupt fence before awaiting provider work, so a request emitted during interruption or after termination is rejected with a diagnostic.
8. Make `ProviderSession.dispose()` idempotent and safe to retry after rejection; Runtime does not declare a session closed until provider disposal and workspace release both succeed.
9. Consume a workspace lease root; never acquire, release, reset, or delete it.
10. Use structured APIs. PTYs, terminal scraping, and ANSI parsing do not belong in core or the SPI.

Two adapters are live, and they illustrate the two shapes a third-party boundary can take.

The Claude package drives the official Claude Agent SDK's structured `query()` API through a typed injection seam. An adapter that depends on a non-permissively licensed SDK declares it as an optional peer dependency and resolves it at runtime, so the published runtime closure stays permissive and the download stays opt-in.

The Codex package speaks the official Codex app-server protocol directly over stdio JSONL. It has **no** Codex dependency: the wire types are hand-authored against a pinned upstream release, and the host supplies the executable. Because it really does spawn a child process, it carries extra structural obligations — an argv vector and never a shell command string, one module that is allowed to spawn, stdout parsed as bounded JSONL and stderr never parsed at all. `tools/repo/check-static.ts` enforces those mechanically.

Both keep the canonical gate credential-free and network-free: Claude through its seam, Codex through its transport seam plus a local stand-in server for the spawning paths a fake cannot exercise. Live provider tests still belong outside that gate, and "wire-compatible with a pinned release" must never be presented as "verified against a live model".

A provider-side execution policy is not an isolation boundary either. Codex's `sandboxMode: 'read-only'` constrains that agent's own file tools; it says nothing about MCP servers, hooks or plugins the user's configuration starts, which run with their own authority. An adapter must not derive a `workspace.writes: false` claim — or any side-effect-free claim — from a policy name it does not enforce. Declare the conservative value and say so in the descriptor.

## Structured questions

Wire `0.5` adds a second question shape: `kind: 'question_set'`, an ordered list of keyed
questions answered as one unit (ADR-0018). Both live adapters bridge a native
multi-question surface onto it — Claude's `AskUserQuestion` through `canUseTool`'s
`updatedInput`, Codex's `item/tool/requestUserInput` through its own JSON-RPC reply. Each
adapter's README carries the exact supported/refused matrix for its provider.

Four rules an adapter bridging questions must follow:

1. **Carry everything, or refuse everything.** Every native per-question fact that changes
   how a user answers — prompt, header, options, selection mode, free-text affordance,
   sensitivity — is carried. A request containing a fact the neutral shape cannot hold is
   refused **whole**, on its own native request id or callback, and raises no interaction.
   Never drop a question, never drop a field, never pre-select, never auto-answer.
2. **Keys are yours, not the provider's.** A native question id, or a question text used as
   a native answer key, is provider identity and must not reach a public DTO. Assign your
   own key, keep the mapping private, and rebuild the native answer map from it.
3. **Aggregate atomically.** One native request is one interaction and one host answer. The
   runtime proves the answer set is complete before your adapter is called; your adapter
   must still build the whole native reply in one step, so there is no code path that
   answers some questions. Validate before consuming the single settlement, so a response
   you cannot apply leaves the question answerable.
4. **Do not invent a deadline.** If a native request asks the client to auto-resolve after
   an interval, refuse it unless the contract has an expiry semantic to map it onto.
   Answering late, or answering for the user, are both fabrications.
5. **Validate the translation, not just the native request.** Parse your complete
   translated `QuestionSetRequest` through the protocol schema before retaining a callback
   or emitting an event. Native surfaces bound counts, not text lengths, so a well-formed
   native request can translate to an invalid neutral one. The runtime discards a malformed
   provider event as a diagnostic — so retaining first and validating later does not
   produce a refusal, it produces a hang: a blocking native request waiting forever on an
   interaction nobody was ever shown.
6. **Propagate withdrawal, not just retirement.** When the native surface takes a question
   back while the run continues — an aborted `AbortSignal`, a `serverRequest/resolved` for
   an unanswered request — retiring your own entry is only half of it. Emit
   `{ type: 'interaction.withdrawn', providerRef }` on the run's sink so the runtime settles
   the interaction `withdrawn` and clears its routing. Without it the run is parked in
   `awaiting_interaction` permanently and its own eventual success is recorded as a
   `provider_contract_violation`.
7. **Build native answer dictionaries safely.** A native answer map keyed by a question id
   or a question text is keyed by _arbitrary_ strings. Use `Object.fromEntries`, a
   null-prototype object or `Object.defineProperty`; `map[key] = value` silently reassigns
   the prototype for `__proto__` and serialises as `{}` — a reply that answers nothing
   while your adapter reports the batch settled.
8. **Keep each bridge independently opt-in.** A question is the model asking the _user_
   something; an approval is the model asking permission to _act_. Enabling one must never
   enable the other, and the capability descriptor must describe what is actually bridged.

Questions and answers are **untrusted and potentially sensitive**, and they are durable:
the request is committed as `interaction.requested`, the answer as `interaction.settled`,
and both are projected and replayed. Carry a native secrecy flag through as `sensitive` so
a host can mask input, but state plainly that it is display guidance and not an enforced
control — the runtime stores the answer either way. A host that must not retain a secret
refuses the interaction rather than answering it. No adapter may copy prompt, option or
answer text into a diagnostic, an `AgentError` message or a `providerCode`; classify
refusals with bounded tokens instead. The protocol holds itself to the same rule:
`checkResponseAgainstRequest` returns a bounded classification, so a rejected answer — which
the runtime records verbatim-free on a durable command receipt — never carries the value or
the unknown key that caused it.

`ProviderSession.respondToInteraction` is public SPI. The runtime validates a response
against its own copy of the request before it ever calls you, but a host holding a session
can call you directly, so apply `InteractionResponseSchema` **and**
`checkResponseAgainstRequest` against the request you retained before consuming your one
settlement. An invalid call must leave the interaction answerable by a later valid one.

## Cleanup an adapter owns before a session exists

`ProviderSession.dispose()` is the SPI's retryable cleanup handle, and it only exists once `createSession()` has resolved. An adapter that acquires a real resource _during_ the handshake — a child process, a socket — therefore has a window where a failure leaves something running that the runtime cannot reach: it never received a session, so it has nothing to dispose, and its open-session rollback can only retry what it was handed.

Tearing that resource down inside the failure path is the normal answer. The case that must not be swallowed is when the teardown _itself_ fails. `close().catch(() => undefined)` there converts a live orphaned process into silence: no error, no owner, no evidence. Instead, keep the resource on an object that outlives the rejected call — the adapter instance the host already holds — expose an attempt-all retry that reports what it released and what is still pending, and say plainly in the rejection that cleanup is outstanding. The Codex adapter does this with `releaseAbandonedConnections()` and `abandonedConnectionCount`, which are adapter-specific public API; widening the neutral SPI for it would have been a break for every out-of-tree adapter.

The same honesty applies to what "closed" means. Process exit, input-stream EOF and release of the resources a process owned are three separate facts. An adapter may end its inbound stream the moment the peer's output closes — nothing more can arrive — but it must not report cleanup complete until the things it actually spawned are gone, and it must not claim containment of descendants it cannot verify.
