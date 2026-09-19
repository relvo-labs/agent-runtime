# ADR-0018: Keyed multi-question interactions and wire 0.5

Status: Accepted

Supersedes nothing. Extends ADR-0001 (interaction identity), ADR-0011 (public API and
versioning) and ADR-0015 (structured provider capabilities).

## Context

Wire `0.4` defines exactly one question shape:

```ts
QuestionRequest  = { kind: 'question'; prompt; choices?; multiSelect; placeholder? }
QuestionResponse = { kind: 'question'; answer: string | string[] }
```

That is one prompt and one scalar-or-list answer. Both provider adapters in this repository
now have a verified native surface that asks **several** questions at once, each with its own
identity, its own selection mode and its own display facts:

- **Codex** `item/tool/requestUserInput` sends `questions: ToolRequestUserInputQuestion[]`,
  each with a native `id`, `header`, `question`, `isOther`, `isSecret` and a nullable
  `options` list. The reply is `{ answers: { [questionId]: { answers: string[] } } }` — a map
  keyed by the native question id.
- **Claude** `AskUserQuestion` sends `questions: [1..4]`, each with `question`, `header`,
  `options` (2–4 × `{label, description, preview?}`) and `multiSelect`. The reply is
  `updatedInput.answers`, a map keyed by the **question text**.

Neither can be carried by `QuestionRequest`. Flattening several prompts into one string
destroys question boundaries; answering positionally destroys answer correlation; answering
only the first question fabricates the rest. All three are forbidden by issues #35 and #36.
`QuestionResponse.answer` also has nowhere to say _which_ question an answer belongs to.

The constraint that decides the shape of the fix: this repository's DTOs are `z.strictObject`
and `z.discriminatedUnion`. Both are **closed**. A pre-1.0 reader does not ignore an unknown
property or an unknown union member — it rejects the value. So there is no additive change
here; every option is a wire break (`runtime-contract-evolution`, step 1).

## Decision

### 1. A new union member, not a mutated one

Add `kind: 'question_set'` as a distinct member of `InteractionRequest` /
`InteractionResponse`. Leave `kind: 'question'` exactly as it is, byte for byte.

The rejected alternative was widening `QuestionRequest` with an optional `questions` array.
That produces a DTO where `prompt` and `questions` are mutually exclusive, needs a refinement
to say so, and leaves every consumer's existing `switch (request.kind)` branch silently
handling a value it was not written for. A separate discriminant makes an unhandled batch a
compile error in a `switch` with an exhaustive check, and a runtime rejection everywhere
else — which is the correct failure for a host that cannot yet render a batch.

### 2. The neutral shapes

```ts
QuestionItem = {
  key;            // adapter-assigned, unique within the request, NOT a native id
  prompt;         // the question text
  header?;        // short label, when the provider supplies one
  choices?;       // absent means free text only
  multiSelect;    // default false
  allowFreeText;  // default false — a choice list that also accepts typed text
  sensitive;      // default false — the answer is a secret
}

QuestionSetRequest  = { kind: 'question_set'; questions: QuestionItem[] }   // 1..32, ordered
QuestionSetResponse = { kind: 'question_set'; answers: Record<key, QuestionAnswer> }

QuestionAnswer =
  | { type: 'text';      text }
  | { type: 'selection'; values: string[] }
```

- **Ordering is preserved** because `questions` is an array and the array order is the
  provider's order. A host renders top to bottom without re-deriving intent.
- **Correlation is by `key`**, never by position. `answers` is a record, so a duplicate key
  is unrepresentable rather than merely invalid.
- **Every semantically relevant native fact is carried.** `multiSelect` (Claude), `isOther` →
  `allowFreeText` (Codex), `isSecret` → `sensitive` (Codex), `header` (both), option
  `label`/`description` (both). Nothing observed is dropped; see §5 for what is refused
  instead.
- **`key` is adapter-assigned.** Codex's native question `id` and Claude's question text are
  mapped to a key inside the adapter and never published, satisfying the rule that
  provider-native identifiers stay out of public DTOs (AGENTS.md §5, ADR-0006). A host
  answers with the key it was given.

### 3. All-or-nothing aggregation

