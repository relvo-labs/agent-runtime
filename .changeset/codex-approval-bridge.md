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

The default is unchanged: with `approvals` unset the adapter still sends
`approvalPolicy: 'never'`, declares no approval capability and declines every
server-initiated request, because this adapter imposes no settlement deadline and a
bridged approval nobody answers would park a run.

Only that one method is bridged, and the descriptor says so in
`extensions.bridgedServerRequests`. Everything else in the pinned 0.153.4 stable
`ServerRequest` surface is declined on its own native request id with no interaction
raised: `item/fileChange/requestApproval` (its params name no files — the change set lives
in an item this adapter does not surface), `item/tool/requestUserInput` (EXPERIMENTAL,
gated behind an `experimentalApi` opt-in that is never sent, and a question _list_ whose
`isSecret` / `isOther` / multi-question payload one neutral `QuestionRequest` cannot
carry), `item/permissions/requestApproval`, `mcpServer/elicitation/request`,
`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, and the
legacy `applyPatchApproval` / `execCommandApproval`, which carry no `turnId` at all. A
multi-question payload is never partially answered and never reduced to one question.

A bridged approval is still refused, on its own request id, when it cannot be represented
faithfully — an unknown or `writeStdin` kind, no reviewable command, or a proposed
execpolicy/network-policy amendment the neutral response cannot carry — and when it does
not name the active `(threadId, turnId)`, arrives before the turn is bound, arrives after
the run concluded or after interruption began, or exceeds the per-session bound.

Settlement is process-local exactly-once, not crash-safe exactly-once: a reference settles
one native callback one time, identical redelivery is a no-op, a conflicting answer is
`interaction_already_settled`, an unknown or retired reference is `unknown_interaction`,
and an unsupported kind or mode is rejected before the settlement is consumed so the
approval stays answerable. Server-request reply ids are tracked separately from the
adapter's own request correlation, and a duplicate native id neither raises a second
interaction nor is answered twice. When a run ends for any reason — completion, failure,
interrupt, EOF, transport failure or disposal — its outstanding approvals are declined and
their references retired, so no native callback dangles and a late answer can neither
settle nor revive the run. A denial `reason` is not transmissible on this protocol, which
the descriptor states as `extensions.approvalDenialReasonDelivered === false`.
