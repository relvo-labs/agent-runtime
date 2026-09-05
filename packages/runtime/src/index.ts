/**
 * `@relvo-labs/agent-runtime` — the composition root.
 *
 * Imports neutral SPIs only. It must never depend on a concrete provider
 * adapter; `pnpm dag:check` fails the build if that ever changes.
 */

export { createAgentRuntime, type AgentRuntime, type AgentRuntimeOptions } from './runtime.ts';

export {
  createInMemoryStore,
  type RuntimeStore,
  type StoreTransaction,
  type CommitResult,
  type SessionRecord,
  type ReceiptRecord,
  type EmitInput,
  type InMemoryStoreOptions,
} from './store.ts';

export { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export { createSubscriptionHub, type SubscriptionHub, type SubscriptionHubOptions } from './subscriptions.ts';

export { applyEvent } from './projection.ts';

// Re-exported so a consumer can program against the executor contract without
// also depending on `@relvo-labs/agent-executor` directly.
export type { AgentExecutor, EventSubscription } from '@relvo-labs/agent-executor';
