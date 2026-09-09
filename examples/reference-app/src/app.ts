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

export function createReferenceApp(config: ReferenceAppConfig): ReferenceApp {
  const runtimeApp = createReferenceAppRuntime({ workspaceBaseDirectory: config.workspaceBaseDirectory });
  const context: RouteContext = { app: runtimeApp, maxRequestBodyBytes: config.maxRequestBodyBytes };

  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error: unknown) => {
      // A route handler threw rather than answering with an error JSON body —
      // this is this app's own bug, not a caller mistake, and the browser must
      // still get a bounded response rather than a hung connection. The
      // message is fixed and generic: an unexpected internal error must never
      // leak upstream provider prose or a stack trace to the client.
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
          resolve({ host: config.host, port: address.port });
        });
      });
    },
    async close(): Promise<void> {
      // Runtime shutdown first: it closes every subscription hub-side, which
      // lets each open SSE response reach its own `finally` and `end()`. Only
      // then does the HTTP server stop — `server.close()`'s callback would
      // otherwise wait forever on a keep-alive connection nothing is closing.
      await runtimeApp.runtime.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
