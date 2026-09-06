/**
 * Commands and receipts.
 *
 * Every mutating call carries a caller-generated `commandId`. The runtime
 * deduplicates on it, which gives callers a safe retry story over an unreliable
 * link: re-sending a command either performs it once or returns the original
 * receipt, and the caller cannot tell the difference except via
 * `disposition`.
 *
 * Three dispositions, and the third is the one people forget:
 *
 *   applied     first time; the effect happened.
 *   duplicate   same id, same payload; the effect already happened. The
 *               original result is replayed verbatim.
 *   rejected    the command was not applied. `error` says why. A rejection is
 *               itself recorded, so replaying a rejected command returns the
 *               same rejection rather than re-attempting it.
 *
 * Reusing a `commandId` with a *different* payload is `command_id_conflict`:
 * silently applying it would break the caller's mental model, and silently
 * ignoring it would lose work.
 */

import { z } from 'zod';
import {
  CommandIdSchema,
  InteractionIdSchema,
  RunIdSchema,
  SequenceSchema,
  SessionIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from './ids.ts';
import { AgentErrorSchema } from './errors.ts';
import { TurnInputSchema } from './entities.ts';
import { InteractionResponseSchema } from './interaction.ts';
import { JsonObjectSchema } from './json.ts';
import { WorkspaceSpecSchema } from './workspace.ts';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commandBase = {
  commandId: CommandIdSchema,
};

export const OpenSessionCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal('open_session'),
  providerId: z.string().min(1).max(64),
  workspace: WorkspaceSpecSchema,
  /** Opaque, provider-interpreted configuration. Validated by the adapter. */
  providerOptions: JsonObjectSchema.optional(),
});

export const SubmitTurnCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal('submit_turn'),
  sessionId: SessionIdSchema,
  input: TurnInputSchema,
});

export const InterruptRunCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal('interrupt_run'),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  reason: z.string().max(2000).optional(),
});

export const RespondToInteractionCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal('respond_to_interaction'),
  sessionId: SessionIdSchema,
  interactionId: InteractionIdSchema,
  response: InteractionResponseSchema,
});

export const CloseSessionCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal('close_session'),
  sessionId: SessionIdSchema,
  /**
   * Closing disposes the provider session and releases the workspace lease. It
   * is NOT a way to cancel a run — use `interrupt_run` for that. If a run is
   * still in flight, this decides what happens to it.
   */
  ifRunActive: z.enum(['interrupt', 'reject']).default('interrupt'),
});

export const AgentCommandSchema = z.discriminatedUnion('type', [
  OpenSessionCommandSchema,
  SubmitTurnCommandSchema,
  InterruptRunCommandSchema,
  RespondToInteractionCommandSchema,
  CloseSessionCommandSchema,
]);

export type OpenSessionCommand = z.infer<typeof OpenSessionCommandSchema>;
export type SubmitTurnCommand = z.infer<typeof SubmitTurnCommandSchema>;
export type InterruptRunCommand = z.infer<typeof InterruptRunCommandSchema>;
export type RespondToInteractionCommand = z.infer<typeof RespondToInteractionCommandSchema>;
export type CloseSessionCommand = z.infer<typeof CloseSessionCommandSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
export type CommandType = AgentCommand['type'];

/**
 * What a *caller* supplies, before schema defaults are applied.
 *
 * These are the types on `AgentExecutor`. The parsed (`z.infer`) forms are what
 * the runtime works with internally. Exposing the parsed form to callers would
 * force them to supply every defaulted field — e.g. `ifRunActive` — which
 * defeats the point of having a default.
 */
