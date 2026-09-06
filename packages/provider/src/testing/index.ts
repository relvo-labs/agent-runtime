/**
 * `@relvo-labs/agent-provider/testing` — deterministic provider doubles.
 *
 * Nothing here is a production adapter. This subpath exists so contract tests
 * never need a model provider, an API key or a network call, which is what
 * makes the canonical gate credential-free.
 */

export {
  createScriptedProvider,
  type ScriptStep,
  type ScriptedController,
  type ScriptedProviderOptions,
} from './scripted.ts';
