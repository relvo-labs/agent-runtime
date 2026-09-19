# `@relvo-labs/agent-provider-codex`

A Codex adapter for the neutral provider SPI in `@relvo-labs/agent-provider`.

It drives the official **Codex app-server** protocol over structured stdio JSONL: no PTY, no shell command string, no terminal scraping, no ANSI parsing. Provider-native identifiers — thread ids, turn ids, item ids, request ids, the child process — stay inside this package and never appear in an emitted event.

## Maturity

**Pre-1.0, and deliberately narrow.** This package went from an explicit scaffold to a live adapter in the text-run vertical slice. Read the capability table below as the complete list of what it does, not as a starting point.

Upstream labels the `codex app-server` subcommand itself `[experimental]`. This adapter uses only the **stable** (non-`--experimental`) protocol surface within it, and sends `capabilities: null` at `initialize`, which by construction cannot opt into `experimentalApi` or `requestAttestation`.

### Protocol evidence

Pinned to **codex-cli 0.153.4** — upstream `openai/codex` tree `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, release tag `rust-v0.153.4`.

The wire types in `seam.ts` are hand-authored against that release's generated stable schemas — `json-schema-stable/` and `typescript-stable/`, produced by `codex app-server generate-json-schema` / `generate-ts` without `--experimental`. **Those generated schemas are the primary evidence.** The hand-authored types and the test fixtures are derived from them and cite the exact source file at the point of use; where the two ever disagree, the schema is correct and this package has a bug.

**Codex is not an npm dependency of this package**, so nothing here adds a large platform payload or a non-permissive licence to a published runtime closure. The host supplies the executable — or its own transport.

### Evidence classification

| Claim                                       | Evidence                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire compatibility with 0.153.4 stable      | Deterministic tests against the pinned frame shapes, plus an end-to-end suite driving the real production transport over real pipes to a local stand-in server. |
| Behaviour against a live credentialed model | **None.** No test in this repository executes a real Codex turn, and none is permitted to: the gate is credential-free and network-free by policy.              |

Do not read "compatible" as "verified against a live model". Those are different claims and only the first is made here.

## Capabilities

| Capability                     | Status                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text turn input                | Supported. `text` parts only; multiple parts are joined.                                                                                                                                        |
| Streaming assistant text       | Supported, via `item/agentMessage/delta`.                                                                                                                                                       |
| Token usage                    | Supported, streamed from `thread/tokenUsage/updated` (the per-turn `last` breakdown, not the cumulative thread total).                                                                          |
| Cooperative interrupt          | Supported, via `turn/interrupt`. The session survives it.                                                                                                                                       |
| Tool activity events           | **Not supported.** The item payloads are stable in the protocol but carry commands, cwd and executor-native paths that need a redaction contract this slice does not build.                     |
| Command approvals              | **Opt-in**, via `createCodexProvider({ approvals: 'bridge' })`. One `item/commandExecution/requestApproval` becomes one neutral approval, granted only by an explicit response. Off by default. |
| Structured questions           | **Opt-in**, via `createCodexProvider({ questions: 'bridge' })`. One `item/tool/requestUserInput` becomes one neutral `question_set`, answered as a whole. Off by default. See below.            |
| Elicitation / other approvals  | **Not supported.** Declined with a JSON-RPC error on their own request id, so a blocking request cannot stall a turn. See the mapping table below.                                              |
| Recovery / resume / export     | **Not supported.**                                                                                                                                                                              |
| Images, audio, file references | **Not supported.**                                                                                                                                                                              |
| Workspace                      | Required. One thread is bound to the acquired lease root for the whole session.                                                                                                                 |
| Side-effect-free execution     | **Not claimed.** `sandboxMode` does not isolate configured MCP servers, hooks or plugins; see below.                                                                                            |

## Usage

```ts
import { createAgentRuntime } from '@relvo-labs/agent-runtime';
import { createCodexProvider } from '@relvo-labs/agent-provider-codex';

// Spawns `codex app-server --stdio` with an argv vector and no shell.
const codex = createCodexProvider({
  executable: '/opt/codex/bin/codex', // host configuration; defaults to `codex` on PATH
  sandboxMode: 'read-only',
});

