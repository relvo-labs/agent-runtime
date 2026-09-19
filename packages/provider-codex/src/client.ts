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
 * It also guarantees that every *server-initiated* request is answered exactly
 * once. The session may take ownership of one and answer it later — that is how
 * an approval reaches a host — but anything it does not take is declined here
 * and now. Silence is not an option: `item/tool/requestUserInput` carries
 * `isBlocking`, so an unanswered request can stall a turn indefinitely
 * (research, "Wire and initialization").
 *
 * The two id spaces are deliberately separate. `pending` holds ids this adapter
 * chose and the server must answer; `serverRequests` holds ids the server chose
 * and this adapter must answer. Both sides number from 1, so merging them would
 * let one side settle the other's request.
 */

import { agentError, type JsonValue } from '@relvo-labs/agent-protocol';
import { ProviderRejection } from '@relvo-labs/agent-provider';

import { METHOD_NOT_SUPPORTED, classifyServerMessage, type JsonlDropReason } from './protocol.ts';
import { classifyThrown } from './translate.ts';
import type { CodexServerRequestOffer } from './interaction.ts';
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

/** Why a request failed, when the failure did not come from the server. */
export const CODEX_REQUEST_FAILURE = {
  /** The peer never answered within the deadline. Admission is unknown. */
  timeout: 'request_timeout',
  /** The stream ended while the request was in flight. Admission is unknown. */
  connectionLost: 'connection_lost',
  /** Refused locally; the frame was never written. Nothing was admitted. */
  connectionClosed: 'connection_closed',
} as const;

/**
 * Failure codes that prove the server decided, so nothing was admitted.
 *
 * Every wire classification qualifies: an error frame naming our request id is
 * the server answering *that* request. `connection_closed` qualifies too,
 * because the frame was never written at all.
 *
 * Everything else — a deadline, a stream that died mid-flight, or any value
 * this layer cannot classify — does **not** qualify. A lost reply is not a
 * rejection: the turn may be running right now.
 */
const AUTHORITATIVE_CODES: ReadonlySet<string> = new Set([
  'overloaded',
  'invalid_request',
  'method_not_found',
  'invalid_params',
  'internal_error',
  'parse_error',
  'unclassified',
  CODEX_REQUEST_FAILURE.connectionClosed,
]);

/**
 * True only when the failure proves the request was *not* admitted.
 *
 * Fail-safe by construction: an unrecognised value answers `false`, so a caller
 * that branches on this treats the unknown case as ambiguous rather than as a
 * clean rejection.
 */
export function isAuthoritativeRejection(error: unknown): boolean {
  if (!(error instanceof ProviderRejection)) return false;
  const code = error.agentError.providerCode;
  return code !== undefined && AUTHORITATIVE_CODES.has(code);
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
  /**
   * A server-initiated request arrived.
   *
   * Return `true` to take responsibility for answering it — now or later,
   * through the offer's own `respond`/`reject`. Return `false` and this layer
   * declines it immediately, so an unhandled request can never hang a turn.
   * The native id is not passed: the ability to answer it once is.
   */
  onServerRequest(request: CodexServerRequestOffer): boolean;
  /** An inbound frame could not be used. Bounded, allowlisted reason token. */
  onDrop(reason: JsonlDropReason | 'unclassifiable' | 'unknown_reply' | 'duplicate_server_request'): void;
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
  /** Ids this adapter chose, awaiting the server's reply. */
  const pending = new Map<CodexRequestId, Pending>();
  /**
   * Ids the *server* chose, awaiting this adapter's reply.
   *
   * Kept strictly apart from `pending`. The two id spaces are independent —
   * both sides number from 1 — so merging them would let a server request
   * resolve one of this adapter's own in-flight calls, or the reverse.
   */
  const serverRequests = new Set<CodexRequestId>();
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
    // Nothing can be written any more, so no server request is still
    // answerable. The session retires its own routing state on `onEnd`.
    serverRequests.clear();
    settleAllPending(
      new ProviderRejection(
        agentError(
          'provider_unavailable',
          end === 'eof'
            ? 'the codex app-server connection ended before answering'
            : `the codex app-server connection failed (${cause ?? 'unknown'})`,
          // Deliberately *not* an authoritative rejection: a request that was
          // already written may have been admitted before the stream died.
          { providerCode: CODEX_REQUEST_FAILURE.connectionLost },
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
        // A second request reusing an id that is still outstanding cannot be
        // answered: a reply frame naming that id would settle the *first*
        // request. So it is recorded and ignored rather than answered or
        // allowed to raise anything.
        if (serverRequests.has(message.id)) {
          handlers.onDrop('duplicate_server_request');
          return;
        }
        serverRequests.add(message.id);

        // At most one reply per server request, guaranteed here rather than
        // trusted to the handler. `serverRequests` is deliberately a separate
        // map from `pending`: one tracks ids the *server* chose and this
        // adapter must answer, the other tracks ids this adapter chose and the
        // server must answer. Sharing them would let one side settle the other.
        let answered = false;
        const reply = (
          body: { id: CodexRequestId; result: JsonValue } | { id: CodexRequestId; error: CodexWireError },
        ): boolean => {
          if (answered || ended) return false;
          answered = true;
          serverRequests.delete(message.id);
          transport.send(body);
          return true;
        };
        const offer: CodexServerRequestOffer = {
          method: message.method,
          params: message.params,
          respond: (result: JsonValue) => reply({ id: message.id, result }),
          reject: (code: number, text: string) => reply({ id: message.id, error: { code, message: text } }),
        };

        let taken: boolean;
        try {
          taken = handlers.onServerRequest(offer);
        } catch {
          // A handler that throws must not leave the server waiting, and must
          // not be able to break the inbound loop.
          taken = false;
        }
        // Decline explicitly, echoing the server's own id so it is not left
        // waiting. `reject` is a no-op if the handler already answered.
        if (!taken) offer.reject(METHOD_NOT_SUPPORTED, 'method not supported by this client');
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
        // Nothing is written, so this one really is authoritative.
        return Promise.reject(
          new ProviderRejection(
            agentError('provider_unavailable', 'the codex app-server connection has ended', {
              providerCode: CODEX_REQUEST_FAILURE.connectionClosed,
            }),
          ),
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
                  providerCode: CODEX_REQUEST_FAILURE.timeout,
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
