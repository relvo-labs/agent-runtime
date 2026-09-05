# ADR-0009: In-process providers are trusted plugins

Status: Accepted

## Context

An in-process adapter has the host process's filesystem, network, environment, and native-code privileges. Capability metadata cannot revoke those privileges.

## Decision

Document adapters as trusted plugins. Approval and permission descriptors state provider-reported intent for UX and audit; they are not sandbox enforcement. Core makes no isolation claim. Sandboxed or remote execution requires a future process/transport boundary outside v0.4.

## Consequences

Hosts must vet adapters. Security documentation cannot promise controls the runtime does not possess.
