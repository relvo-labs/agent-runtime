/**
 * Stable `$defs` identities for shared sub-schemas.
 *
 * Without this, Zod names reused sub-schemas `__schema0`, `__schema1`, … in
 * traversal order. Those names are meaningless to a reader and, worse, they
 * renumber whenever an unrelated field is added — turning a one-line contract
 * change into a thousand-line schema diff that nobody can review.
 *
 * Registration lives in the generator rather than in the shipped package so
 * `@relvo-labs/agent-protocol` stays free of import side effects and can keep
 * `"sideEffects": false`.
 */

import { z } from 'zod';

import {
  CommandIdSchema,
  CursorSchema,
  EventIdSchema,
  InteractionIdSchema,
  RunIdSchema,
  SequenceSchema,
  SessionIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceLeaseIdSchema,
} from '../../packages/protocol/src/ids.ts';
import { JsonValueSchema } from '../../packages/protocol/src/json.ts';
import { AgentErrorCodeSchema, AgentErrorSchema } from '../../packages/protocol/src/errors.ts';
import { RunStateSchema, SessionStateSchema, TurnStateSchema } from '../../packages/protocol/src/lifecycle.ts';
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  ApprovalSubjectSchema,
  InteractionRequestSchema,
  InteractionResponseSchema,
  InteractionSettlementSchema,
  QuestionChoiceSchema,
  QuestionRequestSchema,
  QuestionResponseSchema,
  SettlementOutcomeSchema,
} from '../../packages/protocol/src/interaction.ts';
import {
  RunTerminationSchema,
  TurnInputPartSchema,
  TurnInputSchema,
  UsageSchema,
} from '../../packages/protocol/src/entities.ts';
import {
  WorkspaceLeaseDescriptorSchema,
  WorkspaceOwnershipSchema,
  WorkspaceReleaseReportSchema,
  WorkspaceSpecSchema,
} from '../../packages/protocol/src/workspace.ts';
import { EventPayloadSchema } from '../../packages/protocol/src/events.ts';
import { CommandResultSchema } from '../../packages/protocol/src/commands.ts';
import {
  ApprovalCapabilitySchema,
  ApprovalModeSchema,
  InteractionCapabilitySchema,
  InterruptCapabilitySchema,
  QuestionCapabilitySchema,
  RecoveryCapabilitySchema,
  ProviderRecoveryRecordSchema,
  RunCapabilitySchema,
  StreamingCapabilitySchema,
  WorkspaceCapabilitySchema,
} from '../../packages/protocol/src/capability.ts';

/**
 * Ordered alphabetically by id. Adding an entry is a reviewable, additive
 * change; renaming one changes every `$ref` that points at it and is therefore
 * a breaking wire change.
 */
const NAMED_DEFS: readonly (readonly [string, z.ZodType])[] = [
  ['agent-error', AgentErrorSchema],
  ['agent-error-code', AgentErrorCodeSchema],
  ['approval-capability', ApprovalCapabilitySchema],
  ['approval-mode', ApprovalModeSchema],
  ['approval-request', ApprovalRequestSchema],
  ['approval-response', ApprovalResponseSchema],
  ['approval-subject', ApprovalSubjectSchema],
  ['command-id', CommandIdSchema],
  ['command-result', CommandResultSchema],
  ['cursor', CursorSchema],
  ['event-id', EventIdSchema],
  ['event-payload', EventPayloadSchema],
  ['interaction-capability', InteractionCapabilitySchema],
  ['interaction-id', InteractionIdSchema],
  ['interaction-request', InteractionRequestSchema],
  ['interaction-response', InteractionResponseSchema],
  ['interaction-settlement', InteractionSettlementSchema],
  ['interrupt-capability', InterruptCapabilitySchema],
  ['json-value', JsonValueSchema],
  ['question-capability', QuestionCapabilitySchema],
  ['question-choice', QuestionChoiceSchema],
  ['question-request', QuestionRequestSchema],
  ['question-response', QuestionResponseSchema],
  ['provider-recovery-record', ProviderRecoveryRecordSchema],
  ['recovery-capability', RecoveryCapabilitySchema],
  ['run-capability', RunCapabilitySchema],
  ['run-id', RunIdSchema],
  ['run-state', RunStateSchema],
  ['run-termination', RunTerminationSchema],
  ['sequence', SequenceSchema],
  ['session-id', SessionIdSchema],
  ['session-state', SessionStateSchema],
  ['settlement-outcome', SettlementOutcomeSchema],
  ['streaming-capability', StreamingCapabilitySchema],
  ['timestamp', TimestampSchema],
  ['turn-id', TurnIdSchema],
  ['turn-input', TurnInputSchema],
  ['turn-input-part', TurnInputPartSchema],
  ['turn-state', TurnStateSchema],
  ['usage', UsageSchema],
  ['workspace-capability', WorkspaceCapabilitySchema],
  ['workspace-lease-descriptor', WorkspaceLeaseDescriptorSchema],
  ['workspace-lease-id', WorkspaceLeaseIdSchema],
  ['workspace-ownership', WorkspaceOwnershipSchema],
  ['workspace-release-report', WorkspaceReleaseReportSchema],
  ['workspace-spec', WorkspaceSpecSchema],
];

/** Idempotent: safe to call more than once in a single process. */
export function registerStableDefNames(): readonly string[] {
  for (const [id, schema] of NAMED_DEFS) {
    if (z.globalRegistry.get(schema)?.id !== id) {
      z.globalRegistry.add(schema, { id });
    }
  }
  return NAMED_DEFS.map(([id]) => id);
}