`checkResponseAgainstRequest` requires that the answer record's key set equals the request's
key set **exactly**: no missing question, no unknown key. Per answer it requires the right
answer type for the question (text only where free text is permitted), known choice values,
no duplicate selections, and cardinality ≤ 1 unless `multiSelect`.

A response failing any of these is rejected before the adapter is called, so no provider ever
receives a partial batch. There is no provider-side path that replies to some questions and
not others: each adapter builds its whole native reply from one validated response, or throws.

### 4. Capability

`QuestionCapability` gains `batch`, `maxQuestions`, `freeText` and `sensitive`, so a host can
tell "asks one question" from "asks up to four, one of which may be a secret" before a run
starts. Defaults stay conservative (`false` / `null`), so an adapter that forgets a field
under-promises (ADR-0015).

### 5. Fail closed, whole-request, against the neutral schema

A native request this adapter cannot represent faithfully is refused **in full**, on its own
native request id / callback, and raises no interaction. Refusal is always preferable to a
partial rendering, because a user cannot meaningfully answer a question they were shown an
incomplete version of. The per-adapter matrices live in each adapter's README and are
reproduced in `docs/provider-development.md`.

"Faithfully" includes "within the neutral bounds". Neither native surface declares text
lengths — `AskUserQuestionInput` bounds counts only, and `ToolRequestUserInputParams`
bounds nothing — so an 8001-character prompt is a well-formed native request and an invalid
`QuestionSetRequest`. Each adapter therefore parses its **complete translated request**
through `QuestionSetRequestSchema` before retaining any entry or emitting any event, and
refuses the whole native request with a bounded token when it fails.

This ordering is load-bearing rather than tidy. The Runtime discards a malformed
`ProviderEventInput` as a diagnostic; if the adapter had already retained the native
callback, the result would be a blocking native request waiting forever on an answer to an
interaction that was never raised — a hang, not a refusal.

### 6. Withdrawal is a first-class provider event

`ProviderEventPayload` gains `{ type: 'interaction.withdrawn', providerRef }`. The Runtime
records it as an `interaction.settled` event with a `withdrawn` outcome on the interaction
that reference raised, clears its routing, and lets the run leave
`awaiting_interaction`. Identity and time stay the Runtime's, exactly as for
`interaction.requested`: a provider states which of _its own_ references it is withdrawing
and nothing else, so it cannot settle an interaction it did not raise or stamp a time.

It exists because both pinned surfaces can withdraw a question while the run continues:

- **Claude** aborts that request's `AbortSignal`, and then keeps waiting on the callback.
- **Codex** sends `serverRequest/resolved` (`{ threadId, requestId }`), which both confirms
  an answer already sent and retires a request the server resolved itself. It carries no
  `turnId`, so it is correlated by the native request id the adapter retained — which is
  why the adapter's own interaction registry holds that id.

Without this payload an adapter can only retire its own callback. The interaction stays
pending, the run stays parked in `awaiting_interaction` for the rest of its life, and the
provider's own eventual success is recorded as a `provider_contract_violation` — the run
completed while an interaction it owns was unsettled. A withdrawal that arrives after a
response has already reached the provider is ignored by the Runtime: a retained settlement
is logically ahead of it.

Before attempting persistence, the Runtime retains one logical withdrawal per routed
interaction and fences competing responses. A failed commit, before or after transaction
mutation, leaves that record and routing intact. Redelivery reuses the record and timestamp;
completion and cleanup materialize it as `withdrawn` before deciding the run outcome or
cancelling other interactions. Routing and retention are cleared only after persistence
succeeds. This is bounded process-local retry state, not crash-durable recovery.

`PROVIDER_EMITTABLE_EVENT_TYPES` is consequently typed as `ProviderEventPayload['type'][]`
rather than `EventType[]`, because `interaction.withdrawn` is a provider payload that has
no `EventPayload` member of its own.

### 7. `WIRE_VERSION` 0.4 → 0.5

Required by the table in `runtime-contract-evolution`: adding a member to a closed
discriminated union, and adding fields to the strict `QuestionCapability` object, are both
breaking. `SCHEMA_ID_BASE` moves with it, so every generated `$id` changes from
`…/agent-runtime/0.4/…` to `…/agent-runtime/0.5/…`.

