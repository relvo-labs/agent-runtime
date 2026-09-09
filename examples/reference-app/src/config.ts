/**
 * Reference app configuration.
 *
 * Every field here has a safe default appropriate for a loopback-only demo.
 * Nothing is read from a browser request; this module is the single place a
 * host operator can adjust behaviour, and every value it produces is trusted.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ReferenceAppConfig = {
  /** Loopback only. Never `0.0.0.0` or a public interface — see SECURITY. */
  readonly host: string;
  /** `0` picks an ephemeral port; used by tests and optionally by dev runs. */
  readonly port: number;
  /**
   * Base directory this app owns for disposable *managed* workspaces. Every
   * session gets its own directory under here, created fresh and removed on
   * close. This app never operates against a borrowed/existing directory.
   */
  readonly workspaceBaseDirectory: string;
  /** Maximum accepted JSON request body, in bytes. */
  readonly maxRequestBodyBytes: number;
  /**
   * Opt-in real provider profiles. Both default to disabled: the canonical
   * gate and the default first run stay credential-free. Enabling one here
   * does not supply a credential — it only registers the adapter so
   * `open_session` can attempt it; authentication remains entirely host-side
   * (see `providers/codex.ts` / `providers/claude.ts`).
   */
  readonly enableCodex?: boolean;
  readonly enableClaude?: boolean;
  /** Overrides the `codex` executable resolved from `PATH`. */
  readonly codexExecutable?: string | undefined;
  /** Overrides the default Claude model id. */
  readonly claudeModel?: string | undefined;
};

/**
 * Every digit, no sign, no fraction, no leading zero unless the value is
 * exactly `0` — the same strict shape `src/http/query.ts` requires of a
 * caller-supplied query value. `Number.parseInt` is deliberately not used
 * here either: `Number.parseInt('1junk', 10)` silently truncates to `1`,
 * which is not what an operator who made a typo in an environment variable
 * asked for, and a silently-wrong bind port is exactly the kind of mistake
 * this file's own doc comment says every value here is trusted to have
 * avoided.
 */
const STRICT_NON_NEGATIVE_INT = /^(?:0|[1-9]\d*)$/u;

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!STRICT_NON_NEGATIVE_INT.test(value)) {
    throw new Error(`REFERENCE_APP_PORT must be a plain non-negative integer, got \`${value}\``);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
    throw new Error(`REFERENCE_APP_PORT must be an integer in [0, 65535], got \`${value}\``);
  }
  return parsed;
}

/**
 * Build configuration from the process environment. Called once at process
 * start; a test constructs its own config object directly instead of mutating
 * `process.env`, so the two never interfere.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReferenceAppConfig {
  const host = env.REFERENCE_APP_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `refusing to bind the reference app to \`${host}\`: this demo only ever binds loopback ` +
        '(127.0.0.1, ::1, or localhost). It is not hardened for a shared or public interface.',
    );
  }
  return {
    host,
    port: readPort(env.REFERENCE_APP_PORT, 4173),
    workspaceBaseDirectory:
      env.REFERENCE_APP_WORKSPACE_BASE ?? join(tmpdir(), 'relvo-reference-app', String(process.pid)),
    maxRequestBodyBytes: 64 * 1024,
    enableCodex: env.REFERENCE_APP_ENABLE_CODEX === '1',
    enableClaude: env.REFERENCE_APP_ENABLE_CLAUDE === '1',
    codexExecutable: env.CODEX_EXECUTABLE,
    claudeModel: env.REFERENCE_APP_CLAUDE_MODEL,
  };
}
