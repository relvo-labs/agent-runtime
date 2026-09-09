/**
 * The credential-free default lane.
 *
 * `createScriptedProvider` is `@relvo-labs/agent-provider`'s public deterministic
 * test double, driven through the real `AgentExecutor`/runtime the same as any
 * other provider. It never makes a model or network call; every "run" is a
 * fixed, data-described script advanced by explicitly calling the controller's
 * `drain()` — never by a timer and never by this app fabricating an event.
 *
 * `providerId` is deliberately not `scripted` (the package's own default) so
 * the UI's provider badge cannot be mistaken for a real adapter's identifier.
 */

import { createScriptedProvider, type ScriptedController, type ScriptStep } from '@relvo-labs/agent-provider/testing';
import type { AgentProvider } from '@relvo-labs/agent-provider';

export const SCRIPTED_PROVIDER_ID = 'scripted-demo';

const DEFAULT_SCRIPT: readonly ScriptStep[] = [
  {
    kind: 'diagnostic',
    level: 'info',
    message: 'scripted demo — no model or provider network call is made for this run',
  },
  { kind: 'delta', text: 'Scripted demo provider received your message.\n' },
  { kind: 'tool', toolName: 'demo_echo', phase: 'invoked', detail: {} },
  { kind: 'delta', text: 'It cannot answer questions — it only proves this application, the ' },
  { kind: 'delta', text: 'runtime, and the transport are wired together end to end.' },
  { kind: 'tool', toolName: 'demo_echo', phase: 'succeeded', detail: {} },
  { kind: 'usage', usage: { inputTokens: 12, outputTokens: 24, totalTokens: 36 } },
  { kind: 'succeed' },
];

export type ScriptedDemoProvider = {
  readonly providerId: typeof SCRIPTED_PROVIDER_ID;
  readonly provider: AgentProvider;
  readonly controller: ScriptedController;
};

export function createScriptedDemoProvider(): ScriptedDemoProvider {
  const { provider, controller } = createScriptedProvider({
    providerId: SCRIPTED_PROVIDER_ID,
    defaultScript: DEFAULT_SCRIPT,
    // Approval/question bridging and recovery/resume are not claims this
    // minimal script may make (see the issue's capability-honesty section).
    supportsApproval: false,
    supportsQuestion: false,
    supportsRecovery: false,
    interruptMode: 'immediate',
  });
  return { providerId: SCRIPTED_PROVIDER_ID, provider, controller };
}
