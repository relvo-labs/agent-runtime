import { describe, expect, it } from 'vitest';

import { CLAUDE_ADAPTER_STATUS, CLAUDE_PROVIDER_ID } from '../src/index.ts';

describe('Claude provider boundary', () => {
  it('is explicit that no live adapter ships in the foundation', () => {
    expect(CLAUDE_PROVIDER_ID).toBe('claude');
    expect(CLAUDE_ADAPTER_STATUS).toBe('scaffold');
  });
});
