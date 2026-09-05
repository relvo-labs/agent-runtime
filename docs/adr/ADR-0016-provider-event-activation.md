# ADR-0016: Provider event activation is ordered and bounded

Status: Accepted

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
throw. Before activation the sink retains the first 256 captured valid values or captured
invalid-input diagnostics in emission order and counts, but does not retain, any deterministic
tail. Reusing or mutating an input object therefore cannot rewrite an earlier emission or
change whether that emission was valid.
Runtime first atomically commits `session.opened` or `turn.started` + `run.started`, installs
the in-process owner handle, then drains retained results in order. Only after the drain does
the sink become live; active emissions use the same point-in-time capture rule.

If the bound was crossed, Runtime appends a warning diagnostic after the retained inputs
that states the exact rejected count and buffer size. A provider event is therefore never
silently discarded merely because it was emitted synchronously during creation. If
creation itself fails, no owner exists; Runtime discards the inactive sink while the
command receipt reports the creation failure.

## Consequences

Normalized provider events always follow the start event for their owning identity.
Providers can emit synchronously without adding timers or deferring their own callbacks.
The cap is an in-process safety boundary, not flow control for an already-active sink.
An interaction request is accepted only while its owning run is running or already awaiting
another interaction. Requests emitted while interrupting or terminal are replaced by a
provider-contract diagnostic and cannot reverse the run state.

JSON Schema validators operate on parsed JSON instances, which have no object identity and
cannot contain cycles. Zod and provider ingress additionally inspect hostile in-process
JavaScript graphs. This acyclicity guard intentionally does not appear as a generated JSON
Schema keyword; parity claims cover every value representable by JSON text. Runtime catches
reflection/schema exceptions and converts them to the same diagnostic. JavaScript cannot in
general prove that a stateful `Proxy` will return the same values across separate reflective
operations, so providers must pass ordinary data objects rather than proxies or accessors.
