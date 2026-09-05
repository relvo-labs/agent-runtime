/**
 * Projected entity DTOs — the read model a consumer sees.
 *
 * These are projections of the event log, not independently mutable records.
 * Every field here is reconstructible by replaying events from sequence 0,
 * which is what makes the store's atomic revision boundary meaningful (ST-01).
 */

import { z } from 'zod';
import {
  InteractionIdSchema,
  RunIdSchema,
  SequenceSchema,
  SessionIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from './ids.ts';
import { RunStateSchema, SessionStateSchema, TurnStateSchema } from './lifecycle.ts';
import { AgentErrorSchema } from './errors.ts';
import { AgentInteractionSchema } from './interaction.ts';
import { JsonObjectSchema } from './json.ts';
import { WorkspaceLeaseDescriptorSchema } from './workspace.ts';
import { WIRE_VERSION } from './version.ts';

// ---------------------------------------------------------------------------
// Turn input
// ---------------------------------------------------------------------------

export const TextPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(1_000_000),
});

export const FileRefPartSchema = z.strictObject({
  type: z.literal('file_ref'),
  /** Workspace-relative path. Never absolute; never traversing outside root. */
  path: z
    .string()
    .min(1)
    .max(4096)
    .regex(
      /^(?![\\/])(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/,
      'file references must be relative and must not traverse outside the workspace',
    ),
});

export const TurnInputPartSchema = z.discriminatedUnion('type', [TextPartSchema, FileRefPartSchema]);

export const TurnInputSchema = z.strictObject({
  parts: z.array(TurnInputPartSchema).min(1).max(256),
  /** Caller metadata echoed back on events. Not interpreted by the runtime. */
  metadata: JsonObjectSchema.optional(),
});

export type TurnInputPart = z.infer<typeof TurnInputPartSchema>;
export type TurnInput = z.infer<typeof TurnInputSchema>;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const UsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  totalTokens: z.int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunTerminationSchema = z.strictObject({
  /** Exactly one of these is recorded for a run, exactly once (LC-01). */
  outcome: z.enum(['succeeded', 'failed', 'interrupted']),
  at: TimestampSchema,
  error: AgentErrorSchema.optional(),
  /** Caller-supplied reason when the outcome is `interrupted`. */
  reason: z.string().max(2000).optional(),
});
export type RunTermination = z.infer<typeof RunTerminationSchema>;

export const AgentRunSchema = z
  .strictObject({
    runId: RunIdSchema,
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    /** 1-based attempt number within the turn. */
    attempt: z.int().positive(),
    state: RunStateSchema,
    startedAt: TimestampSchema,
    /** Interactions raised by this run that are not yet settled. */
    pendingInteractionIds: z.array(InteractionIdSchema).default([]),
    usage: UsageSchema.optional(),
    termination: RunTerminationSchema.optional(),
  })
  .refine(
    (value) =>
      (value.termination !== undefined) ===
      (value.state === 'succeeded' || value.state === 'failed' || value.state === 'interrupted'),
    { message: 'a run has a termination record if and only if it is in a terminal state', path: ['termination'] },
  )
  .refine((value) => value.termination === undefined || value.termination.outcome === value.state, {
    message: 'the termination outcome must equal the terminal run state',
    path: ['termination', 'outcome'],
  })
  .refine((value) => value.state !== 'awaiting_interaction' || value.pendingInteractionIds.length > 0, {
    message: 'a run awaiting interaction must have at least one pending interaction',
    path: ['pendingInteractionIds'],
  })
  .meta({
    allOf: [
      {
        if: { properties: { state: { enum: ['succeeded', 'failed', 'interrupted'] } }, required: ['state'] },
        then: { required: ['termination'] },
        else: { not: { required: ['termination'] } },
      },
      {
        if: { properties: { state: { const: 'succeeded' } }, required: ['state'] },
        then: {
          properties: { termination: { type: 'object', properties: { outcome: { const: 'succeeded' } } } },
        },
      },
      {
        if: { properties: { state: { const: 'failed' } }, required: ['state'] },
        then: { properties: { termination: { type: 'object', properties: { outcome: { const: 'failed' } } } } },
      },
      {
        if: { properties: { state: { const: 'interrupted' } }, required: ['state'] },
        then: {
          properties: { termination: { type: 'object', properties: { outcome: { const: 'interrupted' } } } },
        },
      },
      {
        if: { properties: { state: { const: 'awaiting_interaction' } }, required: ['state'] },
        then: { properties: { pendingInteractionIds: { type: 'array', minItems: 1 } } },
      },
    ],
  });

export type AgentRun = z.infer<typeof AgentRunSchema>;

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export const AgentTurnSchema = z.strictObject({
  turnId: TurnIdSchema,
  sessionId: SessionIdSchema,
  state: TurnStateSchema,
  input: TurnInputSchema,
  createdAt: TimestampSchema,
  /** Every run attempted for this turn, oldest first. */
  runIds: z.array(RunIdSchema).default([]),
  /** Concatenated assistant text from the successful run, if any. */
  output: z.string().optional(),
  error: AgentErrorSchema.optional(),
});

export type AgentTurn = z.infer<typeof AgentTurnSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const AgentSessionSchema = z.strictObject({
  sessionId: SessionIdSchema,
  state: SessionStateSchema,
  providerId: z.string().min(1),
  /** The wire version this session was opened under. */
  wireVersion: z.literal(WIRE_VERSION),
  workspace: WorkspaceLeaseDescriptorSchema,
  createdAt: TimestampSchema,
  /** Highest event sequence committed for this session. */
  sequence: SequenceSchema,
  turnIds: z.array(TurnIdSchema).default([]),
  error: AgentErrorSchema.optional(),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

/** The complete projected read model for one session. */
export const SessionSnapshotSchema = z.strictObject({
  session: AgentSessionSchema,
  turns: z.array(AgentTurnSchema),
  runs: z.array(AgentRunSchema),
  interactions: z.array(AgentInteractionSchema),
  /** Committed store revision this snapshot was read at (ST-01). */
  revision: z.int().nonnegative(),
});

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
