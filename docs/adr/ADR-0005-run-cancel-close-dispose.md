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

Runtime installs an in-memory interrupt fence before awaiting `ProviderRun.interrupt()`.
A concurrent interaction request becomes a provider-contract diagnostic rather than
reversing the run. If interrupt rejects, the fence rolls back; if interrupt succeeds but
persistence fails, the fence and logical command remain until exact retry or session cleanup.

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

The eventual close receipt describes the retained logical close operation, not only its
last cleanup attempt. If an earlier attempt interrupted an active run before disposal or
release failed, `interruptedActiveRun` remains true on the successful retry and on later
receipt replay, even if a different close command completed cleanup in between. This
follows the same command-ID reservation and first-acceptance rule.

A provider ingestion commit failure records a queryable fault for that session. The
fault prevents history reads, replaying subscriptions, and `quiesce()` from claiming
complete history. Close still follows its normal interrupt, disposal, release, and
receipt path. Its receipt reports cleanup, while the ingestion fault remains queryable
and history reads continue to reject. If a terminal commit failed, the stored run can
remain non-terminal; ingestion recovery is deferred to issue #43 with issue #6.

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