The `interaction.withdrawn` provider payload in §6 is a member added to a closed union and
is therefore breaking by the same table. It does **not** move the line again: `0.5` has
never been published, and `runtime-contract-evolution` permits a release-blocker correction
to refine a candidate line before its first publication. `0.5` is the line that carries the
whole of ADR-0018, withdrawal included; nothing outside this repository encodes it.

`docs/architecture/foundation-v0.4.md` keeps its filename: it documents the foundation
milestone, not the wire minor, and renaming it would churn the skill ownership map for no
contract reason. Its normative tables are updated in place and it states which wire minor it
describes.

## Compatibility, migration and rollback

**Classification.** Wire: breaking. TypeScript surface: additive exports plus a new member in
two unions that consumers `switch` on — "breaking-ish" per `public-api-evolution`, so every
changeset body carries a `BREAKING:` line. Pre-1.0 this is a `minor` bump for
`agent-protocol`, `agent-provider`, `agent-runtime`, `agent-provider-claude` and
`agent-provider-codex`.

**Nothing published is invalidated.** Only `@relvo-labs/agent-protocol@0.2.0` has ever been
published, and it is a `0.3`-line artifact untouched by this change. No consumer is mid-flight
on wire `0.4` outside this repository.

**Adapter negotiation is already exact.** `checkWireCompatibility` refuses a descriptor whose
`wireVersion` differs from the runtime's. An out-of-tree adapter built against `0.4` therefore
fails registration with `provider_contract_violation` naming both versions — a legible,
immediate failure, not a corrupted interaction.

**Consumer migration.**

1. Rebuild against `agent-protocol` ≥ the version carrying wire `0.5`.
2. Add a `case 'question_set':` to every `switch` on `request.kind` / `response.kind`. A
   consumer that renders only `'question'` keeps working for providers that raise only
   `'question'`; it must reject `'question_set'` rather than guess.
3. Read `descriptor.interaction.question.batch` before offering a batch UI.
4. Existing `kind: 'question'` code needs no change.

**Rollback.** Revert the wire bump and the union member together; they are one commit and no
persisted artifact outside this repository encodes `0.5`. An in-memory store holds no
cross-version state, and `exportRecoveryRecord` stamps `wireVersion` as a literal, so a
`0.5` record is refused by a reverted `0.4` build rather than silently misread.

## Provider mappings (pinned, official)

### Claude — `@anthropic-ai/claude-agent-sdk@0.3.259`

The answer route is `canUseTool`. `AskUserQuestion` reaches the host permission callback like
any other tool, the SDK blocks on the returned promise, and the host answers by allowing the
call with an `updatedInput` that carries the answers:

```ts
{ behavior: 'allow', updatedInput: { ...input, answers: { [questionText]: answerString } } }
```

Evidence in the pinned package: `sdk-tools.d.ts` `AskUserQuestionInput` declares
`answers?: { [k: string]: string }` — "User answers collected by the permission component" —
alongside `annotations?` keyed by question text; `AskUserQuestionOutput` declares the same
`answers` map as the tool's result. `sdk.d.ts` declares `CanUseTool`, its `AbortSignal`, and
`PermissionResult`'s `behavior: 'allow'` variant with `updatedInput`. This is a genuine
structured tool path and **not** an approval: an ordinary `{behavior:'allow'}` without
answers would run the tool with no answers, and a `{behavior:'deny', message}` would hand the
model prose. Neither is ever used to settle a question here.

Multi-select answers are joined with `', '` because the pinned `AskUserQuestionInput.answers`
value type is `string`. The batch is answered in one callback return, so aggregation is
atomic by construction.

The native answer map is keyed by the **question text**, which is model-authored and
unconstrained, so it is built with `Object.fromEntries`. Assigning `answers[text] = value`
would reassign the object's prototype for a question called `__proto__` and serialise as
`{}` — answering nothing while reporting success. Codex has the same hazard on its native
question `id`, and the same fix.

Withdrawal is `CanUseTool`'s `AbortSignal`: the SDK aborts that one request's signal and
keeps waiting on the promise. See §6.

