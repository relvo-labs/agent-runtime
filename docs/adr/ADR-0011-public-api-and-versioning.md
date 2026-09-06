# ADR-0011: Public API and wire versions evolve independently

Status: Accepted

## Context

An npm release can change TypeScript helpers without changing serialized data, while one wire change can affect multiple packages.

## Decision

Use package semver/Changesets for exported JavaScript and TypeScript surfaces. Use `WIRE_VERSION` and versioned JSON Schema IDs for serialized compatibility. Pre-1.0 adapters require an exact wire minor match. Protocol objects and unions are closed: adding even an optional strict-object property or union variant requires a new wire minor after publication because an old reader rejects it. Additive and breaking package changes receive minor intent; breaking notes are explicit.

## Consequences

Package and wire versions do not have to move together. Consumers negotiate exact wire-minor compatibility rather than comparing npm versions or assuming unknown data is ignored. The unreleased initial v0.4 candidate may absorb release-blocker corrections before its schemas are first published; a published line is immutable.
