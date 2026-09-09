/**
 * Shared HTTP/SSE test helpers. Every test in this suite drives a real,
 * running instance of this app's own server — no injected transport, no
 * fabricated event, no mocked runtime.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReferenceApp, type ReferenceApp, type ReferenceAppTestOverrides } from '../src/app.ts';
import type { ReferenceAppConfig } from '../src/config.ts';

export const CSRF_HEADER_NAME = 'x-relvo-reference-app';
export const CSRF_HEADER_VALUE = '1';

export type JsonRecord = Record<string, unknown>;

export function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export type StartedApp = {
  readonly app: ReferenceApp;
  readonly baseUrl: string;
  readonly port: number;
  readonly workspaceBase: string;
  call(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: JsonRecord; headers: Headers }>;
  collectSubscription(
    sessionId: string,
    until: (messages: readonly JsonRecord[]) => boolean,
    query?: string,
  ): Promise<{ messages: JsonRecord[]; stop: () => void }>;
  teardown(): Promise<void>;
};

export async function startTestApp(
  overrides: Partial<ReferenceAppConfig> = {},
  testOverrides: ReferenceAppTestOverrides = {},
): Promise<StartedApp> {
  const workspaceBase = mkdtempSync(join(tmpdir(), 'relvo-reference-app-test-'));
  const config: ReferenceAppConfig = {
    host: '127.0.0.1',
    port: 0,
    workspaceBaseDirectory: workspaceBase,
    maxRequestBodyBytes: 4096,
    ...overrides,
  };
  const app = createReferenceApp(config, testOverrides);
  const { host, port } = await app.listen();
  const baseUrl = `http://${host}:${String(port)}`;

  async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: JsonRecord; headers: Headers }> {
    const headers: Record<string, string> = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text.length > 0 ? (JSON.parse(text) as JsonRecord) : {},
      headers: response.headers,
    };
  }

  async function collectSubscription(
    sessionId: string,
    until: (messages: readonly JsonRecord[]) => boolean,
    query = 'fromSequence=0',
  ): Promise<{ messages: JsonRecord[]; stop: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/subscribe?${query}`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      signal: controller.signal,
    });
    const messages: JsonRecord[] = [];
    if (response.status !== 200 || response.body === null) {
      return { messages, stop: () => controller.abort() };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            messages.push(JSON.parse(line.slice('data:'.length).trim()) as JsonRecord);
          }
        }
        if (until(messages)) return;
      }
    })();

    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([pump, deadline]);
    return { messages, stop: () => controller.abort() };
  }

  return {
    app,
    baseUrl,
    port,
    workspaceBase,
    call,
    collectSubscription,
    async teardown(): Promise<void> {
      await app.close();
      rmSync(workspaceBase, { recursive: true, force: true });
    },
  };
}

/** Opens a session against the scripted-demo provider; asserts it applied. */
export async function openScriptedSession(started: StartedApp): Promise<string> {
  const opened = await started.call('/api/sessions', {
    method: 'POST',
    body: { commandId: commandId('open'), providerId: 'scripted-demo' },
  });
  const receipt = opened.body.receipt as JsonRecord;
  if (receipt.disposition !== 'applied') {
    throw new Error(`expected open_session to apply, got ${JSON.stringify(receipt)}`);
  }
  return (receipt.result as JsonRecord).sessionId as string;
}