### Codex — app-server / CLI `0.153.4`

`item/tool/requestUserInput` is answered on its own native JSON-RPC request id with
`{ answers: { [nativeQuestionId]: { answers: string[] } } }`.

`thread`/`turn`/`item` correlation is enforced before any interaction is raised: a request
whose `(threadId, turnId)` is not the active run's pair is refused with `-32600` and raises
nothing, exactly as command approvals already are.

`serverRequest/resolved` (`{ threadId, requestId }`) is the app-server's resolution
notification for its own outstanding requests. It carries no `turnId`, so it is correlated
by the native request id the adapter retained alongside the entry — the one place a native
`RequestId` is held outside the client layer, compared and never published. A resolution of
an already-answered request is a confirmation and does nothing; a resolution of an
unanswered one is a withdrawal, and is handled as §6 describes.

The two bridges are independently opted into. `questions: 'bridge'` must not enable command
approvals: it changes nothing about `approvalPolicy`, and
`item/commandExecution/requestApproval` is still declined with `-32601` unless
`approvals: 'bridge'` was also asked for. `extensions.bridgedServerRequests` lists exactly
the enabled methods.

**No experimental capability is enabled.** The earlier refusal note in this repository stated
that `ToolRequestUserInput*` is "gated behind `InitializeCapabilities.experimentalApi`". The
pinned generated artifacts contradict that, and the generated schemas win: `--experimental`
is absent from the stable dump generation, `typescript-stable/ServerRequest.ts` nonetheless
includes the `item/tool/requestUserInput` variant, and `typescript-stable/v2/ToolRequestUserInput*.ts`
are byte-identical to their experimental counterparts. Filtering demonstrably does happen —
`thread/queue/*` appears only in the experimental dump — so the presence of these types in the
stable dump is positive evidence, not an artefact.

Leaving `capabilities: null` is therefore both sufficient and safer. Opting in would have
widened `CommandExecutionRequestApprovalParams` with `additionalPermissions` and
`availableDecisions` (the server calls `strip_experimental_fields()` only for non-opted-in
connections), which the existing strict approval parser would have refused as malformed —
a regression in the shipped approval bridge, caused by a capability this feature does not
need. The prose "EXPERIMENTAL" annotation on the types is recorded here so a future reader
knows it was considered and why the generated surface was believed instead.

## Sensitive content

A question and its answer are untrusted, attacker-influenceable text, and an answer may be a
secret (`sensitive`). Interactions are durable: they are committed as `interaction.requested`
and `interaction.settled` events and projected into the session snapshot. Consequences,
documented for hosts in `docs/provider-development.md` and both adapter READMEs:

- The runtime stores answers because settlement must be replayable. A host that must not
  retain a secret must not ask for one — it should refuse a request with `sensitive: true`
  rather than answer it.
- No adapter copies question or answer text into a diagnostic, an `AgentError` message, or a
  `providerCode`. Refusals are classified by bounded tokens (`provider-adapter-development`,
  step 9).
- Neither does the protocol. `checkResponseAgainstRequest` returns a bounded classification,
  and the Runtime wraps that reason in an `AgentError` on a durable command receipt. It may
  name a `key` the request already published — an adapter-assigned token — and it may state
  _how many_ values or unknown keys were wrong, but it never repeats a rejected answer value
  or a caller-supplied answer key. A rejected answer to a `sensitive: true` question would
  otherwise be written into the event log by the very act of refusing it. Command schema
  failures likewise use a stable `invalid_request` classification, without copying raw
  validator messages or caller-controlled property paths, keys or values.
- Option `preview` content is not carried. Claude only generates previews when
  `toolConfig.askUserQuestion.previewFormat` is set, which this adapter never sets; a request
  that carries one anyway is refused whole, because silently dropping a preview changes what
  the user believes they are choosing between.

## Consequences

Hosts gain one shape that both native surfaces map onto without loss, and a mechanical
guarantee that a batch is answered completely or not at all. The cost is a wire-minor break
that every consumer must rebuild for, and a second question shape that consumers must handle.
Out-of-tree adapters targeting wire `0.4` stop registering until rebuilt, by design.
