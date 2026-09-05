/**
 * `@relvo-labs/agent-provider` — the neutral provider SPI.
 *
 * The runtime depends on this package. It must never depend on a concrete
 * adapter, so nothing here may import one.
 *
 * The deterministic scripted provider used by tests lives behind the
 * `@relvo-labs/agent-provider/testing` subpath so it cannot be pulled into a
 * production bundle by accident.
 */

export type {
  AgentProvider,
  ProviderSession,
  ProviderRun,
  ProviderRunRequest,
  ProviderSessionInit,
  ProviderEventSink,
  ProviderWorkspaceView,
  ProviderRecoveryRecord,
} from './spi.ts';

export { ProviderRejection, isProviderRejection } from './spi.ts';

export {
  defineProviderDescriptor,
  canInterruptRun,
  canRaiseApproval,
  canAcceptWorkspace,
  interruptPreservesSession,
  checkWireCompatibility,
  type CapabilityCheck,
} from './descriptor.ts';
