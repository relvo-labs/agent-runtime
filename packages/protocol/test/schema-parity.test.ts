import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { PUBLISHED_SCHEMAS, type PublishedSchemaName } from '../src/registry.ts';
import { JSON_SCHEMAS } from '../src/generated/json-schemas.ts';

type ParityCase = {
  readonly schema: PublishedSchemaName;
  readonly value: unknown;
};

const timestamp = '2026-01-01T00:00:00.000Z';
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const runBase = {
  runId: 'run_0000000000000001',
  sessionId: 'ses_0000000000000001',
  turnId: 'trn_0000000000000001',
  attempt: 1,
  startedAt: timestamp,
  pendingInteractionIds: [],
};
const interactionBase = {
  interactionId: 'int_0000000000000001',
  sessionId: 'ses_0000000000000001',
  turnId: 'trn_0000000000000001',
  runId: 'run_0000000000000001',
  request: { kind: 'question', prompt: 'Continue?', multiSelect: false },
  requestedAt: timestamp,
};
const receiptBase = {
  commandId: 'caller-command-1',
  commandType: 'submit_turn',
  acceptedAt: timestamp,
};
const providerDescriptorBase = {
  providerId: 'fixture',
  providerVersion: '0.1.0',
  wireVersion: '0.4',
  displayName: 'Fixture',
  run: {
    interrupt: { mode: 'immediate', deliversPartialOutput: true, sessionRemainsUsable: true },
    streaming: { messageDeltas: false, toolActivity: false, incrementalUsage: false },
    maxConcurrentRunsPerSession: 1,
  },
  interaction: {
    approval: { supported: false, modes: [], blocking: true },
    question: { supported: false, choices: false, multiSelect: false },
    settlementTimeoutMs: null,
  },
  workspace: { requires: 'directory', acceptsOwnership: ['borrowed', 'managed'], writes: true },
  recovery: { exportsRecoveryRecord: false, resumesFromRecoveryRecord: false },
  extensions: {},
};
const eventEnvelopeBase = {
  eventId: 'evt_0000000000000001',
  sessionId: 'ses_0000000000000001',
  sequence: 1,
  occurredAt: timestamp,
  payload: { type: 'diagnostic', level: 'info', message: 'known' },
};
const agentSessionBase = {
  sessionId: 'ses_0000000000000001',
  state: 'ready',
  providerId: 'fixture',
  workspace: {
    leaseId: 'wsl_0000000000000001',
    ownership: 'borrowed',
    root: '/workspace',
    acquiredAt: timestamp,
    released: false,
  },
  createdAt: timestamp,
  sequence: 1,
  turnIds: [],
};
const sharedDetail = { value: 'shared' };

// --- InteractionSettlement `responded` iff `response` -----------------------
//
// The invariant lives on a *shared* sub-schema, so it must survive being
// extracted into `$defs` and referenced from every published root that embeds
// it. These builders wrap one settlement in each of the six affected roots.

const settledInteractionWith = (settlement: unknown): unknown => ({
  ...interactionBase,
  status: 'settled',
  settlement,
});
const interactionSettledPayload = (settlement: unknown): unknown => ({
  type: 'interaction.settled',
  interactionId: 'int_0000000000000001',
  turnId: 'trn_0000000000000001',
  settlement,
});
const settlementEnvelope = (settlement: unknown): unknown => ({
  eventId: 'evt_0000000000000001',
  sessionId: 'ses_0000000000000001',
  runId: 'run_0000000000000001',
  sequence: 7,
  occurredAt: timestamp,
  wireVersion: '0.4',
  payload: interactionSettledPayload(settlement),
});
const settlementSnapshot = (settlement: unknown): unknown => ({
  session: { ...agentSessionBase, wireVersion: '0.4' },
  turns: [],
  runs: [],
  interactions: [settledInteractionWith(settlement)],
  revision: 1,
});

