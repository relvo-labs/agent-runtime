---
name: public-api-evolution
description: Add, change or remove anything reachable from a package entry point, with a compiling consumer example and an explicit compatibility classification.
version: 1.0.0
stability: stable
tags: [public-api, semver, dts, consumer-example]
---

# Public API evolution

## Trigger

Use this skill when a change adds, renames, removes or retypes anything reachable from a
package's declared entry points — values, types, interfaces, enums, error classes, or the
shape of a returned object.

## Counter-trigger

Do not use this skill when:

- the symbol is not exported from an entry point (internal refactor — no policy applies)
- the change is only to a Zod schema's _wire_ semantics — start with
  `runtime-contract-evolution`, then return here for the TypeScript surface
- the change is to build output or the `exports` map itself — use
  `package-artifact-validation`

## Owns

- `examples/consumer-smoke` — the compiling consumer of every public entry point
- `docs/adr/ADR-0011-public-api-and-versioning.md` — compatibility classification rules

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/*/package.json#exports` — owned by `package-artifact-validation`
- `.changeset` — owned by `changesets-release`

## Relationships

- `boundary-with` → `runtime-contract-evolution` — wire compatibility is decided there; TypeScript-surface compatibility and the consumer example are decided here.
- `boundary-with` → `package-artifact-validation` — this skill decides the API; that skill proves it survives packing. A declaration that does not survive packing is not a public API, whatever the source says.
- `delegates-to` → `changesets-release` — this skill produces the classification; that skill turns it into a version bump.

## Procedure

1. **Classify before editing.** Record the class in the PR body and the changeset.

   | Change                                                     | Class        | Pre-1.0 bump |
   | ---------------------------------------------------------- | ------------ | ------------ |
   | add a new export                                           | additive     | minor        |
   | add an optional property to a returned object              | additive     | minor        |
   | add a required parameter, or a property to an _input_ type | breaking     | minor (0.x)  |
   | narrow a return type / widen a parameter type              | additive     | minor        |
   | widen a return type / narrow a parameter type              | breaking     | minor (0.x)  |
   | remove or rename an export                                 | breaking     | minor (0.x)  |
   | add a member to a union that consumers `switch` on         | breaking-ish | minor + note |

   While the packages are `0.x`, "breaking" still means a **minor** bump — but it must be
   flagged in the changeset body with a `BREAKING:` line so the changelog is honest.

2. **Two exports maps, one truth.** A symbol is public only if it is reachable from a path
   listed in `exports`. Anything else is internal even if `export`ed in source. Do not
   document internals.

3. **Write the consumer proof.** Add or extend a file under
   `examples/consumer-smoke/src/`. It must:
   - import only from package specifiers (`@relvo-labs/agent-runtime`), never a path
   - exercise the new symbol in a way that would fail to compile if the type were wrong
   - avoid `any`, `as unknown as`, and `@ts-expect-error` except when the _point_ of the
     assertion is that something must not compile

   `examples/consumer-smoke` is typechecked against the **packed tarballs**, not the
   source tree, so a symbol that is missing from the published `.d.ts` fails here.

4. **Deprecate before removing.** Mark with `/** @deprecated use X instead */`, keep for
   at least one minor, then remove in a change that says so.

5. **No type-only escape hatches at the boundary.** A public function must not accept or
   return `any`, a bare `object`, or an un-exported type. If a consumer cannot name a type
   they receive, export it.

## Verification

```bash
pnpm build
pnpm artifacts:check     # packs, installs and typechecks examples/consumer-smoke
pnpm typecheck
pnpm gate
```

`pnpm artifacts:check` runs Are The Types Wrong across the packed tarballs; a resolution
failure there (`FalseESM`, `MissingExportEquals`, masked `.d.ts`) is a release blocker,
not a warning.

## Provenance

- Source: independent — authored for this repository against the npm semver
  specification, the TypeScript "declaration files / publishing" documentation, and the
  Are The Types Wrong problem catalogue.
