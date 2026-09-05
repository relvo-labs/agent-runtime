---
name: local-ci-parity
description: Keep one canonical credential-free gate that runs identically on a developer machine and in GitHub Actions, with no step that only exists in one place.
version: 1.0.0
stability: stable
tags: [ci, github-actions, gate, reproducibility]
---

# Local / CI parity

## Trigger

Use this skill when a change touches any of:

- `.github/workflows/**`
- `tools/repo/gate.ts` or any script it invokes
- the `scripts` block of the root `package.json`
- the supported Node version matrix or `.nvmrc`

## Counter-trigger

Do not use this skill when:

- you are changing what a single gate step _checks_ — use that step's owning skill
  (`package-artifact-validation`, `runtime-contract-evolution`, …)
- you are changing dependency install policy — use `pnpm-supply-chain`
- you want to add a publish job — use `changesets-release` (answer: no)

## Owns

- `.github/workflows` — every hosted workflow
- `tools/repo/gate.ts` — the canonical step list
- `.nvmrc` — the baseline Node version and, with it, the supported matrix
- `docs/adr/ADR-0014-ci-and-gate-parity.md` — the parity decision record

## Does not own

- `tools/repo/check-artifacts.ts` — owned by `package-artifact-validation`
- `tools/repo/generate-schemas.ts` — owned by `runtime-contract-evolution`
- `tools/repo/check-dag.ts` — owned by `package-architecture`
- `pnpm-lock.yaml` — owned by `pnpm-supply-chain`
- `.changeset` — owned by `changesets-release`

## Relationships

- `depends-on` → `pnpm-supply-chain` — CI installs with a frozen lockfile.
- `boundary-with` → `package-artifact-validation` — that skill defines the artifact checks; this skill guarantees they run in both places.
- `boundary-with` → `changesets-release` — this skill owns workflows but may not add a publishing job.

## Procedure

1. **One step list, two callers.** `tools/repo/gate.ts` holds the ordered array of gate
   steps. `pnpm gate` runs it. CI runs the _same_ steps by id. A workflow must never
   inline a check that `gate.ts` does not know about — if CI can fail in a way a developer
   cannot reproduce with one command, that is the bug.

2. **Order steps cheapest-first** so feedback is fast: format → lint → typecheck →
   schema drift → skills → dag → test → build → artifacts.

3. **Credential-free, always.** No gate step may require:
   - a model provider API key (no live Codex/Claude calls, ever, in any test)
   - an `NPM_TOKEN` or any publish credential
   - a GitHub token beyond the default read-only `GITHUB_TOKEN`

   A test that needs a provider must use the deterministic scripted provider from
   `@relvo-labs/agent-provider/testing`.

4. **Node matrix.** Support only maintained lines. Current matrix:

   | Line    | Status          | In CI | Notes                          |
   | ------- | --------------- | ----- | ------------------------------ |
   | 22.18+  | Maintenance LTS | yes   | lower bound; oldest supported  |
   | 24.20.0 | Active LTS      | yes   | `.nvmrc` baseline, primary job |
   | 26.x    | Current         | yes   | supported, bounded to major 26 |

   Only the baseline job runs the artifact gate (it performs a real install); the other
   lines run lint/typecheck/test/build. Update this table and `engines` together.

5. **Pin actions and lock the toolchain.** Pin every action to its full immutable commit.
   Use `actions/checkout` with credential persistence disabled, then `pnpm/setup` to
   install exact pnpm 11.25.0 and the matrix runtime in one step. Enable its cache,
   require the lockfile, disable its implicit install, and run the repository's explicit
   frozen install next. Do not depend on `actions/setup-node` or Corepack: supported Node
   installations, including Node 26, need not ship Corepack. Never `npm i -g pnpm@latest`.

6. **Concurrency and permissions.** Every workflow sets `permissions: contents: read` at
   the top level and a `concurrency` group keyed on the ref, so superseded runs cancel.

7. **Do not add a step that is green because it is skipped.** If a step cannot run in an
   environment, it must fail loudly or be removed — not silently no-op. `gate.ts` prints
   an explicit `SKIP` line with a reason and exits non-zero in CI mode when a required
   step is skipped.

## Verification

```bash
pnpm gate                 # must pass locally with no network beyond the npm registry
node tools/repo/gate.ts --list   # the step list CI consumes
act -j gate               # optional, if you have `act` installed
```

After changing a workflow, confirm the step ids in the workflow match
`node tools/repo/gate.ts --list` exactly. A mismatch is a parity break.

## Provenance

- Source: independent — authored for this repository against the GitHub Actions
  documentation (`concurrency`, `permissions`, immutable action references), the
  `pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b` action contract, the pnpm CI
  guide and the Node.js release schedule.
- Incorporated: `antfu/skills@a74f281a27dadc02397bc1a174b0f2c97531b6ae` (MIT) — the
  single-canonical-gate framing and the cheapest-first step ordering were adapted from its
  CI skill guidance.
