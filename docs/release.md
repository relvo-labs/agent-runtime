# Release runbook

This repository has a reviewed, manual npm publication path. It has never published
anything, and running it is a human decision, not an automated consequence of merging.

- Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- Decision record: [ADR-0017](adr/ADR-0017-manual-npm-release.md)
- Owning skill: `.agents/skills/npm-release/SKILL.md`
- Structure is machine-checked by `pnpm release:check`, which the canonical gate runs.

## What the path guarantees

| Concern                     | Where it is enforced                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| no automatic publication    | `workflow_dispatch` is the only trigger; no job or step is conditional             |
| explicit scope              | four required inputs, no defaults, plus a confirmation phrase that restates them   |
| credential-free proof first | `verify` runs `pnpm gate`, packs, and runs preflight before any approval           |
| approval                    | `publish` runs in the `npm-release` environment and needs its reviewers            |
| credential confinement      | exactly one step references `secrets.NPM_TOKEN`; a temporary npmrc interpolates it |
| artifact integrity          | `digest-mismatch: error` on the download, then a local re-hash of every tarball    |
| unambiguous identity        | an archive npm would read as a different package is refused, not described         |
| still-current source        | the gated job and every upload re-ask the **remote** whether `source_sha` is main  |
| ordering                    | dependency-topological publication, one explicit tarball per `npm publish`         |
| provenance                  | `--provenance` with `id-token: write` granted only to the publish job              |
| no overwrite                | preflight and the publish step both refuse an existing version                     |
| verified outcome            | registry readback of identity, integrity, dependencies and dist-tag                |

### How the artifact actually gets from `verify` to `publish`

Worth stating precisely, because it is easy to describe more strongly than it
is. `verify` uploads the staging directory and records the resulting
**artifact id** as a job output. `publish` downloads that exact id — not a name
— and passes `digest-mismatch: error`, so the pinned `actions/download-artifact`
revision fails the job if the bytes it receives do not hash to the digest the
Actions service recorded for that artifact. That check is driven by the
artifact's own metadata; the action declares no input for supplying an expected
digest, and an earlier version of this workflow passed one anyway. It has been
removed, because a value that is silently ignored reads like a comparison that
is not happening.

The protections that do not depend on the transport at all are the ones that
matter most, and they run inside the gated job before the credential exists:
every tarball is re-hashed and re-read from the archive, and the plan is
re-hashed and compared against `plan-digest`, which `verify` recorded as a job
output before the approval was requested.

## Before a release can be dispatched at all

Preflight refuses the release unless **all** of the following hold at the named commit:

1. the dispatch is `workflow_dispatch` on `refs/heads/main`, and `source_sha` is the exact
   current tip of `main` and the commit the runner checked out;
2. the working tree is clean;
3. `.changeset/` contains no unreleased changeset, and `changeset status` proposes no
   release — version intent belongs to a separate versioning PR (see below);
4. every named package exists in the workspace, is not private, and already carries the
   exact version named in the dispatch;
5. every packed tarball is the reviewed one — right identity, `publishConfig.access` of
   `public`, `publishConfig.provenance` true, a license, a repository url, `LICENSE`,
   `NOTICE`, `README.md`, and no `src/` or `test/` files;
6. every packed tarball has exactly one identity. Archive paths are normalised the way
   an extractor normalises them and any collision is refused, header checksums are
   verified, data after the end-of-archive marker is refused, entries outside the
   `package/` tree are refused, and unsupported archive semantics (links, devices,
   global pax headers, pax keys other than a `path` override) are refused rather than
   skipped. Header _formats_ are also refused unless they carry the POSIX ustar
   signature, because a field like `prefix` means different things in different formats
   and npm reads it only under that signature; inside ustar the reader reproduces npm's
   semantics literally rather than approximating them, so that the deep `dist/` paths
   `pnpm pack` really does emit with a `prefix` are still accepted.
   `tools/release/pacote-differential.test.ts` proves the property all of this buys:
   for every archive, either this repository and npm's own reader report the _same_
   name and version, or this repository refuses the archive;
7. the scope is closed over its own dependency graph, every internal dependency resolves
   to an exact version that is either in scope or already published, every third-party
   dependency range is exact (or the caret of an exact version) and published, and the
   graph is acyclic;
8. no named version already exists on the registry, and the dist-tag would not move
   backwards;
