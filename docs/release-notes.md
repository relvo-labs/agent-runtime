# Release notes

`.changeset/config.json` sets `changelog: false`, so `changeset version` bumps versions
without generating per-package `CHANGELOG.md` files. This file is where the information
those consumed changesets carried is kept instead, so that a reviewer approving a
publication — and a reader asking what a version contains — is not reading a diff.

Notes are written when a version is **prepared**. A version appearing here has not, by
itself, been published: publication is a separate manual dispatch described in the
[release runbook](release.md).

## 0.3.0 — prepared, not published

All eight public packages move together from `0.2.0`; `linked` keeps them in step.
`@relvo-labs/reference-app` is private, stays at `0.0.0`, and is not part of this or any
release. At the registry observation taken for this preparation, every one of the eight
served only `0.2.0` with `latest = 0.2.0`; `0.3.0` was absent. Preparation is not merge,
dispatch or publication authority, and this branch is **not dispatchable** — see the
[release runbook](release.md).

Prepared by consuming seven changesets: `structured-question-sets`,
`claude-approval-bridge`, `claude-structured-questions`, `codex-approval-bridge`,
`codex-structured-questions`, `question-validation-retirement` and
`retained-withdrawal-validation`. Because these packages are pre-1.0, a breaking change is
still a **minor** bump; the `BREAKING:` notes below are the migration record.

### Structured question sets — protocol, executor, provider, runtime (minor)

**BREAKING:** `WIRE_VERSION` moves `0.4` → `0.5`. Rebuild every package against the new
protocol and add a `case 'question_set':` to any `switch` on an interaction `kind` before
upgrading. An adapter still declaring `wireVersion: '0.4'` is refused at registration with
`provider_contract_violation` naming both versions. Generated JSON Schema `$id`s move to
`https://schemas.relvo.dev/agent-runtime/0.5/…`. See
[ADR-0018](adr/ADR-0018-structured-question-sets.md) for the decision, migration and
rollback.

`InteractionRequest` and `InteractionResponse` gain a `kind: 'question_set'` member: an
ordered list of adapter-keyed questions, answered by a record keyed by those keys rather
than by array position. The existing `kind: 'question'` form is untouched, so
single-question providers and their hosts need nothing beyond the rebuild. Each question
carries its own `header`, `choices`, `multiSelect`, `allowFreeText` and `sensitive` facts;
`key` is adapter-assigned and never a provider-native identifier. Settlement is
all-or-nothing: `checkResponseAgainstRequest` requires the answered key set to equal the
asked key set exactly, then checks type, choice membership, duplicate selections and
cardinality, before any provider is touched.

**BREAKING:** `ProviderEventPayload` gains `{ type: 'interaction.withdrawn', providerRef }`,
so a provider can withdraw a request it raised while its run continues. The runtime records
it as an `interaction.settled` event with a `withdrawn` outcome, clears routing and lets the
run leave `awaiting_interaction`; identity and time stay the runtime's. A withdrawal naming
a reference the provider did not raise, or one already retained as a logical settlement, is
ignored. `PROVIDER_EMITTABLE_EVENT_TYPES` is consequently typed
`readonly ProviderEventPayload['type'][]`; code that assigned it to an `EventType[]` must
widen.

**BREAKING:** `QuestionCapability` gains `batch`, `maxQuestions`, `freeText` and `sensitive`
(conservative defaults `false` / `null`); an exact-shape assertion on
`descriptor.interaction.question` needs updating. `checkResponseAgainstRequest` also no
longer echoes rejected values — it may name a `key` the request published and state how many
values or unknown keys were wrong, but never repeats a rejected choice value or a
caller-supplied answer key, because the runtime wraps that reason in a durable receipt.
Assertions on the old message text must be updated.

New protocol exports: `QuestionKeySchema`, `QuestionItemSchema`, `QuestionSetRequestSchema`,
`QuestionAnswerSchema`, `QuestionSetResponseSchema` and their types. New from
`@relvo-labs/agent-provider`: `canAskQuestionSet(descriptor, count)`. Runtime behaviour is
otherwise unchanged: interaction identity, settlement-once, receipt idempotency, retained
settlement after a failed store commit and terminal-run rejection all apply to a batch as
they do to a single question.

### `@relvo-labs/agent-provider-claude` — approval and question bridges (minor)

