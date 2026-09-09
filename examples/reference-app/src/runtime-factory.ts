/**
 * Composition root for this application.
 *
 * This is the one place the app imports the SDK's composition pieces and
 * assembles a single `AgentRuntime` instance — exactly what a consumer does.
 * `@relvo-labs/agent-runtime` never depends on a concrete provider; this
 * module is where that neutral composition happens instead.
 */

import { createSystemClock, createCounterIdFactory, type Clock, type IdFactory } from '@relvo-labs/agent-protocol';
import { createAgentRuntime, type AgentRuntime } from '@relvo-labs/agent-runtime';
import { createLocalWorkspaceProvider, type WorkspaceProvider } from '@relvo-labs/agent-workspace';

import { createScriptedDemoProvider } from './providers/scripted.ts';

export type ReferenceAppRuntime = {
  readonly runtime: AgentRuntime;
  readonly workspaces: WorkspaceProvider;
  /**
   * Advance every registered scripted-demo provider until it is quiescent.
   *
   * The scripted provider never produces an event on its own — that is the
   * whole point of a deterministic double. This app calls this exactly once,
   * right after a command that could make a run progress (`submit_turn`,
   * `interrupt_run`, `respond_to_interaction`), so the transport never needs a
   * poll loop or a timer to observe the outcome. A provider that is a real
   * adapter (Codex, Claude) paces itself and needs no such call; this is a
   * no-op once no scripted-demo session remains open.
   */
  readonly advanceScriptedProviders: () => Promise<void>;
};

export type ReferenceAppRuntimeOptions = {
  readonly workspaceBaseDirectory: string;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
};

export function createReferenceAppRuntime(options: ReferenceAppRuntimeOptions): ReferenceAppRuntime {
  const clock = options.clock ?? createSystemClock();
  const idFactory = options.idFactory ?? createCounterIdFactory();

  const workspaces = createLocalWorkspaceProvider({
    baseDirectory: options.workspaceBaseDirectory,
    clock,
    idFactory,
  });

  const scripted = createScriptedDemoProvider();

  const runtime = createAgentRuntime({
    workspaces,
    providers: [scripted.provider],
    clock,
    idFactory,
  });

  return {
    runtime,
    workspaces,
    advanceScriptedProviders: () => scripted.controller.drain(),
  };
}
