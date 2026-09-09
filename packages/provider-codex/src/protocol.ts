/**
 * The wire codec. Pure, synchronous, and total.
 *
 * Two jobs, both of which exist because stdout of a separate process is
 * untrusted input:
 *
 *   1. **Framing.** The app-server writes newline-delimited JSON, one frame per
 *      line (`official-source/transport-stdio.rs`). `createJsonlDecoder`
 *      reassembles chunk boundaries, bounds line length, and reports how many
 *      lines it had to drop instead of throwing.
 *   2. **Classification.** The protocol is JSON-RPC-*shaped* but omits the
 *      `"jsonrpc": "2.0"` member entirely (`official-source/protocol-rpc.rs`:
 *      "We do not do true JSON-RPC 2.0, as we neither send nor expect the
 *      jsonrpc: 2.0 field"), and its `JSONRPCMessage` enum is `#[serde(untagged)]`.
 *      So a frame is identified by which members it carries, not by a tag.
 *
 * Nothing here throws on bad input and nothing here has an ambient dependency,
 * so every hostile-frame case can be characterized exactly, without a process.
 */

import type { CodexRequestId, CodexWireError } from './seam.ts';

/**
 * Longest single frame accepted, in UTF-16 code units.
 *
 * A frame is one turn's worth of protocol, not a payload channel; a line longer
 * than this is a runaway or hostile producer rather than a legitimate message.
 * Dropping it bounds adapter memory against a peer that never emits a newline.
 */
export const MAX_FRAME_CHARS = 4_000_000;

/** Why the decoder discarded a line. Reported, never thrown. */
export type JsonlDropReason = 'oversized' | 'malformed';

export type JsonlDecodeResult = {
  /** Successfully parsed frames, in arrival order. */
  readonly values: readonly unknown[];
  /** Lines discarded by this call, in arrival order. */
  readonly drops: readonly JsonlDropReason[];
};

export type JsonlDecoder = {
  /** Feed one chunk of stdout. Partial trailing lines are buffered. */
  push(chunk: string): JsonlDecodeResult;
  /**
   * Signal end of stream, flushing any buffered trailing line that has no
   * newline. A well-behaved server always terminates its last frame, so an
   * unterminated remainder is parsed on a best-effort basis and dropped if it
   * is not valid JSON.
   */
  end(): JsonlDecodeResult;
};

const EMPTY: JsonlDecodeResult = { values: [], drops: [] };

