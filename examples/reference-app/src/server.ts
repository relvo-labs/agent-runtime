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

const config = loadConfigFromEnv();
const app = createReferenceApp(config);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console -- process lifecycle, not client-facing
  console.log(`reference-app: received ${signal}, shutting down…`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const { host, port } = await app.listen();
// eslint-disable-next-line no-console -- the one startup line an operator needs
console.log(`reference-app: listening on http://${host}:${String(port)} (Ctrl-C to stop)`);
