/**
 * JSON-RPC correlation over the transport seam.
 *
 * This layer owns exactly one thing: matching replies to requests, and
 * guaranteeing that **every** request settles. The bounded protocol surface has
 * no shutdown handshake and no reply to a malformed frame
 * (`official-source/transport-mod.rs:208-216` logs and ignores it), so "await a
 * reply forever" is not a control-flow primitive that can be used safely here.
 * Three independent things settle a pending request:
 *
 *   1. its own response or error frame;
 *   2. end of the inbound stream — EOF or transport failure, which is also how
 *      child-process exit surfaces;
 *   3. a per-request deadline, for a live peer that simply never answers.
 *
 * It also declines every server-initiated request. Silence is not an option:
 * `item/tool/requestUserInput` carries `isBlocking`, so an unanswered request
 * can stall a turn indefinitely (research, "Wire and initialization").
 */

import { agentError, type JsonValue } from '@relvo-labs/agent-protocol';
import { ProviderRejection } from '@relvo-labs/agent-provider';

import { METHOD_NOT_SUPPORTED, classifyServerMessage, type JsonlDropReason } from './protocol.ts';
import { classifyThrown } from './translate.ts';
import type { CodexRequestId, CodexTransport, CodexTransportEnd, CodexWireError } from './seam.ts';

/** Default per-request deadline. Turns are unbounded; RPC round-trips are not. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * JSON-RPC codes the pinned app-server is known to emit.
 *
 * `-32001` is its overload code (`official-source/transport-mod.rs:52`),
 * `-32603` its internal error (`:51`), and `-32600` is used for ownership
 * rejections (README §Errors). `-32601` is this adapter's own decline code.
 *
 * The server's `message` is deliberately never published: "Not initialized" is
 * harmless, but the same field carries arbitrary upstream prose on other paths.
 */
export function classifyWireError(code: number): { readonly classification: string; readonly retryable: boolean } {
  switch (code) {
    case -32001:
      return { classification: 'overloaded', retryable: true };
    case -32600:
      return { classification: 'invalid_request', retryable: false };
    case -32601:
      return { classification: 'method_not_found', retryable: false };
    case -32602:
      return { classification: 'invalid_params', retryable: false };
    case -32603:
      return { classification: 'internal_error', retryable: true };
    case -32700:
      return { classification: 'parse_error', retryable: false };
    default:
      return { classification: 'unclassified', retryable: false };
  }
}

function wireRejection(method: string, error: CodexWireError): ProviderRejection {
  const { classification, retryable } = classifyWireError(error.code);
  return new ProviderRejection(
    agentError(
      retryable ? 'provider_unavailable' : 'provider_rejected',
      `codex rejected \`${method}\` (${classification})`,
      { providerCode: classification },
    ),
  );
}

/** Why the client stopped. Reported once. */
export type CodexClientEnd = {
  readonly end: CodexTransportEnd;
  /** Allowlisted cause token when the stream failed; absent on clean EOF. */
  readonly cause?: string;
};

export type CodexClientHandlers = {
  /** A turn/thread notification. Already classified; params are unvalidated. */
  onNotification(method: string, params: unknown): void;
  /** A server-initiated request was declined. Only the method name is passed. */
  onServerRequest(method: string): void;
  /** An inbound frame could not be used. Bounded, allowlisted reason token. */
  onDrop(reason: JsonlDropReason | 'unclassifiable' | 'unknown_reply'): void;
  /** The inbound stream ended. Fires exactly once. */
  onEnd(end: CodexClientEnd): void;
};

export type CodexClient = {
  /** Send a request and await its reply. Always settles. */
  request(method: string, params?: JsonValue): Promise<unknown>;
  /** Send a notification. Fire-and-forget by protocol definition. */
  notify(method: string, params?: JsonValue): void;
  /** True once the inbound stream has ended, for any reason. */
  readonly ended: boolean;
  /** Tear down the underlying transport. Idempotent; retryable on failure. */
  close(): Promise<void>;
};

type Pending = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
};

export type CodexClientOptions = {
  readonly requestTimeoutMs?: number;
};

export function createCodexClient(
  transport: CodexTransport,
  handlers: CodexClientHandlers,
  options: CodexClientOptions = {},
): CodexClient {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<CodexRequestId, Pending>();
  // Monotonic and never reused, so a late reply to a retired request can never
  // be mistaken for the answer to a current one.
  let nextId = 1;
  let ended = false;
  let announcedEnd = false;

  function settleAllPending(reason: unknown): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(reason);
    }
  }

  function finishStream(end: CodexTransportEnd, cause: string | undefined): void {
    if (announcedEnd) return;
    announcedEnd = true;
    ended = true;
    settleAllPending(
      new ProviderRejection(
        agentError(
          'provider_unavailable',
          end === 'eof'
            ? 'the codex app-server connection ended before answering'
            : `the codex app-server connection failed (${cause ?? 'unknown'})`,
        ),
      ),
    );
    handlers.onEnd({ end, ...(cause === undefined ? {} : { cause }) });
  }

  function handleFrame(value: unknown): void {
    const message = classifyServerMessage(value);
    if (message === undefined) {
      handlers.onDrop('unclassifiable');
      return;
    }

    switch (message.kind) {
      case 'notification':
        handlers.onNotification(message.method, message.params);
        return;

      case 'request': {
        // Decline explicitly, once, echoing the server's own id so it is not
        // left waiting. Nothing about the request payload is read or retained.
        transport.send({
          id: message.id,
          error: {
            code: METHOD_NOT_SUPPORTED,
            message: 'method not supported by this client',
          },
        });
        handlers.onServerRequest(message.method);
        return;
      }

      case 'response': {
        const entry = pending.get(message.id);
        if (entry === undefined) {
          handlers.onDrop('unknown_reply');
          return;
        }
        pending.delete(message.id);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.resolve(message.result);
        return;
      }

      case 'error': {
        const entry = pending.get(message.id);
        if (entry === undefined) {
          handlers.onDrop('unknown_reply');
          return;
        }
        pending.delete(message.id);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.reject(wireRejection(entry.method, message.error));
        return;
      }
    }
  }

  void (async () => {
    try {
      for await (const value of transport.incoming) handleFrame(value);
      finishStream('eof', undefined);
    } catch (error) {
      finishStream('failed', classifyThrown(error));
    }
  })();

  return {
    request(method: string, params?: JsonValue): Promise<unknown> {
      if (ended) {
        return Promise.reject(
          new ProviderRejection(agentError('provider_unavailable', 'the codex app-server connection has ended')),
        );
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(
              new ProviderRejection(
                agentError('provider_unavailable', `codex did not answer \`${method}\` within the request deadline`, {
                  providerCode: 'request_timeout',
                }),
              ),
            );
          }, timeoutMs);
          // A pending deadline must never be the reason a host process stays
          // alive; the stream ending settles the request either way.
          timer.unref();
        }
        pending.set(id, { method, resolve, reject, timer });
        transport.send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },

    notify(method: string, params?: JsonValue): void {
      if (ended) return;
      transport.send({ method, ...(params === undefined ? {} : { params }) });
    },

    get ended(): boolean {
      return ended;
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}
