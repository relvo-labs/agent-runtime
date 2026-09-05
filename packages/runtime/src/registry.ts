/**
 * Provider registry.
 *
 * The runtime knows providers only by id and descriptor. It never imports a
 * concrete adapter — registration is the caller's job, which is what keeps the
 * dependency arrow pointing the right way and what `pnpm dag:check` enforces.
 */

import { AgentRuntimeError, agentError, type ProviderDescriptor } from '@relvo-labs/agent-protocol';
import { checkWireCompatibility, type AgentProvider } from '@relvo-labs/agent-provider';

export type ProviderRegistry = {
  register(provider: AgentProvider): void;
  get(providerId: string): AgentProvider;
  has(providerId: string): boolean;
  descriptors(): readonly ProviderDescriptor[];
};

export function createProviderRegistry(initial: readonly AgentProvider[] = []): ProviderRegistry {
  const providers = new Map<string, AgentProvider>();

  const registry: ProviderRegistry = {
    register(provider: AgentProvider): void {
      const descriptor = provider.describe();

      // Reject an incompatible adapter at registration rather than at the first
      // run, when a user is already waiting.
      const compatibility = checkWireCompatibility(descriptor);
      if (!compatibility.ok) throw new AgentRuntimeError(compatibility.error);

      if (providers.has(descriptor.providerId)) {
        throw new AgentRuntimeError(
          agentError('invalid_request', `provider \`${descriptor.providerId}\` is already registered`),
        );
      }
      providers.set(descriptor.providerId, provider);
    },

    get(providerId: string): AgentProvider {
      const provider = providers.get(providerId);
      if (!provider) {
        throw new AgentRuntimeError(
          agentError('provider_not_registered', `no provider registered as \`${providerId}\``, {
            details: { providerId, registered: [...providers.keys()] },
          }),
        );
      }
      return provider;
    },

    has: (providerId: string) => providers.has(providerId),

    descriptors: () => [...providers.values()].map((provider) => provider.describe()),
  };

  for (const provider of initial) registry.register(provider);
  return registry;
}
