# ADR-0005: Separate run interrupt, session close, and provider dispose

Status: Accepted

## Context

Killing a provider session to cancel one attempt destroys conversation state and makes the terminal outcome unclear.

## Decision

`interrupt_run` targets one Run and normally leaves the Session ready. `close_session` is terminal, first settling active work according to policy, then disposing provider resources and releasing the workspace. `ProviderSession.dispose()` is idempotent cleanup, not the ordinary run-cancellation API. A provider unable to interrupt independently declares that limitation.

Runtime shutdown is memoized. Its first call synchronously closes mutation admission,
drains commands already admitted, closes every resulting live session, releases leases,
and closes subscriptions. Concurrent callers receive the same cleanup promise; later
mutations reject and cannot acquire a workspace or create a provider session.

## Consequences

Hosts can continue after an interrupt. Closing remains the safe terminal fallback for less capable providers.
