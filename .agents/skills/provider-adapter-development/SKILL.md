---
name: provider-adapter-development
description: Implement or change an AgentProvider against the neutral SPI, including capability descriptors, run handles, interaction settlement and the in-process trust boundary.
version: 1.0.0
stability: stable
tags: [spi, provider, capabilities, trust-boundary]
---

# Provider adapter development

## Trigger

Use this skill when a change touches any of:

- `packages/provider/src/` — the provider SPI itself
- an implementation of `AgentProvider`, `ProviderSession` or `ProviderRun`
- a `ProviderDescriptor` / capability descriptor
- how a provider reports interactions, interrupts, usage or termination

## Counter-trigger

Do not use this skill when:

- you are changing the _shape_ of an event or interaction DTO — use
  `runtime-contract-evolution`
- you are changing how the Runtime composes providers or the registry — use
  `package-architecture`
- the work is workspace acquisition or cleanup — use `workspace-lifecycle`
- you are adding a production Codex or Claude adapter — **out of scope for the
  foundation**; open an issue instead

## Owns

- `packages/provider/src` — the neutral provider SPI and its conformance kit
- `docs/adr/ADR-0009-provider-trust-boundary.md` — the in-process trust statement
- `docs/adr/ADR-0006-provider-handle-and-recovery-record.md` — handle vs. serialisable record

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/runtime/src` — owned by `package-architecture`
- `packages/workspace/src` — owned by `workspace-lifecycle`

## Relationships

- `boundary-with` → `runtime-contract-evolution` — that skill defines what a provider may emit; this skill defines how an adapter produces it. A provider may only emit payloads the protocol already defines.
- `boundary-with` → `package-architecture` — this skill owns the SPI contract; that skill owns who is allowed to import it.
- `boundary-with` → `workspace-lifecycle` — an adapter _consumes_ a lease root; it never acquires or releases the lease.
- `escalates-to` → `public-api-evolution` — widening the SPI is a public break for every out-of-tree adapter.

## Procedure

1. **Emit semantic input, not envelopes.** A provider produces `ProviderEventInput`:
   a semantic payload only. It must never invent `eventId`, `sequence`, `occurredAt`,
   or a provider sequence. Runtime snapshots and validates the whole input synchronously
   during each `emit()` call, so object reuse or later mutation cannot rewrite history.
   Pass ordinary acyclic data, not getters or proxies. Self/mutual cycles become a typed
   provider-contract diagnostic before staging; repeated references are valid if the graph
   is acyclic. If you need envelope identity or ordering, you are in the wrong layer.

2. **Keep native identity internal.** Provider-native conversation IDs, thread handles,
   file descriptors and checkpoints stay behind `ProviderRun` / `ProviderSession`, which
   are ordinary non-serializable objects. To persist recovery information, implement
   `exportRecoveryRecord()` and return `{ providerId, wireVersion, opaque }` where
   `opaque` is `JsonValue`. Consumers must treat `opaque` as opaque; never document its
   internals as public API.

3. **Declare capabilities as structured descriptors.** Do not add a boolean.

   ```ts
   // wrong — the boolean bag grows forever and cannot express degrees
   { supportsInterrupt: true, supportsResume: false, supportsImages: true }

   // right — a descriptor can express *how*, and can be extended compatibly
   {
     run: { interrupt: { mode: 'cooperative', deliversPartialOutput: true } },
     interaction: { approval: { modes: ['once', 'session'] }, question: { choices: true } },
   }
   ```

   If a provider cannot express something, say so in the descriptor. Do not invent false
   symmetry by faking a capability the provider lacks.

4. **Separate interrupt from dispose.**
   - `ProviderRun.interrupt(reason)` ends **one run**. The session survives and must
     still accept a new run.
   - `ProviderSession.dispose()` releases provider resources. It must be idempotent,
     remain safe to retry after rejection, and must not be used to cancel a run.
     A provider that can only kill the whole session declares
     `run.interrupt.mode = 'unsupported'` rather than silently disposing.

5. **Settle every interaction exactly once.** When the Runtime calls
   `respondToInteraction`, the provider must either apply the response or reject it with
   a typed error. Re-delivering the same `interactionId` must be a no-op, not a second
   application.

   Emit a new interaction only while its run is `running` or
   `awaiting_interaction`. Once interruption begins, a late request is a provider-contract
   violation recorded as a diagnostic; it cannot create routing state or resume the run.

   Do not report success while a run is awaiting an interaction. Runtime validates
   completion against the pre-settlement run state, records explicit interaction
   settlements, and only then records the terminal run event.

6. **Respect the trust boundary.** An in-process provider is a **trusted plugin**. It runs
   with full process privileges. Do not write code, docs or permission prompts implying
   the Runtime sandboxes it, restricts its filesystem access, or can enforce a policy
   against it. Permission descriptors express _provider-declared intent_ for UX, not an
   enforced security control. See `docs/adr/ADR-0009-provider-trust-boundary.md`.

7. **No PTY.** Control paths are structured. Do not add terminal scraping, ANSI parsing
   or pseudo-terminal emulation to core or the SPI.

## Verification

```bash
pnpm --filter @relvo-labs/agent-provider test
pnpm --filter @relvo-labs/agent-runtime test   # SPI conformance runs against the runtime
pnpm dag:check
pnpm gate
```

A new provider implementation must pass the shared conformance suite exported from
`@relvo-labs/agent-provider/testing` without modifying the suite. If the suite must
change to accommodate a provider, the SPI is under-specified — fix the SPI.

Runtime cleanup tests inject disposal rejection and require a later identical close attempt
to retry safely. An adapter that treats a rejected `dispose()` call as permanently consumed
does not satisfy the SPI.

## Provenance

- Source: independent — authored for this repository.
- Reviewed-not-copied: `mindfold-ai/Trellis@88f4834449da9b4f607ec05e322408a0aa66f2ce`
  (repository/skill license ambiguity) — reviewed for agent lifecycle vocabulary only; no
  text or structure incorporated.
