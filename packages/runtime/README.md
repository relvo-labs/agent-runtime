# `@relvo-labs/agent-runtime`

Provider-neutral runtime with an injected store, workspace provider, and provider SPI. The in-memory store commits events and projections together. Command IDs make exact command retries idempotent within one runtime instance. Everything below is process-local: the in-memory store loses all data on crash or restart, nothing is crash-durable, and no provider or workspace effect is exactly-once. Durable effect intent and crash reconciliation are tracked in issue #6.

## Implemented lifecycle behavior

- **One ordered ingestion queue per session.** Provider events (captured before `emit()` returns), command effects, run terminals, `closing` and `session.closed` are committed in one order per session (issue #43). A command reserves its place before the provider is called, and the provider's outcome fills that same place. A session holds at most 1,023 unpersisted operations; a command refused at that bound gets a retryable `store_unavailable` (`details.reason: 'capacity'`) and loses nothing. There is no byte budget: one large provider value can still use a lot of memory.
- **Faults: A, O, F.** `getProviderIngestionFaults()` returns at most one entry per session, the most severe first. `error.details.fault` names the kind:
  - **A** (`ambiguous`): a store commit's outcome is unknown. Never resubmitted. Non-retryable `store_unavailable`. It clears only if read-back proves the commit applied or absent; otherwise it is permanent for the runtime lifetime.
  - **O** (`overflow`): provider history was refused at a bound and is permanently incomplete. Non-retryable, and it survives a successful close.
  - **F** (`failure`): a commit was proven not to apply. Retryable `store_unavailable` with a saturating `failureCount`.

  `quiesce()`, `readEvents()` and replaying subscriptions reject while a session has any fault, rechecking around every store page. An idle live subscriber wakes and its pending `next()` rejects as soon as a fault appears, before any reconciliation read. A subscriber never receives a healthy-looking `closed` marker for a faulted session.

- **Retry.** `retryProviderIngestion(sessionId?)` resubmits a session's F head unchanged and drains what was accepted behind it. Without an ID it attempts every faulted session in session-ID order, continuing past failures; concurrent retries share one drain. A healthy session is a no-op, and an unknown session is `unknown_session`. It rejects non-retryably under A (without resubmitting) or O, and retryably while the F head still fails. It never calls a provider or workspace effect again. An exact command retry, an exact close retry and `shutdown()` also resubmit a proven-unapplied head.
- **Store contract.** The built-in in-memory store is trusted to reconcile a rejected commit only while its methods are unmodified. A custom `RuntimeStore` is trusted only if it declares `contract: { version: 1, level: 'strong' }`. That declaration promises that a rejected commit never applies later and that a read after the rejection sees every earlier commit. Without it, any commit rejection is a permanent A for that session, by design. The runtime cannot verify a declaration; keeping it is the adapter's (or host's) responsibility. `baseline`, unknown versions and malformed values count as no declaration. See `RuntimeStoreContract`.
- **Provider outcomes.** Only a thrown `ProviderRejection` is a definite rejection, recorded as a rejected receipt. Any other failure of `startRun`, `respondToInteraction` or `interrupt()` is an unknown outcome:
  - the command returns a retryable `provider_unavailable` with a fixed message;
  - nothing is recorded, and upstream text is never persisted;
  - the run's terminal waits behind it;
  - only an exact retry of that command (same ID and payload) calls the provider again.

  An exact retry of a definitely rejected command replays its rejected receipt; a new command ID after a definite interrupt rejection interrupts again.

- **Interactions.** A request becomes answerable only after its event commits; the store answers for a settled interaction (`interaction_already_settled`). A provider withdrawal is ordered after a response already delivered, so it never displaces that response. A provider reference is free again once its interaction settles: a later request that reuses it opens a new interaction, while reusing a still-pending reference becomes a diagnostic.
- **Interrupts.** `interrupt_run` rejects an unknown run ID or a run ID from another session with `unknown_run`. A run that is already terminal gives an applied no-op with `delivered: false`.

  An `interrupt_run` that arrives while the run's interrupt is in flight waits for that one shared interrupt and mirrors its outcome (delivered, the same rejection, or unknown). It never calls the provider itself.

  If the owning command's outcome is unknown, only that command's exact retry calls `interrupt()` again, and the run's terminal waits until it does. A request emitted after interruption began becomes a diagnostic; a callback from an already finished run is discarded.

- **Activation.** Output emitted during `createSession()` or `startRun()` is staged behind `session.opened` / `run.started`, at most 256 per sink. A start or open returns after that staged output is persisted, or once a fault blocking it is queryable. Crossing the bound refuses the excess and marks O. No warning tail is appended. A rejected start discards only its own staged output, and an overflow caused only by that output.
- **Close and shutdown.** Close admission fences the session at once, outside any queued command. It never waits on an unresolved provider start, response or unknown `interrupt_run` outcome: it returns a retryable `provider_unavailable` (`details.pending`), and cleanup continues on its own when that settles.

  Cleanup interrupts the run, disposes the provider session, and releases the workspace only after a confirmed disposal. These effects run even while history cannot be persisted. A retry repeats only phases that failed (`details.failures`, phase-tagged); successful or in-flight calls are never repeated.

  A late start that succeeds commits ahead of `closing`, then is interrupted and disposed. One that is rejected leaves only its rejected receipt.

  `ifRunActive: 'reject'` rejects while a run is active or starting. Another close ID is refused, retryably and without a receipt, while one close is unresolved.

  The close receipt and `session.closed` commit only after the accepted history, the run terminal and the real cleanup. `interruptedActiveRun` accumulates across exact retries. A close receipt attests cleanup, not complete history: an O session closes successfully and stays uncertified.

  `shutdown()` closes admission, fences every session and reports blocked sessions as retryable. It closes subscriptions only after every session is closed; A or an unresolved provider promise can keep it from succeeding.

- **Retirement.** A run's handle, routes and sink state are dropped once its terminal commits. A closed session keeps only a permanent overflow marker, if it overflowed, and its provider sinks are cut off. Bookkeeping stays constant across many successful turns. A provider promise that never settles keeps one small fenced record (and its lease) for the runtime lifetime.
- **Subscriptions.** Subscriptions replay stored events before switching to live delivery. Only matching live event types occupy the buffer, while all published sequences advance its observed high-water mark. The `bufferSize` bound includes an event paused in delivery. Overflow is signaled for matching events. An unstarted subscriber retains a high-water mark and no event bodies. The in-memory store reads history in bounded pages without allocating a full-history intermediate array.

## Deferred behavior

Interaction expiration has a wire settlement value but no runtime deadline scheduler or automatic expiration. Hosts must not assume pending interactions expire. Provider withdrawal is supported only for a known request from its owning run; withdrawal of an unknown reference, after a terminal run, or after a retained response is not a separate cancellation mechanism. Crash-durable command claims, effect intents and multi-process admission are out of scope here (issue #6); concrete persistent stores and a store conformance kit belong to separate adapters (issue #47).
