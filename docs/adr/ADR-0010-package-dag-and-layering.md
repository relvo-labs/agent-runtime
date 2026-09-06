# ADR-0010: Acyclic neutral package layering

Status: Accepted

## Context

If runtime imports a concrete provider, swapping adapters becomes impossible and provider-native concepts leak into core.

## Decision

Protocol is L0. Executor, provider SPI, and workspace SPI are L1. Git workspace and provider scaffold packages are L2. Runtime is L3 and depends only on protocol and neutral SPIs. Concrete providers depend inward on protocol/provider; applications compose them. A mechanical DAG check rejects undeclared edges, cycles, and deep imports.

## Consequences

Some shared types must move into protocol. Runtime remains adapter-neutral by construction.
