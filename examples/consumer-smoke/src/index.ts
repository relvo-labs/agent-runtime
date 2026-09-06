import { EXECUTOR_CONFORMANCE_CASES, type AgentExecutor } from '@relvo-labs/agent-executor';
import {
  WIRE_VERSION,
  createCounterIdFactory,
  createFixedClock,
  type WorkspaceLeaseDescriptor,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRunTerminationSchema,
  defineProviderDescriptor,
  type AgentProvider,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';
import {
  CLAUDE_ADAPTER_STATUS,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudePermissionModeSchema,
  ClaudeSessionOptionsSchema,
  createClaudeProvider,
  type ClaudePermissionMode,
  type ClaudeProviderFactory,
  type ClaudeProviderOptions,
  type ClaudeQuery,
  type ClaudeSessionOptions,
} from '@relvo-labs/agent-provider-claude';
import { CODEX_ADAPTER_STATUS } from '@relvo-labs/agent-provider-codex';
import { createAgentRuntime } from '@relvo-labs/agent-runtime';
import { createLocalWorkspaceProvider, validateWorkspaceLease, type WorkspaceLease } from '@relvo-labs/agent-workspace';
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
async function validateExternalLease(spec: WorkspaceSpec, lease: WorkspaceLease): Promise<WorkspaceLeaseDescriptor> {
  return validateWorkspaceLease(spec, lease);
}

// A host composes the Claude adapter itself; the runtime never imports it.
// Either bind the official SDK by omitting `query`, or inject one — the seam is
// a named public type, so a wrong shape fails to compile here.
const scriptedClaudeQuery: ClaudeQuery = ({ options }) => ({
  async *[Symbol.asyncIterator]() {
    void options.cwd;
    yield { type: 'result', subtype: 'success', is_error: false };
  },
  interrupt: () => Promise.resolve(undefined),
});
const claudeOptions: ClaudeProviderOptions = {
  model: 'claude-sonnet-4-6',
  permissionMode: 'acceptEdits',
  query: scriptedClaudeQuery,
};
const claudeFactory: ClaudeProviderFactory = createClaudeProvider;
const claude: AgentProvider = claudeFactory(claudeOptions);
const claudeRuntime: AgentExecutor = createAgentRuntime({ workspaces, providers: [claude] });
const claudeSessionOptions: ClaudeSessionOptions = ClaudeSessionOptionsSchema.parse({ maxTurns: 4 });
const claudePermissionMode: ClaudePermissionMode = ClaudePermissionModeSchema.parse('plan');

assertReadOnly(['status', '--short']);
void runtime;
void descriptor;
void provider;
void termination;
void READ_ONLY_GIT_COMMANDS;
void gitRunner;
void validateExternalLease;
void EXECUTOR_CONFORMANCE_CASES;
void WIRE_VERSION;
void CODEX_ADAPTER_STATUS;
void CLAUDE_ADAPTER_STATUS;
void CLAUDE_ADAPTER_VERSION;
void CLAUDE_AGENT_SDK_PACKAGE;
void CLAUDE_AGENT_SDK_VERSION;
void claudePermissionMode;
void claudeRuntime;
void claudeSessionOptions;
