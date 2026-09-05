# ADR-0003: Replay-then-live subscriptions and backpressure

Status: Accepted

## Context

Reading history before attaching a listener loses events in the gap. Unlimited subscriber buffers turn a slow reader into a memory leak; silent drops make projections unverifiable.

## Decision

Attach a constant-space listener first. Before iteration and during replay it records only
the highest published sequence; durable storage owns the event bodies. Replay history to
that high-water mark, atomically switch to bounded live buffering, then announce
`caught_up`. An event crossing the transition is therefore read durably or buffered live,
never neither or both. On overflow emit an explicit message with the first undelivered
sequence and a resumable cursor; close or skip according to declared policy. Never remove
durable events because a subscriber is slow.

## Consequences

Merely obtaining a subscription retains constant event space even if iteration never
starts. Consumers must handle `caught_up` and `overflow`. Durable storage remains the
recovery authority, and closing or returning an iterator unregisters it idempotently.
