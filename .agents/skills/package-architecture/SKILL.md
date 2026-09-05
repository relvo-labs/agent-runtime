---
name: package-architecture
description: Add or restructure workspace packages, wire the TypeScript project graph and keep the dependency DAG acyclic with the runtime free of concrete provider adapters.
version: 1.0.0
stability: stable
tags: [monorepo, pnpm-workspace, dag, tsconfig, layering]
---

# Package architecture

## Trigger

Use this skill when a change touches any of:

- adding, removing, renaming or merging a package under `packages/`
- a `dependencies` / `devDependencies` edge between workspace packages
- `tsconfig.base.json`, `tsconfig.build.json` or a package `tsconfig.json`
- `pnpm-workspace.yaml` package globs
- `tools/repo/check-dag.ts`

## Counter-trigger

Do not use this skill when:

- you are adding a **third-party** dependency — use `pnpm-supply-chain`
- you are changing what a package _exports_ — use `public-api-evolution`
- you are changing the built output or `exports` map mechanics — use
  `package-artifact-validation`

## Owns

- `tools/repo/check-dag.ts` — mechanical layering gate
- `tools/repo/check-static.ts` — foundation scope and no-live-adapter boundary
- `tsconfig.base.json` — shared compiler options
- `tsconfig.json` — the workspace typecheck project and its `paths` map
- `pnpm-workspace.yaml#packages` — workspace globs
- `docs/adr/ADR-0010-package-dag-and-layering.md` — the layering decision record

## Does not own

- `packages/*/package.json#exports` — owned by `package-artifact-validation`
- `pnpm-workspace.yaml#catalog` — owned by `pnpm-supply-chain`
- `packages/protocol/src` — owned by `runtime-contract-evolution`
- `packages/provider/src` — owned by `provider-adapter-development`
- `packages/workspace/src` — owned by `workspace-lifecycle`
- `packages/runtime/src` — owned by `runtime-lifecycle-coordination`

## Relationships

- `boundary-with` → `pnpm-supply-chain` — this skill governs _workspace_ edges; that skill governs _third-party_ edges. Both write `package.json`; neither writes the other's dependency class.
- `boundary-with` → `package-artifact-validation` — this skill decides that a package exists and what it may depend on; that skill decides how it is built and packed.
- `boundary-with` → `provider-adapter-development` — that skill owns the SPI contract; this skill owns which packages may import it.
- `boundary-with` → `runtime-lifecycle-coordination` — this skill owns dependency direction; that skill owns runtime behavior inside the package.
- `delegates-to` → `public-api-evolution` — a new package entry point is a public surface.

## Procedure

1. **Place the package in the declared layer.** The only legal edges are:

   ```text
   L0  agent-protocol            (no workspace deps)
   L1  agent-executor            → protocol
       agent-provider            → protocol
       agent-workspace           → protocol
   L2  agent-provider-codex      → protocol, provider
       agent-provider-claude     → protocol, provider
       agent-workspace-git       → protocol, workspace
   L3  agent-runtime             → protocol, executor, provider, workspace
   ```

   `agent-runtime` must **never** depend on a concrete provider adapter. Concrete adapters
   depend on `protocol` + `provider`; composition happens in the consumer's application,
   or through `registerProvider()` at runtime.

2. **Declare every cross-package import.** An import of `@relvo-labs/agent-x` requires a
   `"@relvo-labs/agent-x": "workspace:^"` entry in that package's `dependencies`. A
   `devDependency` edge is allowed only for test-only imports and is checked separately.

3. **Never deep-import.** `import { X } from '@relvo-labs/agent-protocol'` — not
   `.../dist/foo.js`, not `.../src/foo.ts`. `check-dag.ts` rejects any specifier with more
   path segments than a declared subpath export.

4. **Register the package in three resolvers, or it will half-work.** There are no
   TypeScript project references here — typecheck resolves workspace packages to _source_
   through a `paths` map, so a check never depends on build ordering. Add the new package
   to all three:
   - `tsconfig.json` → `compilerOptions.paths`
   - `vitest.config.ts` → `resolve.alias`
   - `tools/repo/check-dag.ts` → the `LAYERS` table

   Miss the first and the typecheck falls back to a stale `dist`. Miss the third and the
   package is exempt from layering enforcement — the failure mode that matters most.

5. **New package checklist** (all required before commit):
   - `packages/<name>/package.json` with `"type": "module"`, `exports`, `files`,
     `engines`, `publishConfig.access`, `sideEffects: false`
   - `packages/<name>/tsdown.config.ts`
   - at least one real test under `packages/<name>/test/`
   - the three resolver registrations from step 4
   - a `README.md` stating the package's single responsibility

6. **Run the gate before assuming the graph is right.** Cycles frequently appear only
   after a test-only import is added.

## Verification

```bash
pnpm dag:check          # layering, cycles, undeclared edges, deep imports
pnpm typecheck          # whole-workspace tsc pass over source
pnpm build
pnpm gate
```

`pnpm dag:check` prints the resolved graph on failure. A cycle is never resolved by
adding an `import type` — extract the shared type into `agent-protocol` instead.

## Provenance

- Source: independent — authored for this repository against the pnpm workspace
  documentation and the TypeScript "Project References" handbook chapter.
- Incorporated: `module-federation/core@5727cf3298ca9b3d04306a4a6065265a131965b7` (MIT) —
  the layered-boundary check framing (explicit layer table + mechanical enforcement rather
  than review convention) was adapted from its internal package-boundary guidance.
