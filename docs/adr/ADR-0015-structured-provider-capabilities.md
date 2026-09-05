# ADR-0015: Structured provider capability differences

Status: Accepted

## Context

A growing boolean bag cannot express cooperative versus immediate interrupt, partial output, blocking versus advisory approval, or session viability after cancellation.

## Decision

Use nested descriptors for run interruption/streaming, question and approval modes, workspace requirements, and recovery. Defaults are conservative. Registration parses the descriptor once, deep-freezes the normalized snapshot, and uses that snapshot for listing and every capability decision. Contradictions such as resume without recovery export, or positive interrupt guarantees with an unsupported interrupt mode, are invalid. Providers may add JSON-safe namespaced extensions; core does not manufacture common behavior that the adapter cannot guarantee.

## Consequences

Hosts can make explicit UX decisions and fail before an unsupported action. Descriptor additions remain possible without turning every capability into a required boolean.
