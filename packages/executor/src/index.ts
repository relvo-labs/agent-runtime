/**
 * `@relvo-labs/agent-executor` — the consumer-facing contract and its
 * conformance kit.
 *
 * This package intentionally contains no implementation. It is what a host
 * application programs against and what an alternative executor must satisfy,
 * so that swapping the implementation is a dependency change rather than a
 * rewrite.
 */

export type { AgentExecutor, EventSubscription } from './executor.ts';

export {
  EXECUTOR_CONFORMANCE_CASES,
  ConformanceFailure,
  conformanceCase,
  type ConformanceCase,
  type ConformanceHarness,
} from './conformance.ts';
