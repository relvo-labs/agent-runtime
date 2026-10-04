# ADR-0005: Separate run interrupt, session close, and provider dispose

Status: Accepted (amended by issue #43)

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
reversing the run. If interrupt rejects with a typed `ProviderRejection`, the fence rolls
back. If it fails in any other way, its outcome is unknown: the fence and the command's
slot stay, and the run's terminal waits. Every other `interrupt_run` for that run mirrors
the outcome, and only the owning command's exact retry calls the provider again. If
interrupt succeeds but persistence fails, the fence and logical command remain until exact
retry or session cleanup.

### Close and shutdown (issue #43)

Every session has one ordered ingestion queue (ADR-0002, ADR-0016). Close admission is
synchronous and happens outside any queued command, so it never waits behind a pending
provider call. Admission reserves the close identity, fingerprint and first acceptance
time, and fences the session: no new run, response or interrupt is admitted. A second close ID
is refused, retryably and without a receipt, while one close is unresolved. An exact retry
shares the close; a changed payload under the same ID is a conflict. `ifRunActive: 'reject'`
rejects while a run is active or still starting.

Cleanup phases, each attempted when the reducer allows it:

1. **Interrupt** the run (reason `session closing`), unless its interrupt is already in
   flight or observed.
2. **Dispose** the provider session, but only once no provider start or interaction
   response is unresolved.
3. **Release** the workspace, only after a **confirmed successful disposal**. A provider can
   therefore never use a released workspace.

Independent phases still run after one fails (disposal after a failed interrupt). Each failure is
retained phase-tagged (`run_interrupt`, `provider_dispose`, `workspace_release`) and the
close rejects retryably. The next attempt repeats only the failed phases: a successful or
in-flight call is never reissued.

Cleanup is independent of persistence: a blocked, failed or permanently ambiguous history
commit does not stop interrupt, disposal or release. Successful interrupt or disposal is
the truthful proof that ends the run. A provider completion observed while close's own
interrupt or disposal call is in flight is applied only after that call settles, so a
provider that ends the run in answer to close is recorded as interrupted by the close.

Close never awaits an unresolved provider start, response or unknown `interrupt_run`
outcome. It returns a retryable `provider_unavailable` naming what it waits for
(`details.pending`), and cleanup continues on its own when that settles:

- A late start that succeeds commits `turn.started` + `run.started` + its receipt ahead of
  `closing`. Its handle is never activated for new work: it is interrupted and disposed,
  then the lease is released.
- A late start that is rejected leaves only its rejected receipt. It discards only that
  run's staged output and any overflow caused solely by it; independent session faults
  survive.
- A start or response that never settles keeps one fenced record and the lease. Each
  close or shutdown returns a retryable error at once rather than wait.

History order is canonical. A run start precedes its output and earlier reservations. If
close selects the terminal, `session.state_changed → closing` precedes that terminal. If a
completion terminal was already submitted or committed, it keeps its frozen place and
outcome, and `closing` follows it. No body follows a terminal.

`session.closed` and the close receipt commit only after the accepted prefix, the run
terminal, `closing` and the real disposal and release. The receipt's `interruptedActiveRun`
accumulates across exact retries. A close receipt attests cleanup, not complete history.
A permanent overflow (O) does not prevent a successful close, and the session keeps its
overflow marker afterwards. A retryable failure (F) blocks the receipt until it is retried.
A permanently ambiguous commit (A) blocks it for good, although the cleanup effects still
run. If an open's provider session or lease exists but the open was never filled, rollback
also disposes first and releases only after a confirmed disposal. While the runtime still
owns a session whose `session.closed` commit is unconfirmed, a close is answered by that
ownership, not by the store's receipt or closed state: under A the exact retry and any other
close ID fail closed with the non-retryable fault, and no cleanup effect is repeated.

Close never awaits an unsettled store commit either (issue #43, accepted with decision B on
2026-10-04). Once cleanup is done, the attempt starts only the submission the queue allows
(an exact retry or shutdown resubmits a proven-unapplied head), lets ready continuations
run for a bounded number of scheduling turns while the session's head keeps advancing, then
inspects state instead of waiting. A confirmed `session.closed` returns the receipt; A
returns its non-retryable fault and F its retryable one. If a commit ahead of
`session.closed` (or `session.closed` itself) is still unacknowledged, the attempt returns a
retryable `store_unavailable` with `details.pending: 'persistence'`. No timeout declares a
commit applied, absent or failed: the ordinary head continues on its own, and a later close
or shutdown confirms the result without repeating any cleanup effect. With a store whose
commits settle asynchronously, a close or shutdown may therefore need a retry where it
previously waited.

Runtime shutdown is memoized per attempt. Its first call synchronously closes mutation
admission to new work and fences every live session with shutdown's internal close. A
command ID that still holds an unresolved identity, such as an `interrupt_run` with an
unknown outcome, is still admitted for its owner's exact retry: only that retry can
resolve it, and shutdown cannot succeed until it is resolved. That close neither
looks up nor records a caller receipt, so a caller cannot reserve a synthetic ID and
suppress cleanup. It resumes a proven-unapplied (F) head, retries retained open rollbacks,
and never waits on an unresolved provider promise or an unsettled store commit (the same
persistence-readiness rule as close). A blocked session is reported
(sorted, retryable unless A) while the other sessions close. Shutdown succeeds only after
every session's cleanup and history commits; it then closes subscriptions. A failed
attempt keeps admission closed, leaves subscriptions open, and lets the next `shutdown()`
call try again.

## Consequences

Hosts can continue after an interrupt. Closing remains the safe terminal fallback for less
capable providers. A provider promise that never settles can prevent a successful close
but can never block the caller or cause a workspace to be released under a live provider.
Successful turns leave constant bookkeeping: a run's handle and routes are dropped when
its terminal commits. A closed session keeps at most a permanent overflow marker, and its
provider sinks are cut off. None of this is crash-durable (issue #6).
