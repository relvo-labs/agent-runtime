# Claude provider text-run activation plan

- **Issue:** #9
- **Branch:** `feat/claude-provider-text-run`
- **Base:** `main@c2a4065c4852aaf9492ba3d5013cf0aedaed96bb`
- **Size / tier:** L / T3 — production external SDK, additive public API, streaming and cancellation lifecycle
- **Writer:** one fresh Claude Agent SDK runner session, exact `claude-opus-5` / `high`

## Outcome

Replace the explicit Claude scaffold with the first production-capable provider vertical slice: a host can compose `@relvo-labs/agent-provider-claude` with Runtime and execute a text turn over the official structured, no-PTY Claude Agent SDK API.

## Fixed boundaries

- Keep Runtime provider-neutral; only the adapter package imports the Claude SDK.
- Keep native session IDs, message IDs, query handles and provider error payloads internal.
- Use the acquired workspace root as SDK `cwd`; providers never acquire or release workspaces.
- Implement only capabilities proven by deterministic tests. Text runs, streaming, usage, tool activity, completion and cooperative interrupt are in scope. Public wire changes, interaction bridging, durable recovery, workspace-free operation, live credential tests, Codex activation and publication are not.
- Tests inject a typed query seam and never contact Anthropic. Production defaults may bind the official SDK.
- Public API changes are additive/pre-1.0 minor intent and require packed-consumer proof plus Changesets.

## Delivery slices

1. **Contract characterization:** inspect the pinned SDK types/runtime and existing provider SPI; add deterministic failing tests for factory/descriptor, text prompt translation, message/tool/usage/result mapping, provider failures, unsupported input, idempotent interrupt and dispose.
2. **Adapter implementation:** add the narrow public factory/options and internal query translator; enforce lifecycle and redaction boundaries; add the catalog-pinned SDK dependency and lockfile update.
3. **Consumer and artifact proof:** update Claude package docs/status, consumer smoke, package metadata and changeset without widening protocol DTOs or Runtime dependencies.
4. **Verification:** focused Claude/provider/runtime checks, package build/typecheck/artifact checks, then one canonical `pnpm gate`. Freeze the resulting commit for independent review.

## Acceptance evidence

- Deterministic adapter tests exercise the complete supported text-run path and hostile/failure paths without provider credentials.
- `pnpm --filter @relvo-labs/agent-provider-claude test` and typecheck pass.
- `pnpm dag:check`, `pnpm artifacts:check`, and `pnpm gate` pass.
- Fresh review is bound to exact base/head and returns no unresolved blocker; at most one consolidated blocker repair is permitted.
- Draft PR links #9 and records exact checks, exclusions, residual risks and human-only merge ownership.

## Rollback / follow-ups

Rollback is closing the unmerged PR and deleting its branch/worktree. Runtime durable recovery remains #6; workspace-free support remains #5; broader edge hardening remains #3; Codex is the next provider milestone after this Claude slice unless review evidence changes priority.
