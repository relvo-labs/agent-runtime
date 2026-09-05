---
name: runtime-lifecycle-coordination
description: Coordinate in-process command idempotency, provider side effects, run supervision, session cleanup, shutdown, and replay-live lifecycle boundaries.
version: 1.0.0
stability: stable
tags: [runtime, lifecycle, idempotency, concurrency, cleanup]
---

# Runtime lifecycle coordination

## Trigger

Use this skill when a change touches any of:

- `packages/runtime/src/` or its lifecycle/concurrency tests
- command receipt reservation, duplicate/conflict behavior, or transient store failures
- provider session/run activation, event staging, supervision, interrupt, close, or shutdown
- replay-then-live subscription coordination or bounded in-process buffers

## Counter-trigger

Do not use this skill when:

- changing wire DTO shapes or state tables — use `runtime-contract-evolution`
- implementing a provider adapter — use `provider-adapter-development`
- changing lease acquisition/removal mechanics — use `workspace-lifecycle`
- changing package dependencies or the monorepo graph — use `package-architecture`

## Owns

- `packages/runtime/src` — runtime composition, store, projection, subscriptions, and lifecycle coordination
- `packages/runtime/test` — deterministic runtime lifecycle and adversarial regressions
- `docs/adr/ADR-0002-command-receipts-and-idempotency.md` — command identity and receipt semantics
- `docs/adr/ADR-0005-run-cancel-close-dispose.md` — cancellation and cleanup ordering
- `docs/adr/ADR-0016-provider-event-activation.md` — synchronous event capture and activation

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/provider/src` — owned by `provider-adapter-development`
- `packages/workspace/src` — owned by `workspace-lifecycle`
- `tools/repo/check-dag.ts` — owned by `package-architecture`

## Relationships

- `boundary-with` → `runtime-contract-evolution` — the protocol defines legal states and receipts; runtime coordination makes those transitions atomic and replayable.
- `boundary-with` → `provider-adapter-development` — adapters provide effects and callbacks; runtime owns activation, normalization, and settlement ordering.
- `boundary-with` → `workspace-lifecycle` — workspace code owns lease safety; runtime owns when acquisition and cleanup occur relative to session state.
- `boundary-with` → `package-architecture` — package architecture owns dependency direction; this skill owns behavior inside the runtime package.
- `escalates-to` → `public-api-evolution` — any exported runtime behavior or type change needs consumer and compatibility classification.
- `depends-on` → `local-ci-parity` — lifecycle fault and race tests must run in the canonical gate.

## Procedure

1. Write a deterministic failing test with controlled promises and an injected store/provider. Avoid timers for ordering assertions.
2. Reserve a validated command ID and canonical fingerprint before the first external effect. On a transient persistence failure, retain a bounded in-memory logical operation so exact retry finishes it without reissuing the effect; changed payload returns `command_id_conflict`.
3. Fence state synchronously before awaiting provider callbacks. Provider ingress must consult the fence, capture hostile values without throwing, and emit a typed `provider_contract_violation` diagnostic or terminal failure.
4. Commit owning start/settlement events and receipts atomically. Activate bounded staged events only after their owner event commits; preserve emission order and explicit overflow diagnostics.
5. On close/shutdown, attempt all required cleanup phases, retain truthful retry state after failure, and never publish success while cleanup remains incomplete. Clear retained commands, sinks, supervision, routing, and fences only after terminal cleanup succeeds.
6. Document the in-process boundary: reservations survive transient store errors in one runtime instance but are not crash-durable. A durable store must transact command reservation, events, projection, and receipt with its own recovery record.

Failure-mode checklist:

- same ID/same payload, same ID/changed payload, and competing interaction settlements
- provider effect succeeds but commit rejects, then exact retry and shutdown
- interaction arrives while interrupt is awaiting the provider
- completion/event contains cycles, accessors, proxies, or malformed discriminants
- close/dispose/release fail separately and together, then retry
- replay/live activation, overflow, terminal subscription, and coordination-map cleanup

## Verification

```bash
pnpm --filter @relvo-labs/agent-runtime test
pnpm --filter @relvo-labs/agent-runtime typecheck
pnpm --filter @relvo-labs/agent-executor test
pnpm skills:check
pnpm gate
```

## Provenance

- Source: independent — authored for this repository against the official Node.js event-loop and asynchronous-flow documentation, npm package lifecycle guidance, and the repository runtime/event/idempotency ADRs named above; no external prose was incorporated.
