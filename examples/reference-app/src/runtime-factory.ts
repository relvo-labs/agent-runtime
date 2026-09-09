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
import type { AgentProvider } from '@relvo-labs/agent-provider';

import { createScriptedDemoProvider, SCRIPTED_PROVIDER_ID } from './providers/scripted.ts';
import { createCodexRealProvider } from './providers/codex.ts';
import { createClaudeRealProvider } from './providers/claude.ts';
import { createSessionAdmission, type SessionAdmission } from './session-admission.ts';

export type ReferenceAppRuntime = {
  readonly runtime: AgentRuntime;
  readonly workspaces: WorkspaceProvider;
  readonly sessionAdmission: SessionAdmission;
  /** The one provider id this app knows how to manually pace (see below). */
  readonly scriptedDemoProviderId: string;
  /**
   * Advance the scripted-demo provider's script by one full pass.
   *
   * The scripted provider never produces an event on its own — that is the
   * whole point of a deterministic double — so nothing calls this except an
   * explicit, user-visible action (the UI's "Advance script" control, or a
   * test). It is never called automatically after `submit_turn`/
   * `interrupt_run`: doing so would let a run reach a terminal state before
   * an HTTP response even returns, making genuine in-flight interruption
   * impossible to demonstrate through the transport. A real provider profile
   * (Codex, Claude) paces itself and never needs this; this is a no-op if no
   * scripted-demo session is open.
   */
  readonly advanceScriptedDemo: () => Promise<void>;
};

export type ReferenceAppRuntimeOptions = {
  readonly workspaceBaseDirectory: string;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
  /** Test-only seam: inject a failing/instrumented directory removal. */
  readonly removeDirectory?: (path: string) => Promise<void>;
  /** Opt-in real provider profiles. Absent (the default) registers neither. */
  readonly realProviders?: {
    readonly codex?: { readonly executable?: string };
    readonly claude?: { readonly model?: string };
  };
};

export function createReferenceAppRuntime(options: ReferenceAppRuntimeOptions): ReferenceAppRuntime {
  const clock = options.clock ?? createSystemClock();
  const idFactory = options.idFactory ?? createCounterIdFactory();

  const workspaces = createLocalWorkspaceProvider({
    baseDirectory: options.workspaceBaseDirectory,
    clock,
    idFactory,
    ...(options.removeDirectory === undefined ? {} : { removeDirectory: options.removeDirectory }),
  });

  const scripted = createScriptedDemoProvider();
  const providers: AgentProvider[] = [scripted.provider];

  if (options.realProviders?.codex) {
    providers.push(createCodexRealProvider(options.realProviders.codex));
  }
  if (options.realProviders?.claude) {
    providers.push(createClaudeRealProvider(options.realProviders.claude));
  }

  const runtime = createAgentRuntime({
    workspaces,
    providers,
    clock,
    idFactory,
  });

  return {
    runtime,
    workspaces,
    sessionAdmission: createSessionAdmission(),
    scriptedDemoProviderId: SCRIPTED_PROVIDER_ID,
    advanceScriptedDemo: async () => {
      await scripted.controller.drain();
      // `drain()` only resolves the provider's own completion promise; the
      // runtime's own commit of that outcome (run.finished, turn.settled) is
      // a separate, asynchronous continuation. `quiesce()` is the SDK's own
      // documented seam for "everything that was going to happen, happened" —
      // without it, a caller reading the snapshot immediately afterwards
      // could still observe the run as non-terminal.
      await runtime.quiesce();
    },
  };
}
