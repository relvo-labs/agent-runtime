import { EXECUTOR_CONFORMANCE_CASES, type AgentExecutor } from '@relvo-labs/agent-executor';
import {
  WIRE_VERSION,
  createCounterIdFactory,
  createFixedClock,
  CommandIdSchema,
  type CommandReceipt,
  type SessionId,
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
  type ClaudeInterruptReceipt,
  type ClaudeMessageUuid,
  type ClaudePermissionMode,
  type ClaudeProviderFactory,
  type ClaudeProviderOptions,
  type ClaudePromptMessage,
  type ClaudeQuery,
  type ClaudeQueryHandle,
  type ClaudeQueryMessage,
  type ClaudeQueryParams,
  type ClaudeSessionOptions,
} from '@relvo-labs/agent-provider-claude';
import {
  CODEX_ADAPTER_STATUS,
  CODEX_ADAPTER_VERSION,
  CODEX_APP_SERVER_ARGV,
  CODEX_APP_SERVER_VERSION,
  CODEX_DEFAULT_EXECUTABLE,
  CODEX_PROVIDER_ID,
  CodexSandboxModeSchema,
  CodexSessionOptionsSchema,
  createCodexProvider,
  createCodexStdioTransport,
  type CodexClientMessage,
  type CodexProviderFactory,
  type CodexProviderOptions,
  type CodexRequestId,
  type CodexSandboxMode,
  type CodexSessionOptions,
  type CodexStdioTransportConfig,
  type CodexTransport,
  type CodexTransportFactory,
  type CodexTransportParams,
  type CodexWireError,
} from '@relvo-labs/agent-provider-codex';
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
const scriptedClaudeQuery: ClaudeQuery = (params: ClaudeQueryParams): ClaudeQueryHandle => ({
  async *[Symbol.asyncIterator]() {
    void params.options.cwd;
    // Correlate the reply with the message the adapter submitted, exactly as
    // the SDK does. `uuid` is optional on the wire, so narrow it first.
    const submitted: ClaudePromptMessage[] = [];
    for await (const message of params.prompt) submitted.push(message);
    const uuid: ClaudeMessageUuid | undefined = submitted[0]?.uuid;
    const result: ClaudeQueryMessage = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      ...(uuid === undefined ? {} : { user_message_uuid: uuid }),
    };
    yield result;
  },
  interrupt: (): Promise<ClaudeInterruptReceipt> => Promise.resolve({ still_queued: [] }),
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

/** A host drives the adapter through the executor contract it already has. */
async function runClaudeTurn(sessionId: SessionId): Promise<CommandReceipt> {
  return claudeRuntime.submitTurn({
    type: 'submit_turn',
    commandId: CommandIdSchema.parse('claude-consumer-turn-1'),
    sessionId,
    input: { parts: [{ type: 'text', text: 'summarise this repository' }] },
  });
}

// A host composes the Codex adapter the same way. Omit `transport` to spawn
// `codex app-server --stdio`, or inject one — the seam is a named public type,
// so a wrong shape fails to compile here.
const scriptedCodexTransport: CodexTransport = {
  send: (message: CodexClientMessage): void => {
    // Outbound frames are typed, and never carry a `jsonrpc` member.
    void ('method' in message ? message.method : message.id);
  },
  incoming: {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      // A terminating fake: it ends immediately rather than hanging a consumer.
      yield { method: 'thread/started', params: { thread: { id: 'thread-1' } } };
    },
  },
  close: (): Promise<void> => Promise.resolve(),
};
const codexTransportFactory: CodexTransportFactory = (params: CodexTransportParams): CodexTransport => {
  void params.cwd;
  return scriptedCodexTransport;
};
const codexOptions: CodexProviderOptions = {
  sandboxMode: 'read-only',
  clientName: 'consumer_smoke',
  transport: codexTransportFactory,
};
const codexFactory: CodexProviderFactory = createCodexProvider;
const codex: AgentProvider = codexFactory(codexOptions);
const codexRuntime: AgentExecutor = createAgentRuntime({ workspaces, providers: [codex] });
const codexSessionOptions: CodexSessionOptions = CodexSessionOptionsSchema.parse({ sandboxMode: 'workspace-write' });
const codexSandboxMode: CodexSandboxMode = CodexSandboxModeSchema.parse('read-only');
const codexRequestId: CodexRequestId = 1;
const codexWireError: CodexWireError = { code: -32601, message: 'method not supported by this client' };
const codexTransportConfig: CodexStdioTransportConfig = {
  executable: CODEX_DEFAULT_EXECUTABLE,
  closeGraceMs: 2000,
};

/** The production transport is public too, for a host that owns the process. */
function openCodexTransport(cwd: string): CodexTransport {
  return createCodexStdioTransport({ cwd }, codexTransportConfig);
}

/** A host drives the Codex adapter through the executor contract it already has. */
async function runCodexTurn(sessionId: SessionId): Promise<CommandReceipt> {
  return codexRuntime.submitTurn({
    type: 'submit_turn',
    commandId: CommandIdSchema.parse('codex-consumer-turn-1'),
    sessionId,
    input: { parts: [{ type: 'text', text: 'summarise this repository' }] },
  });
}

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
void CODEX_ADAPTER_VERSION;
void CODEX_APP_SERVER_ARGV;
void CODEX_APP_SERVER_VERSION;
void CODEX_PROVIDER_ID;
void codexSessionOptions;
void codexSandboxMode;
void codexRequestId;
void codexWireError;
void openCodexTransport;
void runCodexTurn;
void CLAUDE_ADAPTER_STATUS;
void CLAUDE_ADAPTER_VERSION;
void CLAUDE_AGENT_SDK_PACKAGE;
void CLAUDE_AGENT_SDK_VERSION;
void claudePermissionMode;
void runClaudeTurn;
void claudeRuntime;
void claudeSessionOptions;
