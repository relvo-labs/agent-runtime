---
name: npm-release
description: Operate and change the manual, environment-gated npm publication path, where scope, order, integrity and registry facts are all proven before any credential exists.
version: 1.0.0
stability: stable
tags: [npm, provenance, publish, registry, supply-chain]
---

# npm release

## Trigger

Use this skill when a change touches any of:

- `.github/workflows/release.yml`
- anything under `tools/release/`
- `docs/release.md` or `docs/adr/ADR-0017-manual-npm-release.md`
- the question "how would these packages actually reach the registry?"

## Counter-trigger

Do not use this skill when:

- you are deciding a version number or writing version intent — use `changesets-release`;
  this skill never chooses a version, it only publishes one that a commit already carries
- you are changing what a package ships — use `package-artifact-validation`
- you are changing the canonical gate or the validation workflow — use `local-ci-parity`
- you want to publish _now_: publication is a human decision with an environment approval,
  not something an agent may initiate. Nothing in this repository has been published yet.

## Owns

- `.github/workflows/release.yml` — the only workflow that may reach a publish credential
- `tools/release` — preflight, staging verification, publication and the workflow policy check
- `docs/release.md` — the operator runbook and the outstanding-approval record
- `docs/adr/ADR-0017-manual-npm-release.md` — the decision record for this path

## Does not own

- `.github/workflows/gate.yml` — owned by `local-ci-parity`
- `tools/repo/gate.ts` — owned by `local-ci-parity`; this skill contributes one step to it
- `packages/*/package.json#version` — owned by `changesets-release`
- `.changeset` — owned by `changesets-release`
- `tools/repo/check-artifacts.ts` — owned by `package-artifact-validation`

## Relationships

- `boundary-with` → `local-ci-parity` — that skill owns the workflow directory and the canonical gate; this skill owns the one release workflow inside it and the `release` gate step.
- `boundary-with` → `changesets-release` — that skill decides versions; this skill refuses to run while any version intent is still pending.
- `depends-on` → `package-artifact-validation` — the gate's tarball checks are what makes a packed artifact publishable at all.
- `depends-on` → `pnpm-supply-chain` — publication installs frozen and with lifecycle scripts denied.

## Procedure

1. **Nothing publishes itself.** The workflow has exactly one trigger,
   `workflow_dispatch`, on `main`. There is no push, tag, schedule or `workflow_run`
   entrance, and no job or step may carry an `if:` — a release step that can be skipped is
   a release step that can be green without running.

2. **The operator states every fact.** Four required inputs, none defaulted: the full
   40-character `source_sha`, an explicit `packages` scope of `name@version` entries, the
   `dist_tag`, and a `confirm` phrase that restates the count, the commit and the tag:

   ```
   publish <count> package(s) from <source_sha> to <dist_tag>
   ```

   A typo in any input invalidates the confirmation, because the expected phrase is
   derived from the parsed inputs.

3. **Two jobs, one credential.** `verify` is ungated: it checks out the named commit, runs
   the canonical `pnpm gate`, packs exactly the named packages, runs the fail-closed
   preflight and uploads the staged plan plus tarballs. `publish` needs `verify`, runs in
   the `npm-release` environment, downloads that exact artifact id and digest, re-verifies
   everything locally, and only then runs one step that can see `secrets.NPM_TOKEN`.
   Building never happens in a step that holds the credential.

4. **Preflight refuses; it never repairs.** Findings are refusals, and there is no
   override input. It refuses pending version intent, a commit that is not main's tip, a
   dirty tree, a version the commit does not carry, an artifact whose identity or contents
   are not the reviewed ones, a dependency range it cannot resolve to one exact version, a
   scope that is not closed over its own dependency graph, a dependency cycle, an existing
   version, a dist-tag regression, and any registry answer that is not a definitive 404 or
   a well-formed packument.

5. **Publication is ordered, explicit and non-overwriting.** One tarball per `npm publish`,
   in dependency order, with `--ignore-scripts --access public --provenance --tag <tag>
--registry https://registry.npmjs.org` and a temporary `--userconfig` npmrc that
   interpolates the token from the environment and is removed in a `finally`. Each upload
   is followed by a registry readback of identity, integrity, dependency ranges and
   dist-tag before the next package is attempted.

6. **Partial failure stays partial.** On any failure the run stops non-zero and reports
   exactly what is already public. Nothing is unpublished, no version is overwritten, and
   recovery is a _new_ human-reviewed dispatch whose scope names only what is still
   unpublished.

7. **Changing this path is a reviewed change.** `pnpm release:check` parses the workflow
   and fails on a widened trigger, a second credentialed step, an unpinned or unreviewed
   action, an inline shell program, or a publish command outside the reviewed scripts. Add
   a new action to `ALLOWED_ACTIONS` only with an independently verified commit SHA.

## Verification

```bash
pnpm release:check                 # structural policy for the release workflow
pnpm exec vitest run tools/release # preflight, ordering, registry and readback fixtures
pnpm gate                          # both of the above, plus everything else CI runs
```

Dry-run the preflight locally against real packed artifacts (credential-free; it is
expected to refuse while changesets are pending):

```bash
RELEASE_EVENT_NAME=workflow_dispatch RELEASE_REF=refs/heads/main \
RELEASE_RUNNER_SHA=$(git rev-parse HEAD) RELEASE_SOURCE_SHA=$(git rev-parse HEAD) \
RELEASE_PACKAGES='@relvo-labs/agent-protocol@0.1.0' RELEASE_DIST_TAG=latest \
RELEASE_CONFIRM="publish 1 package(s) from $(git rev-parse HEAD) to latest" \
node tools/release/preflight.ts --staging /tmp/release-staging
```

## Provenance

- Source: independent — authored for this repository against the npm CLI documentation
  (`publish`, `dist-tag`, `--provenance`, `--userconfig`), the npm registry packument
  format, and the GitHub Actions documentation for `workflow_dispatch` inputs,
  environments, job outputs and artifact digests.
