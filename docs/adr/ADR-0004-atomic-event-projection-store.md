# ADR-0004: Atomic event, sequence, and projection storage

Status: Accepted

## Context

Separately assigning sequence numbers, appending events, and updating projections permits gaps and state that cannot be reproduced by replay.

## Decision

One store transaction allocates gapless per-session sequences, stamps and appends envelopes, folds projections, and records receipts at one revision. The fold fails closed: every declared `from` state must equal the current projection and the normative transition table must allow `from → to`; terminal events and interaction request/settlement events must reference the projected owning run and turn in a legal nonterminal status. A rejected fold swaps neither log nor projection, so malformed or out-of-order input cannot rewrite terminal state. The in-memory implementation uses deep copy-on-write and serialized commits. It clones data at every ingress and returns isolated, frozen transaction views, commit values, snapshots, event pages, interaction records, and receipts. Durable stores must provide equivalent atomicity, transition validation, and mutation isolation.

## Consequences

Projected state is replayable and never ahead of its log. Storage adapters need genuine transactional or compare-and-swap semantics.
