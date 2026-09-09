/**
 * Adversarial non-leak regression for `safeDiagnostic` — the one function
 * standing between an arbitrary caught error and this app's server-side log
 * (see `src/app.ts`'s route catch-all and `src/server.ts`'s shutdown-failure
 * log, the only two call sites). Node's default `console.error(error)`
 * formatting recurses into `.cause` and, for an `AggregateError`, every entry
 * of `.errors` — exactly where a raw provider/cleanup failure can carry an
 * upstream credential, a native process id, or a host filesystem path. These
 * are SIMULATED sentinel values built directly in this test file — never a
 * real credential, never a live provider — used only to prove the sanitizer
 * actually strips them; they must never be read as real provider evidence.
 */

import { describe, expect, it } from 'vitest';
import { AgentRuntimeError, agentError } from '@relvo-labs/agent-protocol';

import { safeDiagnostic } from '../src/diagnostics.ts';

// A recognisable sentinel that must NEVER appear in `safeDiagnostic`'s
// output, no matter how deeply it is nested. Deliberately unmistakably
// SYNTHETIC — plain marker text, never shaped like any real credential
// format (no `sk-`/`gh_`/`AKIA`-style prefix) — so this file itself stays
// clean of anything `tools/repo/check-static.ts`'s secret-pattern scanner
// (unchanged, and correctly so — see `.agents/skills/local-ci-parity`)
// would, rightly, also flag in a genuine leak. The point of this sentinel is
// only to prove `safeDiagnostic` strips arbitrary sensitive-looking text; it
// does not need to mimic a real token's shape to do that.
const SECRET_SENTINEL = 'SYNTHETIC-SENSITIVE-MARKER-not-a-real-credential-3f9a1c-do-not-leak';
const NATIVE_ID_SENTINEL = 'pid=48213 native-handle=0x7ffee204';
const PATH_SENTINEL = '/home/test-user/.codex/credentials.json';

function assertNoLeak(output: string): void {
  expect(output).not.toContain(SECRET_SENTINEL);
  expect(output).not.toContain(NATIVE_ID_SENTINEL);
  expect(output).not.toContain(PATH_SENTINEL);
  // Never a raw stack-trace line — `at Object.<anonymous>` / `at file://…` /
  // this very test file's own path — leaking through either.
  expect(output).not.toMatch(/at .*\(?.*:\d+:\d+\)?/u);
  expect(output).not.toContain(import.meta.url);
}

describe('safeDiagnostic: adversarial non-leak regression', () => {
  it('never leaks a plain Error carrying a secret in its own .message', () => {
    const raw = new Error(`upstream provider said: ${SECRET_SENTINEL} at ${PATH_SENTINEL}`);
    const output = safeDiagnostic(raw);
    assertNoLeak(output);
    expect(output).toBe('unexpected internal error (Error)');
  });

  it('never leaks a secret nested one level deep via Error.cause', () => {
    const innerCause = new Error(`native failure: ${NATIVE_ID_SENTINEL}, secret ${SECRET_SENTINEL}`);
    const wrapper = new Error('cleanup failed', { cause: innerCause });
    const output = safeDiagnostic(wrapper);
    assertNoLeak(output);
    expect(output).toBe('unexpected internal error (Error)');
  });

  it('never leaks a secret nested several levels deep via chained .cause', () => {
    const level3 = new Error(`deepest secret ${SECRET_SENTINEL}`);
    const level2 = new Error('mid-level failure', { cause: level3 });
    const level1 = new Error('outer failure', { cause: level2 });
    const output = safeDiagnostic(level1);
    assertNoLeak(output);
  });

  it('never leaks any entry of an AggregateError.errors array', () => {
    const perLeaseFailures = [
      new Error(`lease 1 failed: ${PATH_SENTINEL}`),
      new Error(`lease 2 failed: ${SECRET_SENTINEL}`),
      new Error(`lease 3 failed: ${NATIVE_ID_SENTINEL}`),
    ];
    const aggregate = new AggregateError(perLeaseFailures, 'workspace release failed for 3 leases');
    const output = safeDiagnostic(aggregate);
    assertNoLeak(output);
    expect(output).toBe('unexpected internal error (AggregateError)');
  });

  it('never leaks a secret nested inside an AggregateError entry that itself has a .cause', () => {
    const rootCause = new Error(`root cause secret ${SECRET_SENTINEL}`);
    const perConnectionFailure = new Error('abandoned connection teardown failed', { cause: rootCause });
    const aggregate = new AggregateError([perConnectionFailure], `${NATIVE_ID_SENTINEL} could not be released`);
    const output = safeDiagnostic(aggregate);
    assertNoLeak(output);
  });

  it('never leaks a subclassed Error either (message provenance is still unknown)', () => {
    class ProviderTransportError extends Error {}
    const raw = new ProviderTransportError(`transport secret ${SECRET_SENTINEL}`);
    const output = safeDiagnostic(raw);
    assertNoLeak(output);
    // The constructor name alone is safe and useful; the message text is not.
    expect(output).toBe('unexpected internal error (ProviderTransportError)');
  });

  it('logs the documented-safe code/message for a real AgentRuntimeError, never its raw .cause', () => {
    const secretCause = new Error(`upstream secret ${SECRET_SENTINEL} at ${PATH_SENTINEL}`);
    const dto = agentError('workspace_unavailable', 'the workspace could not be released — retry the close');
    const runtimeError = new AgentRuntimeError(dto, { cause: secretCause });
    const output = safeDiagnostic(runtimeError);
    assertNoLeak(output);
    // `AgentError.message` is documented as safe to log — this is the one
    // case where the DTO's own text is expected verbatim, never dropped.
    expect(output).toBe('workspace_unavailable: the workspace could not be released — retry the close');
  });

  it('never treats a non-Error thrown value as safe to echo back verbatim', () => {
    expect(safeDiagnostic(SECRET_SENTINEL)).not.toContain(SECRET_SENTINEL);
    expect(safeDiagnostic({ message: SECRET_SENTINEL, toString: () => SECRET_SENTINEL })).not.toContain(
      SECRET_SENTINEL,
    );
    expect(safeDiagnostic(undefined)).toBe('unexpected internal error');
    expect(safeDiagnostic(null)).toBe('unexpected internal error');
    expect(safeDiagnostic(42)).toBe('unexpected internal error');
  });

  it('the returned string is always bounded and JSON/log-line safe (no embedded newline from a stack)', () => {
    const raw = new Error(`multi\nline\nsecret ${SECRET_SENTINEL}`);
    const output = safeDiagnostic(raw);
    assertNoLeak(output);
    expect(output).not.toContain('\n');
  });
});
