#!/usr/bin/env node
/**
 * Process entry point: `node src/server.ts` (see `README.md`).
 *
 * Reads configuration from the environment, starts listening, and shuts the
 * runtime down cleanly on SIGINT/SIGTERM so a developer's Ctrl-C releases the
 * managed workspace directory instead of abandoning it on disk.
 */

import { createReferenceApp } from './app.ts';
import { loadConfigFromEnv } from './config.ts';
import { safeDiagnostic } from './diagnostics.ts';

const config = loadConfigFromEnv();
const app = createReferenceApp(config);

let shutdownInFlight = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownInFlight) return; // a concurrent signal while one attempt is already running
  shutdownInFlight = true;
  // eslint-disable-next-line no-console -- process lifecycle, not client-facing
  console.log(`reference-app: received ${signal}, shutting down…`);
  try {
    await app.close();
  } catch (error) {
    // `app.close()`'s own cleanup (runtime shutdown, the Codex
    // abandoned-connection sweep) is documented retry-safe — a failure here
    // must stay a VISIBLE, RETRYABLE failure, never a quiet exit(0) that
    // discards an unreleased managed workspace or provider resource. Reset
    // the guard so a second SIGINT/SIGTERM can retry the exact same cleanup,
    // and keep the process alive so there is something left to retry against.
    shutdownInFlight = false;
    // eslint-disable-next-line no-console -- never the raw error; see diagnostics.ts
    console.error(
      `reference-app: shutdown failed and can be retried (send ${signal} again, or force-kill): ${safeDiagnostic(error)}`,
    );
    return;
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const { host, port } = await app.listen();
// eslint-disable-next-line no-console -- the one startup line an operator needs
console.log(`reference-app: listening on http://${host}:${String(port)} (Ctrl-C to stop)`);
