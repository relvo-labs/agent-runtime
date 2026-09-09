/**
 * Wires configuration, the runtime composition root, and the HTTP transport
 * into one object a test or an entry point can start and stop.
 */

import { createServer, type Server } from 'node:http';

import type { ReferenceAppConfig } from './config.ts';
import { createReferenceAppRuntime, type ReferenceAppRuntime } from './runtime-factory.ts';
import { handleRequest, type RouteContext } from './http/routes.ts';

export type ReferenceApp = {
  readonly server: Server;
  readonly runtimeApp: ReferenceAppRuntime;
  /** Resolves once listening. Reads back the actual bound address/port. */
  listen(): Promise<{ readonly host: string; readonly port: number }>;
  /** Stops accepting connections, shuts the runtime down, then closes the server. */
  close(): Promise<void>;
};

/** Test-only construction overrides. Never driven from the environment. */
export type ReferenceAppTestOverrides = {
  readonly removeDirectory?: (path: string) => Promise<void>;
};

/** A shutdown-time grace period for in-flight SSE pipes to end on their own. */
const SSE_DRAIN_GRACE_MS = 3000;

export function createReferenceApp(
  config: ReferenceAppConfig,
  testOverrides: ReferenceAppTestOverrides = {},
): ReferenceApp {
  const realProviders = {
    ...(config.enableCodex
      ? { codex: config.codexExecutable === undefined ? {} : { executable: config.codexExecutable } }
      : {}),
    ...(config.enableClaude ? { claude: config.claudeModel === undefined ? {} : { model: config.claudeModel } } : {}),
  };

  const runtimeApp = createReferenceAppRuntime({
    workspaceBaseDirectory: config.workspaceBaseDirectory,
    ...(testOverrides.removeDirectory === undefined ? {} : { removeDirectory: testOverrides.removeDirectory }),
    ...(Object.keys(realProviders).length > 0 ? { realProviders } : {}),
  });

  // Read back after `listen()` resolves — `port: 0` picks an ephemeral port,
  // and the Host-header check must validate against what this server is
  // ACTUALLY bound to, never the requested configuration value.
  const boundPort = { current: config.port };

  // Every currently-open SSE pipe's completion promise. `close()` awaits
  // these (bounded) before ever touching the server's own sockets — closing
  // a live SSE response out from under its own `for await` loop is exactly
  // the abrupt-socket-termination bug a graceful shutdown exists to avoid;
  // the loop's own `finally` (subscription release, `response.end()`) is what
  // must run, not a forced `destroy()`.
  const activeSseStreams = new Set<Promise<void>>();

  const context: RouteContext = {
    app: runtimeApp,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    expectedPort: () => boundPort.current,
    trackSseStream(promise: Promise<void>): void {
      activeSseStreams.add(promise);
      void promise.finally(() => activeSseStreams.delete(promise));
    },
  };

  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error: unknown) => {
      // A route handler threw rather than answering with an error JSON body.
      // A thrown `AgentRuntimeError` is handled inside `routes.ts` itself (a
      // legitimate, typed, possibly-retryable SDK failure); anything reaching
      // here is this app's own bug, and the browser must still get a bounded
      // response rather than a hung connection. The message is fixed and
      // generic: an unexpected internal error must never leak upstream
      // provider prose or a stack trace to the client.
      if (!response.headersSent) {
        const body = JSON.stringify({ error: { code: 'internal', message: 'unexpected server error' } });
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(body);
      } else if (!response.writableEnded) {
        response.end();
      }
      // eslint-disable-next-line no-console -- the one place this app logs; never forwarded to a client
      console.error('reference-app: unhandled route error', error);
    });
  });

  return {
    server,
    runtimeApp,
    listen(): Promise<{ readonly host: string; readonly port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('reference-app: server did not bind to a TCP address'));
            return;
          }
          boundPort.current = address.port;
          resolve({ host: config.host, port: address.port });
        });
      });
    },
    async close(): Promise<void> {
      // 1. Runtime shutdown: stops new admissions, drains in-flight commands,
      //    closes every open session (emitting `session.closed`, which is
      //    what lets each SSE pipe's own live loop see a terminal message and
      //    end itself).
      await runtimeApp.runtime.shutdown();

      // 2. Give every currently-open SSE pipe a bounded chance to actually
      //    consume that terminal message and end its own response normally.
      if (activeSseStreams.size > 0) {
        await Promise.race([
          Promise.allSettled([...activeSseStreams]),
          new Promise<void>((resolve) => setTimeout(resolve, SSE_DRAIN_GRACE_MS)),
        ]);
      }

      // 3. Only idle connections are force-closed — a keep-alive static-asset
      //    connection with nothing in flight, never one still mid-response.
      server.closeIdleConnections();
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SSE_DRAIN_GRACE_MS)),
      ]);
      if (outcome === 'timeout') {
        // Something survived steps 1–3 (a pipe that ignored its deadline) and
        // would otherwise wedge `server.close()`'s callback forever; force
        // the remaining sockets only now, as a last-resort bound on total
        // shutdown time, then wait for the same `close()` callback to fire.
        server.closeAllConnections();
        await closed;
      }
    },
  };
}
