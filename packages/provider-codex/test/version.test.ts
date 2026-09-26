import { describe, expect, it } from 'vitest';

import { CODEX_APP_SERVER_MAX_VERSION, CODEX_APP_SERVER_MIN_VERSION } from '../src/index.ts';
import { CODEX_SUPPORTED_APP_SERVER_VERSIONS, isCompatibleCodexUserAgent } from '../src/version.ts';

describe('reviewed Codex CLI window', () => {
  it('covers the finite stable releases including both boundaries', () => {
    expect(CODEX_SUPPORTED_APP_SERVER_VERSIONS[0]).toBe(CODEX_APP_SERVER_MIN_VERSION);
    expect(CODEX_SUPPORTED_APP_SERVER_VERSIONS.at(-1)).toBe(CODEX_APP_SERVER_MAX_VERSION);
    for (const version of CODEX_SUPPORTED_APP_SERVER_VERSIONS) {
      expect(isCompatibleCodexUserAgent(`relvo_agent_runtime/${version} (Linux; x86_64)`, 'relvo_agent_runtime')).toBe(
        true,
      );
    }
  });

  it.each([
    'relvo_agent_runtime/0.153.3 (Linux)',
    'relvo_agent_runtime/0.153.5 (Linux)', // unpublished patch in the numerical interval
    'relvo_agent_runtime/0.156.2 (Linux)',
    'relvo_agent_runtime/0.157.0 (Linux)',
    'relvo_agent_runtime/0.156.1-alpha.1 (Linux)',
    'relvo_agent_runtime/0.156.1',
    'other_client/0.156.1 (Linux)',
    'relvo_agent_runtime/0.156.1 (Linux)'.repeat(30),
  ])('refuses unknown, prerelease, malformed or unreviewed versions: %s', (value) => {
    expect(isCompatibleCodexUserAgent(value, 'relvo_agent_runtime')).toBe(false);
  });

  it('refuses absent and non-string responses', () => {
    expect(isCompatibleCodexUserAgent(undefined, 'relvo_agent_runtime')).toBe(false);
    expect(isCompatibleCodexUserAgent({}, 'relvo_agent_runtime')).toBe(false);
  });
});