export function createJsonlDecoder(maxFrameChars: number = MAX_FRAME_CHARS): JsonlDecoder {
  let buffer = '';
  /**
   * Set when the current line already exceeded the bound. The rest of that line
   * is then discarded up to its newline without ever being retained, so an
   * unbounded line cannot be buffered in pieces.
   */
  let discardingLine = false;

  function takeLine(line: string, values: unknown[], drops: JsonlDropReason[]): void {
    // The pinned transport reads with `BufReader::lines()`, so a `\r` from a
    // CRLF producer is part of the line, not a delimiter. Trim it before
    // parsing rather than failing an otherwise valid frame.
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    // Blank keep-alive lines are not frames and are not failures.
    if (trimmed.trim() === '') return;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      drops.push('malformed');
    }
  }

  return {
    push(chunk: string): JsonlDecodeResult {
      if (chunk === '') return EMPTY;
      const values: unknown[] = [];
      const drops: JsonlDropReason[] = [];
      let rest = chunk;

      for (;;) {
        const newline = rest.indexOf('\n');
        if (newline === -1) break;
        const line = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (discardingLine) {
          // Tail of a line already reported as oversized.
          discardingLine = false;
          buffer = '';
          continue;
        }
        if (buffer.length + line.length > maxFrameChars) {
          drops.push('oversized');
          buffer = '';
          continue;
        }
        takeLine(buffer + line, values, drops);
        buffer = '';
      }

      if (discardingLine) return { values, drops };
      if (buffer.length + rest.length > maxFrameChars) {
        // Report once, then swallow the remainder of this line.
        drops.push('oversized');
        buffer = '';
        discardingLine = true;
        return { values, drops };
      }
      buffer += rest;
      return { values, drops };
    },

    end(): JsonlDecodeResult {
      const pending = buffer;
      buffer = '';
      const wasDiscarding = discardingLine;
      discardingLine = false;
      if (wasDiscarding || pending === '') return EMPTY;
      const values: unknown[] = [];
      const drops: JsonlDropReason[] = [];
      takeLine(pending, values, drops);
      return { values, drops };
    },
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A classified inbound frame. */
export type CodexServerMessage =
  | { readonly kind: 'request'; readonly id: CodexRequestId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'response'; readonly id: CodexRequestId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: CodexRequestId; readonly error: CodexWireError };

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A non-empty string, which is what every identifier in this protocol is.
 * An empty `threadId` must never be able to match an empty `threadId`.
 */
export function asId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asRequestId(value: unknown): CodexRequestId | undefined {
  if (typeof value === 'string') return value;
  // `int64` on the wire; anything non-integral is not an id this adapter can
  // echo back safely.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

function asWireError(value: unknown): CodexWireError | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const code = record.code;
  const message = asString(record.message);
  if (typeof code !== 'number' || !Number.isFinite(code) || message === undefined) return undefined;
  return { code, message };
}

/**
 * Identify one inbound frame, or reject it.
 *
 * The order below mirrors the untagged `JSONRPCMessage` enum: Request,
 * Notification, Response, Error. `method` decides request-vs-notification by
 * whether an id is also present; without `method`, `result` and `error` decide.
 *
 * `undefined` means "not a frame this adapter will act on". That covers a
 * non-object, an array, a missing method, an unusable id, and the ambiguous
 * `{ id, result, error }` shape — the last of which is rejected rather than
 * guessed at, because settling a request from a frame that claims both outcomes
 * is exactly the confusion an attacker would want.
 */
export function classifyServerMessage(value: unknown): CodexServerMessage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const hasResult = Object.hasOwn(record, 'result');
  const hasError = Object.hasOwn(record, 'error');
  const method = asString(record.method);
  const id = Object.hasOwn(record, 'id') ? asRequestId(record.id) : undefined;

  if (method !== undefined && method !== '') {
    // A frame carrying a method plus a reply member is self-contradictory.
    if (hasResult || hasError) return undefined;
    if (Object.hasOwn(record, 'id')) {
      if (id === undefined) return undefined;
      return { kind: 'request', id, method, params: record.params };
    }
    return { kind: 'notification', method, params: record.params };
  }

  if (id === undefined) return undefined;
  if (hasResult && hasError) return undefined;
  if (hasResult) return { kind: 'response', id, result: record.result };
  if (hasError) {
    const error = asWireError(record.error);
    if (error === undefined) return undefined;
    return { kind: 'error', id, error };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Method names — pinned to the 0.153.4 stable surface
// ---------------------------------------------------------------------------

/**
 * Every method this adapter sends or reads, verified present in
 * `typescript-stable/` for codex-cli 0.153.4. Nothing experimental appears here.
 */
export const CODEX_METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
} as const;

export const CODEX_NOTIFICATION = {
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  tokenUsage: 'thread/tokenUsage/updated',
  error: 'error',
} as const;

/**
 * Every server-initiated request in the pinned stable surface
 * (`typescript-stable/ServerRequest.ts`, codex-cli 0.153.4).
 *
 * This adapter implements none of them and declines them all. The set exists so
 * a *recognised* method can be named in a diagnostic without republishing an
 * arbitrary server-controlled string: anything not listed here is reported by a
 * constant instead. A method name is metadata from another process, and a
 * durable event is the wrong place to discover what it can contain.
 */
export const CODEX_SERVER_REQUEST: ReadonlySet<string> = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval',
]);

/**
 * JSON-RPC code used when declining a server-initiated request.
 *
 * -32601 (method not found) is the honest classification: this adapter
 * implements none of the stable `ServerRequest` methods. Declining explicitly
 * matters because `item/tool/requestUserInput` carries `isBlocking`, so silence
 * can stall a turn indefinitely (research, "Wire and initialization").
 */
export const METHOD_NOT_SUPPORTED = -32601;
