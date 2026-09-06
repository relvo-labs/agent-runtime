# AGENTS.md

Operating contract for automated and human contributors to `relvo-labs/agent-runtime`.

## 1. Canonical skill root

`.agents/skills/` is the **only** skill root in this repository.

Do not create `.claude/skills/`, `.cursor/rules/`, `skills/`, `docs/skills/` or any other
parallel instruction root. `tools/skills/validate.ts` fails the build if a second active
root appears. If another tool needs to see these skills, symlink _into_ the tool's
expected location from outside version control — never the reverse, and never inside
`.agents/skills/` (symlinks under the skill root are a validation error).

## 2. Read before write

Before mutating any area of this repository, read the skill that owns it.

| If you are about to change…                              | Read first                       |
| -------------------------------------------------------- | -------------------------------- |
| protocol schemas, wire DTOs, JSON Schema, state machines | `runtime-contract-evolution`     |
| a provider SPI implementation or capability descriptor   | `provider-adapter-development`   |
| workspace acquisition, leases, cleanup                   | `workspace-lifecycle`            |
| runtime commands, side effects, cleanup, subscriptions   | `runtime-lifecycle-coordination` |
| package boundaries, the dependency DAG, tsconfig graph   | `package-architecture`           |
| anything exported from a package entry point             | `public-api-evolution`           |
| `exports` maps, build output, tarball contents           | `package-artifact-validation`    |
| dependencies, the lockfile, install scripts              | `pnpm-supply-chain`              |
| version intent for a published package                   | `changesets-release`             |
| CI workflows or the local gate                           | `local-ci-parity`                |

`.agents/skills/INDEX.md` is generated. Run `pnpm skills:index` after adding or editing a
skill; `pnpm skills:check` verifies it is not stale.

## 3. Toolchain

- Node: use `nvm use` (reads `.nvmrc`, currently `24.20.0`).
- Package manager: pnpm, pinned exactly by `packageManager` in the root `package.json`.
  Use that exact pnpm version; Corepack is not assumed to exist. Do not use npm or yarn
  to install this workspace's dependencies.
- Every third-party version lives in the `catalog:` block of `pnpm-workspace.yaml`.
  Packages must reference `catalog:`, never a literal range.

## 4. The gate

One command reproduces CI locally:

```bash
pnpm gate
```

CI runs the identical step list (`tools/repo/gate.ts` is the single source of truth for
both). No gate step may require provider credentials, network access to a model provider,
or a publish token.

## 5. Hard boundaries for this foundation

- `@relvo-labs/agent-runtime` must never import a concrete provider adapter. It composes
  neutral SPIs only. `pnpm dag:check` enforces this mechanically.
- Provider-native identifiers, handles and checkpoints must not appear in public DTOs.
- `existing` workspaces are **borrowed**. Nothing in this repository may delete, reset or
  otherwise destructively mutate a borrowed workspace.
- Zod schemas are authoritative. TypeScript types are inferred from them; JSON Schema is
  generated from them. Never hand-write a type or a `.json` schema that duplicates one.
- No package is published from this repository yet. There is no release workflow.

## 6. Provenance and licensing

This project is Apache-2.0. Material adapted from third-party MIT sources is attributed in
`NOTICE` and in the `## Provenance` section of the skill that carries it, always with a
pinned upstream revision. Sources with absent or ambiguous licensing are recorded as
"reviewed, not copied" and their text must not be incorporated.
