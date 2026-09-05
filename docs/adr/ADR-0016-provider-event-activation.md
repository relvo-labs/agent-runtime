# ADR-0016: Provider event activation is ordered and bounded

Status: Accepted

## Context

An in-process provider can call its synchronous event sink before
`createSession()` or `startRun()` returns. Committing immediately races ahead of the
session or run projection and silently discards valid output. Buffering without a bound
turns a misbehaving provider into an activation-time memory leak.

## Decision

Each creation call receives an inactive sink. Before activation it retains the first 256
`ProviderEventInput` values in emission order and counts, but does not retain, any
deterministic tail. Runtime first atomically commits `session.opened` or `turn.started` +
`run.started`, installs the in-process owner handle, then drains retained inputs in order.
Only after the drain does the sink become live.

If the bound was crossed, Runtime appends a warning diagnostic after the retained inputs
that states the exact rejected count and buffer size. A provider event is therefore never
silently discarded merely because it was emitted synchronously during creation. If
creation itself fails, no owner exists; Runtime discards the inactive sink while the
command receipt reports the creation failure.

## Consequences

Normalized provider events always follow the start event for their owning identity.
Providers can emit synchronously without adding timers or deferring their own callbacks.
The cap is an in-process safety boundary, not flow control for an already-active sink.
