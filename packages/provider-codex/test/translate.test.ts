/**
 * Notification → provider event translation.
 *
 * Two obligations are asserted throughout: every emitted payload validates
 * against the protocol schema, and no provider-native identifier, path, or
 * upstream prose survives translation.
 */

import { describe, expect, it } from 'vitest';

import { ProviderEventInputSchema } from '@relvo-labs/agent-protocol';

import {
  MAX_DELTA_CHARS,
  UNCLASSIFIED_ERROR,
  classifyCodexErrorInfo,
  classifyThrown,
  correlationOf,
  redact,
  sameTurn,
  translateAgentMessageDelta,
  translateErrorNotification,
  translateTokenUsage,
  translateTurnCompleted,
  translateTurnError,
} from '../src/translate.ts';
import { FIXTURE_AWS_KEY, FIXTURE_BEARER, FIXTURE_GITHUB_TOKEN } from './fake-transport.ts';

/** Every emitted payload must be a valid `ProviderEventInput`. */
function expectValid(events: readonly unknown[]): void {
  for (const event of events) expect(() => ProviderEventInputSchema.parse(event)).not.toThrow();
}

describe('correlation', () => {
  it('reads a direct `turnId`', () => {
    expect(correlationOf({ threadId: 't', turnId: 'u', itemId: 'i' })).toEqual({ threadId: 't', turnId: 'u' });
  });

  it('reads `turn.id` for turn lifecycle frames', () => {
    expect(correlationOf({ threadId: 't', turn: { id: 'u', status: 'completed' } })).toEqual({
      threadId: 't',
      turnId: 'u',
    });
  });

  it.each([
    ['no params', undefined],
    ['a non-object', 7],
    ['no thread', { turnId: 'u' }],
    ['no turn', { threadId: 't' }],
    ['an empty thread id', { threadId: '', turnId: 'u' }],
    ['an empty turn id', { threadId: 't', turnId: '' }],
    ['a non-string turn id', { threadId: 't', turnId: 5 }],
    ['a turn object with no id', { threadId: 't', turn: { status: 'completed' } }],
  ])('refuses to correlate %s', (_label, params) => {
    expect(correlationOf(params)).toBeUndefined();
  });

  it('never matches two different turns', () => {
    expect(sameTurn({ threadId: 't', turnId: 'a' }, { threadId: 't', turnId: 'b' })).toBe(false);
    expect(sameTurn({ threadId: 'x', turnId: 'a' }, { threadId: 'y', turnId: 'a' })).toBe(false);
    expect(sameTurn({ threadId: 't', turnId: 'a' }, { threadId: 't', turnId: 'a' })).toBe(true);
  });
});

