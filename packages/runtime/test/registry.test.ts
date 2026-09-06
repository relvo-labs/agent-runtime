import { describe, expect, it } from 'vitest';

import { createScriptedProvider } from '@relvo-labs/agent-provider/testing';
import type { AgentProvider } from '@relvo-labs/agent-provider';
import type { ProviderDescriptor } from '@relvo-labs/agent-protocol';

import { createProviderRegistry } from '../src/registry.ts';

describe('provider registry boundary', () => {
  it('parses and deep-freezes one descriptor snapshot exactly once', () => {
    const scripted = createScriptedProvider({ supportsRecovery: false });
    const mutable = structuredClone(scripted.provider.describe());
    let describeCalls = 0;
    const provider: AgentProvider = {
      describe() {
        describeCalls += 1;
        return mutable;
      },
      createSession: (init) => scripted.provider.createSession(init),
    };
    const registry = createProviderRegistry([provider]);
    expect(describeCalls).toBe(1);
    Reflect.set(mutable, 'displayName', 'mutated later');
    Reflect.set(mutable.run.streaming, 'messageDeltas', false);

    expect(registry.descriptor('scripted')).toMatchObject({
      displayName: 'Scripted test provider',
      run: { streaming: { messageDeltas: true } },
    });
    expect(registry.descriptors()).toEqual([registry.descriptor('scripted')]);
    expect(Object.isFrozen(registry.descriptor('scripted'))).toBe(true);
    expect(Object.isFrozen(registry.descriptor('scripted').run.streaming)).toBe(true);
    expect(describeCalls).toBe(1);
  });

  it('rejects malformed descriptors at registration', () => {
    const scripted = createScriptedProvider();
    const malformed: unknown = { ...scripted.provider.describe(), providerId: 'NOT VALID' };
    const provider: AgentProvider = {
      describe: () => malformed as ProviderDescriptor,
      createSession: (init) => scripted.provider.createSession(init),
    };
    expect(() => createProviderRegistry([provider])).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'provider_contract_violation' }) }),
    );
  });
});
