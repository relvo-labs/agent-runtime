# ADR-0002: Command receipts and idempotency

Status: Accepted

## Context

Callers retry mutations after transport uncertainty. Retrying an unkeyed mutation can create duplicate work; ignoring key reuse can lose work.

## Decision

Every mutation carries a caller-generated command ID. Store the canonical payload
fingerprint and first receipt. Same ID plus same payload returns `duplicate` with the
original result and time once that receipt is committed. An exact retry that reaches a
reservation still queued (because its first attempt returned a persistence fault or an
unknown provider outcome) receives that slot's own receipt when it commits, or the same
error. Same ID plus another payload returns `command_id_conflict`, without recording it.
Persist rejections as well as success. Validation rejection participates in the same rule
when the submitted value has a safely inspectable, schema-valid primitive command ID.
Runtime fingerprints the original raw input without invoking accessors and persists the
rejection; correcting the payload under that ID is therefore a conflict. Inputs whose
identity cannot be inspected safely cannot reserve an untrusted identity.

Before any provider effect, `submit_turn`, `respond_to_interaction` and `interrupt_run`
reserve their command identity, fingerprint, acceptance time and one ordered slot in
their session's ingestion queue (issue #43). The provider's outcome fills that same slot:
the start bundle, the response settlement or the interrupt receipt when it applied, and a
rejected receipt when the provider threw a typed `ProviderRejection`. Any other failure
(a bare `Error`, a transport or native failure, any thrown value, never inspected or
copied) is an unknown outcome. The slot stays unresolved and its run's terminal waits.
The command returns a retryable `provider_unavailable` with a fixed message, and only
an exact retry of that command delivers the same effect again. That re-delivery is why
the provider SPI requires idempotent `startRun` (same `runRef`), response and interrupt
handling.

An exact retry of a definitely rejected command replays its rejected receipt.

An `interrupt_run` with a new command ID chooses its outcome at its own admission, after
the commands queued ahead of it and its command lookup, not when it is invoked
(maintainer decision 2026-10-04). If an interrupt slot can still be reserved for the
nonterminal run, the command mirrors the run's one interrupt while that interrupt is in
flight, or its outcome is unknown and still owned by its command, or its success was
already observed. It waits for that outcome and never calls the provider; only the owning
command's exact retry does. A definite rejection observed before admission leaves no
shared interrupt, so an `interrupt_run` with a new command ID admitted after the definite
rejection is a new interrupt and calls the provider again while the run remains
interruptible. A run that the store already shows as terminal at admission gets the
applied no-op `delivered: false`. A terminal that is placed or submitted but not yet
established as applied, a close in progress, or an ingestion fault returns the existing
transient or fault error and reserves nothing. An admitted command keeps its chosen
outcome through later completion and persistence recovery. A command that only waited in
the runtime's queues is promised no outcome from the time it was invoked.

If a slot's commit fails, the command returns the session's ingestion fault: retryable
when the commit is proven not to have applied, non-retryable when its outcome is unknown.
An exact retry of the command resubmits the identical frozen bundle without calling the
provider again. If provider completion races a delivered response, the response is
ordered first; the completion cannot rewrite it into an `interaction_already_settled`
rejection. This is bounded by outstanding commands and sessions and is not crash
durability.

Within one Runtime instance, a command ID is admitted once. A synchronous claim is taken
before the receipt lookup and bound to the reserved slot. It is held until that slot's
receipt commits, so a lookup can never miss a commit that happened while it was in
flight. A same-payload admission that finds the claim unbound waits until it is bound,
then shares the slot's provider call and outcome. A different payload is the not-recorded
`command_id_conflict`. Claims are released when their slot commits, so they are bounded by
unresolved slots, including unknown ones, until an exact retry resolves them. Same-ID
commands are also serialized by the runtime. An exact retry invoked while the original's
provider call is in flight shares that call's outcome even when it is admitted only after
the call settled: a concurrent retry never re-delivers, and receives the same unknown
outcome. Only an exact retry invoked after an unknown outcome delivers again. `submit_turn`, `interrupt_run` and
`respond_to_interaction` for one session run one at a time; `close_session` does not join
that queue (ADR-0005). Unrelated sessions proceed independently, and queue entries are
removed after their final waiter settles.

Refusals before any effect follow one rule. A permanent fact is recorded as a rejected
receipt: an unknown session or run, a closed session, a `submit_turn` while another run is
active or a close is admitted, or an interaction that is already settled. A condition that
may change without any change to the command is returned as a typed error and never
recorded, so the exact retry later receives the truthful answer:

- ingestion capacity (`store_unavailable`, `details.reason: 'capacity'`);
- a blocked or permanently incomplete history;
- a run that is ending;
- a close in progress;
- an unresolved competing response.

These maps are not a distributed lock. A durable deployment with multiple Runtime
processes must provide a single writer per session and command-ID scope, or extend its
store boundary with a transactional command claim/unique constraint before invoking an
external provider effect. The in-memory store guarantees only one Runtime instance.

## Consequences

Retries converge deterministically and one interaction response reaches the provider,
except that an unknown provider outcome is re-delivered by its exact retry, which the
provider must handle idempotently.
Receipt retention becomes durable-store policy and command IDs must be globally unique
within that policy scope. Multi-writer admission remains the durable host's responsibility.
