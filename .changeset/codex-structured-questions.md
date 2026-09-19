---
'@relvo-labs/agent-provider-codex': minor
---

Bridge the Codex app-server's `item/tool/requestUserInput` to the neutral `question_set`
interaction, so the agent can ask the user structured questions mid-turn and **the same
turn resumes at the native wait point** once they are answered. This is not a follow-up
turn and not an approval.

`createCodexProvider({ questions: 'bridge' })` raises one neutral batch per request, on the
run that owns `(threadId, turnId)`, and replies to the native request with the whole
`{ answers: { [questionId]: { answers } } }` map. Native thread, turn, item and question
identifiers stay inside the adapter; the host answers with adapter-assigned keys.

Supported: choice questions, free-text questions (`options: null`), `isOther` as
`allowFreeText`, `isSecret` as `sensitive`, and several questions in one request answered
as one unit. Multi-select is **not** offered: `ToolRequestUserInputQuestion` has no field
permitting several answers, and offering an unstated capability would be a guess.

Refused **whole**, with `-32602` on the request's own native id and raising no interaction:
`isBlocking: false` (a turn that does not wait cannot be resumed by an answer), any
`autoResolutionMs` (it asks the client to answer _for_ the user; this adapter never
fabricates an answer and imposes no settlement deadline), duplicate question `id` or option
`label` (both are native answer keys), an empty or oversized batch, and any unknown member.
A request that does not name the active turn, has no run to own it, or exceeds the
per-session bound is refused with `-32600`.

**No experimental capability is enabled.** `initialize.params.capabilities` stays `null`.
This corrects a previous claim in this package that `ToolRequestUserInput*` is gated behind
`InitializeCapabilities.experimentalApi`: the pinned 0.153.4 generated artifacts say
otherwise and the generated schemas win — `typescript-stable/ServerRequest.ts` includes the
`item/tool/requestUserInput` variant and `typescript-stable/v2/ToolRequestUserInput*.ts`
are byte-identical to their `--experimental` counterparts, while genuinely experimental
methods such as `thread/queue/*` appear only in the experimental dump. Opting in would also
widen `CommandExecutionRequestApprovalParams` with `additionalPermissions` and
`availableDecisions` (the server strips those only for non-opted-in connections), which the
strict approval parser would refuse — so the opt-in would break the shipped approval bridge
to gain nothing. Enabling questions leaves `approvalPolicy` untouched: a question is the
model asking the user something, not permission to act.

The default is unchanged: with `questions` unset the method is declined with `-32601` on
its own request id, so a blocking request still cannot stall a turn.

Settlement is process-local and exactly-once: an identical redelivery writes no second
reply (key order is normalized), a conflicting one is `interaction_already_settled`, and a
partial or invalid answer is rejected _before_ the single settlement is consumed so the
batch stays answerable. When a run ends with a batch outstanding, the native request is
answered with an **empty** answer map — `ToolRequestUserInputResponse` has no decline
variant, so that is the only honest reply: it answers no question, invents nothing, and
releases the server's wait. Turn completion, interrupt, disposal, EOF and transport failure
all retire outstanding batches; a late answer settles nothing.

Public surface: new `CodexProviderOptions.questions`, and new exported constants
`CODEX_BRIDGED_APPROVAL` and `CODEX_BRIDGED_QUESTION`.

Questions and answers are untrusted and durable. A host that must not retain a secret
should refuse a request carrying `sensitive: true` rather than collect one; no prompt,
option or answer text is copied into a diagnostic, an `AgentError` message or a
`providerCode`.
