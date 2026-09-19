/**
 * Interactions: correlated question/approval exchanges raised during a run.
 *
 * Three properties make this safe to replay and to drive a UI from:
 *
 *  1. Request and response are *separately* discriminated on `kind`, and a
 *     response is only valid when its `kind` matches its request. A caller
 *     cannot answer an approval with free text.
 *  2. Settlement is explicit and once-only. An interaction is `pending` until
 *     exactly one settlement is recorded; the outcome says which of the four
 *     ways it ended.
 *  3. The correlation key is the `InteractionId`, not array position or arrival
 *     order, so out-of-order responses are well defined.
 */

import { z } from 'zod';
import { InteractionIdSchema, RunIdSchema, SessionIdSchema, TimestampSchema, TurnIdSchema } from './ids.ts';
import { JsonObjectSchema } from './json.ts';
import { ApprovalModeSchema } from './capability.ts';
import { AgentErrorSchema } from './errors.ts';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const QuestionChoiceSchema = z.strictObject({
  /** Stable key the response refers to. Not the display text. */
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(400),
  description: z.string().max(2000).optional(),
});

export const QuestionRequestSchema = z.strictObject({
  kind: z.literal('question'),
  prompt: z.string().min(1).max(8000),
  /** Absent means free-text. Present means the answer must select from these. */
  choices: z.array(QuestionChoiceSchema).min(1).max(64).optional(),
  multiSelect: z.boolean().default(false),
  placeholder: z.string().max(400).optional(),
});

/**
 * The key a batch answer is filed under.
 *
 * Assigned by the adapter, unique within one request, and deliberately NOT a
 * provider-native question id: Codex names its questions with its own `id` and
 * Claude keys answers by the question *text*, neither of which may reach a
 * public DTO (AGENTS.md §5). The character class keeps a key usable as a form
 * field name and as a JSON object key without escaping.
 */
export const QuestionKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a question key is alphanumeric with `.`, `_` or `-`');

/**
 * One question inside a batch.
 *
 * Every field exists because a pinned native surface supplies it and a host
 * needs it to render the question faithfully. An adapter that observes a native
 * fact it cannot map here refuses the whole request rather than dropping it —
 * see ADR-0018.
 */
export const QuestionItemSchema = z.strictObject({
  key: QuestionKeySchema,
  prompt: z.string().min(1).max(8000),
  /** Short label for a chip or column heading, when the provider supplies one. */
  header: z.string().min(1).max(200).optional(),
  /** Absent means free text only. Present means selections come from this list. */
  choices: z.array(QuestionChoiceSchema).min(1).max(64).optional(),
  /** Whether more than one choice may be selected. */
  multiSelect: z.boolean().default(false),
  /**
   * Whether typed text is accepted *in addition to* the choice list — the
   * "Other" affordance. Meaningless without `choices`, where text is the only
   * possible answer anyway.
   */
  allowFreeText: z.boolean().default(false),
  /**
   * Whether the answer is a secret. Advisory display guidance for the host, not
   * an enforced control: the runtime commits settled answers to a durable event
   * log either way. A host that must not retain a secret refuses the request.
   */
  sensitive: z.boolean().default(false),
});

/**
 * Several correlated questions asked at once.
 *
 * Order is the provider's order and is preserved. Identity is `key`, never
 * array position, so a response is well defined no matter how a host collects
 * it. See ADR-0018 for why this is a separate union member rather than a
 * widened `QuestionRequest`.
 */
export const QuestionSetRequestSchema = z
  .strictObject({
    kind: z.literal('question_set'),
    questions: z.array(QuestionItemSchema).min(1).max(32),
  })
  /**
   * Keys identify answers, so two questions sharing one key would share one
   * answer while both appearing to have been asked.
   *
   * Draft 2020-12 cannot express "unique by a property across array items" —
   * `uniqueItems` compares whole items, and two questions differing only in
   * `prompt` are distinct items with the same key. This is therefore a
   * documented Zod-stronger-than-JSON-Schema boundary, in the same class as the
   * graph-acyclicity guard: enforced in Zod and at every in-process ingress
   * (the runtime parses each `ProviderEventInput` through this schema), tested
   * separately, and named in `schema-parity.test.ts` rather than left implicit.
   */
  .refine((value) => new Set(value.questions.map((question) => question.key)).size === value.questions.length, {
    message: 'question keys must be unique within a request',
    path: ['questions'],
  });

