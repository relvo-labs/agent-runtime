# ADR-0001: Separate Session, Turn, Run, and Interaction identity

Status: Accepted

## Context

Provider conversations, caller requests, execution attempts, and correlated questions have different lifetimes. Reusing one identifier makes retry, cancellation, and replay ambiguous.

## Decision

Define four distinct branded and runtime-validated IDs. A Session owns ordered Turns; a Turn owns one or more attempted Runs over time; an Interaction belongs to exactly one Run. Provider-native identifiers stay behind the provider SPI.

## Consequences

Consumers can correlate without array positions or provider details. More IDs appear in DTOs, but incorrect cross-entity use fails at compile and parse time.
