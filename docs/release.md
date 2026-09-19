# Release runbook

This repository has a reviewed, manual npm publication path. Running it is a human
decision, not an automated consequence of merging.

**All eight public packages have an immutable `0.2.0` release.** The protocol package was
accepted and published by run 34753860073 attempt 3; the registry serves it with integrity,
shasum and tarball digest matching the reviewed artifact. Registry readback on 2026-09-18
also confirmed that the other seven exact versions are public, carry integrity metadata and
have `latest` pointing to `0.2.0`. Never name any of these versions in another dispatch,
never republish them, and do not treat unpublishing as a recovery plan. Every future version
needs a fresh plan from the current tip of `main`, fresh registry reconciliation, explicit
human authority for that scope and a new environment approval. Preparing a version still
authorises nothing by itself. Exact package links are recorded in the
[release notes](release-notes.md#020--all-eight-packages-published).

That same run is why this document now has a section on
[what happens when npm accepts a version it does not serve yet](#when-npm-accepts-a-version-it-does-not-serve-yet):
the upload succeeded and the job failed anyway, because it stopped reading the registry
about twelve seconds later.

- Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- Decision record: [ADR-0017](adr/ADR-0017-manual-npm-release.md)
- Owning skill: `.agents/skills/npm-release/SKILL.md`
- Structure is machine-checked by `pnpm release:check`, which the canonical gate runs.
- What 0.2.0 contains: [release notes](release-notes.md)

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
| one proven publishing tool  | npm is pinned in the catalog; the gate compares against it and only it publishes   |
| still-current source        | the gated job and every upload re-ask the **remote** whether `source_sha` is main  |
| ordering                    | dependency-topological publication, one explicit tarball per `npm publish`         |
| provenance                  | `--provenance` with `id-token: write` granted only to the publish job              |
| no overwrite                | preflight and the publish step both refuse an existing version                     |
| verified outcome            | registry readback of identity, integrity, dependencies and dist-tag                |
| accepted ≠ visible          | a zero exit is `accepted_pending`, reconciled read-only within a bounded budget    |
| never republished           | one `npm publish` per package per run, enforced in `publishRelease` itself         |

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

### When npm accepts a version it does not serve yet

npm scans a newly published package before it is available to install. npm
documents the delay as usually about five minutes, and says it can be fifteen
minutes or more. That gap is invisible to the publisher, and it is what run
34753860073 attempt 3 appears to have fallen into:
`@relvo-labs/agent-protocol@0.2.0` was accepted, the job read the registry five
times separated by 3000 ms — about twelve seconds — and failed. The version was
still answering 404 publicly 251 s after the registry's own internal version
timestamp, and first answered 200 at 466 s, with integrity, shasum and tarball
digest matching the reviewed artifact exactly.

**Read that as the best-supported cause, not an observed one.** Anonymous public
endpoints do not expose npm's internal scan state, so ordinary publish-time
scanning cannot be distinguished from another transient availability gate from
outside. It is the best-supported reading because the version cleared with no
human action, inside the delay range npm documents, and npm reported no incident
that day. The practical consequence is the one that matters at 3 a.m.: **a long
absence is not evidence that nothing is wrong.** An accepted version can equally
be held for manual review or blocked, and those look identical from here — which
is why the wait below is bounded and its expiry sends you to the account's
notifications rather than to a longer wait.

So the moment `npm publish` exits zero, the version is **`accepted_pending`**:

- the registry has the bytes, the version is immutable, and it is public or
  becoming public. It is never reported as unpublished, and it is never uploaded
  again — `publishRelease` refuses to hand the same `name@version` to
  `npm publish` twice in one run, and reconciliation has no upload port at all;
- reconciliation is **read-only**: exact registry lookups on a deterministic
  backoff (5 s, doubling to a 30 s cap, the final delay clipped to the bound)
  for **20 minutes per package** — deliberately longer than the fifteen minutes
  npm documents, because a bound equal to the documented worst case fails on
  exactly the runs it exists to survive;
- only the two expected post-acceptance answers are waited on: the package
  absent (404), or a well-formed packument that does not yet list the exact
  version. Everything else stops the run immediately:

  | Registry answer during reconciliation                                   | Result                     |
  | ----------------------------------------------------------------------- | -------------------------- |
  | 404, or packument without the exact version                             | wait, within the budget    |
  | network failure, timeout, 5xx, rate limit, 401/403, malformed packument | `readback_unavailable`     |
  | identity, integrity, shasum, dependencies, peer dependencies, dist-tag  | `readback_mismatch`        |
  | budget expired, still not visible                                       | `visibility_not_confirmed` |

  An unanswerable registry is not a registry that is still scanning, so an auth
  or transport failure never spends the delay budget; and an answered mismatch
  cannot be made true by reading again.

Each of the last three stops the run non-zero **before the next package is
attempted**, leaves the version `accepted_pending`, and preserves every other
guard — artifact identity, plan digest, main-tip currency, dist-tag, dependency
order and the pinned npm.

The `publish` job's `timeout-minutes` is derived from the same numbers rather
than chosen: 8 × (20 m visibility budget + 2 m upload and pre-upload rechecks) +
14 m setup, download and staged-artifact verification = **190 minutes**.
`pnpm release:check` asserts that exact value, so the workflow cannot drift below
the wait the publisher is willing to make. A shorter timeout would be the same
defect as a short readback window, with the runner abandoning an accepted upload
instead of the program.

**If the budget expires.** The version is accepted and immutable. Do not
republish it, do not name it in a recovery dispatch, and do not rotate the token
on the strength of a 404. Establish its public state by hand, and — because a
package held beyond the normal scan window may be in manual review or blocked —
read the publishing npm account's email and npmjs.com notifications for a
manual-review or blocked-package notice, then use the appeal path it offers.
Only once that is resolved does a new, separately approved dispatch make sense,
and its scope must name only packages confirmed still unpublished.

### Which npm publishes

One npm, pinned in `pnpm-workspace.yaml`'s catalog and locked with an integrity
hash. It is a declared devDependency rather than something the runtime
supplies, because `pnpm/setup` installs Node from the `node` package — a
`node` binary and nothing else, with no npm beside it. Both jobs therefore
install the workspace from the lockfile, frozen and script-free, and in the
gated job that install is what puts the tool on disk. It runs in a step that
holds no credential.

The same package is used in both places that need it: the canonical gate's
`tools/release/pacote-differential.test.ts` reads archives with _its_ bundled
`pacote` and `tar`, and `tools/release/publish.ts` spawns _its_ CLI with
`process.execPath`. That is the point — the identity-agreement argument is
about npm's behaviour, so the npm it is argued about has to be the npm that
runs. `tools/release/lib/npm-tool.ts` proves that before either one uses it:
declared by the root manifest as a catalog devDependency, taken from exactly
`node_modules/npm`, owned — by real path — by this repository's own dependency
tree, named `npm`, the exact catalog version, with a CLI and bundled readers
that stay inside the package, and with each reader bound to the entry point
`require` will actually load. There is no `PATH` fallback, no ancestor search,
no `NODE_PATH` and no environment override; anything it cannot prove is
refused, in `verify-staging.ts` before the credential exists and again in
`publish.ts` before the tool is spawned.

The last two clauses are not decoration. An independent review of the first
version of this module found both of them missing and demonstrated the cost:
asking Node's resolver for `npm` accepted an npm one directory up, or anywhere
`NODE_PATH` pointed, when the workspace had none installed at all; and checking
only each reader's `package.json` let a `pacote` whose `main` was
`../../../../outside.cjs` — or whose `exports` target was a symlink out of the
tree — pass inspection and then load code from outside npm. A resolver answers
"what would `require` find", which is a different question from "what does this
repository depend on", and a manifest is not an entry point.

Until run 34699256419 this was two different programs. The test looked for npm
beside `process.execPath`, which is where an nvm or distro Node keeps it and
where the runner's managed runtime has nothing — so the suite failed to load
and its gate step could not run. Publication meanwhile spawned bare `npm` off
`PATH`, which on a runner is the image's preinstalled Node's npm: not pinned,
not locked, not reviewed, and not what any differential run had ever compared
against.

## Before a release can be dispatched at all

Preflight refuses the release unless **all** of the following hold at the named commit:

1. the dispatch is `workflow_dispatch` on `refs/heads/main`, and `source_sha` is the exact
   current tip of `main` and the commit the runner checked out;
2. the working tree is clean;
3. `.changeset/` contains no unreleased changeset (including empty files), and the pinned Changesets library proposes no
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

## Authorized version preparation

Preparation of all eight packages at 0.2.0 is authorized, and PR #28 is where it happened.
Its baseline contains the issue #27 gate repair, so the transition below is proven rather
than asserted. Preparation does not authorize merging, dispatching or publishing. The
publication decisions below remain separate human approvals.

1. **Authorized version preparation.** _Prepared and merged in PR #28._ `changeset version`
   consumed all three pending changesets and produced exactly the outcome the pinned
   release plan predicted. That completed version preparation only; it did not authorize
   publication, and the full canonical matrix remains required for any future dispatch.
   The pinned release plan and `linked` configuration keep the eight in step:

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
   `.changeset/` now holds no pending intent. `@relvo-labs/reference-app` is private, was
   deliberately left at `0.0.0`, and is never published. No other manifest field moved:
   the version-only proof compares every workspace manifest against the baseline and
   admits exactly the planned `version`.

   `changelog: false` is set in `.changeset/config.json`, so `changeset version` generates
   no `CHANGELOG.md`. The release information those three changesets carried — including
   their `BREAKING:` notes — is preserved in [`release-notes.md`](release-notes.md)
   instead. That file, not a generated changelog, is what a reviewer reads to see what
   0.2.0 actually contains.

   Preparing the versions did not authorize publication. Separate authorized runs have now
   published all eight `0.2.0` packages. A future release can only be dispatched against a
   commit that is the exact current tip of `main`, with the canonical gate green on that
   commit, a scope that excludes every immutable `0.2.0` version, fresh human authority for
   every named package, and the `npm-release` environment approval given for that run.

   The gate step that once refused this shape of PR is issue #27, fixed in PR #29 and
   present in this candidate's baseline: `pnpm changeset:status` now proves a dedicated
   version transition instead of reading a bare CLI coverage answer. Issue #26 — preflight
   gathering artifacts before it evaluates diagnostics — is a separate, still-open
   limitation and is not addressed here.

## Outstanding human approvals

Every future publication still requires the following human-controlled prerequisites.

1. **Registry ownership and the `npm-release` environment.** The `@relvo-labs` scope,
   the `NPM_TOKEN` secret (granular, write-limited to this scope, short-lived) and the
   environment's required reviewers are configured by a human outside this repository.
   Nothing here edits repository settings.

2. **Each dispatch.** Scope, dist-tag and confirmation are typed per run, and the
   environment approval is given per run.

## First-release evidence policy

A future pre-1.0 version may be published only when the evidence below exists and is stated
accurately. This policy is not weakened by prior releases or by the existence of a release path.

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
  not a recovery plan. A reviewer must accept that before every dispatch.

## Dispatching a release

1. Freeze the exact current tip of `main` that carries the reviewed versions; that commit is
   `source_sha`. If a version-preparation change was required, it must already be merged.
2. Confirm the canonical gate is green on that commit and reconcile every package in the
   proposed scope against the registry. Exclude every version already published.
3. Actions → **release** → _Run workflow_ on `main`, with, for example:
   - `source_sha`: `<the 40-character merge commit>`
   - `packages`: `@relvo-labs/<package>@<reviewed-version> ...` (list the exact,
     dependency-closed scope; never substitute an already-published `0.2.0` version)
   - `dist_tag`: `latest` (a prerelease version may never be published under `latest`)
   - `confirm`: `publish <count> package(s) from <source_sha> to latest`
4. Read the `verify` job output: it prints the full plan, the plan digest, the publication
   order, each tarball's integrity, and every publishable package left **out** of scope.
5. Approve the `npm-release` environment only if that plan is exactly what you intended.
6. Read the `publish` job output: each package is uploaded once, recorded as
   `accepted_pending`, and then reconciled against the registry — read-only, for up to
   20 minutes — before the next one is attempted. A run that sits quietly for minutes
   after an upload is doing exactly what it should; npm is still scanning the package.
   Expect the job to take longer than the upload time suggests, and never cancel it to
   "retry": the versions it has already uploaded are immutable.

## What the first dispatch established

Everything above is verified locally and in the gate, but four facts could only be
observed the first time this workflow actually ran. Run 34753860073 observed all four
holding — the artifact download by id, the anonymous remote read, the pinned npm minting
provenance with the granular token, and the environment's reviewers — and then failed on
the one thing no local test covered: the delay between npm accepting a version and the
registry serving it. That is now modelled above; the list is kept because it is what a
reader of a future first-of-its-kind dispatch should still watch for, and because a
failure in any of them is a workflow bug rather than a reason to retry with a wider scope:

- that the gated job can download the verify job's artifact by id with only
  `contents: read` (same-run downloads use the run's own token, not `actions: read`);
- that `git ls-remote origin refs/heads/main` succeeds in the gated job. `actions/checkout`
  runs with `persist-credentials: false`, so this is an anonymous read of the remote. It
  works for a public repository; if this repository is private when the first release is
  dispatched, the run will **refuse** rather than publish, and that refusal is the control
  working. Fixing it is a reviewed change to how the remote tip is observed, never a
  removal of the check;
- that the pinned `npm` this repository installs accepts the granular token and mints
  provenance with `id-token: write`;
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

| Summary line             | What it means                                                     | What to do                                                     |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `published and verified` | uploaded, and the registry serves what was reviewed               | done; never name it again in any dispatch                      |
| `accepted_pending`       | npm accepted the bytes; this run could not confirm what is served | never republish; reconcile it by hand (see below)              |
| `outcome unknown`        | upload attempted, and the registry could not be consulted         | establish whether it is public **before** dispatching anything |

`accepted_pending` is the line to read most carefully, because it is the one a
hurried reader turns into a second dispatch. It means the registry has the
bytes. The version is immutable whether or not it is visible yet, so the
failure code tells you what to do next: `visibility_not_confirmed` (the bounded
wait expired — check the npm account's notifications for a manual-review or
blocked-package notice), `readback_unavailable` (the registry would not answer —
find out why before anything else), or `readback_mismatch` (the registry served
something other than the reviewed artifact — treat that as a supply-chain
incident, not a retry).

- Nothing is unpublished or overwritten. Do not attempt to "fix" a published version.
- Recovery is a **new** dispatch whose scope names only the packages that are confirmed
  still unpublished, at the same versions, reviewed and approved again.
- A version in either of the two rows below `published and verified` is, or may be,
  public and immutable. Naming
  it in a recovery dispatch cannot succeed — preflight will refuse it once the registry
  lists it, which is the intended behaviour, and is why the summary never folds an
  attempted upload into "nothing was published".

## Local rehearsal

Preflight is credential-free and can be run locally against built, packed artifacts.
Use the actual branch and an explicitly local event; never impersonate `workflow_dispatch`
on `refs/heads/main`. That would spoof the two facts preflight exists to check, and a
rehearsal that lies about its own context cannot tell you anything about a real one. A
local run must refuse release eligibility. Packing still precedes diagnostic evaluation,
so a rehearsal can fail while gathering artifacts before it reports any finding; issue #26
tracks that ordering separately.

```bash
export RELEASE_EVENT_NAME=local_nonpublishing_verification
export RELEASE_REF=$(git symbolic-ref -q HEAD || printf detached)
export RELEASE_SOURCE_SHA=$(git rev-parse HEAD) RELEASE_RUNNER_SHA=$(git rev-parse HEAD)
export RELEASE_PACKAGES='@relvo-labs/agent-protocol@0.2.0'
export RELEASE_DIST_TAG=latest
export RELEASE_CONFIRM="publish 1 package(s) from $RELEASE_SOURCE_SHA to latest"
node tools/release/preflight.ts --staging /tmp/release-staging
```

The one-package example is diagnostic only. It deliberately names the already-published,
immutable protocol version so registry preflight must reject it; never copy that package
scope into a real dispatch.

Read the findings rather than the exit code alone: the question a rehearsal answers is
_which_ facts it could not establish, not merely that it said no. With honest inputs the
dispatch-context findings — not a `workflow_dispatch`, not on `main`, and a `source_sha`
that is not the remote tip — are among the answers you want to see, and they are separate
from the package and inventory facts the same run does establish.

## Feature coverage and version-only proof

The pinned Changesets 3.0.1 CLI can reject a correct version PR before writing status
JSON: packages changed relative to `main`, but versioning consumed all intents. Release
preflight therefore inventories the library release plan directly. An empty inventory
means no planned release; it does not authorize a feature change or a publication.
Publication still refuses raw pending files, including empty and malformed intents.

`pnpm changeset:status` keeps the upstream CLI coverage assertion for feature branches
and requires a real changeset naming each changed public package. For a dedicated version
transition it reads baseline manifests and real intents from the configured branch's
Git merge base and computes the expected versions using the pinned libraries. Every
workspace manifest must match that baseline except for the exact planned version. It
refuses unconsumed intents, missing or arbitrary bumps, package additions/deletions,
source/test/build/tooling-input changes anywhere in the repository, other manifest
edits and planning-config changes.
READMEs may document release evidence; configured changelogs may carry release notes.
Prerelease transitions and dependency-range rewrites are outside the current proof.
No dummy intent, alternate comparison ref, label or environment bypass is used.

The five directly imported planning libraries are exact catalog pins matching the
existing Changesets CLI dependency graph. They add no transitive packages and replace
CLI JSON inventory, not the CLI feature-coverage assertion. They are ESM packages from
the existing Changesets/manypkg projects; removing them would require another reviewed
inventory and baseline-planning implementation. The lockfile retains their existing
resolutions and integrity hashes.

This candidate is what that proof was built for: it is a dedicated version transition on a
baseline that already contains the proof, so `pnpm changeset:status` reports `version-only`
rather than a coverage answer. The check reads `main` as a local ref, exactly as the gate
workflow materializes it from `origin/main` before running — a stale local `main` compares
against the wrong baseline and refuses, which is the check working, not a finding about
the candidate.
