/**
 * The production default binding.
 *
 * `@anthropic-ai/claude-agent-sdk` is an **optional peer dependency**, resolved
 * at runtime rather than imported statically. That is a deliberate packaging
 * decision, not a way to avoid depending on it:
 *
 *   - the SDK is published under Anthropic's proprietary terms, and this
 *     repository may only ship runtime dependencies under permissive licences
 *     (`tools/repo/check-licenses.ts`);
 *   - its platform payload is a ~200 MB native binary, which every consumer of
 *     the package — including those injecting their own `query` — would
 *     otherwise be forced to download;
 *   - a host that already manages the SDK can pass its own `query` instead, and
 *     the adapter takes the identical code path.
 *
 * Removal cost is therefore one function: nothing else in this package names
 * the SDK, and no type in the published surface is derived from it.
 */

import { agentError } from '@relvo-labs/agent-protocol';
import { ProviderRejection } from '@relvo-labs/agent-provider';

import type { ClaudeQuery } from './seam.ts';

/** The npm package that provides the default `query` implementation. */
export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * How a module is resolved. Injected in tests so both branches — bound and
 * unavailable — are deterministic without installing a proprietary package.
 */
export type ClaudeModuleLoader = (specifier: string) => Promise<unknown>;

const importModule: ClaudeModuleLoader = async (specifier: string): Promise<unknown> => {
  // A non-literal specifier keeps this a runtime resolution: the peer is not
  // present in this workspace and must not be a compile-time requirement.
  return (await import(specifier)) as unknown;
};

function unavailable(reason: string): ProviderRejection {
  return new ProviderRejection(
    agentError('provider_unavailable', `${reason}; install \`${CLAUDE_AGENT_SDK_PACKAGE}\` alongside this adapter`, {
      details: { package: CLAUDE_AGENT_SDK_PACKAGE },
    }),
  );
}

/**
 * Resolve the official `query` export.
 *
 * Failure is a typed, retryable `provider_unavailable` rejection: a missing
 * peer is an environment problem the host can fix, not a contract violation.
 */
export async function loadClaudeQuery(load: ClaudeModuleLoader = importModule): Promise<ClaudeQuery> {
  let loaded: unknown;
  try {
    loaded = await load(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    throw unavailable(`\`${CLAUDE_AGENT_SDK_PACKAGE}\` could not be loaded`);
  }
  const candidate =
    typeof loaded === 'object' && loaded !== null ? (loaded as Readonly<Record<string, unknown>>).query : undefined;
  if (typeof candidate !== 'function') {
    throw unavailable(`\`${CLAUDE_AGENT_SDK_PACKAGE}\` does not export a \`query\` function`);
  }
  return candidate as ClaudeQuery;
}
