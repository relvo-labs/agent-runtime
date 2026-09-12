---
name: changesets-release
description: Record version intent for pre-1.0 packages with Changesets, and keep versioning separate from the manual release workflow that publishes them.
version: 1.1.0
stability: stable
tags: [changesets, semver, changelog, prerelease]
---

# Changesets release

## Trigger

Use this skill when a change touches any of:

- a file under `.changeset/`
- `.changeset/config.json`
- a package `version` field
- any user-visible behaviour of a publishable package (which requires a changeset)

## Counter-trigger

Do not use this skill when:

- the change is private to the workspace root, `tools/`, `docs/`, `.agents/` or CI —
  those are not published and need no changeset
- you are classifying _whether_ a change is breaking — use `public-api-evolution` (API
  surface) or `runtime-contract-evolution` (wire contract), then come back
- you want to publish, or to change how publication works — use `npm-release`. This skill
  decides _which version_; that skill decides _whether these exact artifacts may reach the
  registry_, and refuses while any changeset here is still pending.

## Owns

- `.changeset` — changeset files and `config.json`
- `packages/*/package.json#version` — the published version of record
- `packages/*/CHANGELOG.md` — generated release notes

## Does not own

- `packages/protocol/src` — owned by `runtime-contract-evolution`, including `WIRE_VERSION`
- `examples/consumer-smoke` — owned by `public-api-evolution`, which classifies compatibility
- `.github/workflows` — owned by `local-ci-parity`
- `.github/workflows/release.yml` — owned by `npm-release`, which publishes but never versions
- `tools/release` — owned by `npm-release`

## Relationships

- `depends-on` → `public-api-evolution` — the semver class is an input to this skill.
- `depends-on` → `runtime-contract-evolution` — a wire break must also be reflected here.
- `boundary-with` → `local-ci-parity` — that skill owns workflows; no workflow it owns may publish.
- `boundary-with` → `npm-release` — that skill owns the one workflow that may publish; this skill owns the versions it is allowed to publish.

## Procedure

1. **Versioning and publishing are separate decisions, on purpose.** `changeset publish`
   is never run here. The release workflow publishes an explicitly typed `name@version`
   scope, and refuses while any `.changeset/*.md` is pending — so a feature PR can record
   intent freely without ever being one merge away from a publication. The gate runs
   `changeset status` only, which is credential-free.

2. **Add a changeset with every publishable change:**

   ```bash
   pnpm changeset
   ```

   Select every package whose _published output_ changes. If you changed
   `agent-protocol` and `agent-runtime` re-exports the changed type, both change.

3. **Pre-1.0 bump rules.** All packages are `0.x`. `major` is disallowed by config.

   | Compatibility class (from the owning skill) | Changeset bump |
   | ------------------------------------------- | -------------- |
   | breaking (API or wire)                      | `minor`        |
   | additive                                    | `minor`        |
   | fix with no surface change                  | `patch`        |
   | docs / internal refactor only               | none           |

   Because `minor` carries both additive and breaking changes pre-1.0, a breaking
   changeset body **must** begin with `BREAKING:` and state the migration in one sentence.

4. **Write the changeset for a reader, not a diff.** Bad: "update runtime". Good:
   "BREAKING: `subscribe()` now returns `SubscriptionMessage` instead of `EventEnvelope`;
   narrow with `message.type === 'event'` before reading `message.event`."

5. **Keep versions linked where the contract is shared.** `agent-protocol` and its direct
   dependents move together via the `linked` config; do not hand-edit a `version` to
   break that.

6. **Never hand-run `changeset version` on a feature branch.** Version bumps and changelog
   generation belong to a dedicated release PR that does nothing else, so the diff a
   reviewer approves is exactly the versions that may then be published. Publication is a
   separate manual dispatch against that merge commit — see `docs/release.md`.

## Verification

```bash
pnpm changeset:status        # credential-free; lists pending bumps
git diff --name-only origin/main... | grep -q '^packages/' && ls .changeset/*.md
pnpm gate
```

CI fails a PR that modifies `packages/**` without a valid `.changeset/*.md`. This
foundation has no label-based bypass in its workflow.

## Provenance

- Source: independent — authored for this repository against the Changesets documentation
  (config reference, `linked`, `status`) and the semver specification.
