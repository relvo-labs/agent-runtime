---
'@relvo-labs/agent-protocol': minor
'@relvo-labs/agent-executor': minor
'@relvo-labs/agent-provider': minor
'@relvo-labs/agent-runtime': minor
---

BREAKING: `WIRE_VERSION` moves `0.4` → `0.5`; rebuild every package against the new
protocol and add a `case 'question_set':` to any `switch` on an interaction `kind` before
upgrading. An adapter still declaring `wireVersion: '0.4'` is refused at registration with
`provider_contract_violation` naming both versions.

Add a keyed multi-question interaction, so a provider that asks several correlated
questions at once can be represented without losing question boundaries or answer
correlation. See `docs/adr/ADR-0018-structured-question-sets.md` for the decision, the
migration and the rollback.

`InteractionRequest` and `InteractionResponse` gain a `kind: 'question_set'` member. The
existing `kind: 'question'` form is untouched, so single-question providers and the hosts
that render them need no change beyond the rebuild:

```ts
// request: an ordered list of keyed questions
{ kind: 'question_set', questions: [
  { key: 'q1', prompt: 'Which database?', header: 'Database',
    choices: [{ value: 'o1', label: 'PostgreSQL' }], multiSelect: false,
    allowFreeText: true, sensitive: false },
] }

// response: a record keyed by those keys — never by array position
{ kind: 'question_set', answers: { q1: { type: 'selection', values: ['o1'] } } }
```

Ordering is the provider's ordering and is preserved. Each question carries its own
`header`, `choices`, `multiSelect`, `allowFreeText` ("Other") and `sensitive` facts.
`key` is assigned by the adapter and is never a provider-native identifier.

Settlement is **all-or-nothing**. `checkResponseAgainstRequest` requires the answered key
set to equal the asked key set exactly — no missing question, no unknown key — and then
checks each answer's type, choice membership, duplicate selections and cardinality. It
runs before any provider is touched, so no adapter can be handed a partially answered
batch.

BREAKING: `ProviderEventPayload` gains a `{ type: 'interaction.withdrawn', providerRef }`
member, so a provider can withdraw a request it raised while its run continues. The runtime
records it as an `interaction.settled` event with a `withdrawn` outcome, clears the
interaction's routing and lets the run leave `awaiting_interaction`; identity and time stay
the runtime's. Without it an adapter whose native surface takes a question back (Claude
aborts the request's `AbortSignal`; Codex sends `serverRequest/resolved`) could only retire
its own callback, leaving the interaction pending forever and turning the provider's own
later success into a `provider_contract_violation`. A withdrawal naming a reference the
provider did not raise, or one whose response is already a retained logical settlement, is
ignored. `PROVIDER_EMITTABLE_EVENT_TYPES` is consequently typed
`readonly ProviderEventPayload['type'][]` rather than `readonly EventType[]`, and lists the
new member; code that assigned it to an `EventType[]` must widen.

`checkResponseAgainstRequest` no longer echoes rejected values. A message may name a `key`
the request published and state how many values or unknown keys were wrong; it never
repeats a rejected choice value or a caller-supplied answer key. The runtime wraps that
reason in an `AgentError` on a durable command receipt, so echoing would have written a
rejected answer to a `sensitive` question into the event log by the act of refusing it.
Assertions on the old message text (`unknown choice value(s): …`) must be updated.

BREAKING: `QuestionCapability` gains `batch`, `maxQuestions`, `freeText` and `sensitive`
(conservative defaults: `false` / `null`). Reading `descriptor.interaction.question` with
an exact-shape assertion needs updating; reading individual fields does not.

New exports from `@relvo-labs/agent-protocol`: `QuestionKeySchema`, `QuestionItemSchema`,
`QuestionSetRequestSchema`, `QuestionAnswerSchema`, `QuestionSetResponseSchema`, and the
types `QuestionItem`, `QuestionSetRequest`, `QuestionAnswer`, `QuestionSetResponse`. New
export from `@relvo-labs/agent-provider`: `canAskQuestionSet(descriptor, count)`, for
gating a batch surface before a run starts. `@relvo-labs/agent-provider/testing`'s scripted
double now declares the batch capability.

Generated JSON Schema moves with the line: every `$id` becomes
`https://schemas.relvo.dev/agent-runtime/0.5/…`, and the new `question-item`,
`question-answer`, `question-set-request` and `question-set-response` definitions are
published as stable `$defs`. One invariant is deliberately Zod-only — uniqueness of
question keys, which Draft 2020-12 cannot express for a property across array items. It is
enforced at every in-process ingress and asserted explicitly in the Ajv parity corpus
rather than left implicit.

Runtime behaviour is unchanged apart from validating and routing the new kind: interaction
identity, settlement-once, receipt idempotency, the retained-settlement retry after a
failed store commit, and terminal-run rejection all apply to a batch exactly as they do to
a single question.
