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

| Capability                          | Status                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text turn input                     | Supported. `text` parts only; multiple parts are joined.                                                                                                                    |
| Streaming assistant text            | Supported, via `item/agentMessage/delta`.                                                                                                                                   |
| Token usage                         | Supported, streamed from `thread/tokenUsage/updated` (the per-turn `last` breakdown, not the cumulative thread total).                                                      |
| Cooperative interrupt               | Supported, via `turn/interrupt`. The session survives it.                                                                                                                   |
| Tool activity events                | **Not supported.** The item payloads are stable in the protocol but carry commands, cwd and executor-native paths that need a redaction contract this slice does not build. |
| Approvals / questions / elicitation | **Not supported.** Every server-initiated request is declined with a JSON-RPC error, so a blocking request cannot stall a turn.                                             |
| Recovery / resume / export          | **Not supported.**                                                                                                                                                          |
| Images, audio, file references      | **Not supported.**                                                                                                                                                          |
| Workspace                           | Required. One thread is bound to the acquired lease root for the whole session.                                                                                             |
| Side-effect-free execution          | **Not claimed.** `sandboxMode` does not isolate configured MCP servers, hooks or plugins; see below.                                                                        |

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

### Credentials

This adapter does not parse or manage credentials. The child inherits the host process
environment, and the app-server resolves its own auth from `CODEX_HOME`/`HOME`.

Adapter-generated failures are published as allowlisted classifications rather than copied from
raw upstream error strings. That protection is not a blanket redaction guarantee for durable
events: assistant text is transmitted faithfully and can repeat prompts, paths, or other sensitive
content. The host owns access control, retention, logging, downstream forwarding, and any content
redaction required for durable event history.

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
