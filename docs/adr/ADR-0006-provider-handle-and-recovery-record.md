# ADR-0006: Provider handles and recovery records are different things

Status: Accepted

## Context

Live provider sessions may contain child processes, sockets, callbacks, and native identifiers. Persisting those objects is impossible and would expose provider-specific contracts.

## Decision

Keep `ProviderSession` and `ProviderRun` as non-serializable in-process handles. `ProviderRun.completion` resolves a Zod-defined provider termination input without a timestamp. Runtime parses it and owns terminal time. A rejected or malformed completion is normalized to one failed run with `provider_contract_violation`, never swallowed. A capable adapter may export a versioned recovery record containing provider ID/version, wire version, and a JSON-safe opaque value. Only that provider interprets the opaque value. Resume is optional and capability-gated.

## Consequences

Core storage stays provider-neutral. Recovery compatibility is explicitly owned by each adapter rather than inferred from package versions.
