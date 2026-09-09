/**
 * Bounded JSON request body reading.
 *
 * The transport buffer is bounded on purpose: an unauthenticated loopback
 * listener that would happily buffer an unbounded body is a local
 * denial-of-service surface even without a network attacker.
 */

import type { IncomingMessage } from 'node:http';

export type BodyReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  const contentType = request.headers['content-type'];
  if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, message: 'request body must be application/json' };
  }

  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      received += buffer.byteLength;
      if (received > maxBytes) {
        return { ok: false, status: 413, message: `request body exceeds the ${String(maxBytes)}-byte limit` };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: 'request body could not be read' };
  }

  if (received === 0) return { ok: true, value: {} };

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, message: 'request body is not valid JSON' };
  }
}
