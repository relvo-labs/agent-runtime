import { EXECUTOR_CONFORMANCE_CASES, type AgentExecutor } from '@relvo-labs/agent-executor';
import {
  WIRE_VERSION,
  createCounterIdFactory,
  createFixedClock,
  checkResponseAgainstRequest,
  CommandIdSchema,
  InteractionIdSchema,
  QuestionSetRequestSchema,
  QuestionSetResponseSchema,
  type CommandReceipt,
  type InteractionResponse,
  type QuestionAnswer,
  type QuestionItem,
  type QuestionSetRequest,
  type QuestionSetResponse,
  type SessionId,
  type WorkspaceLeaseDescriptor,
  type WorkspaceSpec,
} from '@relvo-labs/agent-protocol';
import {
  ProviderRunTerminationSchema,
  canAskQuestionSet,
  defineProviderDescriptor,
  type AgentProvider,
  type CapabilityCheck,
  type ProviderRunTermination,
} from '@relvo-labs/agent-provider';
import {
  CLAUDE_ADAPTER_STATUS,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_AGENT_SDK_PACKAGE,
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_QUESTION_TOOL,
  ClaudePermissionModeSchema,
  ClaudeSessionOptionsSchema,
  createClaudeProvider,
  type ClaudeAskUserQuestionInput,
  type ClaudeCanUseTool,
  type ClaudeInterruptReceipt,
  type ClaudeMessageUuid,
  type ClaudePermissionMode,
  type ClaudePermissionResult,
  type ClaudeProviderFactory,
  type ClaudeProviderOptions,
  type ClaudePromptMessage,
  type ClaudeQuery,
  type ClaudeQueryHandle,
  type ClaudeQueryMessage,
  type ClaudeQueryParams,
  type ClaudeSessionOptions,
  type ClaudeToolPermissionRequest,
} from '@relvo-labs/agent-provider-claude';
import {
  CODEX_ADAPTER_STATUS,
  CODEX_BRIDGED_QUESTION,
  CODEX_ADAPTER_VERSION,
  CODEX_APP_SERVER_ARGV,
  CODEX_APP_SERVER_VERSION,
  CODEX_DEFAULT_EXECUTABLE,
  CODEX_PROVIDER_ID,
  CodexSandboxModeSchema,
  CodexSessionOptionsSchema,
  createCodexProvider,
  createCodexStdioTransport,
  type CodexAbandonedConnectionReport,
  type CodexClientMessage,
  type CodexProvider,
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
    //
    // WARNING — do not copy this `for await` into a runnable walkthrough or a
    // real interactive session. This fixture exists only so the compiler can
    // check `ClaudeQuery`'s shape here; it is never actually iterated by this
    // file (see `tools/repo/check-artifacts.ts`, which only typechecks this
    // example). Draining `params.prompt` to completion before replying is
    // safe ONLY because that iterable happens to end after one message in
    // this fixture. A real streaming-input session's prompt iterable stays
    // open across every subsequent turn and does not end until the session
    // itself closes — awaiting its end before the FIRST reply would hang a
    // real multi-turn session forever. A real query implementation must
    // reply per received message instead, exactly as the official Claude
    // Agent SDK's own `query()` does (the default this app binds by omitting
    // `query` — see `examples/reference-app`).
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
  // Opt in to the host approval bridge: tool prompts the SDK cannot decide on
  // its own become neutral `approval` interactions this host settles through
  // `respondToInteraction`. Omit it and the adapter declares no approval
  // capability, exactly as before.
  approvals: 'bridge',
  // Opt in to the host question bridge: `AskUserQuestion` becomes a neutral
  // `question_set` interaction this host answers, and the same run resumes.
  questions: 'bridge',
};

/**
 * A host may also drive the SDK's permission callback itself — the seam is a
 * named public type, so an answer of the wrong shape fails to compile here.
 */
const hostPermissionCallback: ClaudeCanUseTool = (
  toolName: string,
  _input: Record<string, unknown>,
  request: ClaudeToolPermissionRequest,
): Promise<ClaudePermissionResult> => {
  const decision: ClaudePermissionResult = request.signal.aborted
    ? { behavior: 'deny', message: 'the session is shutting down' }
    : toolName === 'Read'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'not authorised by this host' };
  return Promise.resolve(decision);
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
// The factory type still yields the neutral SPI, but the concrete adapter also
// exposes its own cleanup ownership: a handshake whose teardown failed leaves a
// connection that only this object can still release.
const codexAdapter: CodexProvider = createCodexProvider(codexOptions);
const abandonedCodexConnections: number = codexAdapter.abandonedConnectionCount;

