# Versioning

The npm package version and wire version answer different questions.

- Package versions describe the TypeScript/JavaScript API and artifact. All packages begin pre-1.0 and use Changesets to record version intent. Additive and breaking public changes both require a minor bump; breaking notes begin with `BREAKING:`.
- `WIRE_VERSION` describes serialized commands, receipts, events, snapshots, capabilities, workspace DTOs, and generated JSON Schema identities. Pre-1.0 wire compatibility is exact by minor line. Strict-object fields and closed-union variants—including optional additions—require a new wire minor once a line is published; old readers reject them. Package patches or minors may retain the same wire version only when serialized schemas are byte-for-byte compatible.

Line-bound documents that carry a `wireVersion` use a literal for that line in both Zod
and generated JSON Schema. Provider descriptors are negotiation inputs: their version is
intentionally parsed as a bounded string, then compared explicitly before registration.

Foundation v0.4 is the unreleased initial line, so release-blocker corrections are incorporated before its first publication rather than pretending the reviewed candidate was already a compatible public contract. After publication, the versioned compatibility fixtures are immutable.

Nothing has been published yet. Version files and pending Changesets record intent only: a version bump is made by a separate reviewed release PR running `changeset version`, and publication is a manual, explicitly scoped dispatch of [`.github/workflows/release.yml`](../.github/workflows/release.yml) that refuses to run while any changeset is still pending. See the [release runbook](release.md).