const runtime = createAgentRuntime({ workspaces, providers: [codex] });
```

Inject your own connection instead — for a host-managed process, or for a deterministic test — by supplying `transport`:

```ts
import { createCodexProvider, type CodexTransport } from '@relvo-labs/agent-provider-codex';

const codex = createCodexProvider({ transport: ({ cwd }) => myTransportFor(cwd) });
```

### Execution policy — and what it does _not_ isolate

`sandboxMode` defaults to `read-only`. It is **Codex's own** execution policy, enforced by the app-server — not a sandbox this runtime imposes, and not a restriction on the in-process adapter (see `docs/adr/ADR-0009-provider-trust-boundary.md`).

> **A read-only policy is not an isolation boundary, and this adapter makes no side-effect-free claim.**
>
> It constrains Codex's own filesystem tool calls. It says nothing about the MCP servers, hooks, plugins and skills the user's Codex configuration may start. Those run with their own authority and can read, write, and reach the network regardless of `sandboxMode`. Neither this adapter nor this runtime configures, inspects, or bounds them.
>
> For that reason `descriptor.workspace.writes` is **always `true`**, including under `read-only`: a host must treat the lease root as mutable whatever policy was requested. `descriptor.extensions.isolatesConfiguredTooling` is `false`, stated explicitly so nothing is inferred from the policy name.

Choosing `workspace-write` or `danger-full-access` alongside a `cwd` also causes the app-server to mark that project trusted in the user's `config.toml`, which is a host-config mutation outside the acquired workspace. That is why the conservative value is the default.

### Approvals — the pinned mapping table

Off by default. `createCodexProvider({ approvals: 'bridge' })` turns it on, which changes exactly three things: `thread/start` sends `approvalPolicy: 'on-request'` instead of `'never'`, the descriptor declares `interaction.approval = { supported: true, modes: ['once', 'session'], blocking: true }`, and one server-initiated method is answered by a host instead of declined.

```ts
const codex = createCodexProvider({ approvals: 'bridge', sandboxMode: 'workspace-write' });
```

The command then runs only after a `{ kind: 'approval', decision: 'approved', mode: 'once' | 'session' }` response reaches `respondToInteraction`. There is no auto-approve, no allow-on-timeout and no allow-on-error path anywhere in this package.

Every `ServerRequest` method in the pinned 0.153.4 stable surface, and what this adapter does with it:

| Method                                  | Bridged    | Why                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval` | **Yes**    | Carries its own reviewable subject (`command`, `cwd`, `reason`), and `accept` / `acceptForSession` / `decline` map onto `once` / `session` / denied.                                                                                        |
| `item/fileChange/requestApproval`       | No         | `FileChangeRequestApprovalParams` names no files — the change set lives in the `itemId` item, which this adapter does not surface (`streaming.toolActivity: false`). The approval would have no reviewable subject.                         |
| `item/tool/requestUserInput`            | **Opt-in** | Bridged when `questions: 'bridge'` is set; declined with `-32601` otherwise. Its question _list_ with `isSecret` / `isOther` maps onto the neutral `question_set` added in wire 0.5 (ADR-0018). No capability opt-in is needed — see below. |
| `item/permissions/requestApproval`      | No         | The response requires a `GrantedPermissionProfile` and a `PermissionGrantScope`, and has no decline variant at all.                                                                                                                         |
| `mcpServer/elicitation/request`         | No         | An arbitrary multi-field form (`McpElicitationSchema`) with a _nullable_ `turnId`, so neither the one-question mapping nor run correlation holds.                                                                                           |
| `item/tool/call`                        | No         | Asks the client to execute a tool. Not an interaction.                                                                                                                                                                                      |
| `account/chatgptAuthTokens/refresh`     | No         | A credential operation; this adapter holds no credentials.                                                                                                                                                                                  |
| `attestation/generate`                  | No         | Requires `requestAttestation`, which is never sent.                                                                                                                                                                                         |
| `applyPatchApproval` (legacy)           | No         | Carries `conversationId` / `callId` and no `turnId`, so it cannot be bound to the active run.                                                                                                                                               |
| `execCommandApproval` (legacy)          | No         | Same: no `turnId`.                                                                                                                                                                                                                          |

