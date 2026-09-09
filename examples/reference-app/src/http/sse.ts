/**
 * Server-Sent Events framing for one subscription.
 *
 * This app deliberately does not use the browser's native `EventSource`: it
 * cannot attach the anti-CSRF header this transport requires (see
 * `security.ts`), and prompt/output text is treated as potentially sensitive.
 * The browser instead reads this same wire format from a normal, header-bearing
 * `fetch()` response body. The framing itself — `data: <json>\n\n` — is
 * unchanged, so either client works.
 */

import type { ServerResponse } from 'node:http';
import type { SubscriptionMessage } from '@relvo-labs/agent-protocol';
import type { EventSubscription } from '@relvo-labs/agent-runtime';

const HEARTBEAT_INTERVAL_MS = 20_000;

export function writeSseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // This app is same-origin only; it never sends an
    // `Access-Control-Allow-Origin` header on any response.
    'x-content-type-options': 'nosniff',
  });
  // Flush headers promptly so the browser's reader starts before the first
  // event, rather than waiting for the response to buffer.
  response.flushHeaders?.();
}

function writeMessage(response: ServerResponse, message: SubscriptionMessage): void {
  response.write(`data: ${JSON.stringify(message)}\n\n`);
}

/**
 * Drain `subscription` into `response` until it ends, the subscriber closes
 * it, or the client disconnects. Always releases the subscription exactly
 * once — a disconnect must free the runtime's bounded per-subscriber buffer,
 * not leak it, and it must never be confused with cancelling the run itself.
 */
export async function pipeSubscriptionToSse(subscription: EventSubscription, response: ServerResponse): Promise<void> {
  writeSseHeaders(response);

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': keep-alive\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await subscription.close();
  };

  response.req.on('close', () => {
    void release();
  });

  try {
    for await (const message of subscription) {
      if (response.writableEnded) break;
      writeMessage(response, message);
      if (message.type === 'closed') break;
    }
  } finally {
    await release();
    if (!response.writableEnded) response.end();
  }
}
