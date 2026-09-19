---
'@relvo-labs/agent-provider-codex': minor
---

Bridge the Codex app-server command-approval request to the neutral approval interaction.

`createCodexProvider({ approvals: 'bridge' })` sends `thread/start` with
`approvalPolicy: 'on-request'` instead of `'never'`, so one
`item/commandExecution/requestApproval` is raised as `interaction.requested`
(`kind: 'approval'`) on the run that owns the turn, and the command proceeds only after a
`{ decision: 'approved', mode: 'once' | 'session' }` response reaches
`respondToInteraction`. The provider then declares
`interaction.approval = { supported: true, modes: ['once', 'session'], blocking: true }`;
`once` is `accept` and `session` is `acceptForSession`.

The default is unchanged: with both bridges unset the adapter still sends
`approvalPolicy: 'never'`, declares no approval capability and declines every
server-initiated request, because this adapter imposes no settlement deadline and a
bridged approval nobody answers would park a run.

Approval bridging enables only that method; `extensions.bridgedServerRequests` lists
the methods enabled by each independent opt-in. The stable pinned 0.153.4
`item/tool/requestUserInput` surface is handled separately by `questions: 'bridge'`
and needs no `experimentalApi` opt-in. Without that bridge it is declined whole:
its `isSecret` / `isOther` / multi-question payload needs the neutral `question_set`
contract rather than the single `QuestionRequest`.

Other methods in the pinned stable `ServerRequest` surface are declined on their own
native request id with no interaction raised: `item/fileChange/requestApproval` (its params name no files — the change set lives
in an item this adapter does not surface), `item/permissions/requestApproval`, `mcpServer/elicitation/request`,
`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, and the
legacy `applyPatchApproval` / `execCommandApproval`, which carry no `turnId` at all. A
multi-question payload is never partially answered and never reduced to one question.

A bridged approval is still refused, on its own request id, when it cannot be represented
faithfully — malformed or unknown fields, an unknown or `writeStdin` kind, no reviewable
command, a non-null execution environment, or policy/network context the neutral response
cannot carry — and when it does not name the active `(threadId, turnId)`, arrives before the turn is bound, arrives after
the run concluded or after interruption began, or exceeds the per-session bound.

Settlement is process-local exactly-once, not crash-safe exactly-once: a reference settles
one native callback one time, identical redelivery is a no-op, a conflicting answer is
`interaction_already_settled`, an unknown or retired reference is `unknown_interaction`,
and an invalid response (including a mode-bearing denial) or unsupported kind or mode is
rejected before the settlement is consumed so the approval stays answerable. Server-request reply ids are tracked separately from the
adapter's own request correlation, and a duplicate native id neither raises a second
interaction nor is answered twice, even after settlement and across runs. The connection
retains up to 4096 native request identities without eviction; the next unique request
and all pending callbacks receive an explicit error, and the connection is fenced with
the active run failed. The host must dispose the session and open a new one.
Interrupt initiation synchronously declines pending approvals and retires their references
before awaiting acknowledgement. Failed interrupts remain retryable without reopening
approvals on that run. Completion, failure and disposal also retire callbacks; EOF and
transport failure retire references even when replies can no longer be written. A late
answer cannot settle or revive the run. A denial `reason` is not transmissible on this
protocol, which the descriptor states as `extensions.approvalDenialReasonDelivered === false`.

Command actions are validated and reconstructed from the four pinned stable variants;
native metadata is never forwarded. Approval subjects intentionally contain untrusted,
potentially sensitive host-visible command, cwd, reason and action content. Hosts own
its display, retention and access controls; approval is not a Runtime sandbox guarantee.

These corrections preserve neutral public contracts and the existing opt-in/default
behavior. Deterministic consumer-level Runtime/Codex tests prove observable settlement
commit failure, changed-command conflict and exact retry with one native reply.
