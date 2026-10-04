# `@relvo-labs/agent-protocol`

The wire contract shared by every Relvo agent package: authoritative Zod schemas,
inferred TypeScript types and generated JSON Schema. It is the dependency graph's
base layer and has no workspace-package dependencies. Use it to validate commands,
receipts, events and projections or build a transport/UI; use
[`agent-runtime`](https://github.com/relvo-labs/agent-runtime/blob/main/packages/runtime/README.md)
when you need to execute those commands.

## Install

ESM-only; Node `^22.18.0 || ^24.11.0 || ^26.0.0`. No peer dependencies; Zod is
installed as a runtime dependency.

```bash
pnpm add @relvo-labs/agent-protocol
# or
npm install @relvo-labs/agent-protocol
```

## Quick start

Parse untrusted transport input before using it. Schemas produce branded IDs and
fill declared defaults; `safeParse` exposes a validation result without requiring
exception handling. The JSON Schema subpath provides the same accepted JSON input
contract for Draft 2020-12 validators.

```ts
import { AgentCommandSchema, WIRE_VERSION, type AgentCommand } from '@relvo-labs/agent-protocol';
import { getJsonSchema, JSON_SCHEMA_WIRE_VERSION } from '@relvo-labs/agent-protocol/schemas';

const input: unknown = {
  type: 'open_session',
  commandId: 'example-open-1',
  providerId: 'scripted',
  workspace: { kind: 'existing', path: process.cwd() },
};
const parsed = AgentCommandSchema.safeParse(input);
if (!parsed.success) throw new Error('Invalid agent command');
const command: AgentCommand = parsed.data;
console.log(command.type, WIRE_VERSION); // open_session, 0.5
console.log(JSON_SCHEMA_WIRE_VERSION, getJsonSchema('agent-command'));
```

Parsing a command does not execute it, authorize it or check that its workspace
exists. The host passes a validated command to an executor and checks its receipt.

## API overview

All names below are exported from the package root. Schema names validate data;
the listed types describe parsed output unless explicitly named `Input`.

### Version and schema identity

- **Values/helpers:** `WIRE_VERSION`, `WIRE_STABILITY`, `SCHEMA_ID_BASE`, `schemaId`.

### JSON values

- **Schemas:** `JsonPrimitiveSchema`, `JsonValueSchema`, `JsonObjectSchema`.
- **Types:** `JsonPrimitive`, `JsonValue`, `JsonObject`.
- **Values/helpers:** `isJsonValue`.

### Identity, cursors and clocks

- **Schemas:** `SessionIdSchema`, `TurnIdSchema`, `RunIdSchema`, `InteractionIdSchema`, `EventIdSchema`, `WorkspaceLeaseIdSchema`, `CommandIdSchema`, `SequenceSchema`, `CursorSchema`, `TimestampSchema`.
- **Types:** `IdKind`, `SessionId`, `TurnId`, `RunId`, `InteractionId`, `EventId`, `WorkspaceLeaseId`, `CommandId`, `Sequence`, `Cursor`, `Timestamp`, `IdFactory`, `Clock`.
- **Values/helpers:** `ID_PREFIX`, `cursorFromSequence`, `sequenceFromCursor`, `createCounterIdFactory`, `createFixedClock`, `createSystemClock`.

### Typed errors

- **Schemas:** `AgentErrorCodeSchema`, `AgentErrorSchema`.
- **Types:** `AgentErrorCode`, `AgentError`.
- **Values/helpers:** `agentError`, `AgentRuntimeError`, `isAgentRuntimeError`, `toAgentError`.

### Provider capabilities and recovery

- **Schemas:** `InterruptModeSchema`, `InterruptCapabilitySchema`, `StreamingCapabilitySchema`, `RunCapabilitySchema`, `ApprovalModeSchema`, `ApprovalCapabilitySchema`, `QuestionCapabilitySchema`, `InteractionCapabilitySchema`, `WorkspaceRequirementSchema`, `WorkspaceCapabilitySchema`, `RecoveryCapabilitySchema`, `ProviderRecoveryRecordSchema`, `ProviderDescriptorSchema`.
- **Types:** `InterruptMode`, `ApprovalMode`, `RunCapability`, `InteractionCapability`, `WorkspaceCapability`, `RecoveryCapability`, `ProviderRecoveryRecord`, `ProviderDescriptor`, `ProviderDescriptorInput`.

### State machines

- **Schemas:** `SessionStateSchema`, `TurnStateSchema`, `RunStateSchema`.
- **Types:** `SessionState`, `TurnState`, `RunState`, `SessionCommandKind`, `TransitionTable`.
- **Values/helpers:** `SESSION_TERMINAL_STATES`, `TURN_TERMINAL_STATES`, `RUN_TERMINAL_STATES`, `SESSION_STATE_TABLE`, `TURN_STATE_TABLE`, `RUN_STATE_TABLE`, `SESSION_COMMAND_MATRIX`, `canTransition`, `isTerminal`, `nextStates`, `isCommandAdmissible`.

### Questions, approvals and settlements

- **Schemas:** `QuestionChoiceSchema`, `QuestionRequestSchema`, `QuestionKeySchema`, `QuestionItemSchema`, `QuestionSetRequestSchema`, `ApprovalSubjectSchema`, `ApprovalRequestSchema`, `InteractionRequestSchema`, `QuestionResponseSchema`, `QuestionAnswerSchema`, `QuestionSetResponseSchema`, `ApprovalResponseSchema`, `InteractionResponseSchema`, `InteractionStatusSchema`, `SettlementOutcomeSchema`, `InteractionSettlementSchema`, `AgentInteractionSchema`.
- **Types:** `QuestionRequest`, `QuestionItem`, `QuestionSetRequest`, `ApprovalRequest`, `InteractionRequest`, `InteractionKind`, `QuestionResponse`, `QuestionAnswer`, `QuestionSetResponse`, `ApprovalResponse`, `InteractionResponse`, `InteractionStatus`, `SettlementOutcome`, `InteractionSettlement`, `AgentInteraction`.
- **Values/helpers:** `checkResponseAgainstRequest`.

### Workspace DTOs

- **Schemas:** `WorkspaceOwnershipSchema`, `ExistingWorkspaceSpecSchema`, `ManagedWorkspaceSpecSchema`, `WorkspaceSpecSchema`, `WorkspaceLeaseDescriptorSchema`, `WorkspaceReleaseReportSchema`.
- **Types:** `WorkspaceOwnership`, `ExistingWorkspaceSpec`, `ManagedWorkspaceSpec`, `WorkspaceSpec`, `WorkspaceLeaseDescriptor`, `WorkspaceReleaseReport`.
- **Values/helpers:** `ownershipFor`.

### Session, turn, run and input DTOs

- **Schemas:** `TextPartSchema`, `FileRefPartSchema`, `TurnInputPartSchema`, `TurnInputSchema`, `UsageSchema`, `RunTerminationSchema`, `AgentRunSchema`, `AgentTurnSchema`, `AgentSessionSchema`, `SessionSnapshotSchema`.
- **Types:** `TurnInputPart`, `TurnInput`, `Usage`, `RunTermination`, `AgentRun`, `AgentTurn`, `AgentSession`, `SessionSnapshot`.

### Semantic events and envelopes

- **Schemas:** `EventPayloadSchema`, `ProviderEventPayloadSchema`, `EventEnvelopeSchema`, `ProviderEventInputSchema`.
- **Types:** `EventPayload`, `EventType`, `ProviderEventPayload`, `EventEnvelope`, `ProviderEventInput`.
- **Values/helpers:** `PROVIDER_EMITTABLE_EVENT_TYPES`, `isEventOfType`.

### Commands and receipts

- **Schemas:** `OpenSessionCommandSchema`, `SubmitTurnCommandSchema`, `InterruptRunCommandSchema`, `RespondToInteractionCommandSchema`, `CloseSessionCommandSchema`, `AgentCommandSchema`, `SessionOpenedResultSchema`, `TurnAcceptedResultSchema`, `RunInterruptRequestedResultSchema`, `InteractionSettledResultSchema`, `SessionClosedResultSchema`, `CommandResultSchema`, `CommandDispositionSchema`, `CommandReceiptSchema`.
- **Types:** `OpenSessionCommand`, `SubmitTurnCommand`, `InterruptRunCommand`, `RespondToInteractionCommand`, `CloseSessionCommand`, `AgentCommand`, `CommandType`, `OpenSessionCommandInput`, `SubmitTurnCommandInput`, `InterruptRunCommandInput`, `RespondToInteractionCommandInput`, `CloseSessionCommandInput`, `AgentCommandInput`, `CommandResult`, `CommandResultFor`, `CommandDisposition`, `CommandReceipt`.
- **Values/helpers:** `canonicalCommandFingerprint`.

### Subscriptions and history pages

- **Schemas:** `OverflowPolicySchema`, `SubscriptionRequestSchema`, `SubscriptionMessageSchema`, `EventPageSchema`, `RunFilterSchema`.
- **Types:** `OverflowPolicy`, `SubscriptionRequest`, `SubscriptionRequestInput`, `SubscriptionMessage`, `EventMessage`, `CaughtUpMessage`, `OverflowMessage`, `ClosedMessage`, `EventPage`, `RunFilter`.
- **Values/helpers:** `isEventMessage`, `isEventMessageOfType`.

### Schema registry

- **Types:** `PublishedSchemaName`.
- **Values/helpers:** `PUBLISHED_SCHEMAS`, `PUBLISHED_SCHEMA_NAMES`.

`checkResponseAgainstRequest` checks a response against the original question or
approval; `canonicalCommandFingerprint` canonicalizes command payload identity.
State-table helpers inspect allowed transitions and command admission. Event
and subscription guards narrow their discriminated unions.

### Subpaths

- `/schemas`: `JSON_SCHEMAS` (schemas keyed by published name),
  `JSON_SCHEMA_WIRE_VERSION`, `jsonSchemaById()` (keyed by stable `$id`),
  `getJsonSchema(name)` and the `PublishedSchemaName` type. These are generated
  input-mode schemas usable by validators in other languages. The current JS
  subpath also loads the shared schema registry; it is not a Zod-free bundle.
- `/package.json`: package metadata. The tarball also includes `schemas/*.json`;
  those files are not separately declared import subpaths.

## Guarantees and limits

- `WIRE_VERSION` is currently `0.5`; `WIRE_STABILITY` is `unstable`. Pre-1.0 wire
  compatibility is exact by minor line, independent of npm versions. Strict
  objects and closed unions reject unknown fields/variants. A provider descriptor
  is a negotiation input; parsing it alone does not prove compatibility.
- IDs distinguish sessions, turns, runs and interactions. Provider-native handles
  and IDs do not belong in public DTOs. Runtime envelopes own event identity,
  timestamps and gapless per-session sequence numbers.
- Generated schemas describe accepted JSON input. Omitted default-filled values
  are optional unless the default violates an invariant, in which case the
  generated conditional rejects the omission as Zod does.
- Zod additionally rejects cyclic, accessor-backed and hostile in-process graphs
  without throwing. Parsed JSON has no cycles, accessors, proxies or object
  identity; JSON Schema makes no claim to validate those JavaScript properties.
  The architecture also records the question-key uniqueness representability limit.
- `question_set` answers must match the complete requested key set. Sensitive
  flags guide display; they do not encrypt or suppress persistence of answers.
- Schemas do not supply execution, persistence, credential management, security
  isolation, crash recovery or exactly-once effects. `expired` is a settlement
  value; the supplied runtime has no deadline scheduler.

## Related packages and reading

- [Executor](https://github.com/relvo-labs/agent-runtime/blob/main/packages/executor/README.md): consumer execution contract.
- [Provider](https://github.com/relvo-labs/agent-runtime/blob/main/packages/provider/README.md) and [workspace](https://github.com/relvo-labs/agent-runtime/blob/main/packages/workspace/README.md): neutral SPIs consuming these DTOs.
- [Foundation architecture](https://github.com/relvo-labs/agent-runtime/blob/main/docs/architecture/foundation-v0.4.md): normative lifecycle, validation and replay rules.
- [Structured question sets (ADR-0018)](https://github.com/relvo-labs/agent-runtime/blob/main/docs/adr/ADR-0018-structured-question-sets.md) and [versioning](https://github.com/relvo-labs/agent-runtime/blob/main/docs/versioning.md).
