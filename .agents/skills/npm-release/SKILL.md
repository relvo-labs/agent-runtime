---
name: npm-release
description: Operate and change the manual, environment-gated npm publication path, where scope, order, integrity and registry facts are all proven before any credential exists.
version: 1.5.0
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
- `tools/release` — preflight, staging verification, publication, the npm tool identity and
  the workflow policy check
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
   the `npm-release` environment, downloads that exact artifact **id** (with
   `digest-mismatch: error`, which the action drives from artifact metadata — it takes no
   expected-digest input), re-verifies everything locally, and only then runs one step that
   can see `secrets.NPM_TOKEN`. Building never happens in a step that holds the credential.

   Both jobs install the workspace from the lockfile, frozen and script-free. In the gated
   job that install is a control, not a convenience: it is where the pinned npm comes from,
   and without it there is no tool whose identity the job can prove (see step 5).

4. **Preflight refuses; it never repairs.** Findings are refusals, and there is no
   override input. It refuses pending version intent, a commit that is not main's tip, a
   dirty tree, a version the commit does not carry, an artifact whose identity or contents
   are not the reviewed ones, a dependency range it cannot resolve to one exact version, a
   scope that is not closed over its own dependency graph, a dependency cycle, an existing
   version, a dist-tag regression, and any registry answer that is not a definitive 404 or
   a well-formed packument. A packument missing `dist-tags`, naming a tag that is not an
   exact version, or pointing a tag at a version it does not list is malformed: the
   dist-tag is the mutable half of a packument and reading it as "unset" is how a release
   moves `latest` backwards while reporting success.

5. **An artifact has exactly one identity, or it is refused.** What this repository
   reads out of a tarball and what npm extracts from it must never be two different
   packages. Paths are normalised the way an extractor normalises them and collisions
   are refused, header checksums are verified, appended data and content outside
   `package/` are refused, and unsupported archive semantics are refused rather than
   skipped. `pacote-differential.test.ts` asserts the resulting property against npm's
   own bundled reader, offline: same identity, or refusal. Never relax that test to
   "we parse tar the same way" — the invariant is about disagreement, not parsing.

   **Which npm, exactly.** That argument is worth nothing unless the npm the test
   reads with is the npm that publishes. `tools/release/lib/npm-tool.ts` is the
   single answer to "which npm": the package pinned in the catalog, taken from the
   explicit path `node_modules/npm`, proven before use, and used by both
   `pacote-differential.test.ts` and `publish.ts`. It never falls back to `PATH`
   and takes no environment override — an unresolvable, malformed, mislocated or
   wrong-versioned tool is a refusal, and refusals name every reason at once
   because the reader is usually looking at a runner they cannot poke at. npm is a
   declared devDependency here rather than something inherited from the runtime
   because `pnpm/setup` installs Node from the `node` package, whose payload is
   the `node` binary alone: guessing at `process.execPath`'s neighbours found no
   npm and made the suite unloadable (run 34699256419), while `spawn('npm')`
   published through whatever the runner image happened to ship. Those were the
   same bug seen from two ends, and splitting the tool apart again reopens it.

   **Locate; do not resolve, and do not stop at the manifest.** Two rules earned
   the hard way, when a review broke the first version of this module twice:
   - `createRequire(root).resolve('npm/…')` answers "what would `require` find",
     which is not "what does this repository depend on". It walks every ancestor
     `node_modules` and then `NODE_PATH`, and with no npm installed in the
     workspace at all, both were accepted as the publishing tool. So: the root
     manifest must declare `devDependencies.npm: "catalog:"`, the package is read
     from exactly `<repoRoot>/node_modules/npm`, and its real path must be owned
     by `<repoRoot>/node_modules`. `node_modules/npm` is a symlink under pnpm and
     must stay usable, so the rule is about where the link _lands_, not that it
     exists.
   - A package's `main` and `exports` are part of its identity, so containment on
     `package.json` proves nothing about the code that loads. A bundled `pacote`
     whose `main` was `../../../../outside.cjs`, or whose `exports` target was a
     symlink out of the tree, passed inspection and then loaded foreign code.
     Each reader's entry point is therefore resolved, realpath'd, confined to
     that reader's own directory and recorded; `loadNpmModule` loads that exact
     file and refuses any id not proven here. Never hand a caller a bare
     `require` rooted in npm — that re-runs resolution at load time, which is
     precisely where the checked answer gets replaced by an unchecked one.

   Two rules of different kinds keep that true, and confusing them breaks something:
   - **Unrecognised header _formats_ are refused.** Only the POSIX ustar signature
     (`ustar\0` + `00`) is accepted. A review built a second `package/package.json`
     header with valid checksums, a populated `prefix` and no signature: npm ignored the
     prefix and let it overwrite the real manifest; this reader applied the prefix and
     saw a harmless path. Refusing the format closes that.
   - **Inside ustar, npm's field semantics are reproduced literally** — the `prefix`
     split including its byte-475 155-vs-130 branch, and the rule that a regular-file
     entry whose name ends in `/` is a directory. `prefix` is _not_ refused: node-tar
     genuinely emits it for deep `dist/` paths, so refusing it would reject artifacts
     `pnpm pack` actually produces. Refusing what npm accepts breaks the release;
     accepting what npm reads differently breaks the approval.

