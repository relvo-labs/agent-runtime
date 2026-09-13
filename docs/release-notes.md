# Release notes

`.changeset/config.json` sets `changelog: false`, so `changeset version` bumps versions
without generating per-package `CHANGELOG.md` files. This file is where the information
those consumed changesets carried is kept instead, so that a reviewer approving a
publication — and a reader asking what a version contains — is not reading a diff.

Notes are written when a version is **prepared**. A version appearing here has not, by
itself, been published: publication is a separate manual dispatch described in the
[release runbook](release.md).

## 0.2.0 — prepared, not published

The first line of Foundation v0.4 prepared for publication. All eight public packages move
together from `0.1.0`; `linked` in the Changesets config keeps them in step, and every
internal dependency in the packed tarballs resolves to `^0.2.0`. `@relvo-labs/reference-app`
is private and is not part of this or any release.

Prepared is not published, and not yet approved for publication. Whether this line may be
published is decided against the [first-release evidence policy](release.md#first-release-evidence-policy)
by a person, after the canonical gate has been run against the merged commit.

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
