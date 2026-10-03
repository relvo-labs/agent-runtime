# ADR-0016: Provider event activation is ordered and bounded

Status: Accepted

**Current behavior** is described under Decision below. The following issue #43
amendment is **proposed, not yet implemented or accepted**; it accompanies
`.hermes/plans/ingestion-recovery-issue-43-v2.md`. Until design approval and an
implementation change, the warning-only 256-event tail remains current behavior.

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

## Proposed issue #43 amendment (pending fresh review and acceptance)

Activation captures count toward the owning session's shared 1,023-operation
nonterminal FIFO cap, including its in-flight head and reserved pre-effect
operations. The 256-entry pre-activation bound remains an additional per-sink
guard **inside** that session budget, not 256 extra uncounted entries. Crossing
either bound refuses the excess before acceptance and **permanently marks the
session's history incomplete** (`O`); the retained prefix drains in order and a
single terminal slot remains reserved. The old warning-only tail in the current
Decision (which could leave replay apparently complete) would no longer apply.
The overflow marker survives close for the runtime lifetime, even when close
returns a truthful cleanup receipt. No claim is made about a byte/memory limit:
one valid JSON body may be large. If session creation fails before an owner exists,
discard its inactive sink without manufacturing a session fault. If a run start
rejects after staging, discard only that run sink's provisional bodies and
release their charged capacity; roll back O caused *solely* by that unowned
staging, but keep an independent session-sink F/O. A late successful start
must be committed before any of its retained run events, even if a close has
already fenced admission. The provider handle may be disposed safely while
the start/ingress store head is faulted, but close receipts cannot bypass it.

Review/implementation proof: emit 257 events before activation and assert the
accepted prefix plus permanent O, not just a warning; emit 1,024 bodies across
both sinks against the 1,023 session budget with a held commit, without an
elapsed-time assertion. Verify README describes the implemented behavior
precisely before accepting this amendment as current.
