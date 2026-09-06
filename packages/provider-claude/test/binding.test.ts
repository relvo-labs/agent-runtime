import { describe, expect, it } from 'vitest';

import { isProviderRejection } from '@relvo-labs/agent-provider';

import { CLAUDE_AGENT_SDK_PACKAGE, loadClaudeQuery } from '../src/binding.ts';
import { createClaudeProvider } from '../src/index.ts';
import { createFakeQuery } from './fake-query.ts';

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isProviderRejection(error)) return error.agentError.code;
    throw error;
  }
  throw new Error('expected a typed provider rejection');
}

describe('default SDK binding', () => {
  it('binds the official package name', () => {
    expect(CLAUDE_AGENT_SDK_PACKAGE).toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('returns the module’s query export', async () => {
    const fake = createFakeQuery();
    const requested: string[] = [];
    const bound = await loadClaudeQuery((specifier) => {
      requested.push(specifier);
      return Promise.resolve({ query: fake.query });
    });

    expect(requested).toEqual([CLAUDE_AGENT_SDK_PACKAGE]);
    expect(bound).toBe(fake.query);
  });

  it('reports an unloadable peer as a retryable provider_unavailable', async () => {
    const code = await rejectionCode(loadClaudeQuery(() => Promise.reject(new Error('Cannot find module'))));
    expect(code).toBe('provider_unavailable');
  });

  it('reports a module without a query export rather than failing later', async () => {
    expect(await rejectionCode(loadClaudeQuery(() => Promise.resolve({ notQuery: true })))).toBe(
      'provider_unavailable',
    );
    expect(await rejectionCode(loadClaudeQuery(() => Promise.resolve(undefined)))).toBe('provider_unavailable');
  });

  it('fails session creation with an install hint when no binding is available', async () => {
    // Deterministic in this workspace by construction: the SDK is an *optional*
    // peer and is deliberately never installed here, so the default binding
    // must resolve to a typed rejection rather than a crash.
    const provider = createClaudeProvider();
    try {
      await provider.createSession({
        options: {},
        workspace: { root: '/tmp/relvo-claude-workspace', ownership: 'borrowed' },
        sink: { emit: () => undefined },
      });
      throw new Error('expected a typed provider rejection');
    } catch (error) {
      if (!isProviderRejection(error)) throw error;
      expect(error.agentError.code).toBe('provider_unavailable');
      expect(error.agentError.retryable).toBe(true);
      expect(error.agentError.message).toContain(CLAUDE_AGENT_SDK_PACKAGE);
    }
  });
});
