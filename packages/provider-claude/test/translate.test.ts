import { describe, expect, it } from 'vitest';

import { ProviderEventInputSchema, type ProviderEventInput } from '@relvo-labs/agent-protocol';

import { createRunTranslator, MAX_DELTA_CHARS } from '../src/translate.ts';
import type { ClaudeQueryMessage } from '../src/seam.ts';

/** Every emitted input must be legal for the runtime, not merely plausible. */
function payloads(events: readonly ProviderEventInput[]) {
  for (const event of events) expect(ProviderEventInputSchema.safeParse(event).success).toBe(true);
  return events.map((event) => event.payload);
}

function assistant(content: unknown, extra: Record<string, unknown> = {}): ClaudeQueryMessage {
  return { type: 'assistant', message: { role: 'assistant', content }, ...extra };
}

function user(content: unknown): ClaudeQueryMessage {
  return { type: 'user', message: { role: 'user', content } };
}

describe('claude message translation', () => {
  it('turns assistant text blocks into concatenating message deltas', () => {
    const translator = createRunTranslator();
    const first = translator.translate(
      assistant([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ]),
    );
    const second = translator.translate(assistant([{ type: 'text', text: '!' }]));

    expect(payloads(first.events)).toEqual([
      { type: 'run.message_delta', text: 'Hello ' },
      { type: 'run.message_delta', text: 'world' },
    ]);
    expect(payloads(second.events)).toEqual([{ type: 'run.message_delta', text: '!' }]);
    expect(first.termination).toBeUndefined();
  });

  it('accepts a plain string assistant body and skips empty text', () => {
    const translator = createRunTranslator();
    expect(payloads(translator.translate(assistant('plain')).events)).toEqual([
      { type: 'run.message_delta', text: 'plain' },
    ]);
    expect(translator.translate(assistant([{ type: 'text', text: '' }])).events).toEqual([]);
  });

  it('splits assistant text that exceeds the protocol delta bound', () => {
    const translator = createRunTranslator();
    const text = 'x'.repeat(MAX_DELTA_CHARS + 5);
    const emitted = payloads(translator.translate(assistant([{ type: 'text', text }])).events);
    expect(emitted).toHaveLength(2);
    expect(emitted.map((payload) => (payload.type === 'run.message_delta' ? payload.text.length : 0))).toEqual([
      MAX_DELTA_CHARS,
      5,
    ]);
  });

  it('reports tool activity by name and never leaks the native tool id', () => {
    const translator = createRunTranslator();
    const invoked = translator.translate(
      assistant([{ type: 'tool_use', id: 'toolu_native_01', name: 'Read', input: { file_path: '/etc/passwd' } }]),
    );
    const settled = translator.translate(user([{ type: 'tool_result', tool_use_id: 'toolu_native_01' }]));
    const failed = translator.translate(
      assistant([{ type: 'tool_use', id: 'toolu_native_02', name: 'Bash', input: {} }]),
    );
    const failure = translator.translate(
      user([{ type: 'tool_result', tool_use_id: 'toolu_native_02', is_error: true }]),
    );

    expect(payloads(invoked.events)).toEqual([{ type: 'run.tool_activity', toolName: 'Read', phase: 'invoked' }]);
    expect(payloads(settled.events)).toEqual([{ type: 'run.tool_activity', toolName: 'Read', phase: 'succeeded' }]);
    expect(payloads(failed.events)).toEqual([{ type: 'run.tool_activity', toolName: 'Bash', phase: 'invoked' }]);
    expect(payloads(failure.events)).toEqual([{ type: 'run.tool_activity', toolName: 'Bash', phase: 'failed' }]);
    expect(JSON.stringify([invoked, settled, failed, failure])).not.toContain('toolu_native');
    expect(JSON.stringify([invoked, settled])).not.toContain('/etc/passwd');
  });

  it('ignores a tool result that does not match a tool this run invoked', () => {
    const translator = createRunTranslator();
    expect(translator.translate(user([{ type: 'tool_result', tool_use_id: 'toolu_unknown' }])).events).toEqual([]);
  });

  it('maps a successful result to usage plus a succeeded termination', () => {
    const translator = createRunTranslator();
    const result = translator.translate({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
      session_id: 'native-session-abc',
    });

    expect(payloads(result.events)).toEqual([
      { type: 'run.usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
    ]);
    expect(result.termination).toEqual({ outcome: 'succeeded' });
    expect(JSON.stringify(result.events)).not.toContain('native-session');
  });

  it('maps an error result to a failed termination classified by its declared subtype', () => {
    const translator = createRunTranslator();
    const result = translator.translate({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['turn budget exhausted'],
    });

    expect(result.termination?.outcome).toBe('failed');
    if (result.termination?.outcome !== 'failed') throw new Error('expected a failed termination');
    expect(result.termination.error.code).toBe('provider_rejected');
    expect(result.termination.error.providerCode).toBe('error_max_turns');
    expect(result.termination.error.message).toBe('claude ended the turn without completing it (error_max_turns)');
    // The upstream prose is not carried, not even redacted: see redaction.test.ts.
    expect(result.termination.error.message).not.toContain('turn budget exhausted');
  });

  it('treats a success subtype flagged as an error as a failure', () => {
    const translator = createRunTranslator();
    const result = translator.translate({ type: 'result', subtype: 'success', is_error: true });
    expect(result.termination?.outcome).toBe('failed');
  });

  it('never carries upstream failure prose into the public error', () => {
    const translator = createRunTranslator();
    const secret = ['sk', 'ant', 'A'.repeat(30)].join('-');
    const result = translator.translate({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [`auth failed for ${secret} ${'y'.repeat(4000)}`],
    });

    if (result.termination?.outcome !== 'failed') throw new Error('expected a failed termination');
    expect(result.termination.error.message).toBe(
      'claude ended the turn without completing it (error_during_execution)',
    );
    expect(result.termination.error.message).not.toContain(secret);
    expect(result.termination.error.message).not.toContain('auth failed');
    expect(result.termination.error.message.length).toBeLessThanOrEqual(2000);
  });

  it('drops session-scoped SDK messages instead of forwarding native identity', () => {
    const translator = createRunTranslator();
    const translation = translator.translate({ type: 'system', subtype: 'init', session_id: 'native-session-abc' });
    expect(translation.events).toEqual([]);
    expect(translation.termination).toBeUndefined();
  });

  it('surfaces an assistant-level error as a warning diagnostic', () => {
    const translator = createRunTranslator();
    const emitted = payloads(translator.translate(assistant([], { error: 'rate_limit' })).events);
    expect(emitted).toEqual([
      { type: 'diagnostic', level: 'warning', message: 'claude reported an assistant error: rate_limit' },
    ]);
  });

  it('ignores messages it does not understand instead of failing the run', () => {
    const translator = createRunTranslator();
    for (const message of [
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'assistant', message: null },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }] } },
      { type: 'result', subtype: 'success', usage: 'not-usage', is_error: false },
    ] as ClaudeQueryMessage[]) {
      const translation = translator.translate(message);
      expect(payloads(translation.events)).not.toContainEqual(expect.objectContaining({ type: 'run.message_delta' }));
    }
  });
});
