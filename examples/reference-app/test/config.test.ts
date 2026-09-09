/**
 * `loadConfigFromEnv` is where every trusted, operator-supplied value in this
 * app is parsed — a silently-truncating parse here would be exactly the kind
 * of "mostly harmless" bug this suite exists to make impossible.
 */

import { describe, expect, it } from 'vitest';

import { loadConfigFromEnv } from '../src/config.ts';

describe('loadConfigFromEnv: strict port parsing', () => {
  it('accepts a plain integer', () => {
    expect(loadConfigFromEnv({ REFERENCE_APP_PORT: '4321' }).port).toBe(4321);
  });

  it('falls back to the default when unset', () => {
    expect(loadConfigFromEnv({}).port).toBe(4173);
  });

  it.each(['1junk', '1.5', '-1', ' 1', '1 ', '007', '0x10', '99999999999999999999'])(
    'rejects %j rather than silently truncating it',
    (bad) => {
      expect(() => loadConfigFromEnv({ REFERENCE_APP_PORT: bad })).toThrow();
    },
  );

  it('treats an empty value as unset (falls back to the default), not as zero', () => {
    expect(loadConfigFromEnv({ REFERENCE_APP_PORT: '' }).port).toBe(4173);
  });

  it('rejects a port above 65535', () => {
    expect(() => loadConfigFromEnv({ REFERENCE_APP_PORT: '65536' })).toThrow();
  });

  it('rejects a non-loopback host', () => {
    expect(() => loadConfigFromEnv({ REFERENCE_APP_HOST: '0.0.0.0' })).toThrow(/loopback/);
  });
});