async function releaseAbandonedCodexConnections(): Promise<CodexAbandonedConnectionReport> {
  const report: CodexAbandonedConnectionReport = await codexAdapter.releaseAbandonedConnections();
  return report;
}
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

// ---------------------------------------------------------------------------
// Structured questions (ADR-0018)
// ---------------------------------------------------------------------------

/**
 * A host renders a batch and answers it as one unit.
 *
 * The answer is keyed by the request's own `key`, never by array position, and
 * the whole batch is answered or none of it is. `checkResponseAgainstRequest`
 * is the same check the runtime applies before any provider is touched, so a
 * host can validate its own form before submitting a command.
 */
const questionBatch: QuestionSetRequest = QuestionSetRequestSchema.parse({
  kind: 'question_set',
  questions: [
    {
      key: 'q1',
      prompt: 'Which database should the service use?',
      header: 'Database',
      choices: [
        { value: 'o1', label: 'PostgreSQL', description: 'Relational' },
        { value: 'o2', label: 'SQLite', description: 'Embedded' },
      ],
      allowFreeText: true,
    },
    { key: 'q2', prompt: 'Paste the deploy token', sensitive: true },
  ],
});

/** Collecting one answer per question, in the shape the contract requires. */
function answerFor(question: QuestionItem): QuestionAnswer {
  const first = question.choices?.[0];
  return first === undefined
    ? { type: 'text', text: 'typed by the user' }
    : { type: 'selection', values: [first.value] };
}

const questionAnswers: QuestionSetResponse = QuestionSetResponseSchema.parse({
  kind: 'question_set',
  answers: Object.fromEntries(questionBatch.questions.map((question) => [question.key, answerFor(question)])),
});

/** `undefined` means the batch is answered completely and validly. */
const questionMismatch: string | undefined = checkResponseAgainstRequest(questionBatch, questionAnswers);

/** A host submits it as an ordinary command, narrowed by the response union. */
async function answerQuestions(sessionId: SessionId): Promise<CommandReceipt> {
  const response: InteractionResponse = questionAnswers;
  return claudeRuntime.respondToInteraction({
    type: 'respond_to_interaction',
    commandId: CommandIdSchema.parse('claude-consumer-answer-1'),
    sessionId,
    interactionId: InteractionIdSchema.parse('int_0000000000000001'),
    response,
  });
}

/** Capability gating before a host offers a batch surface at all. */
const batchSupported: CapabilityCheck = canAskQuestionSet(claude.describe(), questionBatch.questions.length);

/**
 * The Claude question seam is a named public type, so a host that drives
 * `canUseTool` itself answers `AskUserQuestion` with the pinned route and gets
 * a compile error if the shape is wrong.
 */
const askUserQuestionHandler: ClaudeCanUseTool = (toolName, input, request) => {
  if (toolName !== CLAUDE_QUESTION_TOOL || request.signal.aborted) {
    return Promise.resolve({ behavior: 'deny', message: 'not answerable by this host' });
  }
  const questions = (input as unknown as ClaudeAskUserQuestionInput).questions;
  const answers: Record<string, string> = {};
  for (const question of questions) answers[question.question] = question.options[0]?.label ?? '';
  return Promise.resolve({ behavior: 'allow', updatedInput: { questions, answers } });
};

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
void abandonedCodexConnections;
void releaseAbandonedCodexConnections;
void CLAUDE_ADAPTER_STATUS;
void CLAUDE_ADAPTER_VERSION;
void CLAUDE_AGENT_SDK_PACKAGE;
void CLAUDE_AGENT_SDK_VERSION;
void claudePermissionMode;
void hostPermissionCallback;
void runClaudeTurn;
void claudeRuntime;
void claudeSessionOptions;
void questionMismatch;
void answerQuestions;
void batchSupported;
void askUserQuestionHandler;
void CODEX_BRIDGED_QUESTION;
