/**
 * The transport seam.
 *
 * These types are hand-authored against the pinned Codex app-server protocol
 * (codex-cli 0.153.4, upstream `openai/codex@3d2ee51c`). They are deliberately
 * **not** generated from, or imported out of, any Codex package: this adapter
 * has no Codex npm dependency at all, so nothing here can drag a third-party
 * runtime closure — or its licence — into a published artifact.
 *
 * The seam is one duplex message channel, not a process. That is what makes the
 * whole adapter testable without a child process, a binary, a network or a
 * credential: a test supplies its own `CodexTransport` and drives every frame
 * ordering by hand. `transport.ts` supplies the production implementation that
 * really does spawn `codex app-server --stdio`.
 *
 * Note the asymmetry in the two directions:
 *
 *   - **outbound** is typed (`CodexClientMessage`). This adapter controls what
 *     it sends, so it sends only well-formed frames.
 *   - **inbound** is `unknown`. It arrives from a separate process and is
 *     untrusted input. Every inbound value is classified and validated in
 *     `protocol.ts` before anything reads a field off it.
 */

import type { JsonValue } from '@relvo-labs/agent-protocol';

/**
 * A JSON-RPC id.
 *
 * The pinned `RequestId` is `string | integer(int64)`
 * (`typescript-stable/RequestId.ts`). This adapter only ever *sends* integers,
 * but it must be able to echo back whatever a server request used.
 */
export type CodexRequestId = number | string;

/** A JSON-RPC error body: `{ code, message, data? }`. */
export type CodexWireError = {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
};

export type CodexClientRequest = {
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params?: JsonValue;
};

export type CodexClientNotification = {
  readonly method: string;
  readonly params?: JsonValue;
};

export type CodexClientResponse = {
  readonly id: CodexRequestId;
  readonly result: JsonValue;
};

export type CodexClientErrorReply = {
  readonly id: CodexRequestId;
  readonly error: CodexWireError;
};

/**
 * Anything this adapter writes to the server.
 *
 * There is no `jsonrpc` member, by design: the app-server "neither sends nor
 * expects" one (`official-source/protocol-rpc.rs`). Adding one would be a
 * protocol error, not a harmless extra field.
 */
export type CodexClientMessage =
  CodexClientRequest | CodexClientNotification | CodexClientResponse | CodexClientErrorReply;

/**
 * Why the inbound stream stopped.
 *
 * `eof` is an orderly end of stdout — including the normal consequence of the
 * child exiting. `failed` is a transport-level fault. Neither is ever read as a
 * successful turn outcome.
 */
export type CodexTransportEnd = 'eof' | 'failed';

/**
 * One duplex Codex app-server connection.
 *
 * `incoming` yields decoded-but-unvalidated JSON values, one per protocol
 * frame. Ending the iteration means EOF; throwing means transport failure. Both
 * settle every pending request and any admitted run — a client that waits for a
 * graceful protocol goodbye waits forever, because the bounded surface has no
 * shutdown handshake — the stable `ClientRequest` union has no `shutdown` or
 * `exit` method at all (research, "Interrupt and shutdown").
 */
export type CodexTransport = {
  /**
   * Write one frame. Synchronous and non-throwing: a transport that can no
   * longer write reports it by ending `incoming`, so a send can never become a
   * second, competing failure path.
   */
  send(message: CodexClientMessage): void;

  readonly incoming: AsyncIterable<unknown>;

  /**
   * Release the connection. Must be idempotent and safe to retry after a
   * rejection — the SPI requires a failed teardown to keep its ownership
   * (`provider-adapter-development`, step 4).
   */
  close(): Promise<void>;
};

/** What the adapter tells a transport factory when opening a connection. */
export type CodexTransportParams = {
  /**
   * The acquired workspace lease root. Absolute and realpath-resolved by the
   * time it reaches here; the adapter validates that before calling.
   */
  readonly cwd: string;
};

/**
 * How a `CodexTransport` is obtained.
 *
 * Omit `transport` in `CodexProviderOptions` to get the production stdio
 * implementation; pass one to run against a host-managed connection or a
 * deterministic double.
 */
export type CodexTransportFactory = (params: CodexTransportParams) => CodexTransport | Promise<CodexTransport>;
