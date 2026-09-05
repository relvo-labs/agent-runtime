# ADR-0007: ESM package artifacts and replaceable bundling

Status: Accepted

## Context

Dual ESM/CJS packages create two module identities for stateful registries. A build-tool default must not become an accidental public contract.

## Decision

Publish ESM-only packages with explicit `exports`, types-first conditions, `.js` runtime files, `.d.ts` declarations, and a `./package.json` export. tsdown is the current declaration/bundle implementation. It may be replaced if tarball paths, export semantics, declarations, source compatibility, and behavior across the supported Node 22/24/26 matrix remain unchanged.

## Consequences

CommonJS consumers use dynamic import or an application-level bridge. publint, Are The Types Wrong, and clean tarball installs validate the tool-independent artifact contract.
