# Runtime subscription and lifecycle hardening (issue #3)

Branch: `fix/3-runtime-subscription-lifecycle`; base `60942150905b8e58401f98cb8c2c6009334825df`.

## Goal

Make subscription retention and provider ingestion failures visible, preserve truthful lifecycle receipts, and cover the relevant races with deterministic tests.

## Decisions

- Filter live notifications before buffering, while advancing the durable observed sequence for every notification. Count every retained event body, including a batch currently being delivered, against `bufferSize`.
- Record the first provider ingestion failure and a bounded count per session, without retaining failed event bodies. Refuse complete-history reads, replay, and quiescence while a fault remains. Keep normal close and shutdown cleanup and receipts; the fault remains queryable afterward. A lost terminal event can leave the stored run non-terminal.
- Compare only the requested session's sequence across at most three history page reads, and recheck the ingestion fault after each read.
- Treat a close receipt as the result of one logical close command across retries. Remember whether that command interrupted an active run before cleanup failed; preserve the existing command fingerprint and acceptance time.
- Reject run IDs absent from the named session with `unknown_run`; allow the no-op interrupt only for a run known to be terminal in that session.
- Keep interaction expiration deferred. Preserve only the withdrawal behavior that the runtime can settle safely and document its limits.
- Page the in-memory event array directly, with a bounded page and one look-ahead element, instead of filtering the entire history on each read.

## Moved to #43

A9, retained ingestion retry, the per-session cap, overflow interruption and disposal, pending-start targeting, faulted-close and shutdown settlement, and both overflow/retry/close state tables moved to issue #43. Six review rounds found new P1 failures in that design; recovery belongs with issue #6's durable side-effect intent and recovery model.

## Acceptance and proof

| ID  | Acceptance                                                                                                                  | Deterministic proof                             |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A1  | Unrelated filtered traffic does not overflow a subscriber; its cursor advances                                              | filtered live subscription test                 |
| A2  | Retained event bodies, including delivery, never exceed capacity                                                            | paused iterator and buffer-count test           |
| A3  | Unknown and cross-session run IDs reject; known terminal run is idempotent                                                  | interrupt identity test                         |
| A4  | Interaction requests cannot revive interrupting or terminal runs                                                            | controlled interrupt/completion race tests      |
| A5  | Provider event and terminal commit failures leave a queryable fault; reads, replay and quiescence refuse incomplete history | injected store-failure and delayed-read tests   |
| A6  | Close retry receipt retains the original interruption fact                                                                  | two-command cleanup retry and replay test       |
| A7  | History reads allocate only the requested page                                                                              | deterministic bounded-allocation/iteration test |
| A8  | Public docs distinguish implemented and deferred behavior                                                                   | README review and gate                          |

## Non-goals and risks

No wire schema change, provider-native checkpoint, live provider call, or publication. Fault records are process-local and do not recover lost event bodies. A failed terminal commit can leave a run non-terminal in the store; the fault exposes that gap until issue #43 defines recovery. Tests use controlled promises and injected providers and stores, without timing assertions.