/** Every published root that transitively embeds `interaction-settlement`. */
const settlementRoots: readonly {
  readonly schema: PublishedSchemaName;
  readonly wrap: (settlement: unknown) => unknown;
}[] = [
  { schema: 'agent-interaction', wrap: settledInteractionWith },
  { schema: 'event-payload', wrap: interactionSettledPayload },
  { schema: 'event-envelope', wrap: settlementEnvelope },
  {
    schema: 'event-page',
    wrap: (settlement) => ({
      events: [settlementEnvelope(settlement)],
      nextSequence: 8,
      revision: 1,
      hasMore: false,
    }),
  },
  { schema: 'session-snapshot', wrap: settlementSnapshot },
  {
    schema: 'subscription-message',
    wrap: (settlement) => ({
      type: 'event',
      event: settlementEnvelope(settlement),
      cursor: 'cur_7',
      replay: false,
    }),
  },
];

const respondedWithoutResponse = { outcome: 'responded', settledAt: timestamp };
const unrespondedWithResponse = {
  outcome: 'cancelled',
  settledAt: timestamp,
  response: { kind: 'question', answer: 'sneaked in' },
};
const legalSettlement = {
  outcome: 'responded',
  settledAt: timestamp,
  response: { kind: 'question', answer: 'ok' },
};

// --- Git ref must not begin with `-` ---------------------------------------
//
// A ref that starts with `-` is read by git as an option, not a revision. The
// Zod refinement rejects it; the published JSON Schema has to say the same
// thing or a non-TypeScript consumer validates an argument-injection vector as
// conformant.

const gitSpec = (ref: string): unknown => ({
  kind: 'managed',
  source: { kind: 'git', remote: 'https://example.invalid/repo.git', ref },
});
const openSessionWith = (ref: string): unknown => ({
  commandId: 'open-git-ref',
  type: 'open_session',
  providerId: 'fixture',
  workspace: gitSpec(ref),
});

