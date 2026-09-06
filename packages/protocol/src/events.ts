/**
 * The event contract.
 *
 * Two schemas, and the split between them is the whole point:
 *
 *   ProviderEventInput   what an adapter is allowed to emit. Semantic payload
 *                        only. No ids, no sequence, no timestamp.
 *   EventEnvelope        what the runtime commits and a consumer observes.
 *                        Identity, ordering and time are stamped here.
 *
 * A provider that could mint an `eventId` or choose a `sequence` could break
 * ordering for every subscriber, so it is not given the opportunity.
 */

import { z } from 'zod';
import {
  EventIdSchema,
  InteractionIdSchema,
  RunIdSchema,
  SequenceSchema,
  SessionIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from './ids.ts';
import { AgentErrorSchema } from './errors.ts';
import { JsonObjectSchema } from './json.ts';
import { RunStateSchema, SessionStateSchema, TurnStateSchema } from './lifecycle.ts';
import { InteractionRequestSchema, InteractionSettlementSchema } from './interaction.ts';
import { RunTerminationSchema, TurnInputSchema, UsageSchema } from './entities.ts';
import { WorkspaceLeaseDescriptorSchema, WorkspaceReleaseReportSchema } from './workspace.ts';
import { WIRE_VERSION } from './version.ts';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const sessionOpened = z.strictObject({
  type: z.literal('session.opened'),
  providerId: z.string().min(1),
  workspace: WorkspaceLeaseDescriptorSchema,
});

const sessionStateChanged = z.strictObject({
  type: z.literal('session.state_changed'),
  from: SessionStateSchema,
  to: SessionStateSchema,
});

const sessionClosed = z.strictObject({
  type: z.literal('session.closed'),
  /** Distinguishes an orderly close from a failure. */
  reason: z.enum(['requested', 'failed']),
  workspaceRelease: WorkspaceReleaseReportSchema,
  error: AgentErrorSchema.optional(),
});

const turnStarted = z.strictObject({
  type: z.literal('turn.started'),
  turnId: TurnIdSchema,
  /**
   * The caller's input, carried on the event so the projection is a complete
   * fold of the log. Without it, replaying from sequence 0 could not
   * reconstruct what was asked.
   */
  input: TurnInputSchema,
});

const turnStateChanged = z.strictObject({
  type: z.literal('turn.state_changed'),
  turnId: TurnIdSchema,
  from: TurnStateSchema,
  to: TurnStateSchema,
});

const turnSettled = z.strictObject({
  type: z.literal('turn.settled'),
  turnId: TurnIdSchema,
  state: TurnStateSchema,
  output: z.string().optional(),
  error: AgentErrorSchema.optional(),
});

const runStarted = z.strictObject({
  type: z.literal('run.started'),
  turnId: TurnIdSchema,
  attempt: z.int().positive(),
});

const runStateChanged = z.strictObject({
  type: z.literal('run.state_changed'),
  from: RunStateSchema,
  to: RunStateSchema,
});

/** Incremental assistant text. Deltas concatenate; they never overlap. */
const runMessageDelta = z.strictObject({
  type: z.literal('run.message_delta'),
  text: z.string().min(1).max(100_000),
});

const runToolActivity = z.strictObject({
  type: z.literal('run.tool_activity'),
  toolName: z.string().min(1).max(200),
  phase: z.enum(['invoked', 'succeeded', 'failed']),
  /** Provider-declared arguments/result summary. JSON-safe, bounded. */
  detail: JsonObjectSchema.optional(),
});

const runUsage = z.strictObject({
  type: z.literal('run.usage'),
  usage: UsageSchema,
});

const runFinished = z.strictObject({
  type: z.literal('run.finished'),
  turnId: TurnIdSchema,
  termination: RunTerminationSchema,
});

const interactionRequested = z.strictObject({
  type: z.literal('interaction.requested'),
  interactionId: InteractionIdSchema,
  turnId: TurnIdSchema,
  request: InteractionRequestSchema,
  expiresAt: TimestampSchema.optional(),
});

const interactionSettled = z.strictObject({
  type: z.literal('interaction.settled'),
  interactionId: InteractionIdSchema,
  turnId: TurnIdSchema,
  settlement: InteractionSettlementSchema,
});

/**
 * Non-fatal information from the runtime or a provider. Consumers may ignore
 * these entirely; nothing in the projected state depends on them.
 */
const diagnostic = z.strictObject({
  type: z.literal('diagnostic'),
  level: z.enum(['debug', 'info', 'warning']),
  message: z.string().min(1).max(4000),
  detail: JsonObjectSchema.optional(),
});

export const EventPayloadSchema = z.discriminatedUnion('type', [
  sessionOpened,
  sessionStateChanged,
  sessionClosed,
  turnStarted,
  turnStateChanged,
  turnSettled,
  runStarted,
  runStateChanged,
  runMessageDelta,
  runToolActivity,
  runUsage,
  runFinished,
  interactionRequested,
  interactionSettled,
  diagnostic,
]);

export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload['type'];

/** Payload types a provider is permitted to originate. */
export const PROVIDER_EMITTABLE_EVENT_TYPES: readonly EventType[] = [
  'run.message_delta',
  'run.tool_activity',
  'run.usage',
  'interaction.requested',
  'diagnostic',
];

export const ProviderEventPayloadSchema = z.discriminatedUnion('type', [
  runMessageDelta,
  runToolActivity,
  runUsage,
  // A provider states the *request*; the runtime assigns the interaction id.
  z.strictObject({
    type: z.literal('interaction.requested'),
    request: InteractionRequestSchema,
    /** Provider's own correlation token, mapped to an InteractionId by the runtime. */
    providerRef: z.string().min(1).max(200),
  }),
  diagnostic,
]);

export type ProviderEventPayload = z.infer<typeof ProviderEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const EventEnvelopeSchema = z.strictObject({
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  /** Present for every run-scoped event; absent for session-scoped ones. */
  runId: RunIdSchema.optional(),
  /**
   * Strictly increasing, gapless, per session. Allocated inside the same store
   * commit as the event body and the projected state (ST-01).
   */
  sequence: SequenceSchema,
  occurredAt: TimestampSchema,
  wireVersion: z.literal(WIRE_VERSION),
  payload: EventPayloadSchema,
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * The only thing a provider hands to the runtime.
 *
 * Note what is absent: `eventId`, `sequence`, `occurredAt`, `sessionId`. A
 * provider physically cannot supply them, so it cannot corrupt ordering.
 */
export const ProviderEventInputSchema = z.strictObject({
  payload: ProviderEventPayloadSchema,
});

export type ProviderEventInput = z.infer<typeof ProviderEventInputSchema>;

/** Narrowing helper so consumers do not hand-roll a `switch` on `payload.type`. */
export function isEventOfType<T extends EventType>(
  envelope: EventEnvelope,
  type: T,
): envelope is EventEnvelope & { payload: Extract<EventPayload, { type: T }> } {
  return envelope.payload.type === type;
}