export type OpenSessionCommandInput = z.input<typeof OpenSessionCommandSchema>;
export type SubmitTurnCommandInput = z.input<typeof SubmitTurnCommandSchema>;
export type InterruptRunCommandInput = z.input<typeof InterruptRunCommandSchema>;
export type RespondToInteractionCommandInput = z.input<typeof RespondToInteractionCommandSchema>;
export type CloseSessionCommandInput = z.input<typeof CloseSessionCommandSchema>;
export type AgentCommandInput = z.input<typeof AgentCommandSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const SessionOpenedResultSchema = z.strictObject({
  type: z.literal('session_opened'),
  sessionId: SessionIdSchema,
});

export const TurnAcceptedResultSchema = z.strictObject({
  type: z.literal('turn_accepted'),
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
  runId: RunIdSchema,
});

export const RunInterruptRequestedResultSchema = z.strictObject({
  type: z.literal('run_interrupt_requested'),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  /**
   * False when the run was already terminal. The command still succeeds — the
   * caller's intent ("this run must not continue") holds either way — but the
   * receipt says no interrupt was actually delivered.
   */
  delivered: z.boolean(),
});

export const InteractionSettledResultSchema = z.strictObject({
  type: z.literal('interaction_settled'),
  sessionId: SessionIdSchema,
  interactionId: InteractionIdSchema,
});

export const SessionClosedResultSchema = z.strictObject({
  type: z.literal('session_closed'),
  sessionId: SessionIdSchema,
  /** True when closing had to interrupt an in-flight run. */
  interruptedActiveRun: z.boolean(),
});

export const CommandResultSchema = z.discriminatedUnion('type', [
  SessionOpenedResultSchema,
  TurnAcceptedResultSchema,
  RunInterruptRequestedResultSchema,
  InteractionSettledResultSchema,
  SessionClosedResultSchema,
]);

export type CommandResult = z.infer<typeof CommandResultSchema>;

/** Maps each command type to the result type it produces when applied. */
export type CommandResultFor<T extends CommandType> = Extract<
  CommandResult,
  {
    type: T extends 'open_session'
      ? 'session_opened'
      : T extends 'submit_turn'
        ? 'turn_accepted'
        : T extends 'interrupt_run'
          ? 'run_interrupt_requested'
          : T extends 'respond_to_interaction'
            ? 'interaction_settled'
            : 'session_closed';
  }
>;

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export const CommandDispositionSchema = z.enum(['applied', 'duplicate', 'rejected']);
export type CommandDisposition = z.infer<typeof CommandDispositionSchema>;

export const CommandReceiptSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    commandType: z.enum(['open_session', 'submit_turn', 'interrupt_run', 'respond_to_interaction', 'close_session']),
    disposition: CommandDispositionSchema,
    /** Present unless the command was rejected. */
    result: CommandResultSchema.optional(),
    /** Present if and only if rejected. */
    error: AgentErrorSchema.optional(),
    /**
     * Highest sequence committed by this command, so a caller can subscribe
     * from exactly the point its own command took effect.
     */
    sequence: SequenceSchema.optional(),
    /** When the command was FIRST applied — unchanged across duplicate replays. */
    acceptedAt: TimestampSchema,
  })
  .refine((value) => (value.disposition === 'rejected') === (value.error !== undefined), {
    message: 'a receipt carries an error if and only if it was rejected',
    path: ['error'],
  })
  .refine((value) => (value.disposition === 'rejected') === (value.result === undefined), {
    message: 'a receipt carries a result if and only if it was not rejected',
    path: ['result'],
  })
  .meta({
    if: { properties: { disposition: { const: 'rejected' } }, required: ['disposition'] },
    then: { required: ['error'], not: { required: ['result'] } },
    else: { required: ['result'], not: { required: ['error'] } },
  });

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

/**
 * Two dispatches of the same `commandId` are the same command only if their
 * payloads match. Compared on a canonical JSON form so key order cannot cause a
 * spurious conflict.
 */
export function canonicalCommandFingerprint(command: AgentCommand): string {
  const { commandId: _commandId, ...rest } = command;
  return canonicalStringify(rest);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`).join(',')}}`;
}