9. the registry answered definitively. A 404 means "not published". An authentication
   failure, a rate limit, a 5xx, a timeout or a malformed packument is a refusal — and
   a packument counts as malformed if it omits `dist-tags`, names a tag that is not an
   exact version, or points a tag at a version it does not itself list. A document this
   tooling cannot fully account for never authorises a publication.

## What is re-established after the approval

An environment approval is not a snapshot of the world. It can sit for hours,
and three things it depended on are mutable in that window: `main` can advance,
the registry's dist-tags can move, and a dependency this scope needs can be
unpublished. Preflight proved all of them before the approval; the gated job
proves them again afterwards, and the publisher proves them again immediately
before **each** package's bytes are uploaded:

- `source_sha` is still the tip of `main` **on the remote**, still the
  checked-out `HEAD`, still a clean tree, and there is still no pending version
  intent;
- the dist-tag this dispatch would move does not already point at something
  newer than the version about to be published;
- every runtime dependency the packed manifest names is still resolvable at the
  exact version it names — **including the packages this same run has already
  published**, because a dependency can be unpublished while a later package in
  the same scope is still uploading.

Any of these failing stops the run non-zero, before that package is uploaded.

### Why the remote is asked, and what happens when it cannot answer

The checkout's `refs/remotes/origin/main` is fixed the moment the gated job
checks out. Re-reading it during the run therefore proves nothing about what
happened after the approval — it is the same value every time. The publisher
runs `git ls-remote --exit-code origin refs/heads/main` before each upload
instead, and compares that to `source_sha`.

That query is read-only, fetches no objects, writes nothing and persists no
credential (git is spawned without `NPM_TOKEN` in its environment). It needs no
permission beyond what cloning the repository already required.

It is also **fail-closed**, which has an operational consequence worth knowing
before the first dispatch: if the remote cannot be reached, answers with
something unparseable, reports no `refs/heads/main`, or reports it more than
once, the run refuses rather than proceeding. The correct response to that is to
find out why the remote is unreadable — not to remove the check.

## Outstanding human approvals

None of these has been granted. Each is a person's decision, recorded where a reviewer can
find it.

1. **Version preparation.** Every publishable package is still `0.1.0` and three
   changesets are pending, so a release cannot run today. A separate, reviewed release PR
   must run `changeset version` and produce exactly this (from `pnpm changeset:status`,
   `linked` keeps the eight in step):

   | Package                             | From  | To    | Bump  |
   | ----------------------------------- | ----- | ----- | ----- |
   | `@relvo-labs/agent-protocol`        | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-executor`        | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-provider`        | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-provider-codex`  | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-provider-claude` | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-runtime`         | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-workspace`       | 0.1.0 | 0.2.0 | minor |
   | `@relvo-labs/agent-workspace-git`   | 0.1.0 | 0.2.0 | minor |

   Consumed changesets: `foundation-runtime-v0-4` (all eight, minor),
   `codex-provider-text-run` (codex, minor), `claude-provider-text-run` (claude, minor).
   `@relvo-labs/reference-app` is private and is never published. No version in this
   repository has been changed to prepare that PR; deriving and reviewing it is step one.

2. **Registry ownership and the `npm-release` environment.** The `@relvo-labs` scope,
   the `NPM_TOKEN` secret (granular, write-limited to this scope, short-lived) and the
   environment's required reviewers are configured by a human outside this repository.
   Nothing here edits repository settings.

3. **The first-release decision itself.** Publishing 0.2.0 makes the v0.4 contract
   public and immutable. That call is made against the evidence policy below.

4. **Each dispatch.** Scope, dist-tag and confirmation are typed per run, and the
   environment approval is given per run.

## First-release evidence policy

The pre-1.0 line may be published only when the evidence below exists and is stated
accurately. This policy is not weakened by the existence of a release path.

- **Deterministic evidence, complete.** `pnpm gate` green on Node 22/24/26, including
  packed-tarball install, typecheck and import from a clean store (`artifacts:check`) and
  the packed reference application (`app-pack:check`).
- **Provider evidence, stated exactly as it is.** Both adapters are deliberately narrow
  and their compatibility evidence is deterministic, not live-model:
  - Codex: issue #15 carries authentic recorded Codex app-server interaction evidence.
  - Claude: there is **no** verified live Claude-model evidence in this repository. Do not
    describe the Claude adapter as live-model-verified. Publishing it means publishing an
    adapter whose SDK integration is proven only against deterministic doubles, and the
    changelog and README must keep saying so.
