# Relvo Agent Runtime

Relvo Agent Runtime is a provider-neutral TypeScript SDK for embedding coding-agent execution in a host application through structured commands and events, without a PTY.

> [!IMPORTANT]
> This SDK is pre-1.0. The default store is in-memory and loses history on restart;
> the reference app uses a credential-free scripted provider by default. Claude and
> Codex adapters have live execution paths, but their acceptance evidence here is
> deterministic, **not live-model verification**.
> CI is configured for manual dispatch and PR `ready_for_review` events only.
> The [2026-10-05 gate run](https://github.com/relvo-labs/agent-runtime/actions/runs/37342182723)
> passed all three Node jobs; the [2026-10-06 release verification](https://github.com/relvo-labs/agent-runtime/actions/runs/37433590640/job/112169921001)
> passed the gate at base commit `957f6c4`. These results do not certify later changes.

## What it does

**Host application authors** get distinct Session, Turn, Run and Interaction identities,
command receipts, snapshots, and replay-then-live event subscriptions. Caller-supplied
command IDs make exact retries idempotent within one runtime instance. Atomic store
commits keep receipts, gapless per-session events and projections together; the default
implementation is process-local, without crash durability or distributed locking.

**Provider-adapter authors** implement a neutral SPI with explicit capability descriptors,
in-process session/run handles and JSON-safe recovery records. The host registers adapters;
the runtime never imports them. Claude uses the structured Agent SDK `query()` API with a
host-installed optional peer; Codex uses app-server stdio JSONL with a host-supplied
executable and no Codex dependency. Both support text streaming, usage and interruption,
plus independently opt-in approval and structured-question bridges. Check each adapter's
capability matrix before exposing controls to users.

**Evaluators** can run the private [reference app](examples/reference-app/README.md): a
consumer-owned Node HTTP/JSON + SSE backend and plain browser UI. It demonstrates
open → subscribe → turn → interrupt → close → shutdown, with scripted execution by
default and opt-in Claude/Codex profiles.

| Package | Responsibility |
| --- | --- |
| [`@relvo-labs/agent-protocol`](packages/protocol/README.md) | Authoritative Zod wire schemas, inferred types and generated JSON Schema |
| [`@relvo-labs/agent-executor`](packages/executor/README.md) | Consumer command/read/subscribe contract and conformance kit |
| [`@relvo-labs/agent-provider`](packages/provider/README.md) | Neutral provider SPI, capability checks and scripted test provider |
| [`@relvo-labs/agent-runtime`](packages/runtime/README.md) | Composition, in-memory store, lifecycle coordination and subscriptions |
| [`@relvo-labs/agent-workspace`](packages/workspace/README.md) | Workspace leases and guarded local directory ownership |
| [`@relvo-labs/agent-workspace-git`](packages/workspace-git/README.md) | Git provisioning through an injected command runner |
| [`@relvo-labs/agent-provider-codex`](packages/provider-codex/README.md) | Codex app-server adapter and its supported/refused capability matrix |
| [`@relvo-labs/agent-provider-claude`](packages/provider-claude/README.md) | Claude Agent SDK adapter and its supported/refused capability matrix |

The SDK supplies no control plane, scheduler, remote execution service, queue system,
tenancy, RBAC, workflow DAG engine or product-specific integrations. The reference
app's HTTP transport belongs to that example, not to a published SDK package.

## Architecture

Execution and ownership flow:

```text
Host application (owns transport, provider setup, store policy, clock and IDs)
  ↕ agent-executor contract
agent-runtime ──↔ neutral agent-provider SPI ↔ Claude / Codex / scripted provider
  ├─ RuntimeStore (in-memory by default; custom store supplied by host)
  └─ agent-workspace leases ← local provider / agent-workspace-git
```

Package dependency layers (`→` means “depends on”):

```text
L0  agent-protocol
L1  agent-executor / agent-provider / agent-workspace → protocol
L2  agent-provider-claude / agent-provider-codex → provider, protocol
    agent-workspace-git → workspace, protocol
L3  agent-runtime → executor, provider, workspace, protocol
```

The host composes concrete adapters. [ADR-0010](docs/adr/ADR-0010-package-dag-and-layering.md)
defines the acyclic DAG. In-process adapters run with host privileges; approval metadata
is advisory UX/audit intent, not a sandbox guarantee. Borrowed `existing` workspaces
are never destructively mutated by workspace acquisition or release.

## Quick start: a credential-free HTTP response

Start from a clean clone of this repository, in its root directory. Prerequisites:
Git, curl, Bash with nvm loaded, Node **24.20.0** installed in nvm (the `.nvmrc`
baseline), and **pnpm 11.25.0** on `PATH`. Corepack is not required. To provision pnpm
without Corepack, install the pinned tool in user space:

```bash
source ~/.nvm/nvm.sh
nvm use
npm install --global --prefix "$HOME/.local" pnpm@11.25.0
export PATH="$HOME/.local/bin:$PATH"
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @relvo-labs/reference-app start
```

`pnpm --version` must print `11.25.0`. Wait for:

```text
reference-app: listening on http://127.0.0.1:4173 (Ctrl-C to stop)
```

Keep that terminal running. In a second terminal, confirm the HTTP API responds:

```bash
curl -fsS -H 'x-relvo-reference-app: 1' http://127.0.0.1:4173/api/providers
```

Success is a JSON `providers` array containing `providerId: "scripted-demo"`.
The custom header is required by the example's transport. This verifies the app
and runtime are serving the scripted provider; it makes no model call.

For a visible turn, open **http://127.0.0.1:4173**, select **scripted-demo**, click
**Open session**, enter a message, then **Send turn** and **Advance script**.
The script advances only when requested: the transcript shows
“Scripted demo provider received your message.” and the run reaches `succeeded`.
To try interruption, send another turn and click **Interrupt run** before advancing.

Click **Close session**, then stop the server with **Ctrl-C** in the first terminal.
Shutdown disposes the provider and removes its managed session workspace; a cleanup
failure is reported and can be retried with another Ctrl-C. The listening port is
released after successful shutdown. See the [app guide](examples/reference-app/README.md)
for its transport, cleanup policy and opt-in real-provider setup.

### Use the packages in your app

In an external ESM application, install the runtime and siblings used by its
[credential-free package example](packages/runtime/README.md#quick-start):

```bash
npm install @relvo-labs/agent-runtime@0.5.0 @relvo-labs/agent-protocol@0.5.0 @relvo-labs/agent-provider@0.5.0 @relvo-labs/agent-workspace@0.5.0
```

All eight packages were observed at npm `latest=0.5.0` on **2026-10-06**, following
the [release run](https://github.com/relvo-labs/agent-runtime/actions/runs/37433590640).
Published versions are immutable. The checkout's wire line is `0.5`; the historical
“Foundation v0.4” architecture filename is a milestone name, not the current npm
version. See [versioning](docs/versioning.md) for compatibility rules. Older registry
statements in governance files are tracked in [#51](https://github.com/relvo-labs/agent-runtime/issues/51).

## Maturity and limitations

| Surface | Current boundary | Evidence / next work |
| --- | --- | --- |
| Storage and idempotency | In-memory reference store; restart loses history. No distributed exactly-once effects or crash resume. | [Store contract](docs/adr/ADR-0004-atomic-event-projection-store.md), [#6](https://github.com/relvo-labs/agent-runtime/issues/6), [#47](https://github.com/relvo-labs/agent-runtime/issues/47) |
| Claude / Codex | Live paths exist; evidence is deterministic. Host owns credentials and executable/optional SDK installation. Capabilities differ. | [Claude matrix](packages/provider-claude/README.md), [Codex matrix](packages/provider-codex/README.md), [provider guide](docs/provider-development.md) |
| History and ingestion | Faults fail reads/replay closed. Proven-unapplied commits can be retried; ambiguous outcomes and overflow can permanently uncertify history. | [Runtime behavior](packages/runtime/README.md#implemented-lifecycle-behavior), [landed #43](https://github.com/relvo-labs/agent-runtime/issues/43) |
| Buffering | Bounded subscriber buffers, staging and ingestion entry counts; retained provider bodies have no byte budget. | [Activation ADR](docs/adr/ADR-0016-provider-event-activation.md), [#44](https://github.com/relvo-labs/agent-runtime/issues/44) |
| Workspaces and isolation | Borrowed directories stay untouched by lease cleanup; trusted adapters have host privileges. Workspace-free capability needs reconciliation. | [Ownership ADR](docs/adr/ADR-0008-workspace-lease-ownership.md), [trust boundary](docs/adr/ADR-0009-provider-trust-boundary.md), [#5](https://github.com/relvo-labs/agent-runtime/issues/5) |
| Reference app | Private example: one session at a time, scripted by default, no interaction-response route. | [App limits](examples/reference-app/README.md#known-limits-by-design) |
| Supported runtimes | ESM-only; engines `^22.18.0 \|\| ^24.11.0 \|\| ^26.0.0`. CI representatives: 22.18.0, 24.20.0, 26.8.1. | [Manifest](package.json), [matrix](.github/workflows/gate.yml), [passed run](https://github.com/relvo-labs/agent-runtime/actions/runs/37342182723) |

`readEvents()` compares the requested session's sequence across at most three page
reads. If that session keeps changing it rejects with retryable `store_unavailable`;
other sessions' commits do not force rereads. History reads and replay reject while
an ingestion fault remains, including one raised during a read.

Close and shutdown still attempt provider disposal and workspace release while
history is blocked; release requires confirmed disposal. Unresolved provider calls
or persistence can require retry. A close receipt attests cleanup, not complete
history: an overflow fault can survive successful close. A permanently ambiguous
commit prevents confirmed close/shutdown even after cleanup effects succeed.
See the [cleanup contract](docs/adr/ADR-0005-run-cancel-close-dispose.md).

## Documentation by reader

| Reader | Start here |
| --- | --- |
| Evaluator | [Reference app](examples/reference-app/README.md), [foundation architecture](docs/architecture/foundation-v0.4.md) |
| Host integrator | [Runtime example and API](packages/runtime/README.md), [executor contract](packages/executor/README.md), [packed consumer proof](examples/consumer-smoke), [security model](SECURITY.md) |
| Provider-adapter author | [Provider development](docs/provider-development.md), [neutral SPI](packages/provider/README.md), [architecture decisions](docs/adr) |
| Contributor | [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [skill ownership index](.agents/skills/INDEX.md) |
| Release maintainer | [Versioning](docs/versioning.md), [release notes](docs/release-notes.md), [manual release runbook](docs/release.md) |

## Repository structure

```text
packages/                 eight public SDK packages
examples/reference-app/   private HTTP/SSE + browser integration walkthrough
examples/consumer-smoke/  consumer typecheck against packed public exports
docs/                     architecture, ADRs, versioning and release guidance
tools/                    canonical gate, validators and release tooling
.agents/skills/           single repository skill root
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
