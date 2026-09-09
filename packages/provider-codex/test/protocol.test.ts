/**
 * The wire codec, characterized against hostile input.
 *
 * stdout of a separate process is untrusted. Every case below is something a
 * broken, malicious or simply newer producer can put on the wire, and none of
 * them may throw, hang, or be mistaken for a frame that settles a run.
 */

import { describe, expect, it } from 'vitest';

import {
  CODEX_METHOD,
  CODEX_NOTIFICATION,
  METHOD_NOT_SUPPORTED,
  classifyServerMessage,
  createJsonlDecoder,
} from '../src/protocol.ts';

describe('JSONL framing', () => {
  it('decodes one frame per line', () => {
    const decoder = createJsonlDecoder();
    const result = decoder.push('{"a":1}\n{"b":2}\n');
    expect(result.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.drops).toEqual([]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const decoder = createJsonlDecoder();
    expect(decoder.push('{"method":"tu').values).toEqual([]);
    expect(decoder.push('rn/completed"').values).toEqual([]);
    expect(decoder.push('}\n').values).toEqual([{ method: 'turn/completed' }]);
  });

  it('splits a chunk that carries several frames and a partial tail', () => {
    const decoder = createJsonlDecoder();
    const first = decoder.push('{"a":1}\n{"b":2}\n{"c":');
    expect(first.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.push('3}\n').values).toEqual([{ c: 3 }]);
  });

  it('treats a CRLF line ending as a delimiter, not as frame content', () => {
    const decoder = createJsonlDecoder();
    expect(decoder.push('{"a":1}\r\n').values).toEqual([{ a: 1 }]);
  });

  it('ignores blank and whitespace-only lines', () => {
    const decoder = createJsonlDecoder();
    const result = decoder.push('\n   \n{"a":1}\n\n');
    expect(result.values).toEqual([{ a: 1 }]);
    expect(result.drops).toEqual([]);
  });

  it('reports a malformed line and keeps decoding the ones after it', () => {
    const decoder = createJsonlDecoder();
    const result = decoder.push('{"a":1}\nnot json at all\n{"b":2}\n');
    expect(result.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.drops).toEqual(['malformed']);
  });

  it('drops an oversized line exactly once and recovers on the next one', () => {
    const decoder = createJsonlDecoder(32);
    const huge = `{"pad":"${'x'.repeat(500)}"}`;
    // Fed in several chunks: the bound must hold across them, and the tail of
    // the discarded line must not be retained or re-reported.
    expect(decoder.push(huge.slice(0, 200)).drops).toEqual(['oversized']);
    expect(decoder.push(huge.slice(200)).drops).toEqual([]);
    const recovered = decoder.push('\n{"ok":1}\n');
    expect(recovered.values).toEqual([{ ok: 1 }]);
    expect(recovered.drops).toEqual([]);
  });

  it('never buffers an unbounded line', () => {
    const decoder = createJsonlDecoder(16);
    for (let pass = 0; pass < 100; pass += 1) decoder.push('y'.repeat(1000));
    // The only observable is that it still works afterwards; nothing was kept.
    expect(decoder.push('\n{"ok":1}\n').values).toEqual([{ ok: 1 }]);
  });

  it('flushes a trailing frame that has no final newline', () => {
    const decoder = createJsonlDecoder();
    decoder.push('{"a":1}');
    expect(decoder.end().values).toEqual([{ a: 1 }]);
  });

  it('reports an unterminated trailing line that is not valid JSON', () => {
    const decoder = createJsonlDecoder();
    decoder.push('{"a":');
    expect(decoder.end().drops).toEqual(['malformed']);
  });

  it('is idempotent at end of stream', () => {
    const decoder = createJsonlDecoder();
    decoder.push('{"a":1}\n');
    expect(decoder.end().values).toEqual([]);
    expect(decoder.end().values).toEqual([]);
  });
});

describe('frame classification', () => {
  it('classifies a notification', () => {
    expect(classifyServerMessage({ method: 'turn/completed', params: { a: 1 } })).toEqual({
      kind: 'notification',
      method: 'turn/completed',
      params: { a: 1 },
    });
  });

  it('classifies a server request by the presence of an id alongside a method', () => {
    expect(classifyServerMessage({ id: 7, method: 'item/tool/requestUserInput', params: {} })).toEqual({
      kind: 'request',
      id: 7,
      method: 'item/tool/requestUserInput',
      params: {},
    });
  });

  it('classifies a response and an error', () => {
    expect(classifyServerMessage({ id: 1, result: {} })).toEqual({ kind: 'response', id: 1, result: {} });
    expect(classifyServerMessage({ id: 'a', error: { code: -32603, message: 'boom' } })).toEqual({
      kind: 'error',
      id: 'a',
      error: { code: -32603, message: 'boom' },
    });
  });

  it('accepts both string and integer request ids', () => {
    expect(classifyServerMessage({ id: 'req-1', result: 1 })?.kind).toBe('response');
    expect(classifyServerMessage({ id: 12, result: 1 })?.kind).toBe('response');
  });

  it('never requires or produces a `jsonrpc` member', () => {
    // The pinned server "neither sends nor expects" it. A frame carrying one is
    // still usable; the member is simply not part of classification.
    const classified = classifyServerMessage({ jsonrpc: '2.0', method: 'turn/started', params: {} });
    expect(classified).toEqual({ kind: 'notification', method: 'turn/started', params: {} });
  });

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['an array', [{ method: 'turn/completed' }]],
    ['a string', '{"method":"turn/completed"}'],
    ['an empty object', {}],
    ['a method-less, id-less frame', { params: {} }],
    ['an empty method name', { method: '', params: {} }],
    ['a non-string method', { method: 7, params: {} }],
    ['a reply with no result or error', { id: 1 }],
    ['a reply claiming both result and error', { id: 1, result: 1, error: { code: -1, message: 'x' } }],
    ['a request with an unusable id', { id: { nested: true }, method: 'x' }],
    ['a request with a fractional id', { id: 1.5, method: 'x' }],
    ['a method frame that also carries a result', { id: 1, method: 'x', result: 1 }],
    ['a method frame that also carries an error', { method: 'x', error: { code: -1, message: 'y' } }],
    ['an error frame with no code', { id: 1, error: { message: 'x' } }],
    ['an error frame with a non-numeric code', { id: 1, error: { code: 'bad', message: 'x' } }],
    ['an error frame with no message', { id: 1, error: { code: -1 } }],
    ['an error frame whose body is not an object', { id: 1, error: 'boom' }],
  ])('rejects %s', (_label, value) => {
    expect(classifyServerMessage(value)).toBeUndefined();
  });

  it('does not confuse an inherited property for a frame member', () => {
    const hostile = Object.create({ result: 'inherited' }) as Record<string, unknown>;
    hostile.id = 1;
    // `result` lives on the prototype, so this frame settles nothing.
    expect(classifyServerMessage(hostile)).toBeUndefined();
  });

  it('treats an explicit `undefined` result as a present result', () => {
    // `JSON.parse` cannot produce this, but a host-supplied transport can.
    expect(classifyServerMessage({ id: 1, result: undefined })).toEqual({
      kind: 'response',
      id: 1,
      result: undefined,
    });
  });
});

describe('pinned method names', () => {
  it('names only stable 0.153.4 methods', () => {
    expect(CODEX_METHOD).toEqual({
      initialize: 'initialize',
      initialized: 'initialized',
      threadStart: 'thread/start',
      turnStart: 'turn/start',
      turnInterrupt: 'turn/interrupt',
    });
    expect(CODEX_NOTIFICATION.turnCompleted).toBe('turn/completed');
    expect(CODEX_NOTIFICATION.agentMessageDelta).toBe('item/agentMessage/delta');
    expect(CODEX_NOTIFICATION.tokenUsage).toBe('thread/tokenUsage/updated');
  });

  it('declines server requests with `method not found`', () => {
    expect(METHOD_NOT_SUPPORTED).toBe(-32601);
  });
});
