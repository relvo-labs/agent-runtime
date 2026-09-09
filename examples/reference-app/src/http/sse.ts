/**
 * Server-Sent Events framing for one subscription.
 *
 * This app deliberately does not use the browser's native `EventSource`: it
 * cannot attach the anti-CSRF header this transport requires (see
 * `security.ts`), and prompt/output text is treated as potentially sensitive.
 * The browser instead reads this same wire format from a normal, header-bearing
 * `fetch()` response body. The framing itself — `data: <json>\n\n` — is
 * unchanged, so either client works.
 *
 * Three failure modes this module exists to prevent:
 *
 *   - A slow reader must apply real backpressure to this app, not merely to
 *     the runtime's own bounded per-subscriber buffer. Calling
 *     `response.write()` without checking its return value queues bytes in
 *     Node's own unbounded internal buffer regardless of whether the socket
 *     is keeping up, which reintroduces the same unbounded-memory problem the
 *     protocol's subscriber buffer exists to prevent — just one layer higher.
 *   - A write that never drains (a genuinely dead peer, e.g. behind a NAT
 *     that silently dropped the connection) must not wait forever; it is
 *     released after a bounded deadline.
 *   - Release must be tied to the *response*'s lifecycle, not the *request*'s.
 *     `IncomingMessage`'s own `close` event is not the same signal — a
 *     released subscription must correspond to "no further bytes can reach
 *     this peer", which is what `ServerResponse`'s `close` event means.
 */

import type { ServerResponse } from 'node:http';
import type { SubscriptionMessage } from '@relvo-labs/agent-protocol';
import type { EventSubscription } from '@relvo-labs/agent-runtime';

const HEARTBEAT_INTERVAL_MS = 20_000;
/** A write that has not drained within this long is treated as a dead peer. */
const WRITE_DEADLINE_MS = 15_000;

export function writeSseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
  // Flush headers promptly so the browser's reader starts before the first
  // event, rather than waiting for the response to buffer.
  response.flushHeaders?.();
}

/** A dedicated error so a timed-out write is distinguishable from a socket error. */
class WriteDeadlineExceededError extends Error {
  constructor() {
    super('SSE write did not drain within the deadline; treating the peer as unresponsive');
    this.name = 'WriteDeadlineExceededError';
  }
}

/**
 * Write `chunk`, resolving only once Node has actually drained it (or it fit
 * within the socket's own buffer without backpressure). Rejects if the
 * connection errors, or if the write does not drain inside
 * {@link WRITE_DEADLINE_MS}.
 */
function writeBounded(response: ServerResponse, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      response.removeListener('error', onError);
      reject(new WriteDeadlineExceededError());
    }, WRITE_DEADLINE_MS);
    // A timer that outlives the request would keep a test process alive.
    timer.unref();

    function onError(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    response.once('error', onError);

    const canWriteMore = response.write(chunk, (error) => {
      if (settled) return;
      if (error) {
        settled = true;
        clearTimeout(timer);
        response.removeListener('error', onError);
        reject(error);
        return;
      }
      // Only resolve here when `write` reported backpressure below — the
      // fast path (no backpressure) resolves immediately, not via callback,
      // so a steady stream of small messages is not held to one write's
      // actual flush-to-socket latency.
    });
    if (canWriteMore) {
      settled = true;
      clearTimeout(timer);
      response.removeListener('error', onError);
      resolve();
      return;
    }
    response.once('drain', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.removeListener('error', onError);
      resolve();
    });
  });
}

function frame(message: SubscriptionMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

/**
 * Drain `subscription` into `response` until it ends, the subscriber closes
 * it, or the client disconnects. Always releases the subscription exactly
 * once — a disconnect must free the runtime's bounded per-subscriber buffer,
 * not leak it, and it must never be confused with cancelling the run itself.
 *
 * Bounded end to end: this app never calls `reader.read()`-equivalent (never
 * pulls the next message from the subscription's async iterator) until the
 * previous write has actually drained, so a slow client throttles delivery
 * all the way back to the subscription itself rather than buffering
 * unboundedly in this process.
 */
export async function pipeSubscriptionToSse(subscription: EventSubscription, response: ServerResponse): Promise<void> {
  writeSseHeaders(response);

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await subscription.close();
  };

  // Tied to the RESPONSE's lifecycle: fires once no further byte can reach
  // this peer, whether that is a client-initiated disconnect, a server-side
  // `response.end()`, or the underlying socket erroring out. `request.close`
  // is a different, less reliable signal for exactly this purpose.
  response.on('close', () => {
    void release();
  });

  // Guards against a heartbeat write overlapping the main loop's write: both
  // ultimately call the same underlying `response.write()`, which is safe on
  // its own (Node queues writes in call order), but skipping a redundant
  // heartbeat while a real message write is in flight keeps the two paths
  // from ever attaching concurrent one-shot `drain`/`error` listeners.
  let writingMessage = false;
  const heartbeat = setInterval(() => {
    if (response.writableEnded || released || writingMessage) return;
    void writeBounded(response, ': keep-alive\n\n').catch(() => {
      void release();
      if (!response.writableEnded) response.end();
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    for await (const message of subscription) {
      if (response.writableEnded || released) break;
      writingMessage = true;
      try {
        await writeBounded(response, frame(message));
      } finally {
        writingMessage = false;
      }
      if (message.type === 'closed') break;
    }
  } catch {
    // A write failure (socket error or deadline) ends the stream the same
    // way a client disconnect does — release and stop, never throw out of
    // this pipe and into the route handler's generic 500 path.
  } finally {
    await release();
    if (!response.writableEnded) response.end();
  }
}