const corpus: readonly ParityCase[] = [
  {
    schema: 'agent-command',
    value: { commandId: 'close-default', type: 'close_session', sessionId: 'ses_0000000000000001' },
  },
  { schema: 'subscription-request', value: { sessionId: 'ses_0000000000000001' } },
  { schema: 'agent-error', value: { code: 'invalid_request', message: 'default retryable' } },
  { schema: 'interaction-request', value: { kind: 'question', prompt: 'Default multi-select' } },
  { schema: 'interaction-request', value: { kind: 'approval', prompt: 'Default risk' } },
  { schema: 'agent-run', value: { ...runBase, state: 'running', pendingInteractionIds: undefined } },
  {
    schema: 'agent-turn',
    value: {
      turnId: 'trn_0000000000000001',
      sessionId: 'ses_0000000000000001',
      state: 'accepted',
      input: { parts: [{ type: 'text', text: 'defaults' }] },
      acceptedAt: timestamp,
    },
  },
  {
    schema: 'workspace-lease-descriptor',
    value: { leaseId: 'wsl_0000000000000001', ownership: 'borrowed', root: '/workspace', acquiredAt: timestamp },
  },
  {
    schema: 'workspace-release-report',
    value: { leaseId: 'wsl_0000000000000001', ownership: 'borrowed', releasedAt: timestamp },
  },
  {
    schema: 'agent-session',
    value: {
      sessionId: 'ses_0000000000000001',
      state: 'ready',
      providerId: 'fixture',
      wireVersion: '0.4',
      workspace: { leaseId: 'wsl_0000000000000001', ownership: 'borrowed', root: '/workspace', acquiredAt: timestamp },
      createdAt: timestamp,
      sequence: 0,
    },
  },
  {
    schema: 'provider-descriptor',
    value: {
      providerId: 'minimal',
      providerVersion: '0.1.0',
      wireVersion: '0.4',
      displayName: 'Minimal',
      run: { interrupt: { mode: 'unsupported' }, streaming: {} },
      interaction: { approval: {}, question: {} },
      workspace: { requires: 'directory' },
      recovery: {},
    },
  },
  {
    schema: 'provider-event-input',
    value: {
      payload: {
        type: 'run.tool_activity',
        toolName: 'shared-acyclic',
        phase: 'succeeded',
        detail: { left: sharedDetail, right: sharedDetail },
      },
    },
  },
  { schema: 'event-envelope', value: { ...eventEnvelopeBase, wireVersion: '0.4' } },
  { schema: 'event-envelope', value: { ...eventEnvelopeBase, wireVersion: '0.5' } },
  { schema: 'agent-session', value: { ...agentSessionBase, wireVersion: '0.4' } },
  { schema: 'agent-session', value: { ...agentSessionBase, wireVersion: '0.5' } },
  {
    schema: 'provider-recovery-record',
    value: { providerId: 'fixture', providerVersion: '0.1.0', wireVersion: '0.4', opaque: {} },
  },
  {
    schema: 'provider-recovery-record',
    value: { providerId: 'fixture', providerVersion: '0.1.0', wireVersion: '0.5', opaque: {} },
  },
  { schema: 'turn-input', value: { parts: [{ type: 'file_ref', path: 'src/index.ts' }] } },
  { schema: 'turn-input', value: { parts: [{ type: 'file_ref', path: '/etc/passwd' }] } },
  { schema: 'turn-input', value: { parts: [{ type: 'file_ref', path: '../outside' }] } },
  { schema: 'agent-run', value: { ...runBase, state: 'running' } },
  { schema: 'agent-run', value: { ...runBase, state: 'succeeded' } },
  {
    schema: 'agent-run',
    value: { ...runBase, state: 'succeeded', termination: { outcome: 'failed', at: timestamp } },
  },
  { schema: 'agent-run', value: { ...runBase, state: 'awaiting_interaction' } },
  { schema: 'agent-interaction', value: { ...interactionBase, status: 'pending' } },
  {
    schema: 'agent-interaction',
    value: {
      ...interactionBase,
      status: 'pending',
      settlement: { outcome: 'cancelled', settledAt: timestamp },
    },
  },
  { schema: 'agent-interaction', value: { ...interactionBase, status: 'settled' } },
  {
    schema: 'agent-interaction',
    value: {
      ...interactionBase,
      status: 'settled',
      settlement: {
        outcome: 'responded',
        settledAt: timestamp,
        response: { kind: 'approval', decision: 'denied' },
      },
    },
  },
  {
    schema: 'command-receipt',
    value: {
      ...receiptBase,
      disposition: 'applied',
      result: {
        type: 'turn_accepted',
        sessionId: 'ses_0000000000000001',
        turnId: 'trn_0000000000000001',
        runId: 'run_0000000000000001',
      },
    },
  },
  { schema: 'command-receipt', value: { ...receiptBase, disposition: 'applied' } },
  {
    schema: 'command-receipt',
    value: {
      ...receiptBase,
      disposition: 'duplicate',
      error: { code: 'invalid_request', message: 'no', retryable: false },
    },
  },
  { schema: 'command-receipt', value: { ...receiptBase, disposition: 'rejected' } },
  { schema: 'provider-descriptor', value: providerDescriptorBase },
  {
    schema: 'provider-descriptor',
    value: {
      ...providerDescriptorBase,
      recovery: { exportsRecoveryRecord: false, resumesFromRecoveryRecord: true },
    },
  },
  {
    schema: 'provider-descriptor',
    value: {
      ...providerDescriptorBase,
      run: {
        ...providerDescriptorBase.run,
        interrupt: { mode: 'unsupported', deliversPartialOutput: true, sessionRemainsUsable: true },
      },
    },
  },
  // Legal settlements must stay accepted by both validators in every root, so
  // the conditional cannot be "fixed" by rejecting everything.
  ...settlementRoots.map(({ schema, wrap }) => ({ schema, value: wrap(legalSettlement) })),
  ...settlementRoots.map(({ schema, wrap }) => ({
    schema,
    value: wrap({ outcome: 'expired', settledAt: timestamp }),
  })),
  { schema: 'workspace-spec', value: gitSpec('main') },
  { schema: 'workspace-spec', value: gitSpec('release/v1-rc-1') },
  { schema: 'workspace-spec', value: gitSpec('--force') },
  { schema: 'agent-command', value: openSessionWith('refs/heads/main') },
  { schema: 'agent-command', value: openSessionWith('-o') },
];

