# ADR-0017: One manual, environment-gated npm release path

Status: Accepted

## Context

Until now this repository had no publication path at all, and said so. That was honest but
not durable: the packages exist to be consumed, and the first publication is the moment
where a mistake becomes permanent. npm versions are immutable, dist-tags are observable
immediately, and unpublishing is not a recovery plan.

The alternatives were a Changesets publish workflow on merge, or `changeset publish` run by
hand. Both decide _scope_ implicitly — whatever the working tree happens to contain — and
both put a credential in the same job that builds the artifacts.

## Decision

Publication is a manual, explicitly scoped, environment-gated workflow, and the scope,
order and registry facts are proven before any credential exists.

- `workflow_dispatch` on `main` is the only entrance. There is no automatic trigger and no
  conditional job or step, so no release run can be green without having run.
- The operator states the full commit id, the exact `name@version` scope, the dist-tag and
  a confirmation phrase derived from those three facts.
- The ungated `verify` job runs the canonical gate, packs the named packages and runs a
  fail-closed preflight. Findings are refusals; there is no override input.
- The gated `publish` job re-derives everything locally — re-hashing the tarballs and
  re-reading the packed manifests — and then runs exactly one step that can see
  `secrets.NPM_TOKEN`. `id-token: write` exists only in that job, for provenance.
- Publication is one explicit tarball per `npm publish`, in dependency-topological order,
  with lifecycle scripts disabled, followed by a registry readback of identity, integrity,
  dependency ranges and dist-tag before the next package is attempted.
- An approval is not a snapshot of the world. Every fact it rested on that can change
  while it is pending — `source_sha` still being main's exact tip, the dist-tag not
  already pointing at something newer, every packed dependency still resolvable — is
  re-established in the gated job and again immediately before each individual upload.
  "Re-established" means observed, not recalled: main's tip is read from the **remote**
  with `git ls-remote`, because the checkout's cached `origin/main` is frozen for the
  life of the job; and a dependency this run published itself is looked up again like
  any other, because an upload this run performed is not evidence that the registry
  still serves it. An unanswerable remote or registry refuses.
- An artifact has exactly one identity or it is refused. What this repository reads out
  of a packed tarball and what npm extracts from it must never be two different packages;
  an offline differential test against npm's own bundled reader asserts that they either
  agree or that this repository refuses the archive. That reader is loaded out of the one
  npm this workspace pins — the same package that publishes — because an agreement with
  an npm that never sees the release is not an agreement about anything. Unrecognised
  header _formats_ are
  refused outright; inside the one recognised format, npm's field semantics are
  reproduced literally rather than approximated, because being stricter than npm about a
  format it accepts would reject artifacts this repository actually ships.
- Acceptance and verification are reported as different facts. A zero exit from
  `npm publish` means the bytes were accepted; only a readback means the registry serves
  what was reviewed. An accepted-but-unconfirmed upload is never folded into "nothing was
  published", because that is exactly the error that would invite a recovery dispatch
  naming an immutable version.
- Versioning is not part of this path. A release from a commit with pending version intent
  is refused; `changeset version` belongs to a separate reviewed PR.
- The workflow's structure is parsed and asserted by `pnpm release:check` inside the
  canonical gate, so widening it fails on a developer machine, not in a hosted run.

An unanswerable registry is never read as permission. Only a definitive 404 means "not
published"; an auth failure, a rate limit, a 5xx, a timeout or a malformed packument stops
the release.

## Consequences

Releasing takes two deliberate human actions (dispatch, then environment approval) and
cannot be triggered by merging. A partial failure stays partial: the run exits non-zero
having published a prefix of the scope, reported in three categories — verified,
accepted-but-unverified, and unknown — and recovery is a new, narrower, reviewed dispatch
naming only what is _confirmed_ still unpublished, rather than a retry that could
overwrite.

The policy check is exhaustive rather than a list of prohibitions, because a field a
policy does not assert is a field an attacker chooses. That makes editing the workflow a
two-file change: the workflow and the reviewed structure in `workflow-policy.ts`. That
friction is the point.

The release tooling that runs in either job imports nothing outside Node's standard
library — including its own narrow YAML-subset parser — so reviewing this path means
reviewing this repository's code rather than a supply chain. Four actions are trusted,
each pinned to a verified immutable commit; adding a fifth is a reviewed change, as is
passing an action any input its pinned revision does not declare.

There is one deliberate exception, and it was originally recorded the other way round.
This ADR first said the gated job installed no dependencies, and that the differential
test's `pacote` came out of "the npm bundled with the `.nvmrc` Node runtime" without
adding a workspace dependency. That was wrong about the runtime and, more importantly,
wrong about what published: `pnpm/setup` installs Node from the `node` package, which
bundles no npm, so on a runner the test could not load at all — and the publisher,
which spawned bare `npm` from `PATH`, was using a different program than any
differential run had ever compared against (run 34699256419). npm is therefore a pinned
devDependency of this workspace, both jobs install from the lockfile, and
`tools/release/lib/npm-tool.ts` proves the tool's identity before either the test or the
publisher uses it, with no `PATH` fallback and no environment override. It costs one
lockfile entry — npm vendors its own dependencies — and nothing it loads is shipped.

Proving an identity turned out to be narrower than resolving one. A review of the first
version of that module showed two ways the proof leaked, and both are now closed by
construction: npm is read from the explicit path `node_modules/npm` whose real path must
be owned by this repository — asking Node's resolver instead accepted an npm in an
ancestor directory or on `NODE_PATH` when the workspace had none — and each bundled
reader is bound to the realpath'd entry point `require` would load, confined to that
reader's own directory, because a `main` or `exports` pointing out of the package made a
contained `package.json` say nothing about the code that runs.

Nothing has been published. The outstanding human approvals, and the evidence required
before a first release, are recorded in `docs/release.md`.
