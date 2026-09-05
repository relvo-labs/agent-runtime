---
name: runtime-contract-evolution
description: Change Session/Turn/Run/Interaction schemas, events, commands or JSON Schema output in @relvo-labs/agent-protocol without breaking the wire contract.
version: 1.0.0
stability: stable
tags: [protocol, zod, json-schema, state-machine, wire-version]
---

# Runtime contract evolution

## Trigger

Use this skill when a change touches any of:

- a Zod schema under `packages/protocol/src/`
- the Session, Turn, Run or Interaction state tables
- the event envelope, event payload union, command union or command receipt
- `WIRE_VERSION` or a JSON Schema `$id`
- generated artefacts under `packages/protocol/schemas/`

## Counter-trigger

Do not use this skill when:

- the change is only to a package's `exports` map, build config or tarball shape —
  use `package-artifact-validation`
- the change adds a TypeScript-only helper that does not alter a schema — use
  `public-api-evolution`
- the change is a provider implementing an existing contract — use
  `provider-adapter-development`
- you are choosing a version bump for release — use `changesets-release`

## Owns

- `packages/protocol/src` — authoritative Zod schemas and inferred types
- `packages/protocol/schemas` — generated JSON Schema artefacts
- `tools/repo/generate-schemas.ts` — deterministic schema emission and drift check
- `tools/repo/schema-defs.ts` — stable `$defs` names for shared sub-schemas
- `docs/architecture/foundation-v0.4.md` — normative state tables and lifecycle rules

## Does not own

- `packages/provider/src` — owned by `provider-adapter-development`
- `packages/workspace/src` — owned by `workspace-lifecycle`
- `packages/runtime/src` — owned by `package-architecture`
- `packages/*/package.json#exports` — owned by `package-artifact-validation`

## Relationships

- `boundary-with` → `public-api-evolution` — every schema change is also a public API change; this skill decides wire compatibility, that skill decides the TypeScript surface and the consumer example.
- `boundary-with` → `provider-adapter-development` — this skill defines what a provider may emit; that skill defines how a provider produces it.
- `delegates-to` → `changesets-release` — semver classification of an accepted change.
- `depends-on` → `local-ci-parity` — the drift check must run in the canonical gate.

## Procedure

1. **Classify the change before writing code.**

   Strict objects and discriminated unions are closed. Pre-1.0 compatibility is
   exact by wire minor; old readers do not ignore unknown properties or union
   variants.

   | Change                                             | Wire class | Required before release         |
   | -------------------------------------------------- | ---------- | ------------------------------- |
   | add optional field to a strict object              | breaking   | bump `WIRE_VERSION` minor + ADR |
   | add a member to a closed discriminated union       | breaking   | bump `WIRE_VERSION` minor + ADR |
   | add required field / remove field / narrow an enum | breaking   | bump `WIRE_VERSION` minor + ADR |
   | rename a discriminant value                        | breaking   | bump `WIRE_VERSION` minor + ADR |
   | change a JSON Schema `$id`                         | breaking   | bump `WIRE_VERSION` minor + ADR |
   | implementation-only change with identical schemas  | compatible | keep the current wire minor     |

   Before the first publication of a wire line, release-blocker corrections may
   still refine that candidate line. Once a line is published, its schemas are
   immutable compatibility fixtures.

2. **Write the failing test first.** Contract invariants live in
   `packages/protocol/test/`. A lifecycle or identity change must first appear as a red
   test in `state-machine.test.ts` or `identity.test.ts`.

3. **Edit the Zod schema only.** Never hand-write the TypeScript type:

   ```ts
   export const RunStateSchema = z.enum([...]);
   export type RunState = z.infer<typeof RunStateSchema>;
   ```

   A hand-written `interface` that mirrors a schema is a defect; it will drift.

4. **Keep DTOs JSON-safe.** Wire types may contain only the recursive `JsonValue` shape.
   Native `Error`, `Date`, `Map`, `Set`, class instances, functions and provider-native
   identifiers must not appear in a schema exported from `@relvo-labs/agent-protocol`.
   Timestamps are RFC 3339 strings. Errors cross the boundary as `AgentErrorSchema`.

5. **Respect who stamps what.** The Runtime stamps `eventId`, `sessionId`, `runId`,
   `sequence` and `occurredAt`. Providers supply semantic payload only. If a change makes
   a provider responsible for identity or ordering, it is wrong — revise it.

6. **Bump `WIRE_VERSION`** in `packages/protocol/src/version.ts` for any breaking class,
   and record the reason in `docs/adr/`.

7. **Regenerate and review the schema diff:**

   ```bash
   pnpm schema:generate
   git diff --stat packages/protocol/schemas
   ```

   An unexplained diff in a file you did not intend to touch means a shared sub-schema
   moved. Stop and re-scope.

8. **Prove Zod / Draft 2020-12 parity.** Safety refinements must either use
   JSON-Schema-representable Zod constraints or carry equivalent deterministic
   conditional metadata. Add each invariant to the Ajv parity corpus; a Zod-only
   `.refine()` without JSON Schema evidence is incomplete.

## Verification

```bash
pnpm --filter @relvo-labs/agent-protocol test
pnpm schema:check      # fails if generated JSON Schema is stale or non-deterministic
pnpm typecheck
pnpm gate              # before requesting review
```

`pnpm schema:check` must be run twice in a row and produce byte-identical output; schema
emission is required to be deterministic (sorted keys, fixed `$id`, no timestamps).

## Provenance

- Source: independent — authored for this repository against the Zod 4 documentation
  (`z.toJSONSchema`), JSON Schema 2020-12, and RFC 3339.
- Reviewed-not-copied: `OpenRouterTeam/typescript-agent@e31b50e3f087abf7a05b09de14ae50749da5d827`
  (no clear repository license) — reviewed for provider-neutral event shape only.