describe('Zod and Draft 2020-12 JSON Schema parity', () => {
  it.each(corpus)('$schema accepts and rejects the safety corpus identically', ({ schema, value }) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-wire-version', schemaType: 'string', valid: true });
    const validate = ajv.compile(JSON_SCHEMAS[schema]);
    const zodAccepted = PUBLISHED_SCHEMAS[schema].safeParse(value).success;
    expect(validate(value), JSON.stringify(validate.errors)).toBe(zodAccepted);
  });

  it.each([
    { schema: 'event-envelope' as const, value: { ...eventEnvelopeBase, wireVersion: '0.5' } },
    { schema: 'agent-session' as const, value: { ...agentSessionBase, wireVersion: '0.5' } },
    {
      schema: 'provider-recovery-record' as const,
      value: { providerId: 'fixture', providerVersion: '0.1.0', wireVersion: '0.5', opaque: {} },
    },
  ])('rejects a version-only mismatch in both $schema validators', ({ schema, value }) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-wire-version', schemaType: 'string', valid: true });
    const validate = ajv.compile(JSON_SCHEMAS[schema]);
    expect(PUBLISHED_SCHEMAS[schema].safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
  });

  it.each([
    {
      schema: 'agent-run' as const,
      value: {
        runId: runBase.runId,
        sessionId: runBase.sessionId,
        turnId: runBase.turnId,
        attempt: 1,
        state: 'awaiting_interaction',
        startedAt: timestamp,
      },
    },
    {
      schema: 'session-snapshot' as const,
      value: {
        session: { ...agentSessionBase, wireVersion: '0.4' },
        turns: [],
        runs: [
          {
            runId: runBase.runId,
            sessionId: runBase.sessionId,
            turnId: runBase.turnId,
            attempt: 1,
            state: 'awaiting_interaction',
            startedAt: timestamp,
          },
        ],
        interactions: [],
        revision: 1,
      },
    },
  ])('rejects an omitted default that violates the post-default $schema invariant', ({ schema, value }) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-wire-version', schemaType: 'string', valid: true });
    const validate = ajv.compile(JSON_SCHEMAS[schema]);
    expect(PUBLISHED_SCHEMAS[schema].safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
  });

  it.each(
    settlementRoots.flatMap(({ schema, wrap }) => [
      { schema, label: '`responded` without a response', value: wrap(respondedWithoutResponse) },
      { schema, label: 'a non-`responded` outcome carrying a response', value: wrap(unrespondedWithResponse) },
    ]),
  )('$schema rejects $label in both validators', ({ schema, value }) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-wire-version', schemaType: 'string', valid: true });
    const validate = ajv.compile(JSON_SCHEMAS[schema]);
    expect(PUBLISHED_SCHEMAS[schema].safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
  });

  it.each([
    { schema: 'workspace-spec' as const, label: 'a standalone spec', value: gitSpec('--upload-pack=touch /tmp/pwn') },
    { schema: 'workspace-spec' as const, label: 'a bare short option', value: gitSpec('-x') },
    {
      schema: 'agent-command' as const,
      label: 'the open_session wrapper',
      value: openSessionWith('--upload-pack=touch /tmp/pwn'),
    },
    { schema: 'agent-command' as const, label: 'a wrapped bare short option', value: openSessionWith('-x') },
  ])('$schema rejects a leading-dash git ref in $label in both validators', ({ schema, value }) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-wire-version', schemaType: 'string', valid: true });
    const validate = ajv.compile(JSON_SCHEMAS[schema]);
    expect(PUBLISHED_SCHEMAS[schema].safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
  });

  it('publishes the settlement conditional on the shared $defs entry, not only on roots', () => {
    for (const { schema } of settlementRoots) {
      const document = JSON_SCHEMAS[schema] as { readonly $defs?: Record<string, unknown> };
      const settlement = document.$defs?.['interaction-settlement'];
      expect(settlement, `${schema} must reference the shared settlement definition`).toBeDefined();
      expect(JSON.stringify(settlement)).toContain('"if"');
    }
  });
});