Both bridges are **opt-in and independent**, and both keep their documented fail-closed
boundaries.

`createClaudeProvider({ approvals: 'bridge' })` sets the SDK's `permissionPrompts: 'host'`
and installs `canUseTool`, raising an undecided tool call as `interaction.requested`
(`kind: 'approval'`); the call proceeds only after `{ decision: 'approved', mode: 'once' }`.
The provider then declares `interaction.approval = { supported: true, modes: ['once'],
blocking: true }`. The default is unchanged: with `approvals` unset the adapter still sends
`permissionPrompts: 'none'`, declares no approval capability, and a prompt fails closed
inside the SDK rather than parking a run — this adapter imposes no settlement deadline, so
bridging is for hosts that actually settle interactions. Everything but that one grant fails
closed and never executes the SDK callback twice; run end, interrupt, EOF, stream failure or
disposal denies outstanding prompts and retires their references. References are namespaced
per session with an adapter-generated nonce. Settlement is in-process, not crash-safe
exactly-once. The approval subject carries a sanitized tool name only, never tool input.

`createClaudeProvider({ questions: 'bridge' })` bridges the SDK's `AskUserQuestion` tool to
the neutral `question_set` interaction, so **the same run resumes at the native wait point**
once answered — not a follow-up turn and not an approval. The host answers by allowing the
call with an `updatedInput` carrying the answers map. Supported: single-select, multi-select
(labels joined with `', '`), free text as the "Other" answer sent verbatim, 1–4 questions
answered as one unit, and withdrawal via the request's `AbortSignal` — which denies the call
**and** emits `interaction.withdrawn`, so the run's own success stays a success instead of
becoming a `provider_contract_violation`. Refused whole, raising no interaction: option
`preview`, pre-filled `answers`/`annotations`, duplicate question text or option label,
counts outside the pinned 1–4 / 2–4 bounds, unknown members, and anything past the neutral
`question_set` bounds — the complete translated batch is parsed through
`QuestionSetRequestSchema` before any entry is retained. `onUserDialog` and MCP elicitation
remain unbridged and unclaimed. Do not add `AskUserQuestion` to `allowedTools`: auto-approved
calls bypass `canUseTool` and defeat the bridge.

Public surface: `ClaudeProviderOptions.questions`, `CLAUDE_QUESTION_TOOL`, and the types
`ClaudeCanUseTool`, `ClaudePermissionResult`, `ClaudeToolPermissionRequest`,
`ClaudeAskUserQuestionInput`, `ClaudeQuestion`, `ClaudeQuestionOption`. `ClaudeQueryOptions`
now declares `permissionPrompts: 'host' | 'none'` and an optional `canUseTool`; a host
binding annotated with the narrow literal must widen. `ClaudePermissionResult`'s `allow`
branch gains an optional `updatedInput`.

### `@relvo-labs/agent-provider-codex` — approval and question bridges (minor)

Both bridges are **opt-in and independent**; `extensions.bridgedServerRequests` lists only
the methods each enabled opt-in actually enables.

`createCodexProvider({ approvals: 'bridge' })` sends `thread/start` with
`approvalPolicy: 'on-request'`, raising `item/commandExecution/requestApproval` as
`interaction.requested` (`kind: 'approval'`); the command proceeds only after
`{ decision: 'approved', mode: 'once' | 'session' }`. Declared modes are `['once',
'session']`. The default is unchanged: with both bridges unset the adapter sends
`approvalPolicy: 'never'`, declares no approval capability and declines every
server-initiated request. Other pinned stable `ServerRequest` methods are declined on their
own native request id with no interaction raised. A bridged approval is refused when it
cannot be represented faithfully, does not name the active `(threadId, turnId)`, arrives
before binding or after conclusion or interruption, or exceeds the per-session bound. A
denial `reason` is not transmissible on this protocol, stated as
`extensions.approvalDenialReasonDelivered === false`.