/**
 * A described action, not an executed one. `command` is the provider's stated
 * intent for display and audit; the runtime does not run it and cannot
 * guarantee the provider will run exactly this.
 */
export const ApprovalSubjectSchema = z.strictObject({
  /** Coarse category so a UI can render without understanding every provider. */
  category: z.enum(['command', 'file_write', 'file_delete', 'network', 'tool', 'other']),
  summary: z.string().min(1).max(2000),
  /** Provider-declared detail: argv, path, URL. Advisory, never authoritative. */
  detail: JsonObjectSchema.optional(),
});

export const ApprovalRequestSchema = z.strictObject({
  kind: z.literal('approval'),
  subject: ApprovalSubjectSchema,
  /** Modes the provider will honour for *this* request. Subset of capability. */
  allowedModes: z.array(ApprovalModeSchema).min(1),
  /**
   * Provider-declared risk hint for UX ordering. This is not a security
   * classification and must not be presented as an enforced control.
   */
  riskHint: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const InteractionRequestSchema = z.discriminatedUnion('kind', [
  QuestionRequestSchema,
  QuestionSetRequestSchema,
  ApprovalRequestSchema,
]);

export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;
export type QuestionItem = z.infer<typeof QuestionItemSchema>;
export type QuestionSetRequest = z.infer<typeof QuestionSetRequestSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionKind = InteractionRequest['kind'];

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const QuestionResponseSchema = z.strictObject({
  kind: z.literal('question'),
  /** Free-text answer, or the selected choice `value`s. */
  answer: z.union([z.string().max(16_000), z.array(z.string().min(1).max(200)).min(1).max(64)]),
});

/**
 * One question's answer.
 *
 * Discriminated rather than a `string | string[]` union so "the user typed
 * `pg,sqlite`" and "the user selected two choices" can never be confused, and
 * so a free-text answer that happens to equal a choice value is still recorded
 * as text.
 */
export const QuestionAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(16_000) }),
  z.strictObject({
    type: z.literal('selection'),
    /** Choice `value`s, in the order the host collected them. */
    values: z.array(z.string().min(1).max(200)).min(1).max(64),
  }),
]);

const QuestionAnswersSchema = z.record(QuestionKeySchema, QuestionAnswerSchema);

function hasInvalidAnswerKeys(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Reflect.ownKeys(value).some((key) => !QuestionKeySchema.safeParse(key).success)
  );
}

/**
 * The answers to a whole batch, filed under the keys the request handed out.
 *
 * A record, not an array of pairs: a duplicate key is then unrepresentable
 * rather than merely invalid. Completeness is checked against the request by
 * `checkResponseAgainstRequest`, which is what makes settlement all-or-nothing.
 */
export const QuestionSetResponseSchema = z.strictObject({
  kind: z.literal('question_set'),
  answers: z.preprocess((value: z.input<typeof QuestionAnswersSchema>, ctx) => {
    // Zod's record parser skips own `__proto__` properties. Validate keys
    // before reconstruction so no invalid answer disappears before validation.
    // This enforces the record's existing JSON Schema propertyNames grammar;
    // it does not change the accepted wire shape or the inferred input type.
    if (hasInvalidAnswerKeys(value)) {
      ctx.addIssue({ code: 'custom', message: 'answer keys must match the question key grammar' });
      return z.NEVER;
    }
    return value;
  }, QuestionAnswersSchema),
});

export const ApprovalResponseSchema = z.strictObject({
  kind: z.literal('approval'),
  decision: z.enum(['approved', 'denied']),
  /** Required when approving; must be one of the request's `allowedModes`. */
  mode: ApprovalModeSchema.optional(),
  /** Shown back to the model when denying, so it can adapt. */
  reason: z.string().max(2000).optional(),
});

export const InteractionResponseSchema = z.discriminatedUnion('kind', [
  QuestionResponseSchema,
  QuestionSetResponseSchema,
  ApprovalResponseSchema,
]);