A bridged command approval is **still refused**, on its own request id with `-32602`, when the request cannot be represented faithfully: `kind: 'writeStdin'` or any unknown kind, no reviewable `command`, or a proposed execpolicy / network-policy amendment or managed-network context — because the neutral response cannot carry the amendment the server is actually asking about, and answering it with a plain `accept` would discard the question. A well-formed approval that does not name the active `(threadId, turnId)`, arrives before the turn is bound, arrives after the run concluded or after interruption began, or exceeds the per-session bound, is refused with `-32600`. Nothing in either case raises an interaction.

### Structured questions

`createCodexProvider({ questions: 'bridge' })` turns one `item/tool/requestUserInput` into
one neutral `question_set` interaction on the run that owns `(threadId, turnId)`. The turn
**pauses at the native wait point** and resumes there once the host answers: the native
request is replied to with the whole `{ answers: { [questionId]: { answers } } }` map. It
is not a follow-up turn and not an approval.

| Native form                          | Bridged            | Notes                                                                                                                                                                                      |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| choice question (`options`)          | **yes**            | Single-select only — see below. The native answer is the option's `label`.                                                                                                                 |
| free-text question (`options: null`) | **yes**            | Carried as a question with no choices; the answer is a one-element array holding the typed text.                                                                                           |
| `isOther: true`                      | **yes**            | Carried as `allowFreeText: true`: choices plus typed text. The user's text is sent verbatim.                                                                                               |
| `isSecret: true`                     | **yes**            | Carried as `sensitive: true` so a host can mask input. Advisory display guidance, not an enforced control.                                                                                 |
| several questions in one request     | **yes**            | Raised as one ordered batch, answered as one unit. A partial answer is refused before any native reply is written.                                                                         |
| multi-select                         | no — not offered   | `ToolRequestUserInputQuestion` has no field permitting several answers. The reply array can hold them; the request never says they are allowed, so none is offered rather than guessed at. |
| `isBlocking: false`                  | no — refused whole | A turn that does not wait cannot be resumed by an answer, so asking a host for one would be misleading.                                                                                    |
| `autoResolutionMs` (deprecated)      | no — refused whole | It asks the client to answer _for_ the user after an interval. This adapter never fabricates an answer and imposes no settlement deadline.                                                 |
| duplicate question `id`              | no — refused whole | The native answer map is keyed by it, so duplicates cannot both be answered.                                                                                                               |
| duplicate option `label`             | no — refused whole | The native answer _is_ the label, so duplicates are an ambiguous answer.                                                                                                                   |
| cancellation / withdrawal            | n/a                | The protocol has no withdrawal for this request. Turn completion, interrupt, disposal and EOF retire it — see below.                                                                       |

A refused request is declined with `-32602` on its own native id and **raises no
interaction**; one that does not name the active turn, has no run to own it, or exceeds the
per-session bound is declined with `-32600`. The refusal diagnostic carries a bounded
reason token and no prompt, option or answer text.

**No experimental capability is enabled.** `initialize.params.capabilities` stays `null`.
The types were previously believed to be gated behind `InitializeCapabilities.experimentalApi`;
the pinned generated artifacts say otherwise, and the generated schemas win:
`typescript-stable/ServerRequest.ts` includes the `item/tool/requestUserInput` variant and
`typescript-stable/v2/ToolRequestUserInput*.ts` are byte-identical to their `--experimental`
counterparts, while genuinely experimental methods such as `thread/queue/*` appear only in
the experimental dump. Opting in would additionally widen
`CommandExecutionRequestApprovalParams` with `additionalPermissions` and
`availableDecisions` — the server strips those only for non-opted-in connections — which
the strict approval parser would refuse. So the opt-in would break a shipped feature to
gain nothing. Enabling questions also leaves `approvalPolicy` untouched: a question is the
model asking the user something, not permission to act.

When a run ends with a batch outstanding, the native request is answered with an **empty**
answer map. `ToolRequestUserInputResponse` has no decline variant, so that is the only
honest reply: it answers no question, invents nothing, and releases the server's wait.

Questions and answers are untrusted, possibly sensitive text, and a settled answer is
committed to the durable event log. A host that must not retain a secret should refuse a
request carrying `sensitive: true` rather than collect one. This adapter copies no prompt,
option or answer text into a diagnostic, an `AgentError` message or a `providerCode`.

