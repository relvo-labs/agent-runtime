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

export const InteractionRequestSchema = z.discriminatedUnion('kind', [QuestionRequestSchema, ApprovalRequestSchema]);

export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;
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

export const ApprovalResponseSchema = z.strictObject({
  kind: z.literal('approval'),
  decision: z.enum(['approved', 'denied']),
  /** Required when approving; must be one of the request's `allowedModes`. */
  mode: ApprovalModeSchema.optional(),
  /** Shown back to the model when denying, so it can adapt. */
  reason: z.string().max(2000).optional(),
});

export const InteractionResponseSchema = z.discriminatedUnion('kind', [QuestionResponseSchema, ApprovalResponseSchema]);

export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;
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
  );

export type AgentInteraction = z.infer<typeof AgentInteractionSchema>;

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
      return `unknown choice value(s): ${unknown.join(', ')}`;
    }
    return undefined;
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