describe('assistant text', () => {
  it('passes a delta through unchanged', () => {
    const events = translateAgentMessageDelta({ threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' });
    expect(events).toEqual([{ payload: { type: 'run.message_delta', text: 'hello' } }]);
    expectValid(events);
  });

  it('splits a delta longer than the protocol bound', () => {
    const long = 'x'.repeat(MAX_DELTA_CHARS + 10);
    const events = translateAgentMessageDelta({ threadId: 't', turnId: 'u', itemId: 'i', delta: long });
    expect(events).toHaveLength(2);
    expectValid(events);
    const rejoined = events.map((event) => (event.payload as { text: string }).text).join('');
    expect(rejoined).toBe(long);
  });

  it.each([
    ['an empty delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: '' }],
    ['a missing delta', { threadId: 't', turnId: 'u', itemId: 'i' }],
    ['a non-string delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: 42 }],
    ['a missing item id', { threadId: 't', turnId: 'u', delta: 'hi' }],
    ['a non-object', 'nope'],
  ])('emits nothing for %s', (_label, params) => {
    expect(translateAgentMessageDelta(params)).toEqual([]);
  });

  it('never emits a native identifier', () => {
    const events = translateAgentMessageDelta({
      threadId: 'thread-secret',
      turnId: 'turn-secret',
      itemId: 'item-secret',
      delta: 'visible',
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

describe('usage', () => {
  it('maps the per-turn breakdown, not the cumulative thread total', () => {
    const events = translateTokenUsage({
      threadId: 't',
      turnId: 'u',
      tokenUsage: {
        total: { totalTokens: 5000, inputTokens: 4000, outputTokens: 1000 },
        last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
        modelContextWindow: 400_000,
      },
    });
    expect(events).toEqual([
      { payload: { type: 'run.usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } },
    ]);
    expectValid(events);
  });

  it('omits fields the server did not supply', () => {
    const events = translateTokenUsage({ tokenUsage: { last: { outputTokens: 3 } } });
    expect(events).toEqual([{ payload: { type: 'run.usage', usage: { outputTokens: 3 } } }]);
    expectValid(events);
  });

  it.each([
    ['no usage at all', {}],
    ['no `last` breakdown', { tokenUsage: { total: { totalTokens: 1 } } }],
    ['an empty breakdown', { tokenUsage: { last: {} } }],
    ['negative counters', { tokenUsage: { last: { inputTokens: -1, outputTokens: -2 } } }],
    ['fractional counters', { tokenUsage: { last: { inputTokens: 1.5 } } }],
    ['string counters', { tokenUsage: { last: { inputTokens: '10' } } }],
  ])('emits nothing for %s', (_label, params) => {
    expect(translateTokenUsage(params)).toEqual([]);
  });
});

describe('error classification', () => {
  it('accepts a plain string variant', () => {
    expect(classifyCodexErrorInfo('usageLimitExceeded')).toBe('usageLimitExceeded');
  });

  it('accepts a single-key tagged variant and keeps only its tag', () => {
    expect(classifyCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 503 } })).toBe('httpConnectionFailed');
  });

  it.each([
    ['an unknown string', 'somethingNewUpstream'],
    ['an unknown tag', { brandNewVariant: {} }],
    ['a multi-key object', { httpConnectionFailed: {}, unauthorized: {} }],
    ['null', null],
    ['a number', 7],
    ['an array', ['unauthorized']],
    ['undefined', undefined],
  ])('classifies %s as unclassified', (_label, value) => {
    expect(classifyCodexErrorInfo(value)).toBe(UNCLASSIFIED_ERROR);
  });

  it('marks transient categories retryable and terminal ones not', () => {
    expect(translateTurnError({ codexErrorInfo: 'rateLimitExceeded' }).retryable).toBe(true);
    expect(translateTurnError({ codexErrorInfo: 'rateLimitExceeded' }).code).toBe('provider_unavailable');
    expect(translateTurnError({ codexErrorInfo: 'unauthorized' }).retryable).toBe(false);
    expect(translateTurnError({ codexErrorInfo: 'unauthorized' }).code).toBe('provider_rejected');
  });

  it('never copies upstream prose into a durable error', () => {
    const error = translateTurnError({
      message: `failed for /home/alice/secret-project using ${FIXTURE_BEARER}`,
      codexErrorInfo: 'badRequest',
      additionalDetails: 'stack trace with /etc/passwd and the prompt text',
      misalignment: { detailedExplanation: 'prose', steer: { message: 'more prose' } },
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('/home/alice');
    expect(serialized).not.toContain(FIXTURE_BEARER);
    expect(serialized).not.toContain('/etc/passwd');
    expect(serialized).not.toContain('prose');
    expect(error.providerCode).toBe('badRequest');
  });
});

describe('terminal frames', () => {
  it.each([
    ['completed', 'succeeded'],
    ['interrupted', 'interrupted'],
  ])('maps `%s` to `%s`', (status, outcome) => {
    const translation = translateTurnCompleted({ threadId: 't', turn: { id: 'u', status } });
    expect(translation.kind).toBe('settled');
    if (translation.kind !== 'settled') throw new Error('unreachable');
    expect(translation.termination.outcome).toBe(outcome);
  });

  it('maps `failed` to a classified failure', () => {
    const translation = translateTurnCompleted({
      threadId: 't',
      turn: { id: 'u', status: 'failed', error: { message: 'raw prose', codexErrorInfo: 'sandboxError' } },
    });
    if (translation.kind !== 'settled' || translation.termination.outcome !== 'failed') {
      throw new Error('expected a failed termination');
    }
    expect(translation.termination.error.providerCode).toBe('sandboxError');
    expect(translation.termination.error.message).not.toContain('raw prose');
  });

  it('treats a non-terminal status on a terminal frame as a contract violation', () => {
    // `inProgress` is a real `TurnStatus`, but it cannot end a run. Accepting it
    // would leave the run hanging forever.
    expect(translateTurnCompleted({ threadId: 't', turn: { id: 'u', status: 'inProgress' } })).toEqual({
      kind: 'violation',
      reason: 'inProgress',
    });
  });

  it.each([
    ['an unknown status', { threadId: 't', turn: { id: 'u', status: 'whatever' } }],
    ['a missing status', { threadId: 't', turn: { id: 'u' } }],
    ['a missing turn', { threadId: 't' }],
    ['a non-object', 5],
  ])('treats %s as a contract violation rather than a success', (_label, params) => {
    const translation = translateTurnCompleted(params);
    expect(translation.kind).toBe('violation');
  });
});

describe('mid-turn error notification', () => {
  it('is a diagnostic, never a termination', () => {
    const events = translateErrorNotification({
      threadId: 't',
      turnId: 'u',
      willRetry: true,
      error: { message: 'upstream prose', codexErrorInfo: 'serverOverloaded' },
    });
    expectValid(events);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { type: string; level: string; message: string };
    expect(payload.type).toBe('diagnostic');
    expect(payload.level).toBe('warning');
    expect(payload.message).toContain('serverOverloaded');
    expect(payload.message).toContain('the server is retrying');
    expect(payload.message).not.toContain('upstream prose');
  });

  it('reports when the server is not retrying', () => {
    const events = translateErrorNotification({ threadId: 't', turnId: 'u', error: {} });
    expect((events[0]?.payload as { message: string }).message).toContain('the server is not retrying');
  });

  it('emits nothing for a non-object', () => {
    expect(translateErrorNotification(null)).toEqual([]);
  });
});

describe('redaction and thrown values', () => {
  it('redacts credential shapes', () => {
    expect(redact(`token ${FIXTURE_BEARER} rest`)).toBe('token [redacted] rest');
    expect(redact(FIXTURE_GITHUB_TOKEN)).toBe('[redacted]');
    expect(redact(FIXTURE_AWS_KEY)).toBe('[redacted]');
  });

  it('classifies a thrown value into one allowlisted token', () => {
    expect(classifyThrown(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(classifyThrown(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('ABORT_ERR');
    expect(classifyThrown(Object.assign(new Error('x'), { code: 'SOMETHING_NEW' }))).toBe('unknown');
    expect(classifyThrown('a bare string with /home/alice in it')).toBe('unknown');
    expect(classifyThrown(undefined)).toBe('unknown');
  });
});
