import { describe, expect, it } from 'vitest';

import { AgentRuntimeError, ProviderDescriptorSchema } from '@relvo-labs/agent-protocol';
import { canInterruptRun, checkWireCompatibility, defineProviderDescriptor } from '../src/index.ts';

function descriptor(interrupt: 'immediate' | 'cooperative' | 'unsupported' = 'unsupported') {
  return defineProviderDescriptor({
    providerId: 'fixture',
    providerVersion: '0.1.0',
    displayName: 'Fixture',
    run: {
      interrupt: { mode: interrupt },
      streaming: {},
    },
    interaction: { approval: {}, question: {} },
    workspace: { requires: 'directory' },
    recovery: {},
  });
}

describe('provider SPI', () => {
  it('defaults capabilities conservatively', () => {
    const value = descriptor();
    expect(value.run.interrupt.mode).toBe('unsupported');
    expect(value.run.interrupt.deliversPartialOutput).toBe(false);
    expect(value.run.interrupt.sessionRemainsUsable).toBe(false);
    expect(value.interaction.approval.supported).toBe(false);
    expect(value.recovery.resumesFromRecoveryRecord).toBe(false);
  });

  it('reports unsupported interrupt as a typed capability result', () => {
    const result = canInterruptRun(descriptor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capability_unsupported');
  });

  it('rejects an adapter built against another wire line', () => {
    const value = { ...descriptor('immediate'), wireVersion: '0.3' };
    const result = checkWireCompatibility(value);
    expect(result.ok).toBe(false);
  });

  it('keeps provider rejections in process', () => {
    expect(AgentRuntimeError).toBeDefined();
  });

  it('rejects contradictory recovery and interrupt capabilities', () => {
    const value = descriptor('immediate');
    expect(
      ProviderDescriptorSchema.safeParse({
        ...value,
        recovery: { exportsRecoveryRecord: false, resumesFromRecoveryRecord: true },
      }).success,
    ).toBe(false);
    expect(
      ProviderDescriptorSchema.safeParse({
        ...value,
        run: {
          ...value.run,
          interrupt: { mode: 'unsupported', deliversPartialOutput: true, sessionRemainsUsable: true },
        },
      }).success,
    ).toBe(false);
  });
});
