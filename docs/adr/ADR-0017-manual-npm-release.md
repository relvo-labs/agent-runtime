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
having published a known prefix of the scope, and recovery is a new, narrower, reviewed
dispatch rather than a retry that could overwrite.

The release tooling imports nothing outside Node's standard library — including its own
narrow YAML-subset parser — so the gated job installs no dependencies, and reviewing this
path means reviewing this repository's code rather than a supply chain. Four actions are
trusted, each pinned to a verified immutable commit; adding a fifth is a reviewed change.

Nothing has been published. The outstanding human approvals, and the evidence required
before a first release, are recorded in `docs/release.md`.
