# ADR-0005: Separate run interrupt, session close, and provider dispose

Status: Accepted

## Context

Killing a provider session to cancel one attempt destroys conversation state and makes the terminal outcome unclear.

## Decision

`interrupt_run` targets one Run and normally leaves the Session ready. `close_session`
terminalizes active work according to policy and requires both provider disposal and
workspace release before the Session becomes terminal. `ProviderSession.dispose()` is
idempotent cleanup, not the ordinary run-cancellation API. A provider unable to interrupt
independently declares that limitation.

A close attempt invokes provider disposal and lease release once each, even if the first
operation rejects. Either failure rejects as a retryable `AgentRuntimeError` with an
ordered, phase-tagged failure list. Runtime does not emit `session.closed`, persist the
close receipt, or remove the live session until both operations have succeeded. The
session remains `closing`, and the exact command ID may retry because no receipt exists.
Run fallback events are emitted at most once, and only after interrupt or successful
disposal makes their terminal state truthful.

The failed close still retains its command fingerprint before cleanup begins. The exact
payload may retry; changing `ifRunActive` under the same ID is a conflict and cannot reach
cleanup. If opening fails after a lease has been validated, Runtime retains the provider
session and lease as rollback cleanup until both are released. Rollback failure rejects
observably and stores no final receipt; an exact command retry or shutdown retries cleanup
without acquiring another workspace or creating another provider session.

Runtime shutdown is memoized. Its first call synchronously closes mutation admission,
drains commands already admitted, closes every resulting live session, releases leases,
and closes subscriptions. Concurrent callers receive the same cleanup promise; later
mutations reject and cannot acquire a workspace or create a provider session. A cleanup
failure rejects that attempt without closing subscriptions or declaring shutdown complete.
The next `shutdown()` call starts another cleanup attempt while admission remains closed.
Shutdown invokes an internal session-close operation that neither looks up nor records a
caller command receipt, so a caller cannot reserve a synthetic ID and suppress cleanup.
It also retries retained open rollbacks and cannot succeed while any rollback remains.

## Consequences

Hosts can continue after an interrupt. Closing remains the safe terminal fallback for less capable providers.