6. **The approval is not a snapshot.** An approval can sit for hours while `main`
   advances, a dist-tag moves and a dependency is unpublished. Every fact the approval
   rested on is re-established in the gated job, and again immediately before each
   individual upload: the dist-tag not already pointing at something newer, every packed
   dependency still resolvable at its exact version — **including dependencies this run
   published itself**, because "we uploaded it" is memory and the registry is fact — and
   `source_sha` still being main's tip **on the remote**, read with `git ls-remote` rather
   than from the checkout's cached `origin/main`, which cannot change once the job has
   started. An unanswerable remote refuses; it is never read as agreement.

7. **Publication is ordered, explicit and non-overwriting.** One tarball per `npm publish`,
   in dependency order, with `--ignore-scripts --access public --provenance --tag <tag>
--registry https://registry.npmjs.org` and a temporary `--userconfig` npmrc that
   interpolates the token from the environment and is removed in a `finally`. Each upload
   is followed by a registry readback of identity, integrity, dependency ranges and
   dist-tag before the next package is attempted.

8. **Partial failure stays partial, and acceptance is not verification.** On any failure
   the run stops non-zero. A zero exit from `npm publish` means the registry accepted the
   bytes; a readback means it serves what was reviewed. The report keeps those apart —
   `published`, `acceptedUnverified`, and `unknown` for an upload it could not
   adjudicate — because reporting an accepted-but-unconfirmed upload as "not published"
   invites a recovery dispatch naming a version that is already public and immutable.
   Nothing is unpublished, no version is overwritten, and recovery is a _new_
   human-reviewed dispatch whose scope names only what is _confirmed_ still unpublished.

9. **Changing this path is a reviewed change.** `pnpm release:check` describes the
   reviewed workflow as an exact structure: allowed job and step keys, exact job `env`
   and `outputs` bindings, exact action inputs, the exact command sequence per job, and
   an allow-list of every `${{ … }}` expression that may appear anywhere in the file. It
   is exhaustive on purpose — a field the policy does not assert is a field an attacker
   chooses, and `continue-on-error`, a `shell:` override, an extra `run:`, a constant in
   place of a dispatch input and `secrets['NPM_TOKEN']` were each demonstrated to pass a
   policy that only checked a list of properties. Editing the workflow therefore means
   editing `EXPECTED_JOBS` in `workflow-policy.ts` too; that is the review step. Add a
   new action to `ALLOWED_ACTIONS` only with an independently verified commit SHA, and
   never pass an action input the pinned revision does not declare.

## Verification

```bash
pnpm release:check                 # structural policy for the release workflow
pnpm exec vitest run tools/release # tool identity, preflight, ordering, registry, readback
pnpm gate                          # both of the above, plus everything else CI runs
```

A local `pnpm gate` passing proves less about the release path than it looks like it does
if your Node came from nvm or a system package: that layout has a bundled npm, and the
runner's does not. When changing anything about how the tool is located, reproduce the CI
layout rather than trusting the local one — install the pinned pnpm executable, run
`pnpm runtime set node <matrix version> -g` into a scratch `PNPM_HOME`, and run the gate
with that `node` first on `PATH`.

Rehearse preflight locally against real packed artifacts, without credentials. Report
local facts honestly: never supply `workflow_dispatch` or `refs/heads/main` to impersonate
a hosted dispatch. The 0.2.0 scope below is an example for the separately authorized
version-preparation candidate; this repair retains the current manifests and intents.
A local run must refuse release eligibility even after that candidate is versioned.
Packing still precedes diagnostic evaluation; issue #26 tracks that separate limitation.

```bash
export RELEASE_EVENT_NAME=local_nonpublishing_verification
export RELEASE_REF=$(git symbolic-ref -q HEAD || printf detached)
export RELEASE_SOURCE_SHA=$(git rev-parse HEAD) RELEASE_RUNNER_SHA=$(git rev-parse HEAD)
export RELEASE_PACKAGES='@relvo-labs/agent-protocol@0.2.0'
export RELEASE_DIST_TAG=latest
export RELEASE_CONFIRM="publish 1 package(s) from $RELEASE_SOURCE_SHA to latest"
node tools/release/preflight.ts --staging /tmp/release-staging
```

This one-package example is a diagnostic rehearsal, not the full first-release scope.
Read `docs/release.md` for the eight-package preparation and separate publication decision.
The library release inventory does not assert feature coverage: the gate owns that proof.
Raw pending-file checks remain required so empty or malformed intent cannot authorize
publication through an empty release plan.

## Provenance

- Source: independent — authored for this repository against the npm CLI documentation
  (`publish`, `dist-tag`, `--provenance`, `--userconfig`), the npm registry packument
  format, and the GitHub Actions documentation for `workflow_dispatch` inputs,
  environments, job outputs and artifact digests.
- Reviewed-not-copied: `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`
  — its `action.yml` contract and `src/download-artifact.ts` were read to establish that
  the pinned revision declares no `digest` input and derives the expected hash from
  artifact metadata. No text was incorporated.
- Compared-against: `pacote` and `tar`, as bundled with the `npm` pinned in
  `pnpm-workspace.yaml`'s catalog — the same package this repository publishes with. They
  are loaded offline, out of that package, for the identity-agreement test. npm is a
  declared devDependency (one lockfile entry; it vendors its own dependencies) and no code
  from it is incorporated. It was previously loaded from whichever npm happened to sit
  beside `process.execPath`, which assumed an official Node distribution's layout.