export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type QuestionSetResponse = z.infer<typeof QuestionSetResponseSchema>;
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export const InteractionStatusSchema = z.enum(['pending', 'settled']);
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>;

export const SettlementOutcomeSchema = z.enum([
  /** A caller responded. */
  'responded',
  /** The run ended before a response arrived. */
  'cancelled',
  /** A provider- or runtime-imposed deadline passed. */
  'expired',
  /** The provider withdrew the request (e.g. it no longer needs the answer). */
  'withdrawn',
]);
export type SettlementOutcome = z.infer<typeof SettlementOutcomeSchema>;

export const InteractionSettlementSchema = z
  .strictObject({
    outcome: SettlementOutcomeSchema,
    settledAt: TimestampSchema,
    /** Present if and only if `outcome === 'responded'`. */
    response: InteractionResponseSchema.optional(),
    /** Optional explanation for a non-`responded` outcome. */
    error: AgentErrorSchema.optional(),
  })
  .refine((value) => (value.outcome === 'responded') === (value.response !== undefined), {
    message: 'a `responded` settlement must carry a response, and only a `responded` settlement may carry one',
    path: ['response'],
  })
  .meta({
    if: { properties: { outcome: { const: 'responded' } }, required: ['outcome'] },
    then: { required: ['response'] },
    else: { not: { required: ['response'] } },
  });

export type InteractionSettlement = z.infer<typeof InteractionSettlementSchema>;

// ---------------------------------------------------------------------------
// The interaction record
// ---------------------------------------------------------------------------

export const AgentInteractionSchema = z
  .strictObject({
    interactionId: InteractionIdSchema,
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    /** Interactions always belong to a run; a session at rest raises none. */
    runId: RunIdSchema,
    status: InteractionStatusSchema,
    request: InteractionRequestSchema,
    requestedAt: TimestampSchema,
    /** Absent while `pending`. Present exactly once, forever, when `settled`. */
    settlement: InteractionSettlementSchema.optional(),
    /** Runtime-computed deadline, if any. */
    expiresAt: TimestampSchema.optional(),
  })
  .refine((value) => (value.status === 'settled') === (value.settlement !== undefined), {
    message: 'status and settlement must agree: `settled` iff a settlement is present',
    path: ['settlement'],
  })
  .refine(
    (value) => value.settlement?.response === undefined || value.settlement.response.kind === value.request.kind,
    {
      message: 'a response must have the same `kind` as its request',
      path: ['settlement', 'response', 'kind'],
    },
  )
  .meta({
    allOf: [
      {
        if: { properties: { status: { const: 'settled' } }, required: ['status'] },
        then: { required: ['settlement'] },
        else: { not: { required: ['settlement'] } },
      },
      {
        if: {
          properties: {
            request: { type: 'object', properties: { kind: { const: 'question' } }, required: ['kind'] },
          },
          required: ['request'],
        },
        then: {
          properties: {
            settlement: {
              type: 'object',
              properties: {
                response: {
                  type: 'object',
                  properties: { kind: { const: 'question' } },
                  required: ['kind'],
                },
              },
            },
          },
        },
      },
      {
        if: {
          properties: {
            request: { type: 'object', properties: { kind: { const: 'question_set' } }, required: ['kind'] },
          },
          required: ['request'],
        },
        then: {
          properties: {
            settlement: {
              type: 'object',
              properties: {
                response: {
                  type: 'object',
                  properties: { kind: { const: 'question_set' } },
                  required: ['kind'],
                },
              },
            },
          },
        },
      },
      {
        if: {
          properties: {
            request: { type: 'object', properties: { kind: { const: 'approval' } }, required: ['kind'] },
          },
          required: ['request'],
        },
        then: {
          properties: {
            settlement: {
              type: 'object',
              properties: {
                response: {
                  type: 'object',
                  properties: { kind: { const: 'approval' } },
                  required: ['kind'],
                },
              },
            },
          },
        },
      },
    ],
  });

export type AgentInteraction = z.infer<typeof AgentInteractionSchema>;

