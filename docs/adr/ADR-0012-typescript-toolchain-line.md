# ADR-0012: TypeScript toolchain line

Status: Accepted

## Context

The repository runs TypeScript tooling directly under Node and requires typed ESLint plus declaration emission across the supported Node lines.

## Decision

Pin TypeScript 6 exactly until the native TypeScript 7 toolchain and its ecosystem provide equivalent compiler-API support. Compile against Node 22 types, the lowest supported line. Enable strict, exact optional, unchecked-index, isolated-module, verbatim-module, and erasable-syntax checks.

## Consequences

Newer Node-only APIs cannot enter by accident. A TypeScript-major change requires a dedicated compatibility review.