- **No unverified claim in published metadata.** Everything a consumer reads on the
  registry — description, README, changelog — must match what is actually proven.
- **Irreversibility acknowledged.** npm versions cannot be overwritten and unpublishing is
  not a recovery plan. A reviewer must accept that before the first dispatch.

## Dispatching a release

1. Merge the reviewed version-preparation PR. Note its merge commit; that is `source_sha`.
2. Confirm `main` is at that commit and CI is green on it.
3. Actions → **release** → _Run workflow_ on `main`, with, for example:
   - `source_sha`: `<the 40-character merge commit>`
   - `packages`: `@relvo-labs/agent-protocol@0.2.0 @relvo-labs/agent-executor@0.2.0 …`
     (every package that must be publishable together — the scope must be dependency-closed)
   - `dist_tag`: `latest` (a prerelease version may never be published under `latest`)
   - `confirm`: `publish 8 package(s) from <source_sha> to latest`
4. Read the `verify` job output: it prints the full plan, the plan digest, the publication
   order, each tarball's integrity, and every publishable package left **out** of scope.
5. Approve the `npm-release` environment only if that plan is exactly what you intended.
6. Read the `publish` job output: each package is published and then verified against the
   registry before the next one is attempted.

## What the first dispatch will establish

Everything above is verified locally and in the gate, but four facts can only be observed
the first time this workflow actually runs. Expect to read the logs carefully, and treat a
failure in any of them as a workflow bug rather than a reason to retry with a wider scope:

- that the gated job can download the verify job's artifact by id with only
  `contents: read` (same-run downloads use the run's own token, not `actions: read`);
- that `git ls-remote origin refs/heads/main` succeeds in the gated job. `actions/checkout`
  runs with `persist-credentials: false`, so this is an anonymous read of the remote. It
  works for a public repository; if this repository is private when the first release is
  dispatched, the run will **refuse** rather than publish, and that refusal is the control
  working. Fixing it is a reviewed change to how the remote tip is observed, never a
  removal of the check;
- that `npm` from the Node runtime `pnpm/setup` installs accepts the granular token and
  mints provenance with `id-token: write`;
- that the `npm-release` environment's reviewers are the people you expect.

Everything before the environment approval is credential-free, so a first dispatch can be
taken all the way to the approval prompt and then declined: that exercises the inputs, the
gate, the pack, the preflight and the artifact upload without publishing anything.

## If a release fails part way

The run stops at the first failure and exits non-zero. Its summary lists what is already
public, what failed and why, and what was never attempted.

A zero exit from `npm publish` and a confirmed registry readback are **different facts**,
and the summary keeps them apart, because the recovery instruction depends entirely on
which one you have. Read the summary in these three categories:

| Summary line                 | What it means                                             | What to do                                                     |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `published and verified`     | uploaded, and the registry serves what was reviewed       | done; never name it again in any dispatch                      |
| `published but NOT verified` | uploaded and public, but readback could not confirm it    | investigate the registry state; never name it again either     |
| `outcome unknown`            | upload attempted, and the registry could not be consulted | establish whether it is public **before** dispatching anything |

- Nothing is unpublished or overwritten. Do not attempt to "fix" a published version.
- Recovery is a **new** dispatch whose scope names only the packages that are confirmed
  still unpublished, at the same versions, reviewed and approved again.
- A version in either of the lower two rows is, or may be, public and immutable. Naming
  it in a recovery dispatch cannot succeed — preflight will refuse it once the registry
  lists it, which is the intended behaviour, and is why the summary never folds an
  attempted upload into "nothing was published".

## Local rehearsal

Preflight is credential-free and can be run locally. Today it is expected to **refuse**,
because version intent is still pending — that refusal is the control working, not a
failure of the tooling:

```bash
export RELEASE_EVENT_NAME=workflow_dispatch RELEASE_REF=refs/heads/main
export RELEASE_SOURCE_SHA=$(git rev-parse HEAD) RELEASE_RUNNER_SHA=$(git rev-parse HEAD)
export RELEASE_PACKAGES='@relvo-labs/agent-protocol@0.1.0'
export RELEASE_DIST_TAG=latest
export RELEASE_CONFIRM="publish 1 package(s) from $RELEASE_SOURCE_SHA to latest"
node tools/release/preflight.ts --staging /tmp/release-staging
```