/**
 * Check a whole batch answer against the batch that was asked.
 *
 * All-or-nothing by construction: the key sets must match exactly before any
 * individual answer is looked at, so an adapter never sees a batch it would
 * have to answer partially.
 *
 * Every message here is a *bounded classification*. It may name a `key` the
 * request itself published — an adapter-assigned token already in the durable
 * event log — and it may state how many things were wrong. It must never carry
 * a value the caller supplied: a rejected answer is echoed straight into an
 * `AgentError` and a command receipt, and an answer may be a secret
 * (`QuestionItem.sensitive`) or attacker-influenced text. An unknown answer
 * *key* is caller-controlled too, so it is counted rather than repeated.
 */
function checkQuestionSetAnswers(request: QuestionSetRequest, response: QuestionSetResponse): string | undefined {
  const asked = new Map(request.questions.map((question) => [question.key, question]));

  const unanswered = request.questions.filter((question) => !Object.hasOwn(response.answers, question.key));
  if (unanswered.length > 0) {
    return `unanswered question(s): ${String(unanswered.length)}`;
  }
  const extra = Object.keys(response.answers).filter((key) => !asked.has(key));
  if (extra.length > 0) {
    return `the response carries ${String(extra.length)} answer(s) for question(s) that ${extra.length === 1 ? 'was' : 'were'} not asked`;
  }

  for (const question of request.questions) {
    const answer = response.answers[question.key];
    // The completeness check above already established this, so reaching it is
    // a defect rather than a caller error — but the contract says every
    // question is answered, so it is stated rather than assumed.
    if (answer === undefined) return 'unanswered question(s): 1';

    if (answer.type === 'text') {
      if (question.choices !== undefined && !question.allowFreeText) {
        return `question \`${question.key}\` does not accept free text`;
      }
      continue;
    }

    if (question.choices === undefined) {
      return `question \`${question.key}\` offers no choices to select`;
    }
    if (!question.multiSelect && answer.values.length > 1) {
      return `question \`${question.key}\` does not accept multiple selections`;
    }
    if (new Set(answer.values).size !== answer.values.length) {
      return `question \`${question.key}\` has a repeated selection`;
    }
    const permitted = new Set(question.choices.map((choice) => choice.value));
    const unknown = answer.values.filter((value) => !permitted.has(value));
    if (unknown.length > 0) {
      return `question \`${question.key}\` names ${String(unknown.length)} choice value(s) it does not offer`;
    }
  }

  return undefined;
}

/**
 * Validate a response against the request it claims to answer.
 *
 * Returned as a reason string rather than thrown so the runtime can turn it
 * into a rejection receipt with the caller's command id attached.
 */
export function checkResponseAgainstRequest(
  request: InteractionRequest,
  response: InteractionResponse,
): string | undefined {
  if (request.kind !== response.kind) {
    return `expected a \`${request.kind}\` response, received \`${response.kind}\``;
  }

  if (request.kind === 'question' && response.kind === 'question') {
    const { choices, multiSelect } = request;
    const { answer } = response;

    if (choices === undefined) {
      if (typeof answer !== 'string') return 'a free-text question must be answered with a string';
      return undefined;
    }

    const selected = typeof answer === 'string' ? [answer] : answer;
    if (!multiSelect && selected.length > 1) {
      return 'this question does not accept multiple selections';
    }
    const permitted = new Set(choices.map((choice) => choice.value));
    const unknown = selected.filter((value) => !permitted.has(value));
    if (unknown.length > 0) {
      // Counted, never echoed: a rejected answer reaches a durable receipt.
      return `the answer names ${String(unknown.length)} choice value(s) this question does not offer`;
    }
    return undefined;
  }

  if (request.kind === 'question_set' && response.kind === 'question_set') {
    return checkQuestionSetAnswers(request, response);
  }

  if (request.kind === 'approval' && response.kind === 'approval') {
    if (response.decision === 'approved') {
      if (response.mode === undefined) {
        return 'an approval must state the mode it was granted under';
      }
      if (!request.allowedModes.includes(response.mode)) {
        return `mode \`${response.mode}\` is not among the request's allowed modes (${request.allowedModes.join(', ')})`;
      }
    } else if (response.mode !== undefined) {
      return 'a denial must not carry an approval mode';
    }
    return undefined;
  }

  return undefined;
}