Two limits worth stating plainly:

- **A denial reason does not reach the model.** `CommandExecutionRequestApprovalResponse` carries `decision` and nothing else, so `response.reason` is not transmissible on this protocol. The descriptor says so: `extensions.approvalDenialReasonDelivered === false`.
- **An approval is provider-declared intent, not a runtime guarantee.** The subject's `command`, `cwd`, `reason` and parsed command actions are untrusted, potentially sensitive host-visible data from another process, and the runtime neither runs the command nor can enforce that Codex runs exactly it (ADR-0009). Displaying, retaining and access-controlling that text is the host's responsibility.

Settlement is **process-local and exactly-once**: one reference settles one native callback one time. An identical redelivery is a no-op, a conflicting answer is `interaction_already_settled`, an unknown or retired reference is `unknown_interaction`, and a mode the protocol cannot encode is `capability_unsupported` _before_ the settlement is consumed, so the approval stays answerable. This is not crash-safe exactly-once. Interrupt initiation synchronously declines outstanding approvals and retires their references before awaiting acknowledgement. A failed interrupt can be retried, but approvals remain fenced for that run. Completion, failure and disposal also retire approvals; EOF or transport failure retires references even when a reply can no longer be written. Late answers cannot settle or revive the run.

The complete command-approval shape is validated against the pinned schema before admission. Missing required fields, malformed optional fields, unknown fields or command-action variants, non-null execution environments, stdin requests and policy/network context that the neutral response cannot represent are rejected. Only declared display fields of the four stable command-action variants (`read`, `listFiles`, `search`, `unknown`) are reconstructed in the subject. Native correlation and callback identifiers remain private. Mode-bearing denials and other invalid neutral responses are rejected before consuming the callback.

Native request identities are retained for the connection lifetime, including after reply and across runs. Identical and conflicting reuse both produce a diagnostic with no second interaction or reply. Retention is bounded at **4096 unique server request IDs**, separate from the **256 approvals per run** registry bound. The next unique request and any outstanding callbacks receive an explicit error, then the client fences the connection and fails the active run; no identity is evicted to admit new traffic. The host must dispose the session (retrying failed disposal) and open a new one.

### Credentials

The host owns authentication; this adapter implements no credential-management RPCs. The child inherits the host process environment, and the app-server resolves its own auth from `CODEX_HOME`/`HOME`. Diagnostics and `AgentError` publish upstream failures only as allowlisted classifications, never raw upstream error strings. Approval subjects intentionally publish command, cwd, reason and parsed action content into host-visible events; that untrusted content can contain sensitive paths, prompt text or credentials. Hosts control its display, retention and access.

## Lifecycle

| Concept   | Mapping                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session   | One app-server connection and **one** thread: `initialize` → `initialized` → a single ephemeral `thread/start` bound to the workspace root, reused by every run in the session.                            |
| run       | Exactly one `turn/start` on that thread, correlated by the `(threadId, turnId)` pair it returns, until `turn/completed`. The conversation is never reset per run, and no process is respawned per run.     |
| interrupt | `turn/interrupt`. Its `{}` reply acknowledges the _request_; the run settles on the `turn/completed` that follows, which the server marks `interrupted`. Output queued before the stop is still delivered. |
| dispose   | Close stdin, escalate SIGTERM → SIGKILL, then verify the owned process group is empty before reporting success. Idempotent, and a failed attempt keeps its retry ownership rather than reporting success.  |

A run settles exactly once, from whichever of these happens first: its own `turn/completed`, connection EOF, child exit, transport failure, disposal, or a per-request deadline. Success and interruption are never _inferred_ from EOF.

Stream end, process exit and resource cleanup are three separate facts:

- **stdout EOF** ends the inbound stream immediately, even while the process lives — it can never send another frame, so waiting is a hang rather than patience.
- **leader exit** also ends the inbound stream, after a bounded drain (`exitDrainMs`, default 250 ms) so buffered final frames are not truncated. The drain exists because a descendant that inherited the pipe can hold it open indefinitely; the leader is gone, so nothing further can legitimately arrive either way.
- **cleanup** is neither of those. `close()` reports success only once the leader has exited _and_ the process group it owned is verifiably empty.

