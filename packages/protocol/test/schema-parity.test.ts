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

const corpus: readonly ParityCase[] = [
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
});
