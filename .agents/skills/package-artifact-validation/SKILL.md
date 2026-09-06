---
name: package-artifact-validation
description: Validate what a package actually publishes by inspecting packed tarballs, exports maps, declarations, publint and Are The Types Wrong rather than trusting the source tree.
version: 1.0.0
stability: stable
tags: [packaging, exports, tarball, publint, attw, tsdown]
---

# Package artifact validation

## Trigger

Use this skill when a change touches any of:

- a package `exports`, `main`, `types`, `files`, `sideEffects` or `publishConfig` field
- `tsdown.config.ts` or build output layout
- `.npmignore` / packing behaviour
- `tools/repo/check-artifacts.ts`
- any report from `publint` or `@arethetypeswrong/cli`

## Counter-trigger

Do not use this skill when:

- you are deciding _whether_ a symbol should be public — use `public-api-evolution`
- you are adding a package or a workspace dependency edge — use `package-architecture`
- you are choosing a version number — use `changesets-release`

## Owns

- `packages/*/package.json#exports` — the `exports`, `files`, `types` and `publishConfig` fields
- `packages/*/tsdown.config.ts` — build input, output layout and declaration emission
- `tools/repo/check-artifacts.ts` — pack, inspect, install, smoke
- `docs/adr/ADR-0007-module-format-and-exports.md` — the ESM-only decision record

## Does not own

- `packages/protocol/src` — owned by `public-api-evolution` for export decisions and by `runtime-contract-evolution` for schemas
- `pnpm-workspace.yaml#packages` — owned by `package-architecture`
- `pnpm-workspace.yaml#catalog` — owned by `pnpm-supply-chain`

## Relationships

- `boundary-with` → `public-api-evolution` — that skill decides the API; this skill proves the API survives publication.
- `boundary-with` → `package-architecture` — that skill owns package existence and layering; this skill owns build and packaging mechanics.
- `boundary-with` → `local-ci-parity` — this skill defines the artifact checks; that skill guarantees they run identically in CI.

## Procedure

1. **The source tree lies. The tarball does not.** Never validate packaging by importing
   from `packages/*/src`. Always `pnpm pack`, extract, install into a scratch project and
   import by package specifier.

2. **Required `package.json` shape** for every publishable package:

   ```jsonc
   {
     "type": "module",
     "exports": {
       ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
       "./package.json": "./package.json",
     },
     "files": ["dist", "README.md", "LICENSE", "NOTICE"],
     "sideEffects": false,
     "publishConfig": { "access": "public", "provenance": true },
   }
   ```

   - `types` must be **first** in every export condition object.
   - Always export `./package.json`; tooling reads it.
   - npm provenance must stay enabled so a future public release is attributable
     to its build environment; the artifact gate rejects `false` or omission.
   - No `main`/`module`/`types` top-level fallbacks that disagree with `exports`.
   - This repository is ESM-only. Do not add a CJS condition without an ADR amendment —
     dual publishing re-introduces the dual-package hazard for our stateful registry.

3. **Every entry point needs a declaration.** `tsdown` emits `.d.ts` per entry. A subpath
   export without a matching `types` condition is invisible to `node16`/`bundler`
   resolution and will be reported by ATTW.

4. **Inspect the file list, not just the exit code:**

   ```bash
   pnpm --filter <pkg> pack --pack-destination /tmp/artifacts
   tar -tzf /tmp/artifacts/<pkg>-<v>.tgz | sort
   ```

   Reject the tarball if it contains: `src/`, `test/`, `*.tsbuildinfo`, `tsconfig*.json`,
   `*.map` you did not intend, or a missing `LICENSE`/`NOTICE`.

5. **Run the two independent linters.** They catch different classes:
   - `publint` — malformed `exports`, wrong file extensions, unresolvable paths
   - `attw --pack` — resolution-mode failures (`FalseESM`, `NoResolution`,
     `MissingExportEquals`, masked types)

   Neither may be waived by a config exclusion without an inline comment naming the
   reason and an issue link.

6. **Consumer smoke from the tarball.** `tools/repo/check-artifacts.ts` installs the packed
   tarballs into a throwaway directory with a _clean_ store and runs
   `examples/consumer-smoke`. This is what catches a missing runtime dependency that the
   workspace symlink was silently satisfying.

## Verification

```bash
pnpm build
pnpm artifacts:check
pnpm gate
```

`pnpm artifacts:check` is expected to be slow (it performs a real install). It must never
be skipped locally before requesting review, and it must never be given network access to
a registry other than the one in `.npmrc`.

## Provenance

- Source: independent — authored for this repository against the Node.js "Modules:
  Packages" documentation, the npm `package.json` reference, the publint rule list and the
  Are The Types Wrong problem catalogue.
- Incorporated: `rolldown/tsdown@f7f0cc3adb70d2589216d479a59f226869ac4b08` (MIT) — the
  entry/`exports`/declaration expectations in step 2 and the "validate the packed
  artefact" ordering follow tsdown's documented publishing guidance.
