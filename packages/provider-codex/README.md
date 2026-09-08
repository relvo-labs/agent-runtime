# `@relvo-labs/agent-provider-codex`

A Codex adapter for the neutral provider SPI in `@relvo-labs/agent-provider`.

It drives the official **Codex app-server** protocol over structured stdio JSONL: no PTY, no shell command string, no terminal scraping, no ANSI parsing. Provider-native identifiers — thread ids, turn ids, item ids, request ids, the child process — stay inside this package and never appear in an emitted event.

## Maturity

**Pre-1.0, and deliberately narrow.** This package went from an explicit scaffold to a live adapter in the text-run vertical slice. Read the capability table below as the complete list of what it does, not as a starting point.

Upstream labels the `codex app-server` subcommand itself `[experimental]`. This adapter uses only the **stable** (non-`--experimental`) protocol surface within it, and sends `capabilities: null` at `initialize`, which by construction cannot opt into `experimentalApi` or `requestAttestation`.

### Protocol evidence

Pinned to **codex-cli 0.153.4** — upstream `openai/codex` tree `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, release tag `rust-v0.153.4`.

The wire types in `seam.ts` are hand-authored against that release's generated stable schemas. **Codex is not an npm dependency of this package**, so nothing here adds a large platform payload or a non-permissive licence to a published runtime closure. The host supplies the executable — or its own transport.

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
| Workspace                           | Required. One thread is bound to the acquired lease root.                                                                                                                   |

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

### Execution policy

`sandboxMode` defaults to `read-only`. It is **Codex's own** execution policy, enforced by the app-server — not a sandbox this runtime imposes, and not a restriction on the in-process adapter (see `docs/adr/ADR-0009-provider-trust-boundary.md`).

Choosing `workspace-write` or `danger-full-access` alongside a `cwd` also causes the app-server to mark that project trusted in the user's `config.toml`, which is a host-config mutation outside the acquired workspace. That is why the conservative value is the default.

### Credentials

This adapter neither reads, manages, nor forwards credentials. The child inherits the host process environment, and the app-server resolves its own auth from `CODEX_HOME`/`HOME`. Nothing from a credential, a prompt, a path or a raw upstream error string is copied into a durable event or `AgentError`: upstream failures are published only as an allowlisted classification.

## Lifecycle

| Concept   | Mapping                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session   | One app-server connection: `initialize` → `initialized` → one ephemeral `thread/start` bound to the workspace root.                                                                                        |
| run       | One `turn/start`, correlated by the `(threadId, turnId)` pair it returns, until `turn/completed`.                                                                                                          |
| interrupt | `turn/interrupt`. Its `{}` reply acknowledges the _request_; the run settles on the `turn/completed` that follows, which the server marks `interrupted`. Output queued before the stop is still delivered. |
| dispose   | Close stdin, then escalate SIGTERM → SIGKILL, then settle. Idempotent, and a failed attempt keeps its retry ownership rather than reporting success.                                                       |

A run settles exactly once, from whichever of these happens first: its own `turn/completed`, connection EOF, child exit, transport failure, disposal, or a per-request deadline. Success and interruption are never _inferred_ from EOF.

Traffic that cannot be attributed to the active `(threadId, turnId)` pair — another thread, a background turn, a late frame after the terminal one, or a malformed frame — is dropped with a diagnostic and can never settle a run.

## Verification

```bash
pnpm --filter @relvo-labs/agent-provider-codex test
```

Credential-free and network-free. See `docs/provider-development.md` for the adapter contract.