`createCodexProvider({ questions: 'bridge' })` bridges `item/tool/requestUserInput` to the
neutral `question_set` interaction, so **the same turn resumes at the native wait point**.
Native thread, turn, item and question identifiers stay inside the adapter. Supported:
choice questions, free-text (`options: null`), `isOther` as `allowFreeText`, `isSecret` as
`sensitive`, and several questions answered as one unit. Multi-select is **not** offered:
the native question type has no field permitting several answers, and offering an unstated
capability would be a guess. Refused whole with `-32602`, raising no interaction:
`isBlocking: false`, any `autoResolutionMs`, duplicate question `id` or option `label`, an
empty or oversized batch, unknown members, and anything the neutral schema refuses; the
batch is parsed through `QuestionSetRequestSchema` before any entry is retained. Withdrawal
is bridged: a `serverRequest/resolved` for an unanswered request is the app-server
withdrawing it, so the adapter writes nothing on that native id, fences it, and emits
`interaction.withdrawn`. `initialize.params.capabilities` stays `null` — no experimental
capability is enabled. When a run ends with a batch outstanding the native request is
answered with an **empty** answer map, the only honest reply this protocol has: it answers
no question, invents nothing, and releases the server's wait.

Public surface: `CodexProviderOptions.questions`, `CODEX_BRIDGED_APPROVAL`,
`CODEX_BRIDGED_QUESTION`.

### Validation and retention fixes (patch)

`@relvo-labs/agent-protocol`, `@relvo-labs/agent-runtime` and
`@relvo-labs/agent-provider-codex` reject invalid own question-answer keys before record
parsing, including JSON-parsed `__proto__`, without changing the key grammar or valid
`constructor` / `toString` answers; missing-answer errors stay bounded for maximum-size
batches so Runtime returns a replayable `invalid_request` receipt and leaves the interaction
answerable. Correlated server-resolved Codex requests are retired in the client reply ledger
without writing a reply, with duplicate protection and the tracking bound preserved.

`@relvo-labs/agent-protocol` and `@relvo-labs/agent-runtime` retain provider question
withdrawals across transient store failures, fence competing answers, and persist the
withdrawn outcome during redelivery, completion or cleanup; retention is bounded by routed
interactions in one Runtime process and is **not crash durable**. Command schema rejections
use a stable `invalid_request` classification without copying caller-controlled keys, paths
or values into receipt errors. These are compatible implementation fixes: schemas, public
signatures and wire 0.5 are unchanged by them.

### Evidence for this line, stated as it is

