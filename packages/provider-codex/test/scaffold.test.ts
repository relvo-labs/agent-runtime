import { describe, expect, it } from 'vitest';

import { CODEX_ADAPTER_STATUS, CODEX_PROVIDER_ID } from '../src/index.ts';

describe('Codex provider boundary', () => {
  it('is explicit that no live adapter ships in the foundation', () => {
    expect(CODEX_PROVIDER_ID).toBe('codex');
    expect(CODEX_ADAPTER_STATUS).toBe('scaffold');
  });
});
