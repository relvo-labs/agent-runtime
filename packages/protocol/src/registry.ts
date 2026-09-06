/**
 * The published schema set.
 *
 * This is an explicit allow-list, not a sweep of every exported schema. A
 * schema appears in generated JSON Schema only when someone decided it is part
 * of the wire contract — which means adding a helper schema does not silently
 * expand the published surface, and removing an entry is a visible diff.
 *
 * Names are stable identity. Renaming one changes its `$id` and is a breaking
 * wire change (see .agents/skills/runtime-contract-evolution).
 */

import type { z } from 'zod';

import { AgentErrorSchema } from './errors.ts';
import { ProviderDescriptorSchema, ProviderRecoveryRecordSchema } from './capability.ts';
import { AgentInteractionSchema, InteractionRequestSchema, InteractionResponseSchema } from './interaction.ts';
import {
  AgentRunSchema,
  AgentSessionSchema,
  AgentTurnSchema,
  SessionSnapshotSchema,
  TurnInputSchema,
} from './entities.ts';
import { EventEnvelopeSchema, EventPayloadSchema, ProviderEventInputSchema } from './events.ts';
import { AgentCommandSchema, CommandReceiptSchema, CommandResultSchema } from './commands.ts';
import { SubscriptionMessageSchema, SubscriptionRequestSchema, EventPageSchema } from './subscription.ts';
import { WorkspaceLeaseDescriptorSchema, WorkspaceReleaseReportSchema, WorkspaceSpecSchema } from './workspace.ts';

/** Ordered by name so generated output is deterministic regardless of edits. */
export const PUBLISHED_SCHEMAS = {
  'agent-command': AgentCommandSchema,
  'agent-error': AgentErrorSchema,
  'agent-interaction': AgentInteractionSchema,
  'agent-run': AgentRunSchema,
  'agent-session': AgentSessionSchema,
  'agent-turn': AgentTurnSchema,
  'command-receipt': CommandReceiptSchema,
  'command-result': CommandResultSchema,
  'event-envelope': EventEnvelopeSchema,
  'event-page': EventPageSchema,
  'event-payload': EventPayloadSchema,
  'interaction-request': InteractionRequestSchema,
  'interaction-response': InteractionResponseSchema,
  'provider-descriptor': ProviderDescriptorSchema,
  'provider-event-input': ProviderEventInputSchema,
  'provider-recovery-record': ProviderRecoveryRecordSchema,
  'session-snapshot': SessionSnapshotSchema,
  'subscription-message': SubscriptionMessageSchema,
  'subscription-request': SubscriptionRequestSchema,
  'turn-input': TurnInputSchema,
  'workspace-lease-descriptor': WorkspaceLeaseDescriptorSchema,
  'workspace-release-report': WorkspaceReleaseReportSchema,
  'workspace-spec': WorkspaceSpecSchema,
} as const satisfies Record<string, z.ZodType>;

export type PublishedSchemaName = keyof typeof PUBLISHED_SCHEMAS;

export const PUBLISHED_SCHEMA_NAMES: readonly PublishedSchemaName[] = Object.keys(
  PUBLISHED_SCHEMAS,
).sort() as PublishedSchemaName[];
