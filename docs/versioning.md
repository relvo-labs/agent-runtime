# Versioning

The npm package version and wire version answer different questions.

- Package versions describe the TypeScript/JavaScript API and artifact. All packages begin pre-1.0 and use Changesets to record version intent. Additive and breaking public changes both require a minor bump; breaking notes begin with `BREAKING:`.
- `WIRE_VERSION` describes serialized commands, receipts, events, snapshots, capabilities, workspace DTOs, and generated JSON Schema identities. Pre-1.0 wire compatibility is exact by minor line. Strict-object fields and closed-union variants—including optional additions—require a new wire minor once a line is published; old readers reject them. Package patches or minors may retain the same wire version only when serialized schemas are byte-for-byte compatible.

Line-bound documents that carry a `wireVersion` use a literal for that line in both Zod
and generated JSON Schema. Provider descriptors are negotiation inputs: their version is
intentionally parsed as a bounded string, then compared explicitly before registration.

Foundation v0.4 is the initial pre-1.0 line. All eight public packages have an immutable
`0.2.0` release. The wire compatibility fixtures published by
`@relvo-labs/agent-protocol@0.2.0` are therefore immutable.

A version file records intent, not a release: a version bump is made by a separate reviewed
release PR running `changeset version`, and publication is a manual, explicitly scoped
dispatch of [`.github/workflows/release.yml`](../.github/workflows/release.yml) that refuses
to run while any changeset is still pending. The eight public package manifests are prepared
at `0.2.0` with no changeset pending, but that does not authorize another publication.

A release runs only against a commit that is the exact current tip of `main`, with the
canonical gate green on that commit and the `npm-release` environment approval given for
that run. Carrying a version number is one of those conditions and the weakest of them — it
makes a line reviewable, not releasable. No published `0.2.0` package may be named in a
dispatch again; every future version and scope needs fresh human authority. See the
[release runbook](release.md) and the [release notes](release-notes.md).

Because `.changeset/config.json` sets `changelog: false`, consuming a changeset does not leave a generated `CHANGELOG.md` behind. `docs/release-notes.md` carries that information forward per prepared version, including the `BREAKING:` notes that justify a pre-1.0 minor.
