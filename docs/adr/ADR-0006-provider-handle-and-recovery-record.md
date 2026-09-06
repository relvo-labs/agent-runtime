# ADR-0006: Provider handles and recovery records are different things

Status: Accepted

## Context

Live provider sessions may contain child processes, sockets, callbacks, and native identifiers. Persisting those objects is impossible and would expose provider-specific contracts.

## Decision

Keep `ProviderSession` and `ProviderRun` as non-serializable in-process handles. `ProviderRun.completion` resolves a Zod-defined provider termination input without a timestamp. Runtime parses it and owns terminal time. A rejected, malformed, or lifecycle-impossible completion is normalized to one failed run with `provider_contract_violation`, never swallowed. A capable adapter may export a versioned recovery record containing provider ID/version, exact line-bound wire version, and a JSON-safe opaque value. Only that provider interprets the opaque value. Resume is optional and capability-gated.

Completion is validated against the run state observed before Runtime settles pending
interactions. A success reported while the run is awaiting input is therefore a contract
violation even though cancelling the interactions would subsequently resume the projection
to `running`. Runtime emits explicit interaction settlements before `run.finished`; replay
rejects a terminal event while any interaction owned by that run remains pending.

## Consequences

Core storage stays provider-neutral. Recovery compatibility is explicitly owned by each adapter rather than inferred from package versions.
