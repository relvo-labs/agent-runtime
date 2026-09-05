/**
 * `@relvo-labs/agent-workspace` — workspace SPI and the local-filesystem
 * implementation.
 *
 * The invariant this package exists to hold: a directory the caller gave us is
 * borrowed, and borrowed directories are never destroyed.
 */

export type { WorkspaceLease, WorkspaceProvider } from './spi.ts';

export { createLocalWorkspaceProvider, type LocalWorkspaceProviderOptions } from './local.ts';

export {
  assertRemovable,
  checkRemovable,
  isStrictlyInside,
  resolveRealPath,
  type RemovalRequest,
  type RemovalRefusal,
} from './safety.ts';