### Descendants: what is verified, and what is not

The child is spawned into its own process group, so commands and MCP servers it starts are torn down with it. Membership is only ever recorded from evidence gathered while the group provably belonged to this transport:

| Moment                                         | Why the group id is still ours                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While the leader is alive (start of `close()`) | The leader holds its PID, so the group id cannot have been reused. Unconditional.                                                                                                |
| Synchronously as the leader is reaped          | The one ambiguous instant. Used only when the leader's own start time is known, so members that predate it are excluded — and never as the sole basis for claiming completeness. |
| During the drain                               | A process group id cannot be recycled while any member of it exists, so one living member proves the group is the same one.                                                      |

Each member is recorded as an exact `(PID, start time)` pair, and that identity is **re-read immediately before every signal**. A PID whose start time no longer matches is not signalled: the process this transport owned has exited, and the number now belongs to something else. A PID whose state cannot be read is not signalled either.

> **The residual race is real and is not claimed away.** The identity check and the signal are two separate system calls. A process that exits between them could in principle have its PID reused before the signal lands. That window cannot be closed with `process.kill`, and this adapter does not pretend otherwise — it narrows it to a single stat/kill pair and never widens it by signalling a group id or acting on a stale scan.

**Unknown is never treated as empty.** Evidence is tri-state: an `ENOENT`/`ESRCH` read means the process is genuinely gone; an entry owned by a different uid provably is not ours; anything else — denied, unparsable, or an unreadable listing — is _unknown_. Unknown evidence fails the teardown with `group_cleanup_unverified`, leaving `closed` false so a later attempt still owns it and can succeed once the evidence is readable again. A member still alive after SIGKILL fails with `process_group_did_not_exit` on the same terms.

**Portability, stated plainly.** Attribution needs `/proc`, so it is Linux-only today. Elsewhere — and when `useProcessGroup` is off — the group is still signalled as a group _while the leader is alive_, but there is **no post-exit sweep and no descendant-containment claim at all**: this adapter will not signal a PID it cannot attribute. A descendant that deliberately detaches into its own group leaves the group and is outside the guarantee on every platform.

### When a turn's fate is unknown

A `turn/start` that is _rejected_ by the server admitted nothing, so the session stays usable. A `turn/start` that simply never answers — a deadline, a connection that died mid-request, or a success whose turn id is unusable — proves nothing: the turn may be running. Since a second `turn/start` on the same thread can steer an already-active turn, admitting another run could attribute one native turn to two Runtime runs. The session is therefore **fenced**: a diagnostic is emitted, further `startRun` calls are refused with `providerCode: 'session_fenced'`, and disposal — which really does end the connection and the native work with it — is the way out.

### Connections abandoned by a failed handshake

`createSession()` returns no session when the handshake fails, so there is nothing for a caller to dispose. The adapter tears the half-open connection down itself; if that _also_ fails, the connection would be unreachable, so it is retained on the provider instead and the rejection says so (`providerCode: 'handshake_cleanup_pending'`). `provider.releaseAbandonedConnections()` retries every retained connection — attempt-all, never fail-fast — and `provider.abandonedConnectionCount` reports how many are still outstanding. Both live on the concrete `CodexProvider`; the neutral SPI is unchanged.

```ts
const provider = createCodexProvider();
// …later, or in a host's shutdown path:
if (provider.abandonedConnectionCount > 0) await provider.releaseAbandonedConnections();
```

Traffic that cannot be attributed to the active `(threadId, turnId)` pair — another thread, a background turn, a late frame after the terminal one, a duplicate terminal frame, a reply naming no pending request, or a malformed frame — is dropped with a diagnostic. None of it settles a run, and none of it is treated as a fatal error for the run that _is_ active: an unknown notification method is simply ignored, because a newer server is expected to send methods this adapter does not know.

The session also remembers the turn ids it has already settled, so a retired turn's tail is discarded on arrival rather than buffered against the next run — it could never have settled that run, but it could have crowded out the frames the run actually owns.

## Verification

```bash
pnpm --filter @relvo-labs/agent-provider-codex test
```

Credential-free and network-free. See `docs/provider-development.md` for the adapter contract.
