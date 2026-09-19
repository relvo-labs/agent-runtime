# `@relvo-labs/agent-provider-claude`

A Claude adapter for the neutral provider SPI. Its single responsibility is translating
between `@relvo-labs/agent-provider` and the official Claude Agent SDK's structured
`query()` surface — no PTY, no terminal scraping, no ANSI parsing.

The runtime never imports this package; a host composes it.

```ts
import { createAgentRuntime } from '@relvo-labs/agent-runtime';
import { createClaudeProvider } from '@relvo-labs/agent-provider-claude';

const runtime = createAgentRuntime({
  workspaces,
  providers: [createClaudeProvider({ model: 'claude-sonnet-4-6' })],
});

await runtime.openSession({ type: 'open_session', commandId, providerId: 'claude', workspace });
await runtime.submitTurn({
  type: 'submit_turn',
  commandId,
  sessionId,
  input: { parts: [{ type: 'text', text: 'hello' }] },
});
```

`type` is required on every command — it is what makes `AgentExecutor#dispatch` and each typed method agree on shape, and it is easy to drop by hand as the snippet above shows. `commandId` is a caller-generated, unique string (see `@relvo-labs/agent-protocol`'s `CommandIdSchema`); `sessionId` is the `openSession` receipt's own result, not invented; `workspace` is a `WorkspaceSpec` your host constructs (see `@relvo-labs/agent-workspace`). This snippet illustrates composition — it is not, on its own, a runnable program. For a complete, executable walkthrough that actually runs this exact sequence end to end (including workspace acquisition, a real subscription, receipts vs. completion, and cleanup), see [`examples/reference-app`](../../examples/reference-app/README.md).

## Installing the SDK

`@anthropic-ai/claude-agent-sdk` is an **optional peer dependency**, resolved at runtime
by the adapter's default binding. Install it in the host application:

```bash
pnpm add @relvo-labs/agent-provider-claude @anthropic-ai/claude-agent-sdk@0.3.259
```

The peer range is the exact pin the seam was derived from (`CLAUDE_AGENT_SDK_VERSION`).

It is a peer, not a dependency, because it is published under Anthropic's proprietary
terms and ships a per-platform native payload of roughly 200 MB. Making it a runtime
dependency would put a non-permissive licence into this repository's published closure and
force the download on every consumer, including those that inject their own binding.

Without it, `createSession` rejects with a retryable `provider_unavailable` error naming
the package. Nothing else in the adapter changes.

## Maturity

**Pre-1.0, and deliberately narrow.** This package went from an explicit scaffold to a live
adapter in the text-run vertical slice. Read the mapping and capability tables below as the
complete list of what it does, not as a starting point.

### Evidence classification

`CLAUDE_ADAPTER_STATUS` is `'live'`. That describes the adapter, not the integration: it
means this package implements and executes the SDK `query()` surface, not that the result
has been observed against a real Claude model.

| Claim                                       | Evidence                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implements the SDK `query()` surface        | Deterministic tests over the `ClaudeQuery` seam — correlation, interrupt settlement, disposal and error classification are exercised against scripted doubles.                                                   |
| Bridges host permission prompts             | Deterministic tests invoke the installed `canUseTool` exactly as the SDK does — approve, deny, unsupported mode/kind, unknown, cross-session, redelivered, conflicting, unattributable, and every teardown path. |
| Behaviour against a live credentialed model | **None.** No test in this repository executes a real Claude turn, and none is permitted to: the gate is credential-free and network-free by policy.                                                              |

The seam is hand-authored against `@anthropic-ai/claude-agent-sdk` **0.3.259**
(`CLAUDE_AGENT_SDK_VERSION`), which is the pinned peer range. There is no captured
live-model acceptance for this adapter anywhere in this repository, so a behaviour this
adapter infers from the SDK's documented message shapes — correlation fields, interrupt
receipts, terminal subtypes — is verified only to the extent that those shapes are what the
SDK actually emits at that version.

Do not read `'live'` as "verified against a live model". Those are different claims and
only the first is made here.

## What it maps

| SDK message                  | Provider event / outcome                            |
| ---------------------------- | --------------------------------------------------- |
| `canUseTool` prompt          | `interaction.requested` (`approval`) — bridge only  |
| assistant `text` block       | `run.message_delta` (split at 100 000 chars)        |
| assistant `tool_use` block   | `run.tool_activity` `invoked`                       |
| user `tool_result` block     | `run.tool_activity` `succeeded` / `failed`          |
| assistant `error`            | `diagnostic` (`warning`)                            |
| `result` usage               | `run.usage`                                         |
| `result` `success`           | completion `succeeded`                              |
| `result` error subtype       | completion `failed` (`providerCode` = subtype)      |
| stream ends without a result | completion `failed` (`provider_contract_violation`) |
| stream throws                | completion `failed` (`provider_unavailable`)        |

A session is one SDK query in streaming-input mode, so successive turns continue the same
conversation and `interrupt()` — a control request the SDK offers only in that mode — ends
one run without ending the session.

### Which turn a frame belongs to

That one stream also carries turns this adapter never submitted: background and scheduled
work, and turns whose run has already finished. Every submitted message is therefore
stamped with a private client uuid, and the SDK echoes it back as `user_message_uuid` (or
inside `user_message_uuids` when a batch was coalesced) on the turn's first reply frame and
on its result. Frames are bound to a run through that stamp; anything unattributable is
dropped with a `debug` diagnostic rather than emitted into, or used to complete, the run in
front of it.

That includes traffic that arrives before this session has correlated anything. An
unstamped frame is not evidence of a producer that cannot stamp — a background, scheduled
or synthetic turn is unstamped for the same reason — so absence of a stamp never confers
ownership. A host talking to a producer that genuinely never stamps, such as a
pre-`user_message_uuid` CLI, declares it with `createClaudeProvider({ correlation:
'legacy-unstamped' })` and gets attribution by position back, because demanding a stamp
that cannot arrive would hang every run. That declaration lapses the moment a stamp does
appear: the producer has then proven it correlates.

### Tool approvals

Off by default. `createClaudeProvider({ approvals: 'bridge' })` sets the SDK's
`permissionPrompts: 'host'` and installs its `canUseTool` callback; anything the permission
mode, rules and hooks did not already decide becomes a neutral `approval` interaction on
the run that asked, and the tool call proceeds **only** after a response of
`{ kind: 'approval', decision: 'approved', mode: 'once' }`.

| Neutral capability          | Bridged         | Why                                                                                     |
| --------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `approval.modes: ['once']`  | yes             | The callback decides the one call in front of it.                                       |
| `approval.blocking: true`   | yes             | The SDK waits for the answer; the prompt has no deadline of its own.                    |
| `approval.modes: 'session'` | no — rejected   | A durable grant is a permission rule this adapter does not write.                       |
| `question_set`              | separate opt-in | See "Structured questions" below. `approvals: 'bridge'` claims nothing about questions. |
| `expired` / `withdrawn`     | no              | No settlement deadline is imposed here, so neither outcome is manufactured.             |

Everything that is not that one grant fails closed. There is no auto-allow, no
allow-on-timeout and no allow-on-error path:

- a response for an unknown, already-retired or other session's reference is
  `unknown_interaction`, and the reference is never echoed back on the error;
- an unsupported mode or a non-approval response is `capability_unsupported` and does
  **not** consume the settlement, so a correct answer can still arrive;
- an identical redelivery is a no-op — the SDK callback is never executed twice — while a
  different answer to a settled reference is `interaction_already_settled`;
- when the run ends for any reason (its own result, interrupt, stream EOF, stream failure,
  session disposal) every outstanding prompt it raised is denied and its references are
  forgotten, so nothing dangles and a late answer cannot resurrect it;
- when the SDK withdraws a prompt — it aborts that request's own signal, and then keeps
  waiting on the answer — the prompt is denied once, its cancellation listener is detached
  and its reference is retired, so a host cannot answer into a request nothing is listening
  for. A prompt that is already withdrawn when it arrives raises no interaction at all. For
  a _question_, withdrawal is additionally propagated to the Runtime so the interaction
  settles `withdrawn` rather than staying pending;
- a prompt that arrives once disposal has begun, including the retry window after a
  rejected teardown, raises no interaction and is denied.

References are namespaced per session with an adapter-generated nonce, so one session's
reference is not a valid token in another even when both hold their first pending approval.
Unattributable prompts are announced once per session, not once per prompt: the producer is
a separate process and must not be able to grow a durable event log by asking repeatedly.

This is in-process settlement, not crash-safe exactly-once.

The approval subject carries a **sanitized tool name and nothing else**. Tool input holds
paths, argv, URLs and workspace contents, and an event is durable, so none of it is
published; the category (`command`, `file_write`, `network`, `tool`) is an advisory label
derived from the tool name, not an enforced classification. A host that needs the arguments
to decide wraps `query` in its own binding, where it sees the full `canUseTool` context.

One limitation, stated rather than papered over: a permission callback in 0.3.259 carries
no `user_message_uuid`, so it cannot be correlated the way a message frame is. Attribution
rests on this adapter running one turn per session at a time plus the stream binding — a
prompt is raised for the active run only while nothing contradicts it, and is denied
outright when another turn owns the wire, when the active run has already produced its
terminal frame, or when there is no active run. Approval is a host decision surface, not a
runtime sandbox: see `docs/adr/ADR-0009-provider-trust-boundary.md`.

### Interrupt semantics

Interrupt is idempotent and coalescing: concurrent calls share one control request.
Intent is recorded before the round-trip, so a terminal result that arrives before the
acknowledgement is still reported as `interrupted` rather than `failed`, and output
produced before the stop is still delivered.

That intent is provisional until the round-trip answers. A result that lands while the
control request is still in flight closes the run to further output but does not settle it
yet: if the request is then refused, or reports the input as still queued, no stop
happened, and the run settles with the outcome the turn itself reported.

The SDK answers with an `interrupt_receipt_v1` receipt listing input that **survived** the
stop. The pinned public `interrupt()` takes no arguments, so `cancel_queued` cannot be
requested and a survivor cannot be recalled. When the run's own input is listed there, the
adapter reports the stop as not applied — a typed `provider_rejected` with
`details.reason === 'input_still_queued'`, plus a session warning — and leaves the run
active, so the turn that does run is reported for what it actually was. Retrying the
interrupt once the turn has started stops it normally.

Disposal fences new runs the instant it begins, shares one teardown between concurrent
callers, and stays retryable to success if teardown rejects.

## Structured questions

Off by default. `createClaudeProvider({ questions: 'bridge' })` installs the SDK's host
callback and turns each `AskUserQuestion` call reaching it into one neutral `question_set`
interaction on the run that asked. The run **pauses at the native wait point** and resumes
there once the host answers — this is not a follow-up turn and not an approval.

The answer route requires `AskUserQuestion` to reach `canUseTool`. The host answers by
allowing the call with an `updatedInput` carrying the answers map that
`AskUserQuestionInput.answers` declares ("User answers collected by the permission
component"). A bare `{ behavior: 'allow' }` would run the tool with no answers;
a denial would hand the model prose. Neither is ever used to settle a question here.

| Native form                          | Bridged            | Notes                                                                                                                                                                                         |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single-select question               | **yes**            | `multiSelect: false`. The answer is the option's `label`.                                                                                                                                     |
| multi-select question                | **yes**            | `multiSelect: true`. Labels are joined with `', '`, the pinned encoding for the `string`-valued map.                                                                                          |
| free text / "Other"                  | **yes**            | Every question carries `allowFreeText: true`; the typed text is sent verbatim, never the word "Other".                                                                                        |
| 1–4 questions in one call            | **yes**            | Raised as one ordered batch, answered as one unit. Partial answers are refused before the SDK is called.                                                                                      |
| cancellation / withdrawal            | **yes**            | Aborting the request's signal denies once, detaches and retires the reference, **and** withdraws the interaction on the Runtime so the run resumes.                                           |
| option `preview`                     | no — refused whole | `toolConfig.askUserQuestion.previewFormat` is never set, so none is generated; one arriving is refused.                                                                                       |
| secret answers                       | n/a                | `AskUserQuestion` has no secret-answer concept, so `sensitive` is always `false`.                                                                                                             |
| `autoResolution` / `afkTimeoutMs`    | no                 | Output-only in the SDK, and this adapter never auto-answers. No settlement deadline is imposed.                                                                                               |
| pre-filled `answers` / `annotations` | no — refused whole | Answers arriving inbound are not a host answer; treating them as one would fabricate consent.                                                                                                 |
| duplicate question text              | no — refused whole | The native answer map is keyed by question text, so duplicates cannot both be answered.                                                                                                       |
| duplicate option label               | no — refused whole | The native answer _is_ the label, so duplicates are an ambiguous answer.                                                                                                                      |
| counts outside 1–4 / 2–4             | no — refused whole | The pinned tool bounds, enforced rather than assumed.                                                                                                                                         |
| text past a neutral bound            | no — refused whole | `AskUserQuestionInput` declares counts but no lengths. A prompt, header, label or description longer than `question_set` permits is refused (`neutral_bounds`) before any interaction exists. |
| `onUserDialog`, MCP elicitation      | no                 | Different native mechanisms; neither is bridged, and neither is claimed.                                                                                                                      |

A refused call is denied whole, on its own callback, and **raises no interaction** — a
question a host cannot display faithfully must never be shown half-rendered. The whole
translated batch is validated against the neutral `question_set` schema before any entry is
retained, because a batch the Runtime would discard as a malformed provider event would
otherwise leave the SDK blocked forever on a question no host was ever shown. The refusal
diagnostic carries a bounded reason token and no prompt, option or answer text.

**Withdrawal reaches the Runtime, not just this adapter.** When the SDK aborts the
request's signal while the run continues, the call is denied _and_ `interaction.withdrawn`
is emitted on that run's sink, so the interaction settles `withdrawn`, its routing clears,
a later answer is `interaction_already_settled`, the next question can be raised, and the
run's own success stays a success instead of becoming a `provider_contract_violation`.

In the pinned SDK 0.3.259, `tools` controls the available tool inventory; `allowedTools`
auto-approves tool calls. This adapter forwards `allowedTools` but does not expose the
SDK's `tools` option. Do not add `AskUserQuestion` to `allowedTools` to enable questions:
auto-approved calls bypass `canUseTool`, preventing this bridge from creating a structured
interaction and returning `updatedInput.answers`. Allow rules or permission modes that
already decide the call can also bypass the callback. Tool availability alone does not
guarantee that the callback runs.

Keep `questions: 'bridge'` and `approvals: 'bridge'` as separate opt-ins. Enabling questions
does not approve other tools; relaxing permissions is not a substitute for collecting
answers through `canUseTool`.

Questions and answers are untrusted, possibly sensitive text, and a settled answer is
committed to the durable event log. See "Untrusted and sensitive content" below.

## What it does not do

- **Questions, unless asked for.** Without `questions: 'bridge'` no question is declared
  and an `AskUserQuestion` call is denied with a message telling the model to ask in its
  reply. Approvals are likewise raised only when the host opts in with
  `approvals: 'bridge'`; without either, `permissionPrompts: 'none'` is set and a prompt
  nobody can answer fails closed instead of parking a run, since this adapter imposes no
  settlement deadline. Pre-authorising tool use does not supply question answers.
- **Non-text turn input.** A `file_ref` part is rejected with `capability_unsupported`
  rather than being invented into prose.
- **Recovery.** No recovery record is exported, so none is claimed.
- **Native identity.** Session ids, message uuids, tool-use ids, the client correlation
  uuid, the query handle and the child process stay inside the adapter. Tool arguments and
  results are never summarised into event detail, because they routinely contain workspace
  contents.
- **Upstream error prose, or caller text.** `AgentError.message`, `providerCode` and
  diagnostics carry allowlisted classifications only — never SDK error text, which can
  contain credentials, native ids, paths or the prompt, and never a caller-controlled value
  such as an interaction reference or a rejected response's `kind`/`mode`: a rejection
  states what this adapter supports, not what it was handed. An assistant frame the SDK flagged with `error` is
  reported as its classification alone: the blocks that came with it are the error body
  rather than model output, so they are not published as message deltas either. A host that
  wants the raw text wraps `query` in its own binding, where it sees every SDK message and
  error without any of it reaching the durable event log.

## Untrusted and sensitive content

A question, its options and an answer are **untrusted input**. The prompts and option
labels are model-authored; the answer is whatever the host's user typed. Both are durable:
the request is committed as `interaction.requested` and the answer as
`interaction.settled`, and both are projected into the session snapshot and replayed to
every subscriber.

What that means for a host:

- **Display.** Render question and option text as inert text. It is not markup, not a
  command, and not a trusted instruction — treat it exactly as you would any model output.
- **Retention.** The runtime stores answers, because settlement has to be replayable. If
  an answer must not be retained, do not collect it: refuse the interaction instead. This
  adapter marks no `AskUserQuestion` question `sensitive`, because the tool has no such
  concept — an absent flag is not a promise that an answer is harmless.
- **Access.** Anyone who can read the session event stream can read every question and
  every answer. Scope subscriptions accordingly.
- **Logging.** This adapter copies no prompt, option or answer text into a diagnostic, an
  `AgentError` message or a `providerCode`; refusals are bounded classification tokens.
  A host that logs its own rendered form owns that decision.

## Testing against it

`ClaudeProviderOptions.query` is a typed injection seam. The official `query` export
satisfies it without a cast, and a test can pass a deterministic implementation instead,
which is how this package's own suite runs with no credentials and no network:

```ts
const provider = createClaudeProvider({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', is_error: false };
    },
    interrupt: () => Promise.resolve(undefined),
  }),
});
```

The seam mirrors `@anthropic-ai/claude-agent-sdk` **0.3.259** (`CLAUDE_AGENT_SDK_VERSION`).
`ClaudeQueryOptions` is what an injected `query` **receives**, so note that its
`permissionPrompts` is now `'host' | 'none'` rather than the literal `'none'`, and it may
carry an optional `canUseTool`. An implementation that annotated its own parameter with the
narrower literal has to widen it; one that infers the type, as the snippet above does,
needs no change.

See [`docs/provider-development.md`](../../docs/provider-development.md) for the SPI rules
this adapter follows.
