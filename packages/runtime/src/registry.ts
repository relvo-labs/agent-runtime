/**
 * Provider registry.
 *
 * The runtime knows providers only by id and descriptor. It never imports a
 * concrete adapter — registration is the caller's job, which is what keeps the
 * dependency arrow pointing the right way and what `pnpm dag:check` enforces.
 */

import {
  AgentRuntimeError,
  ProviderDescriptorSchema,
  agentError,
  type ProviderDescriptor,
} from '@relvo-labs/agent-protocol';
import { checkWireCompatibility, type AgentProvider } from '@relvo-labs/agent-provider';

export type ProviderRegistry = {
  register(provider: AgentProvider): void;
  get(providerId: string): AgentProvider;
  descriptor(providerId: string): ProviderDescriptor;
  has(providerId: string): boolean;
  descriptors(): readonly ProviderDescriptor[];
};

export function createProviderRegistry(initial: readonly AgentProvider[] = []): ProviderRegistry {
  const providers = new Map<string, { readonly provider: AgentProvider; readonly descriptor: ProviderDescriptor }>();

  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const entry of Object.values(value)) deepFreeze(entry);
      Object.freeze(value);
    }
    return value;
  }

  function requireEntry(providerId: string) {
    const entry = providers.get(providerId);
    if (!entry) {
      throw new AgentRuntimeError(
        agentError('provider_not_registered', `no provider registered as \`${providerId}\``, {
          details: { providerId, registered: [...providers.keys()] },
        }),
      );
    }
    return entry;
  }

  const registry: ProviderRegistry = {
    register(provider: AgentProvider): void {
      let described: unknown;
      try {
        described = provider.describe();
      } catch (error) {
        throw new AgentRuntimeError(
          agentError('provider_contract_violation', 'provider describe() threw during registration'),
          { cause: error },
        );
      }
      const parsed = ProviderDescriptorSchema.safeParse(described);
      if (!parsed.success) {
        throw new AgentRuntimeError(
          agentError(
            'provider_contract_violation',
            `provider descriptor is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
          ),
        );
      }
      const descriptor = deepFreeze(parsed.data);

      // Reject an incompatible adapter at registration rather than at the first
      // run, when a user is already waiting.
      const compatibility = checkWireCompatibility(descriptor);
      if (!compatibility.ok) throw new AgentRuntimeError(compatibility.error);

      if (providers.has(descriptor.providerId)) {
        throw new AgentRuntimeError(
          agentError('invalid_request', `provider \`${descriptor.providerId}\` is already registered`),
        );
      }
      providers.set(descriptor.providerId, { provider, descriptor });
    },

    get(providerId: string): AgentProvider {
      return requireEntry(providerId).provider;
    },

    descriptor: (providerId: string) => requireEntry(providerId).descriptor,

    has: (providerId: string) => providers.has(providerId),

    descriptors: () => [...providers.values()].map((entry) => entry.descriptor),
  };

  for (const provider of initial) registry.register(provider);
  return registry;
}
