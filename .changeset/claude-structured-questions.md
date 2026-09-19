---
'@relvo-labs/agent-provider-claude': minor
---

Bridge the Claude Agent SDK's `AskUserQuestion` tool to the neutral `question_set`
interaction, so the agent can ask the user a structured question mid-run and **the same
run resumes at the native wait point** once it is answered. This is not a follow-up turn
and not an approval.

`createClaudeProvider({ questions: 'bridge' })` installs the SDK's host callback and turns
each `AskUserQuestion` call into one neutral batch on the run that asked. The answer route
is the pinned one: `AskUserQuestion` reaches `canUseTool` like any other tool, and the host
answers by allowing the call with an `updatedInput` carrying the answers map that
`AskUserQuestionInput.answers` declares ("User answers collected by the permission
component") — which the CLI returns as `AskUserQuestionOutput.answers`. A bare
`{ behavior: 'allow' }` would run the tool with no answers, and a denial would hand the
model prose; neither is ever used to settle a question here.

Supported: single-select, multi-select (labels joined with `', '`, the pinned encoding for
the `string`-valued map), free text as the "Other" answer (sent verbatim, never the word
"Other"), 1–4 questions per call answered as one unit, and withdrawal via the request's
`AbortSignal`.

Refused **whole**, on the callback, raising no interaction: an option `preview` (never
requested, so never expected — dropping one would change what the user is choosing
between), pre-filled `answers`/`annotations`, duplicate question text or option label (both
are native answer keys, so duplicates are unanswerable), question or option counts outside
the pinned 1–4 / 2–4 bounds, and any unknown member. `onUserDialog` and MCP elicitation
remain unbridged and unclaimed.

The default is unchanged: with `questions` unset no question capability is declared and an
`AskUserQuestion` call is denied with a message telling the model to ask in its reply.
Setting `questions: 'bridge'` while `approvals` is `'none'` installs the callback but
grants nothing — every non-question tool prompt reaching it is denied, the same outcome as
the `permissionPrompts: 'none'` posture it replaces.

Settlement is process-local and exactly-once: an identical redelivery is a no-op
(key order is normalized, so the same answers collected differently are the same answer), a
conflicting one is `interaction_already_settled`, a partial or invalid answer is rejected
_before_ the single settlement is consumed so the question stays answerable, and an unknown
or retired reference is `unknown_interaction` without echoing the reference. When the run
ends — result, interrupt, EOF, stream failure or disposal — outstanding questions are
denied once and their references retired, so no callback dangles and a late answer cannot
resurrect a terminal run.

Two limits worth stating: `canUseTool` is not called for a tool an allow rule or permission
mode already decided, so a pre-approved `AskUserQuestion` never reaches this bridge; and if
you pass `allowedTools`, include `AskUserQuestion` or the tool is never offered.

Public surface: new `ClaudeProviderOptions.questions`, new exported constant
`CLAUDE_QUESTION_TOOL`, and new exported types `ClaudeAskUserQuestionInput`,
`ClaudeQuestion`, `ClaudeQuestionOption`. `ClaudePermissionResult`'s `allow` branch now
carries an optional `updatedInput` — the field that carries the answers. A host that
constructs that value is unaffected; a host that exhaustively destructures it should widen.

Questions and answers are untrusted and durable. The README states the host's display,
retention, access and logging responsibilities; no prompt, option or answer text is copied
into a diagnostic, an `AgentError` message or a `providerCode`.
