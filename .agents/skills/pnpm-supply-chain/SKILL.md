---
name: pnpm-supply-chain
description: Add or update third-party dependencies, keep the lockfile authoritative and keep dependency lifecycle scripts denied by default.
version: 1.0.0
stability: stable
tags: [pnpm, lockfile, dependencies, catalog, install-scripts, audit]
---

# pnpm supply chain

## Trigger

Use this skill when a change touches any of:

- a third-party entry in any `dependencies` / `devDependencies` / `peerDependencies`
- the `catalog:` block of `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tools/repo/check-supply-chain.ts` or `tools/repo/check-licenses.ts`
- `.npmrc`
- `onlyBuiltDependencies`
- the `packageManager` pin

## Counter-trigger

Do not use this skill when:

- the edge is between two workspace packages — use `package-architecture`
- you are changing what a package publishes — use `package-artifact-validation`
- you are only changing a Node version in CI — use `local-ci-parity`

## Owns

- `pnpm-lock.yaml` — the resolution of record
- `.npmrc` — install policy
- `pnpm-workspace.yaml#catalog` — the single version pin per third-party package
- `pnpm-workspace.yaml#onlyBuiltDependencies` — the install-script allow-list
- `pnpm-workspace.yaml#minimumReleaseAge` — the publish-cooldown policy
- `package.json#packageManager` — the exact pnpm pin
- `docs/adr/ADR-0013-supply-chain-policy.md` — the policy decision record
- `tools/repo/check-supply-chain.ts` — effective dependency-policy validation
- `tools/repo/check-licenses.ts` — production dependency license validation

## Does not own

- `pnpm-workspace.yaml#packages` — owned by `package-architecture`
- `packages/*/package.json#exports` — owned by `package-artifact-validation`

## Relationships

- `boundary-with` → `package-architecture` — both write dependency fields; this skill owns third-party edges and versions, that skill owns workspace edges and layering.
- `depends-on` → `local-ci-parity` — the frozen-lockfile install is a CI gate.

## Procedure

1. **Justify the dependency.** For a foundation SDK, prefer the platform. Before adding,
   answer in the PR body: what does it replace, how many transitive packages does it pull,
   is it ESM-native, is it maintained, and what is the removal cost. A dependency that
   only saves a few lines of Node built-in usage is rejected.

2. **Pin exactly, in the catalog, once.**

   ```yaml
   # pnpm-workspace.yaml
   catalog:
     some-lib: 1.2.3
   ```

   ```jsonc
   // packages/x/package.json
   { "dependencies": { "some-lib": "catalog:" } }
   ```

   Never write a literal range in a package. Exact pins plus a committed lockfile give a
   reproducible tree; ranges give a lockfile that drifts on every unrelated install.

3. **Verify compatibility, do not assume latest works.** Check `engines` and
   `peerDependencies` of the candidate against our Node matrix and our TypeScript line
   _before_ installing:

   ```bash
   npm view <pkg> version engines peerDependencies --json
   ```

   `strict-peer-dependencies=true` is set deliberately — an unmet peer is a design defect
   and must be resolved, not silenced.

4. **Respect the publish cooldown; do not exclude your way past it.** The workspace sets
   `minimumReleaseAge: 4320` (3 days) with `minimumReleaseAgeStrict: true`. The window
   immediately after a publish is when a compromised release is most likely to be live and
   least likely to have been noticed.

   When an install fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, the correct fix is to
   **pin the previous version and wait the window out**, not to add an exclusion:

   ```bash
   npm view <pkg> time --json   # find the newest version older than the cutoff
   # edit the catalog pin, then:
   pnpm install
   ```

   `minimumReleaseAgeExclude` must stay empty. An entry there is a reviewed, documented
   exception with a stated reason — and it is a liability the next contributor inherits.
   A transitive range resolves to an older version automatically; only exact catalog pins
   need manual attention.

5. **Install scripts stay denied.** pnpm does not run dependency lifecycle scripts unless
   the package is listed in `onlyBuiltDependencies`. Adding an entry requires:
   - naming the package and _why_ a build step is unavoidable (native addon, etc.)
   - confirming there is no prebuilt or pure-JS alternative
   - a line in `docs/adr/ADR-0013-supply-chain-policy.md`

   Never run `pnpm install --unsafe-perm`, never set `dangerouslyAllowAllBuilds`, and never
   add a blanket `enable-pre-post-scripts=true`.

6. **Keep the lockfile honest.**

   ```bash
   pnpm install                  # local: updates the lockfile
   pnpm install --frozen-lockfile  # what CI runs; must be a no-op
   git diff --stat pnpm-lock.yaml
   ```

   A lockfile diff in a PR that added no dependency means something drifted — investigate
   before committing it. Never hand-edit `pnpm-lock.yaml`.

7. **Audit at the boundary you actually ship.** Run the audit and triage by whether the
   advisory is reachable from a _runtime_ dependency of a published package. Dev-only
   advisories are tracked, not release-blocking:

   ```bash
   pnpm audit --prod --audit-level=high
   pnpm licenses list --prod
   ```

   A published package may only carry runtime dependencies under permissive licences
   (MIT, ISC, BSD-2/3, Apache-2.0). Copyleft in a runtime dependency is a blocker.

8. **The `packageManager` pin is exact.** Bump it deliberately, with the corresponding
   lockfile format check, never as a drive-by.

## Verification

```bash
pnpm install --frozen-lockfile   # must not modify pnpm-lock.yaml
pnpm audit --prod --audit-level=high
pnpm licenses list --prod
git diff --exit-code pnpm-lock.yaml
pnpm gate
```

## Provenance

- Source: independent — authored for this repository against the pnpm documentation
  (`catalogs`, `onlyBuiltDependencies`, `--frozen-lockfile`, settings reference) and the
  npm audit documentation.
