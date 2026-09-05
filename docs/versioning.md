# Versioning

The npm package version and wire version answer different questions.

- Package versions describe the TypeScript/JavaScript API and artifact. All packages begin pre-1.0 and use Changesets to record version intent. Additive and breaking public changes both require a minor bump; breaking notes begin with `BREAKING:`.
- `WIRE_VERSION` describes serialized commands, receipts, events, snapshots, capabilities, workspace DTOs, and generated JSON Schema identities. Pre-1.0 wire compatibility is exact by minor line. Strict-object fields and closed-union variants—including optional additions—require a new wire minor once a line is published; old readers reject them. Package patches or minors may retain the same wire version only when serialized schemas are byte-for-byte compatible.

Foundation v0.4 is the unreleased initial line, so release-blocker corrections are incorporated before its first publication rather than pretending the reviewed candidate was already a compatible public contract. After publication, the versioned compatibility fixtures are immutable.

No publish workflow exists. Version files and pending Changesets provide evidence and release intent only; publication requires a separate reviewed decision.
