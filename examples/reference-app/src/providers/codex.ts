/**
 * Opt-in real Codex profile.
 *
 * Registered only when explicitly enabled (see `runtime-factory.ts`); never
 * on by default, and never a fallback for a failed scripted or Claude
 * attempt. This composes the SDK's own adapter — it does not spawn or manage
 * `codex` itself beyond what `createCodexProvider` already does.
 *
 * Authentication is entirely host-side and out of this app's control, by
 * design: the app never reads, stores or forwards a credential. The spawned
 * `codex app-server --stdio` process inherits this Node process's own
 * environment (Node's `child_process.spawn` default), so whatever the host
 * already configured — an interactive `codex login` session under
 * `CODEX_HOME` (default `~/.codex`), or `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN`
 * for non-interactive use — is what Codex itself resolves. See the live
 * upstream docs: https://developers.openai.com/codex/auth and
 * https://developers.openai.com/codex/environment-variables (read during
 * implementation; this file guesses nothing about auth and changes nothing
 * about it).
 *
 * A missing or unusable `codex` executable is a `provider_unavailable`/
 * `provider_rejected` setup failure surfaced from `open_session`, exactly
 * like any other adapter failure — this app adds no special-case handling
 * and no silent fallback to the scripted lane.
 *
 * `createCodexProvider` returns the SPI-neutral `AgentProvider` PLUS this
 * adapter's own cleanup ownership for a connection whose handshake *and*
 * whose own teardown both failed (`CodexProvider#releaseAbandonedConnections`
 * — see `packages/provider-codex/src/provider.ts`). That extra surface is
 * deliberately NOT erased to a plain `AgentProvider` here: the runtime never
 * sees it (composition stays adapter-specific, matching
 * `.agents/skills/package-architecture/SKILL.md`), but the host that
 * registered this adapter is exactly who the SDK expects to call it — see
 * `runtime-factory.ts`, which retains this same handle for `app.ts`'s
 * shutdown path.
 */

import { createCodexProvider, type CodexProvider } from '@relvo-labs/agent-provider-codex';

export const CODEX_REAL_PROVIDER_ID = 'codex';

export type CodexRealProviderOptions = {
  /** Overrides the executable resolved from `PATH` (`codex` by default). */
  readonly executable?: string;
};

export function createCodexRealProvider(options: CodexRealProviderOptions = {}): CodexProvider {
  return createCodexProvider({
    // Conservative default posture (see the issue's security defaults):
    // Codex's own execution policy, not a runtime sandbox guarantee.
    sandboxMode: 'read-only',
    clientName: 'relvo_reference_app',
    ...(options.executable === undefined ? {} : { executable: options.executable }),
  });
}
