import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AgentCommandSchema,
  AgentSessionSchema,
  EventEnvelopeSchema,
  AgentInteractionSchema,
  AgentRunSchema,
  CommandIdSchema,
  JsonValueSchema,
  ProviderEventInputSchema,
  RUN_STATE_TABLE,
  RunIdSchema,
  ProviderRecoveryRecordSchema,
  SessionIdSchema,
  TurnIdSchema,
  WIRE_VERSION,
  type QuestionRequest,
  checkResponseAgainstRequest,
  canonicalCommandFingerprint,
  isJsonValue,
} from '../src/index.ts';

describe('wire contract', () => {
  it('keeps session, turn, run, interaction and command identities distinct', () => {
    expect(SessionIdSchema.safeParse('ses_0000000000000001').success).toBe(true);
    expect(TurnIdSchema.safeParse('ses_0000000000000001').success).toBe(false);
    expect(RunIdSchema.safeParse('trn_0000000000000001').success).toBe(false);
    expect(CommandIdSchema.safeParse('caller-command-1').success).toBe(true);
  });

  it('accepts only recursively JSON-safe provider options', () => {
    const base = {
      commandId: 'caller-command-1',
      type: 'open_session',
      providerId: 'scripted',
      workspace: { kind: 'managed' },
    } as const;

    expect(AgentCommandSchema.safeParse({ ...base, providerOptions: { nested: [1, true, null] } }).success).toBe(true);
    expect(AgentCommandSchema.safeParse({ ...base, providerOptions: { when: new Date() } }).success).toBe(false);
    expect(AgentCommandSchema.safeParse({ ...base, providerOptions: { count: 1n } }).success).toBe(false);
    expect(AgentCommandSchema.safeParse({ ...base, providerOptions: { callback: () => undefined } }).success).toBe(
      false,
    );
    const cyclicOptions: Record<string, unknown> = {};
    cyclicOptions.self = cyclicOptions;
    expect(AgentCommandSchema.safeParse({ ...base, providerOptions: cyclicOptions }).success).toBe(false);
  });

  it('rejects non-JSON objects and cycles at the explicit boundary guard', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(new Error('no'))).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(cyclic)).toBe(false);
    const throwingAccessor = {};
    Object.defineProperty(throwingAccessor, 'value', {
      enumerable: true,
      get(): never {
        throw new Error('hostile getter');
      },
    });
    expect(isJsonValue(throwingAccessor)).toBe(false);
    expect(isJsonValue({ ok: ['yes', 1, false, null] })).toBe(true);
  });

  it('keeps JSON schema parsing non-throwing and aligned for accessors and exotic arrays', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get(): never {
        throw new Error('getter must never escape');
      },
    });
    const array = ['valid'];
    Object.defineProperty(array, 'extra', { enumerable: true, value: 'not represented by JSON arrays' });
    for (const hostile of [accessor, array]) {
      expect(() => JsonValueSchema.safeParse(hostile)).not.toThrow();
      expect(JsonValueSchema.safeParse(hostile).success).toBe(isJsonValue(hostile));
      expect(isJsonValue(hostile)).toBe(false);
    }
  });

  it('preserves an own enumerable __proto__ JSON key and fingerprints it distinctly', () => {
    const value = JSON.parse('{"__proto__":{"variant":1},"safe":true}') as unknown;
    expect(isJsonValue(value)).toBe(true);
    const parsed = JsonValueSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.prototype.hasOwnProperty.call(parsed.data, '__proto__')).toBe(true);
    expect(JSON.stringify(parsed.data)).toBe('{"__proto__":{"variant":1},"safe":true}');

    const base = {
      commandId: 'proto-fingerprint',
      type: 'open_session',
      providerId: 'scripted',
      workspace: { kind: 'managed' },
    } as const;
    const first = AgentCommandSchema.parse({ ...base, providerOptions: value });
    const second = AgentCommandSchema.parse({
      ...base,
      providerOptions: JSON.parse('{"__proto__":{"variant":2},"safe":true}'),
    });
    const absent = AgentCommandSchema.parse({ ...base, providerOptions: { safe: true } });
    expect(canonicalCommandFingerprint(first)).not.toBe(canonicalCommandFingerprint(second));
    expect(canonicalCommandFingerprint(first)).not.toBe(canonicalCommandFingerprint(absent));
  });

  it('rejects cyclic JavaScript graphs in authoritative JSON-value schemas', () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    const mutualObject: Record<string, unknown> = {};
    const mutualArray: unknown[] = [mutualObject];
    mutualObject.array = mutualArray;

    for (const detail of [objectCycle, { arrayCycle }, mutualObject]) {
      expect(JsonValueSchema.safeParse(detail).success).toBe(false);
      expect(
        ProviderEventInputSchema.safeParse({
          payload: { type: 'run.tool_activity', toolName: 'cycle', phase: 'invoked', detail },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts JSON-serializable shared references when the graph is acyclic', () => {
    const shared = { value: 'shared' };
    const graph = { left: shared, right: shared, list: [shared] };
    expect(isJsonValue(graph)).toBe(true);
    const parsed = ProviderEventInputSchema.safeParse({
      payload: { type: 'run.tool_activity', toolName: 'shared', phase: 'succeeded', detail: graph },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(() => JSON.stringify(parsed.data)).not.toThrow();
  });

  it('requires terminal run state and termination outcome to agree', () => {
    const run = {
      runId: 'run_0000000000000001',
      sessionId: 'ses_0000000000000001',
      turnId: 'trn_0000000000000001',
      attempt: 1,
      state: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      pendingInteractionIds: [],
    };
    expect(AgentRunSchema.safeParse(run).success).toBe(false);
    expect(
      AgentRunSchema.safeParse({
        ...run,
        termination: { outcome: 'failed', at: '2026-01-01T00:00:00.001Z' },
      }).success,
    ).toBe(false);
  });

  it('publishes closed terminal states and interrupting race outcomes', () => {
    expect(RUN_STATE_TABLE.succeeded).toEqual([]);
    expect(RUN_STATE_TABLE.failed).toEqual([]);
    expect(RUN_STATE_TABLE.interrupted).toEqual([]);
    expect(RUN_STATE_TABLE.interrupting).toEqual(['interrupted', 'succeeded', 'failed']);
  });

  it('correlates responses by kind and allowed value', () => {
    const request: QuestionRequest = {
      kind: 'question',
      prompt: 'Pick one',
      choices: [{ value: 'a', label: 'A' }],
      multiSelect: false,
    };
    expect(checkResponseAgainstRequest(request, { kind: 'question', answer: 'a' })).toBeUndefined();
    expect(checkResponseAgainstRequest(request, { kind: 'question', answer: 'b' })).toContain('unknown choice');
    expect(
      AgentInteractionSchema.safeParse({
        interactionId: 'int_0000000000000001',
        sessionId: 'ses_0000000000000001',
        turnId: 'trn_0000000000000001',
        runId: 'run_0000000000000001',
        status: 'pending',
        request,
        requestedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('keeps wire and package versions conceptually separate', () => {
    expect(WIRE_VERSION).toBe('0.4');
  });

  it('rejects a version-only mismatch on line-bound session documents', () => {
    expect(
      AgentSessionSchema.safeParse({
        sessionId: 'ses_0000000000000001',
        state: 'ready',
        providerId: 'scripted',
        wireVersion: '0.5',
        workspace: {
          leaseId: 'wsl_0000000000000001',
          ownership: 'borrowed',
          root: '/workspace',
          acquiredAt: '2026-01-01T00:00:00.000Z',
          released: false,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        sequence: 0,
        turnIds: [],
      }).success,
    ).toBe(false);
  });

  it('requires a new wire minor for strict-object fields and closed-union members', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/wire-compatibility.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(fixture.wireVersion).toBe(WIRE_VERSION);
    expect(fixture.nextWireVersion).not.toBe(WIRE_VERSION);
    expect(EventEnvelopeSchema.safeParse(fixture.current).success).toBe(true);
    expect(EventEnvelopeSchema.safeParse(fixture.versionOnlyMismatch).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse(fixture.futureOptionalField).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse(fixture.futureUnionMember).success).toBe(false);
  });

  it('validates provider recovery as JSON-safe wire data', () => {
    expect(
      ProviderRecoveryRecordSchema.safeParse({
        providerId: 'scripted',
        providerVersion: '0.1.0',
        wireVersion: WIRE_VERSION,
        opaque: { resumable: true },
      }).success,
    ).toBe(true);
    expect(
      ProviderRecoveryRecordSchema.safeParse({
        providerId: 'scripted',
        providerVersion: '0.1.0',
        wireVersion: WIRE_VERSION,
        opaque: new Error('not serializable'),
      }).success,
    ).toBe(false);
    expect(
      ProviderRecoveryRecordSchema.safeParse({
        providerId: 'scripted',
        providerVersion: '0.1.0',
        wireVersion: '0.5',
        opaque: { resumable: true },
      }).success,
    ).toBe(false);
  });

  it('rejects option-shaped git refs before they reach a command runner', () => {
    expect(
      AgentCommandSchema.safeParse({
        commandId: 'caller-command-2',
        type: 'open_session',
        providerId: 'scripted',
        workspace: {
          kind: 'managed',
          source: { kind: 'git', remote: 'https://example.invalid/repo', ref: '--upload-pack=evil' },
        },
      }).success,
    ).toBe(false);
  });
});
