# Relvo Agent Runtime

Relvo Agent Runtime is a provider-neutral, No-PTY execution SDK for embedding coding agents in products. It gives a host application one durable command/event contract while leaving model-provider choice, workspace provisioning, and storage behind explicit interfaces.

Foundation v0.4 is an intentionally pre-1.0 base. It includes real protocol schemas, deterministic in-memory execution, bounded replay-then-live subscriptions, and guarded workspace ownership. Two live adapters execute text turns through the same neutral SPI: `@relvo-labs/agent-provider-claude` over the official Claude Agent SDK's structured `query()` API, with the SDK an optional peer dependency, and `@relvo-labs/agent-provider-codex` over the official Codex app-server stdio JSONL protocol, with no Codex dependency at all. Both are deliberately narrow — text in, streamed text out, usage, and a cooperative interrupt — and their compatibility evidence is deterministic, not live-model. This foundation does **not** include a control plane, scheduling, remote execution, queues, tenancy, RBAC, workflow DAGs, or product-specific integrations.

## What is stable enough to build on

- Distinct Session, Turn, Run, and Interaction identities and state machines.
- Caller-supplied command IDs with durable idempotent receipts.
- Runtime-stamped, gapless per-session events and atomic projections.
- Explicit subscriber overflow with a resumable durable cursor.
- Neutral provider capabilities, in-process handles, and JSON-safe recovery records.
- Borrowed workspaces that are never destructively cleaned.
- Generated JSON Schema derived from the authoritative Zod schemas.

## Packages

| Package                             | Responsibility                                                  |
| ----------------------------------- | --------------------------------------------------------------- |
| `@relvo-labs/agent-protocol`        | Zod wire schemas, inferred types, generated JSON Schema         |
| `@relvo-labs/agent-executor`        | Consumer contract and executor conformance kit                  |
| `@relvo-labs/agent-provider`        | Neutral provider SPI and deterministic test provider            |
| `@relvo-labs/agent-runtime`         | Composition root, in-memory store, lifecycle and subscriptions  |
| `@relvo-labs/agent-workspace`       | Workspace leases and guarded local implementation               |
| `@relvo-labs/agent-workspace-git`   | Git workspace boundary with an injected command seam            |
| `@relvo-labs/agent-provider-codex`  | Codex adapter over the official app-server stdio JSONL protocol |
| `@relvo-labs/agent-provider-claude` | Claude adapter over the official Claude Agent SDK query API     |

## Try it: reference app

[`examples/reference-app`](examples/reference-app/README.md) is a runnable, private (unpublished) walkthrough:
a consumer-owned Node HTTP/SSE backend and a plain browser UI over `@relvo-labs/agent-runtime`, exercising the
full open → subscribe → turn → interrupt → close → shutdown lifecycle against a credential-free scripted
provider by default, with opt-in Codex/Claude profiles. Start with its own README for setup and the exact
integration steps.

## Development

Use the repository toolchain exactly:

```bash
nvm use
pnpm install --frozen-lockfile
pnpm gate
```

Install the exact pnpm version declared by `packageManager` before running these commands;
Corepack is not required. Node `^22.18.0`, `^24.11.0`, and `^26.0.0` are supported and
exercised in CI. Node 20 and Node 27+ are not supported. Packages are not published from
this repository.

Start with [Architecture Foundation v0.4](docs/architecture/foundation-v0.4.md), then see [CONTRIBUTING.md](CONTRIBUTING.md), [provider development](docs/provider-development.md), [versioning](docs/versioning.md), and [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
