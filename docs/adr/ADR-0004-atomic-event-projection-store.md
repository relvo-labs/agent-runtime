# ADR-0004: Atomic event, sequence, and projection storage

Status: Accepted

## Context

Separately assigning sequence numbers, appending events, and updating projections permits gaps and state that cannot be reproduced by replay.

## Decision

One store transaction allocates gapless per-session sequences, stamps and appends envelopes, folds projections, and records receipts at one revision. The fold fails closed: every declared `from` state must equal the current projection and the normative transition table must allow `from → to`; terminal events and interaction request/settlement events must reference the projected owning run and turn in a legal nonterminal status. A rejected fold swaps neither log nor projection, so malformed or out-of-order input cannot rewrite terminal state. The in-memory implementation uses deep copy-on-write and serialized commits. It clones data at every ingress and returns isolated, frozen transaction views, commit values, snapshots, event pages, interaction records, and receipts. Durable stores must provide equivalent atomicity, transition validation, and mutation isolation.

### Rejected commits and the store contract (issue #43)

The runtime commits each session's history through one ordered ingestion queue and treats a rejected `commit` as possibly applied. It never blindly resubmits one. Before any read it records an unknown-outcome fault (A), wakes idle subscribers and fails waiting commands. It then reconciles only if the store meets the **strong contract**: a commit whose promise rejected is never applied later, and a read issued after the rejection observes every earlier commit.

Under that contract, a read-after-failure that finds every captured envelope (or the receipt) and a projection equal to the fold of the log proves the commit applied: it is published once and never appended again. Proven absence turns A into a retryable failure (F), whose identical frozen bundle may be resubmitted. Anything else leaves A permanent for the runtime lifetime.

A store states its guarantees through the optional, additive `RuntimeStore.contract` declaration (`RuntimeStoreContract`, `{ version: 1, level: 'baseline' | 'strong' }`):

- `baseline`: the atomicity, gapless sequence, fail-closed fold, isolation and receipt lookup described above;
- `strong`: `baseline` plus the two guarantees above.

Only `{ version: 1, level: 'strong' }` enables reconciliation. A missing, `baseline`, unknown-version or malformed declaration, or one whose property throws, means unverified: any commit rejection is a permanent A for that session, and its head is never resubmitted.

A store from `createInMemoryStore` carries no declaration and is trusted implicitly. That trust holds only while its contract members (`revision` and the six methods) are, at each use, the original built-in functions; a replaced or wrapped member makes it unverified unless the host explicitly declares the contract. The declaration is self-asserted and read at each use: the runtime cannot verify it, and keeping it is the adapter's (or host's) responsibility.

Concrete persistent adapters, a store conformance kit and any SPI revision are separate work (issue #47). Crash recovery is issue #6.

## Consequences

Projected state is replayable and never ahead of its log. Storage adapters need genuine transactional or compare-and-swap semantics, and should declare the strong contract only when a rejected commit can never apply later. An unverified store fails closed: one ambiguous rejection leaves that session's history permanently uncertified, which is the accepted cost of never duplicating history.
