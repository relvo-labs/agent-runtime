import { EXECUTOR_CONFORMANCE_CASES, type AgentExecutor } from '@relvo-labs/agent-executor';
import { WIRE_VERSION, createCounterIdFactory, createFixedClock } from '@relvo-labs/agent-protocol';
import {
  ProviderRunTerminationSchema,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';
import { CLAUDE_ADAPTER_STATUS } from '@relvo-labs/agent-provider-claude';
import { CODEX_ADAPTER_STATUS } from '@relvo-labs/agent-provider-codex';
import { createAgentRuntime } from '@relvo-labs/agent-runtime';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';
import { READ_ONLY_GIT_COMMANDS, assertReadOnly, type GitRunner } from '@relvo-labs/agent-workspace-git';

const clock = createFixedClock();
const idFactory = createCounterIdFactory();
const workspaces = createLocalWorkspaceProvider({ baseDirectory: '/tmp/relvo-consumer-smoke', clock, idFactory });
const runtime: AgentExecutor = createAgentRuntime({ workspaces });
const descriptor = defineProviderDescriptor({
  providerId: 'consumer-fixture',
  providerVersion: '0.1.0',
  displayName: 'Consumer fixture',
  run: { interrupt: { mode: 'unsupported' }, streaming: {} },
  interaction: { approval: {}, question: {} },
  workspace: { requires: 'directory' },
  recovery: {},
});
const provider: AgentProvider | undefined = undefined;
const termination: ProviderRunTermination = ProviderRunTerminationSchema.parse({ outcome: 'succeeded' });
const gitRunner: GitRunner = (command) => Promise.resolve({ exitCode: 0, stdout: command.argv.join(' '), stderr: '' });

assertReadOnly(['status', '--short']);
void runtime;
void descriptor;
void provider;
void termination;
void READ_ONLY_GIT_COMMANDS;
void gitRunner;
void EXECUTOR_CONFORMANCE_CASES;
void WIRE_VERSION;
void CODEX_ADAPTER_STATUS;
void CLAUDE_ADAPTER_STATUS;
