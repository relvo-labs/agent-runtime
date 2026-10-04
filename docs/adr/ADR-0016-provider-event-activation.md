# ADR-0016: Provider event activation is ordered and bounded

Status: Accepted (amended by issue #43; the amendment below is implemented and replaces
the former warning-only tail)

## Context

An in-process provider can call its synchronous event sink before
`createSession()` or `startRun()` returns. Committing immediately races ahead of the
session or run projection and silently discards valid output. Buffering without a bound
turns a misbehaving provider into an activation-time memory leak.

## Decision

Each creation call receives an inactive sink. Every synchronous `emit()` first applies the
shared JSON-value graph guard, then parses, clones, and freezes its input before returning to
provider code. Self-cycles and mutual object/array cycles fail the guard; repeated references
are accepted when no path reaches an ancestor. A rejection is captured as a typed
`provider_contract_violation` diagnostic, not as the invalid input, and the sink does not
throw. Reusing or mutating an input object therefore cannot rewrite an earlier emission or
change whether that emission was valid.

Every captured emission joins its session's single ordered ingestion queue (issue #43),
behind the reservation of its owning `session.opened` or run start. Runtime commits the
owner first, then the retained emissions in order. A command returns only after the output
staged behind its owner is persisted (or a fault is queryable).

Activation captures count toward the session's shared 1,023-operation budget. That budget
covers every nonterminal operation: its in-flight head and every reserved pre-effect
operation. The 256-entry pre-activation bound is an additional per-sink guard inside that
budget, not 256 extra entries. Crossing either bound refuses the excess before it is
accepted. It also **permanently marks the session's history incomplete (O)** and
interrupts the run once a provider handle exists. The retained prefix still drains in
order, and one terminal slot stays reserved. No warning tail is appended: replay never
looks complete. The overflow marker survives close for the runtime lifetime, even when
close returns a truthful cleanup receipt.

No claim is made about a byte or memory limit: one valid JSON body may be large. A command
refused at the operation budget receives a retryable error and does not mark O, because
nothing it carried was lost. If creation itself fails, no owner exists: Runtime discards the
inactive sink and its staging without manufacturing a session fault, and the command
receipt reports the creation failure. If a run start is rejected after staging, Runtime
discards only that run sink's provisional output, releases its capacity and rolls back an
overflow caused solely by it; an independent session-sink fault persists. A late
successful start is committed before any of its retained run events, even if a close has
already fenced admission. The provider handle may be disposed safely while the head is
blocked, but no close receipt can bypass it. A sink whose run has finished, or whose session
has closed, is stale: its emissions are discarded before they are counted.

## Consequences

Normalized provider events always follow the start event for their owning identity.
Providers can emit synchronously without adding timers or deferring their own callbacks.
The cap is an in-process safety boundary, not flow control for an already-active sink.
An interaction request is accepted only while its owning run is running or already awaiting
another interaction. A request emitted while the run is interrupting or otherwise ending is
replaced by a provider-contract diagnostic; once the run's terminal has committed its sink
is stale and the request is discarded. Neither can reverse the run state.

JSON Schema validators operate on parsed JSON instances, which have no object identity and
cannot contain cycles. Zod and provider ingress additionally inspect hostile in-process
JavaScript graphs. This acyclicity guard intentionally does not appear as a generated JSON
Schema keyword; parity claims cover every value representable by JSON text. Runtime catches
reflection/schema exceptions and converts them to the same diagnostic. JavaScript cannot in
general prove that a stateful `Proxy` will return the same values across separate reflective
operations, so providers must pass ordinary data objects rather than proxies or accessors.
