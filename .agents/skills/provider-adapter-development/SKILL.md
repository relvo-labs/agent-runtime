---
name: provider-adapter-development
description: Implement or change an AgentProvider against the neutral SPI, including capability descriptors, run handles, interaction settlement and the in-process trust boundary.
version: 1.1.0
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
- you are adding a **new** production adapter package — that is a scoped,
  reviewed milestone; open an issue first. `@relvo-labs/agent-provider-claude`
  is live and in scope for this skill; `@relvo-labs/agent-provider-codex` is
  still an explicit scaffold and must stay non-live until its own issue lands

## Owns

- `packages/provider/src` — the neutral provider SPI and its conformance kit
- `docs/adr/ADR-0009-provider-trust-boundary.md` — the in-process trust statement
- `docs/adr/ADR-0006-provider-handle-and-recovery-record.md` — handle vs. serialisable record

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/runtime/src` — owned by `runtime-lifecycle-coordination`
- `packages/workspace/src` — owned by `workspace-lifecycle`

## Relationships

- `boundary-with` → `runtime-contract-evolution` — that skill defines what a provider may emit; this skill defines how an adapter produces it. A provider may only emit payloads the protocol already defines.
- `boundary-with` → `package-architecture` — this skill owns the SPI contract; that skill owns who is allowed to import it.
- `boundary-with` → `workspace-lifecycle` — an adapter _consumes_ a lease root; it never acquires or releases the lease.
- `boundary-with` → `runtime-lifecycle-coordination` — adapters provide effects and callbacks; runtime coordination owns activation and settlement ordering.
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
   or pseudo-terminal emulation to core or the SPI. `tools/repo/check-static.ts` enforces
   this for live adapter source by matching the module specifier, not the call site, so an
   alias (`import { exec as run } from 'child_process'`) cannot slip past it.

8. **Correlate before you settle.** A long-lived provider connection carries more than the
   run in front of you: background, scheduled and already-retired turns share the same
   stream. Bind each terminal frame to the run that caused it using the provider's own
   correlation fields, and drop what you cannot attribute. Completing a run with another
   turn's result is indistinguishable from a correct completion in the event log.

9. **Publish classifications, not upstream prose.** `AgentError.message`, `providerCode`
   and diagnostic text are durable and consumer-visible. Provider error strings routinely
   contain credentials, native ids, paths and prompt text, so map them to a closed
   allowlist instead of copying them — pattern-based redaction only catches the shapes you
   already thought of. Raw text belongs in the host's own injected seam, not the log.

10. **Depend on a non-permissive SDK as an optional peer.** A published package may only
    carry permissively licensed runtime dependencies (`tools/repo/check-licenses.ts`).
    Resolve such an SDK at runtime, keep the seam types hand-authored, and fail with a
    typed `provider_unavailable` naming the package when it is absent.

## Verification

```bash
pnpm --filter @relvo-labs/agent-provider test
pnpm --filter @relvo-labs/agent-runtime test   # SPI conformance runs against the runtime
pnpm dag:check
pnpm gate
```

`@relvo-labs/agent-provider/testing` exports `createScriptedProvider` — a deterministic
double used to test the _runtime_ against the SPI. It is not a conformance suite for an
adapter, and there is no exported adapter conformance suite yet: an adapter proves itself
with its own deterministic tests that validate every emitted `ProviderEventInput` against
the protocol schema and cover the failure, interrupt, disposal and correlation paths, with
no credentials and no network. `packages/provider-claude/test` is the worked example.
Extracting the shared parts into a real exported suite is open work; do not cite one that
does not exist.

Runtime cleanup tests inject disposal rejection and require a later identical close attempt
to retry safely. An adapter that treats a rejected `dispose()` call as permanently consumed
does not satisfy the SPI.

## Provenance

- Source: independent — authored for this repository.
- Reviewed-not-copied: `mindfold-ai/Trellis@88f4834449da9b4f607ec05e322408a0aa66f2ce`
  (repository/skill license ambiguity) — reviewed for agent lifecycle vocabulary only; no
  text or structure incorporated.