Version preparation moves versions. It produces no new provider evidence and upgrades none
that the adapters already had. The
[first-release evidence policy](release.md#first-release-evidence-policy) governs whether
this line may be published at all.

| Claim                                                   | Evidence                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic gate, all eight packages                  | **Required, and established only against the exact commit under review.** Authoring versions does not produce it; a run against any other tree says nothing about this one.                       |
| Wire 0.5 and `question_set` contract                    | Deterministic Zod/JSON Schema parity evidence, including the Ajv parity corpus for the Zod-only question-key uniqueness invariant.                                                                |
| Same-run resumption of a bridged question               | Deterministic tests and protocol evidence against pinned frame shapes and scripted doubles.                                                                                                       |
| Bridged approvals and questions against a live provider | **None.** There is no verified live-provider same-run acceptance for either bridge. The canonical gate is credential-free and no gate test executes a real Codex or Claude turn.                  |
| Codex wire compatibility with 0.153.4 stable            | Deterministic tests against pinned frame shapes, plus an end-to-end suite over real pipes to a local stand-in server. Issue #15 carries authentic recorded Codex app-server interaction evidence. |
| Claude SDK integration                                  | Deterministic doubles only — the `query()` seam is exercised against scripted implementations.                                                                                                    |

Both bridges are implemented against their documented protocol surfaces; neither has been
verified against a live credentialed provider. "Implements the surface" and "verified
against the provider" are different claims, and only the first is made for the bridges this
line adds. Do not describe the bridges, or the same-run resumption behaviour, as
live-verified. This table states the evidence for the new behaviour in 0.3.0; it does not
restate or revise the evidence recorded for earlier lines. Settlement in both
adapters is process-local exactly-once, not crash-safe exactly-once. Questions, answers and
approval subjects are untrusted and durable; hosts own display, retention, access and
logging, and approval is not a Runtime sandbox guarantee.

## 0.2.0 — published, and immutable

**All eight public packages are published at 0.2.0.** A registry observation taken at
`2026-09-19T18:03:17Z` against `https://registry.npmjs.org` asked for each of the eight
package names below: every one answered HTTP 200, listed exactly one version — `0.2.0` —
and reported `latest = 0.2.0`. npm versions cannot be overwritten and unpublishing is not a
recovery plan, so each of these is public and immutable: never republish one, and never name
one in a dispatch again.

That observation establishes existence, the version list and the dist-tag, and nothing more.
It recorded a hash of each packument response body only; it did not parse per-version
integrity, shasum or tarball metadata. **Nothing here asserts that the artifacts the
registry serves match the reviewed ones** — that is a separate check this preparation did
not perform.

The first line of Foundation v0.4. All eight public packages moved together from `0.1.0`;
`linked` in the Changesets config kept them in step, and every internal dependency in the
packed tarballs resolves to `^0.2.0`. `@relvo-labs/reference-app` is private and is not part
of this or any release.

The preparation record for this line is kept below as history: it was written when 0.2.0 was
prepared and not yet published, and it is what a reader asking what 0.2.0 contains should
read.

- `@relvo-labs/agent-protocol`
- `@relvo-labs/agent-executor`
- `@relvo-labs/agent-provider`
- `@relvo-labs/agent-provider-codex`
- `@relvo-labs/agent-provider-claude`
- `@relvo-labs/agent-runtime`
- `@relvo-labs/agent-workspace`
- `@relvo-labs/agent-workspace-git`

Prepared by consuming three changesets: `foundation-runtime-v0-4`,
`codex-provider-text-run` and `claude-provider-text-run`. Because these packages are
pre-1.0, a breaking change is still a **minor** bump; the `BREAKING:` notes below are the
migration record, and the reason this line is not a patch.

### Foundation v0.4 — all eight packages (minor)

**BREAKING:** this establishes the initial pre-1.0 Architecture Foundation v0.4 contract.
Provider completion is timestamp-free and validated, workspace leases are ownership-typed,
and borrowed Git accepts only fixed query argv.

The foundation includes provider-neutral wire schemas, executor and provider contracts,
deterministic runtime behavior, safe workspace leases, explicit adapter scaffolds, and
publishability validation. Runtime preserves bounded synchronous provider emissions behind
their owning start events and coordinates command idempotency per command and session
without blocking unrelated sessions. Store views are mutation-isolated, provider emissions
are snapshotted at each call, projection replay rejects impossible transitions and
ownership, completion/interaction races settle once, and cleanup-aware shutdown coalesces
concurrent attempts while preserving retry after provider or workspace failure. Cyclic
provider/JSON-value graphs are rejected before staging while shared acyclic references
remain valid. Failed external effects reserve their command fingerprint; failed-open
rollback cleanup remains visible to exact retry and shutdown, whose internal close cannot
collide with caller command IDs. Provider completion is validated before interaction
settlement, and replay rejects terminal runs with pending interactions. Local lease cleanup
uses private authority state, while borrowed-Git validates primitive argv and executes a
detached copy immune to serialization/prototype tricks. Line-bound wire documents enforce
exact v0.4 in both Zod and JSON Schema, and the Zod/JSON Schema safety refinements have
executable parity evidence.

Transient persistence failures after submit, response, or interrupt retain one in-memory
logical effect for exact retry without repeating the provider call; validation rejections
reserve safely inspected command IDs, and an interrupt fence rejects concurrent late
interactions. Hostile completion/accessor inputs normalize without throwing. Workspace
acquisition runtime-validates specs, binds borrowed roots to the requested realpath, and
Git operations require nominal provider-issued leases. Generated schemas describe accepted
Zod input, including conditional behavior after default-filled omissions.
`validateWorkspaceLease` is asynchronous, to perform canonical path validation.

Release-blocker corrections were folded into this still-unpublished candidate line rather
than pretending the reviewed candidate was already a compatible public contract. None of
them change the set of documents Zod accepts: the `InteractionSettlement` "responded iff
response" conditional is no longer dropped when the shared sub-schema is given its stable
`$defs` name, so every published root that embeds it enforces the invariant; a git `ref`
rejects a leading `-` via a JSON-Schema-representable `pattern` instead of a Zod-only
predicate; and the local workspace provider forgets successfully released leases instead of
retaining every lease a long-lived provider ever issued, while still tracking active and
retryable ones.

This changeset includes no package publication and no live provider integration.

### `@relvo-labs/agent-provider-codex` — text-run activation (minor)

Activates the Codex adapter: `createCodexProvider()` executes text turns through the
neutral provider SPI over the official Codex app-server stdio JSONL protocol.

**BREAKING:** `CodexProviderOptions` is no longer the `JsonObject` alias it was as a
scaffold; it is now a structured options type, and `CODEX_ADAPTER_STATUS` narrows to
`'live'`. Code that assigned an arbitrary `JsonObject` to `CodexProviderOptions`, or
compared the status against `'scaffold'`, must be updated. Nothing depended on the scaffold
at runtime, because it executed nothing.

New exports: `createCodexProvider`, `CODEX_PROVIDER_ID`, `CODEX_ADAPTER_VERSION`,
`createCodexStdioTransport`, `CODEX_APP_SERVER_ARGV`, `CODEX_APP_SERVER_VERSION`,
`CODEX_DEFAULT_EXECUTABLE`, `CodexSandboxModeSchema`, `CodexSessionOptionsSchema`, the
`CodexTransport` seam types, and the `CodexProvider` / `CodexAbandonedConnectionReport`
cleanup types.

`createCodexProvider()` returns `CodexProvider`, a narrowing of `AgentProvider` that adds
`releaseAbandonedConnections()` and `abandonedConnectionCount`. This is additive — the
value is still an `AgentProvider` everywhere one is expected, and the neutral provider SPI
is unchanged. When a handshake fails _and_ tearing its connection down also fails, the
connection is retained on the provider and the rejection reports
`providerCode: 'handshake_cleanup_pending'`; `releaseAbandonedConnections()` retries every
retained connection attempt-all and reports `{ attempted, released, pending }`. Previously
that teardown failure was swallowed, which could leave a child process running with no
owner and no evidence.

Teardown is truthful about three separate facts. The inbound stream ends as soon as the
child's stdout closes, so a live process with a closed output stream can no longer hang an
admitted run. Leader exit also ends it, after a bounded `exitDrainMs` (new config field,
default 250 ms) so that a descendant holding an inherited pipe cannot keep the stream — and
every request waiting on it — open forever, while buffered final frames are still not
truncated. And `close()` reports success only after verifying that the process group the
adapter owns is empty.

Ownership evidence is tri-state, so "we could not find out" is never recorded as "nothing
is there": `ENOENT`/`ESRCH` means genuinely gone, a different owning uid means provably not
ours, and anything else — denied, unparsable, an unreadable listing — fails teardown with
`group_cleanup_unverified` and keeps retry ownership. Members are recorded as exact
`(PID, start time)` pairs while the group provably belongs to the transport, and that
identity is re-read immediately before every signal, so a reused PID is never signalled.
The remaining stat-then-kill window is documented rather than claimed away. Attribution
needs `/proc`: elsewhere there is no post-exit sweep and no descendant-containment claim at
all.

A `turn/start` whose outcome is unknown — a deadline, a connection lost mid-request, or a
success carrying an unusable turn id — fences the session: further runs are refused with
`providerCode: 'session_fenced'` until it is disposed. A lost reply is not a rejection, and
a retry could otherwise steer the first native turn or attribute it to a second Runtime
run. An authoritative server rejection is unchanged and still leaves the session usable.

Early turn traffic that arrives before the `turn/start` reply can no longer discard the
frame that ends the turn: streamed output is bounded and its loss is reported, while a
terminal frame is admitted by evicting output instead. An implausible flood of
unattributable terminal frames fails the run closed, fences the session and interrupts the
native turn rather than dropping frames silently. Server-controlled request metadata no
longer reaches durable events: an unrecognised server-initiated request method is reported
by a constant, and only methods on the pinned stable `ServerRequest` allowlist are named.

One provider session owns one app-server connection and one workspace-bound thread; each
Runtime run owns exactly one correlated turn on that thread. The conversation is not reset
per run and no process is respawned per run.

`descriptor.workspace.writes` is always `true`, including under `sandboxMode: 'read-only'`:
that policy constrains Codex's own file tools but does not isolate MCP servers, hooks or
plugins from the user's configuration. No side-effect-free behaviour is claimed, and
`descriptor.extensions.isolatesConfiguredTooling` is `false`.

Scope is deliberately narrow and matches the descriptor: text input, streamed assistant
text, per-turn token usage, and a cooperative interrupt. Tool activity, approvals,
questions, and recovery are explicitly unsupported, and every server-initiated request is
declined rather than left to stall a turn.

### `@relvo-labs/agent-provider-claude` — text-run activation (minor)

Activates the Claude adapter: `createClaudeProvider()` executes text turns through the
official Claude Agent SDK `query()` surface — streaming assistant text, tool activity,
usage and terminal outcomes into the existing provider event shapes, with cooperative,
idempotent run interrupt that leaves the session usable.

**BREAKING:** `CLAUDE_ADAPTER_STATUS` is now `'live'` instead of `'scaffold'`, and
`ClaudeProviderOptions` is a structured options object instead of an alias for
`JsonObject`; pass `{ model, maxTurns, permissionMode, allowedTools, disallowedTools,
query }` and read the status as `'live'`. Failure text also changed shape: an `AgentError`
from this adapter now carries an allowlisted classification
(`claude ended the turn without completing it (error_max_turns)`) instead of upstream error
prose, so do not match on the old message text.

Each submitted turn is stamped with a private client uuid and correlated through the SDK's
`user_message_uuid` / `user_message_uuids` fields, so a background, scheduled or already
retired turn on the shared session stream can never emit into — or complete — the run in
front of it. That holds before the session has correlated anything: an unstamped frame is
not evidence of a producer that cannot stamp, since a background turn is unstamped for the
same reason, so a host bound to a genuinely non-stamping producer declares it with
`createClaudeProvider({ correlation: 'legacy-unstamped' })`, and the declaration lapses as
soon as a stamp appears.

Interrupts coalesce into one control request and record intent before the round-trip, so a
cancellation result that arrives first is still reported as an interruption — but that
intent is provisional: a result that lands while the request is in flight closes the run to
further output and settles only once the request answers, so an interrupt that is refused,
or that reads `interrupt_receipt_v1` as "input still queued", leaves the turn's own outcome
standing instead of relabelling it. When the submitted input survived the stop and will
still run, the interrupt is reported as not applied rather than claiming an interruption
that would mislabel the turn still to come. Disposal fences new runs the moment it starts,
shares one teardown between concurrent callers, and stays retryable to success after a
rejection — including a teardown that throws synchronously rather than rejecting — without
leaving a run that can hang.

`@anthropic-ai/claude-agent-sdk` (pinned at 0.3.259) is an **optional peer dependency**:
install it in the host to use the default binding, or inject your own `ClaudeQuery`.
Without either, `createSession()` rejects with a retryable `provider_unavailable` error
naming the package. It is a peer rather than a dependency because it is published under
proprietary terms and carries a ~200 MB per-platform native payload.

Only implemented capabilities are declared. Approvals and questions are not bridged
(`permissionPrompts: 'none'` fails closed instead of hanging), non-text turn input is
rejected with `capability_unsupported`, and no recovery record is exported. An assistant
frame the SDK flagged with `error` is published as its allowlisted classification alone;
the blocks that arrived with it are the upstream error body rather than model output, so
they are not emitted as `run.message_delta`. No wire schema, protocol DTO or runtime
dependency changed.

### Evidence for this line, stated as it is

Version preparation moves versions. It produces no new provider evidence, and it does not
upgrade the evidence the adapters already had. The
[first-release evidence policy](release.md#first-release-evidence-policy) governs whether
this line may be published at all; restated here so the two do not drift:

| Claim                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic gate, all eight packages       | **Required, and established only against the exact commit under review.** The policy asks for `pnpm gate` green on Node 22/24/26, including packed-tarball install and import from a clean store and the packed reference app. Authoring the versions does not produce that evidence; it is run and read against a frozen commit, and a run against any other tree says nothing about this one. |
| Codex wire compatibility with 0.153.4 stable | Deterministic tests against pinned frame shapes, plus an end-to-end suite over real pipes to a local stand-in server. Issue #15 carries authentic recorded Codex app-server interaction evidence.                                                                                                                                                                                               |
| Codex behaviour against a live model         | **None.** No test here executes a real Codex turn, and none is permitted to.                                                                                                                                                                                                                                                                                                                    |
| Claude SDK integration                       | Deterministic doubles only — the `query()` seam is exercised against scripted implementations.                                                                                                                                                                                                                                                                                                  |
| Claude behaviour against a live model        | **None.** There is no captured live-model acceptance for this adapter anywhere in this repository.                                                                                                                                                                                                                                                                                              |

Both adapters are activated against their documented protocol surfaces; neither has been
verified against a live credentialed model. "Implements the surface" and "verified against
the provider" are different claims, and only the first is made for either adapter. Do not
describe the Claude adapter as live-model-verified.
