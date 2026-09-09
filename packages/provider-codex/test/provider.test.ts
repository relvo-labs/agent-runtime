/**
 * The adapter lifecycle, end to end, with no process and no credentials.
 *
 * The properties that matter most here are the ones a log cannot show you
 * afterwards: a run settles **exactly once**, admitted work can never hang, and
 * another turn's output can never complete this one.
 */

import { describe, expect, it, vi } from 'vitest';

import { ProviderEventInputSchema, type JsonObject, type ProviderEventInput } from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { CODEX_ADAPTER_STATUS, CODEX_ADAPTER_VERSION, CODEX_PROVIDER_ID, createCodexProvider } from '../src/index.ts';
import type { CodexProviderOptions } from '../src/options.ts';
import {
  FAKE_THREAD_ID,
  FIXTURE_BEARER,
  FAKE_TURN_ID,
  agentMessageDelta,
  createFakeTransport,
  defaultResponders,
  flush,
  tokenUsage,
  turnCompleted,
  type FakeTransport,
  type Responder,
} from './fake-transport.ts';

type Sink = {
  readonly events: ProviderEventInput[];
  readonly sink: { emit(input: ProviderEventInput): void };
  texts(): string;
  ofType(type: string): ProviderEventInput[];
};

/** A sink that validates every emission against the protocol as it arrives. */
function createSink(): Sink {
  const events: ProviderEventInput[] = [];
  return {
    events,
    sink: {
      emit(input: ProviderEventInput): void {
        // The runtime parses synchronously during `emit`; anything invalid here
        // would be a provider-contract diagnostic in production.
        ProviderEventInputSchema.parse(input);
        events.push(input);
      },
    },
    texts(): string {
      return events
        .filter((event) => event.payload.type === 'run.message_delta')
        .map((event) => (event.payload as { text: string }).text)
        .join('');
    },
    ofType(type: string): ProviderEventInput[] {
      return events.filter((event) => event.payload.type === type);
    },
  };
}

type Opened = {
  readonly fake: FakeTransport;
  readonly session: ProviderSession;
  readonly sessionSink: Sink;
};

async function openSession(
  options: Omit<CodexProviderOptions, 'transport'> = {},
  responders?: Record<string, Responder>,
  sessionOptions: JsonObject = {},
): Promise<Opened> {
  const fake = createFakeTransport(responders === undefined ? {} : { responders });
  const provider = createCodexProvider({ ...options, transport: () => fake.transport });
  const sessionSink = createSink();
  const session = await provider.createSession({
    options: sessionOptions,
    workspace: { root: '/workspace', ownership: 'borrowed' },
    sink: sessionSink.sink,
  });
  return { fake, session, sessionSink };
}

async function startRun(
  session: ProviderSession,
  sink: Sink,
  text = 'summarise this repository',
): Promise<ProviderRun> {
  return session.startRun({
    input: { parts: [{ type: 'text', text }] },
    sink: sink.sink,
    runRef: 'run-ref-1',
  });
}

// ---------------------------------------------------------------------------

describe('descriptor', () => {
  it('advertises only behaviour this slice implements and tests', () => {
    const descriptor = createCodexProvider().describe();
    expect(descriptor.providerId).toBe(CODEX_PROVIDER_ID);
    expect(descriptor.providerVersion).toBe(CODEX_ADAPTER_VERSION);
    expect(descriptor.run.interrupt).toEqual({
      mode: 'cooperative',
      deliversPartialOutput: true,
      sessionRemainsUsable: true,
    });
    expect(descriptor.run.streaming).toEqual({
      messageDeltas: true,
      // Not claimed: command/file-change/MCP item payloads are not mapped.
      toolActivity: false,
      incrementalUsage: true,
    });
    expect(descriptor.run.maxConcurrentRunsPerSession).toBe(1);
    expect(descriptor.interaction.approval.supported).toBe(false);
    expect(descriptor.interaction.question.supported).toBe(false);
    expect(descriptor.recovery.exportsRecoveryRecord).toBe(false);
    expect(descriptor.workspace.requires).toBe('directory');
    expect(descriptor.extensions.protocolSurface).toBe('stable');
  });

  it('reports the package as live', () => {
    expect(CODEX_ADAPTER_STATUS).toBe('live');
  });

  it('declares `writes` even under a read-only policy, because tooling is not isolated', () => {
    // A read-only sandbox constrains Codex's own file tools. It does not bound
    // MCP servers, hooks or plugins from the user's configuration, so deriving
    // `writes: false` from it would tell a host the lease root is safe from
    // mutation when it is not.
    expect(createCodexProvider().describe().workspace.writes).toBe(true);
    expect(createCodexProvider({ sandboxMode: 'workspace-write' }).describe().workspace.writes).toBe(true);
  });

  it('reports the declared policy as intent, and denies isolating configured tooling', () => {
    expect(createCodexProvider().describe().extensions.declaredSandboxMode).toBe('read-only');
    expect(createCodexProvider({ sandboxMode: 'danger-full-access' }).describe().extensions.declaredSandboxMode).toBe(
      'danger-full-access',
    );
    expect(createCodexProvider().describe().extensions.isolatesConfiguredTooling).toBe(false);
  });

  it('exposes no recovery surface, matching the descriptor', () => {
    expect(createCodexProvider().describe().recovery.exportsRecoveryRecord).toBe(false);
  });
});

describe('handshake', () => {
  it('initializes once, acknowledges, then binds a thread to the workspace root', async () => {
    const { fake } = await openSession();

    const methods = fake.sent.map((message) => ('method' in message ? message.method : '<reply>'));
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start']);

    const initialize = fake.requests('initialize')[0];
    expect(initialize?.params).toEqual({
      clientInfo: { name: 'relvo_agent_runtime', title: 'Relvo Agent Runtime', version: CODEX_ADAPTER_VERSION },
      // `null` cannot opt into the experimental API.
      capabilities: null,
    });

    const threadStart = fake.requests('thread/start')[0];
    expect(threadStart?.params).toEqual({
      cwd: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    });
  });

  it('sends `initialized` as a bare notification with no params', async () => {
    const { fake } = await openSession();
    expect(fake.sent[1]).toEqual({ method: 'initialized' });
  });

  it('never opts into the experimental surface', async () => {
    const { fake } = await openSession();
    expect(JSON.stringify(fake.sent)).not.toContain('experimentalApi');
    expect(JSON.stringify(fake.sent)).not.toContain('requestAttestation');
  });

  it('passes host and session configuration through to `thread/start`', async () => {
    const { fake } = await openSession(
      { sandboxMode: 'workspace-write', model: 'default-model', clientName: 'acme_ide', clientVersion: '9.9.9' },
      undefined,
      { model: 'session-model' },
    );
    expect(fake.requests('thread/start')[0]?.params).toMatchObject({
      sandbox: 'workspace-write',
      // A session override beats the provider default.
      model: 'session-model',
    });
    expect(fake.requests('initialize')[0]?.params).toMatchObject({
      clientInfo: { name: 'acme_ide', version: '9.9.9' },
    });
  });

  it('rejects a relative or empty workspace root', async () => {
    const fake = createFakeTransport();
    const provider = createCodexProvider({ transport: () => fake.transport });
    for (const root of ['', 'relative/path']) {
      await expect(
        provider.createSession({
          options: {},
          workspace: { root, ownership: 'borrowed' },
          sink: createSink().sink,
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isProviderRejection(error) && error.agentError.code === 'invalid_request',
      );
    }
    // Nothing was spawned or sent for a request that never should have started.
    expect(fake.sent).toEqual([]);
  });

  it('rejects unknown session options rather than ignoring them', async () => {
    const fake = createFakeTransport();
    const provider = createCodexProvider({ transport: () => fake.transport });
    await expect(
      provider.createSession({
        options: { sandboxMode: 'read-only', unexpected: true },
        workspace: { root: '/workspace', ownership: 'borrowed' },
        sink: createSink().sink,
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderRejection(error) && error.agentError.code === 'invalid_request');
  });

  it('tears the connection down when the handshake fails, rather than leaking it', async () => {
    const responders = defaultResponders();
    delete responders['thread/start'];
    const fake = createFakeTransport({ responders });
    const provider = createCodexProvider({ transport: () => fake.transport });

    const opening = provider.createSession({
      options: {},
      workspace: { root: '/workspace', ownership: 'borrowed' },
      sink: createSink().sink,
    });
    await flush();
    fake.respondWithError('thread/start', -32603, 'nope');

    await expect(opening).rejects.toThrow();
    expect(fake.closeCalls).toBe(1);
  });

  it('fails closed when the server starts a thread without a usable id', async () => {
    const responders = defaultResponders();
    responders['thread/start'] = () => ({ thread: { cwd: '/workspace' } });
    const fake = createFakeTransport({ responders });
    const provider = createCodexProvider({ transport: () => fake.transport });

    await expect(
      provider.createSession({
        options: {},
        workspace: { root: '/workspace', ownership: 'borrowed' },
        sink: createSink().sink,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_contract_violation',
    );
    expect(fake.closeCalls).toBe(1);
  });
});

describe('a text run', () => {
  it('starts one correlated turn and streams its text to completion', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink, 'hello codex');

    expect(fake.requests('turn/start')[0]?.params).toEqual({
      threadId: FAKE_THREAD_ID,
      // `text_elements` is omitted: the stable schema defaults it to `[]`.
      input: [{ type: 'text', text: 'hello codex' }],
    });

    fake.push(agentMessageDelta('Hello'));
    fake.push(agentMessageDelta(', world'));
    fake.push(tokenUsage({ inputTokens: 11, outputTokens: 4, totalTokens: 15 }));
    fake.push(turnCompleted('completed'));

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(runSink.texts()).toBe('Hello, world');
    expect(runSink.ofType('run.usage')).toEqual([
      { payload: { type: 'run.usage', usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } } },
    ]);
  });

  it('joins multiple text parts and rejects any non-text part', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await session.startRun({
      input: {
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
      sink: runSink.sink,
      runRef: 'run-ref-1',
    });
    expect(fake.requests('turn/start')[0]?.params).toMatchObject({
      input: [{ type: 'text', text: 'first\n\nsecond' }],
    });
    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('rejects unsupported input without starting a turn', async () => {
    const { fake, session } = await openSession();
    await expect(
      session.startRun({
        input: { parts: [{ type: 'file_ref', path: 'a.txt' }] },
        sink: createSink().sink,
        runRef: 'run-ref-1',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'capability_unsupported',
    );
    expect(fake.requests('turn/start')).toEqual([]);
  });

  it('reports a failed turn with a classification, never upstream prose', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push(
      turnCompleted('failed', {
        error: {
          message: `exploded in /home/alice/project with token ${FIXTURE_BEARER}`,
          codexErrorInfo: 'unauthorized',
          additionalDetails: 'prompt text echoed back',
        },
      }),
    );

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('unreachable');
    expect(termination.error.providerCode).toBe('unauthorized');
    const serialized = JSON.stringify(termination);
    expect(serialized).not.toContain('/home/alice');
    expect(serialized).not.toContain(FIXTURE_BEARER);
    expect(serialized).not.toContain('prompt text echoed back');
  });

  it('treats a mid-turn error notification as a diagnostic, not a termination', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push({
      method: 'error',
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        willRetry: true,
        error: { message: 'transient', codexErrorInfo: 'serverOverloaded' },
      },
    });
    await flush();

    expect(runSink.ofType('diagnostic')).toHaveLength(1);
    // The run is still open — the server said it is retrying.
    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    fake.push(agentMessageDelta('recovered'));
    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(runSink.texts()).toBe('recovered');
  });

  it('fails closed when a terminal frame carries a non-terminal status', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    fake.push(turnCompleted('inProgress'));

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('unreachable');
    expect(termination.error.code).toBe('provider_contract_violation');
  });

  it('emits no provider-native identifier anywhere', async () => {
    const { fake, session, sessionSink } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push(agentMessageDelta('text'));
    fake.push(tokenUsage({ totalTokens: 9 }));
    fake.push(turnCompleted('completed'));
    await run.completion;

    const serialized = JSON.stringify([...runSink.events, ...sessionSink.events]);
    expect(serialized).not.toContain(FAKE_THREAD_ID);
    expect(serialized).not.toContain(FAKE_TURN_ID);
    expect(serialized).not.toContain('item-1');
    expect(serialized).not.toContain('/workspace');
  });

  it('buffers turn traffic that races the `turn/start` response', async () => {
    const responders = defaultResponders();
    delete responders['turn/start'];
    const { fake, session } = await openSession({}, responders);
    const runSink = createSink();

    const starting = startRun(session, runSink);
    await flush();
    // The server streams before its own response is read.
    fake.push(agentMessageDelta('early'));
    await flush();
    expect(runSink.texts()).toBe('');

    fake.respond('turn/start', { turn: { id: FAKE_TURN_ID, status: 'inProgress' } });
    const run = await starting;
    await flush();
    expect(runSink.texts()).toBe('early');

    fake.push(agentMessageDelta(' and late'));
    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(runSink.texts()).toBe('early and late');
  });

  it('rejects a run whose `turn/start` fails, leaving the session usable', async () => {
    const responders = defaultResponders();
    delete responders['turn/start'];
    const { fake, session } = await openSession({}, responders);

    const failing = startRun(session, createSink());
    await flush();
    fake.respondWithError('turn/start', -32600, 'not steerable');
    await expect(failing).rejects.toThrow();

    // The session survives a refused turn: a second run can still be admitted.
    fake.setResponder('turn/start', () => ({ turn: { id: 'turn-2', status: 'inProgress' } }));
    const runSink = createSink();
    const run = await startRun(session, runSink);
    fake.push(turnCompleted('completed', { turnId: 'turn-2' }));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('fails closed when the server accepts a turn without a usable turn id', async () => {
    const responders = defaultResponders();
    responders['turn/start'] = () => ({ turn: { status: 'inProgress' } });
    const { session } = await openSession({}, responders);

    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_contract_violation',
    );
  });

  it('runs one turn at a time', async () => {
    const { session } = await openSession();
    await startRun(session, createSink());
    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'illegal_state_transition',
    );
  });
});

describe('conversation and turn ownership', () => {
  it('keeps one workspace-bound thread for the whole session and one turn per run', async () => {
    // Issue #11 governs over the research summary's process-per-run suggestion:
    // the conversation is not reset per run, and no connection is respawned.
    const { fake, session } = await openSession();

    const first = await startRun(session, createSink(), 'first question');
    fake.push(turnCompleted('completed'));
    await expect(first.completion).resolves.toEqual({ outcome: 'succeeded' });

    fake.setResponder('turn/start', () => ({ turn: { id: 'turn-2', status: 'inProgress' } }));
    const second = await startRun(session, createSink(), 'follow-up question');
    fake.push(turnCompleted('completed', { turnId: 'turn-2' }));
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });

    // Exactly one handshake and one thread for two runs.
    expect(fake.requests('initialize')).toHaveLength(1);
    expect(fake.requests('thread/start')).toHaveLength(1);

    // Two turns, both on that same thread, each named by its own run.
    const turns = fake.requests('turn/start');
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn.params).toMatchObject({ threadId: FAKE_THREAD_ID });
    expect((turns[0]?.params as { input: { text: string }[] }).input[0]?.text).toBe('first question');
    expect((turns[1]?.params as { input: { text: string }[] }).input[0]?.text).toBe('follow-up question');
  });

  it('binds the thread to the acquired lease root exactly once', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await run.completion;

    expect(fake.requests('thread/start')).toHaveLength(1);
    expect(fake.requests('thread/start')[0]?.params).toMatchObject({ cwd: '/workspace' });
    // No `thread/resume`, `thread/fork`, or second connection is ever used.
    expect(fake.requests('thread/resume')).toHaveLength(0);
    expect(fake.requests('thread/fork')).toHaveLength(0);
  });
});

describe('correlation and foreign traffic', () => {
  it('ignores a frame from another thread', async () => {
    const { fake, session, sessionSink } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push(agentMessageDelta('not mine', { threadId: 'other-thread' }));
    fake.push(turnCompleted('completed', { threadId: 'other-thread' }));
    await flush();

    expect(runSink.texts()).toBe('');
    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(sessionSink.ofType('diagnostic').length).toBeGreaterThan(0);

    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('ignores a frame from another turn on the same thread', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    // A background or already-retired turn shares this connection.
    fake.push(agentMessageDelta('background output', { turnId: 'turn-background' }));
    fake.push(turnCompleted('failed', { turnId: 'turn-background' }));
    await flush();

    expect(runSink.texts()).toBe('');
    fake.push(agentMessageDelta('mine'));
    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(runSink.texts()).toBe('mine');
  });

  it('drops buffered pre-response traffic that turns out to belong to another turn', async () => {
    const responders = defaultResponders();
    delete responders['turn/start'];
    const { fake, session } = await openSession({}, responders);
    const runSink = createSink();

    const starting = startRun(session, runSink);
    await flush();
    fake.push(agentMessageDelta('someone else', { turnId: 'turn-other' }));
    fake.push(agentMessageDelta('mine', { turnId: FAKE_TURN_ID }));
    await flush();

    fake.respond('turn/start', { turn: { id: FAKE_TURN_ID, status: 'inProgress' } });
    const run = await starting;
    await flush();

    expect(runSink.texts()).toBe('mine');
    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('ignores everything after its own terminal frame, and settles exactly once', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    let settlements = 0;
    void run.completion.then(() => {
      settlements += 1;
    });

    fake.push(turnCompleted('completed'));
    await flush();

    // The pinned protocol explicitly allows a late `item/completed` after
    // `turn/completed`, and a hostile producer can repeat a terminal frame.
    fake.push(agentMessageDelta('after the end'));
    fake.push(turnCompleted('failed', { error: { codexErrorInfo: 'unauthorized' } }));
    fake.push(turnCompleted('interrupted'));
    fake.push({ method: 'item/completed', params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID, item: {} } });
    await flush();

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(settlements).toBe(1);
    expect(runSink.texts()).toBe('');
  });

  it("cannot let a retired turn's tail crowd out the next run", async () => {
    const responders = defaultResponders();
    const { fake, session } = await openSession({}, responders);

    const first = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await expect(first.completion).resolves.toEqual({ outcome: 'succeeded' });

    // The next run's `turn/start` is deliberately left unanswered, so the whole
    // burst below lands in the pre-binding window.
    fake.setResponder('turn/start', () => undefined);
    const secondSink = createSink();
    const starting = startRun(session, secondSink, 'second');
    await flush();

    // A large tail from the *retired* turn. It could never settle run two, but
    // if it were buffered it could exhaust the bound and starve run two's own
    // early frames.
    for (let index = 0; index < 2000; index += 1) {
      fake.push(agentMessageDelta('stale ', { turnId: FAKE_TURN_ID }));
    }
    fake.push(agentMessageDelta('mine', { turnId: 'turn-2' }));
    await flush();

    fake.respond('turn/start', { turn: { id: 'turn-2', status: 'inProgress' } }, 1);
    const second = await starting;
    await flush();

    // Run two received its own early frame, and none of the retired tail.
    expect(secondSink.texts()).toBe('mine');
    expect(secondSink.texts()).not.toContain('stale');

    fake.push(turnCompleted('completed', { turnId: 'turn-2' }));
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it("ignores a retired turn's terminal frame replayed while a later run is active", async () => {
    const { fake, session } = await openSession();
    const first = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await first.completion;

    fake.setResponder('turn/start', () => ({ turn: { id: 'turn-2', status: 'inProgress' } }));
    const second = await startRun(session, createSink(), 'second');

    // The server replays the first turn's failure while run two is running.
    fake.push(turnCompleted('failed', { turnId: FAKE_TURN_ID, error: { codexErrorInfo: 'unauthorized' } }));
    await flush();

    let settled = false;
    void second.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    fake.push(turnCompleted('completed', { turnId: 'turn-2' }));
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('ignores thread-scoped notifications that name no turn', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    fake.push({ method: 'thread/started', params: { thread: { id: FAKE_THREAD_ID } } });
    fake.push({ method: 'warning', params: { threadId: FAKE_THREAD_ID, message: 'x' } });
    await flush();

    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
  });

  it('drops hostile frames without settling or crashing the run', async () => {
    const { fake, session, sessionSink } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    for (const hostile of [
      42,
      null,
      [],
      'a string',
      {},
      { method: '' },
      { id: 1, result: 'x', error: { code: 1, message: 'y' } },
      { method: 'turn/completed' },
      { method: 'turn/completed', params: null },
      { method: 'turn/completed', params: { threadId: FAKE_THREAD_ID } },
      { method: 'item/agentMessage/delta', params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID } },
    ]) {
      fake.push(hostile);
    }
    await flush();

    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(runSink.texts()).toBe('');
    expect(sessionSink.ofType('diagnostic').length).toBeGreaterThan(0);

    fake.push(turnCompleted('completed'));
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });
});

describe('interrupt', () => {
  it('asks the server to stop and settles on the terminal frame it sends back', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push(agentMessageDelta('partial'));
    await flush();
    await run.interrupt('user cancelled');

    expect(fake.requests('turn/interrupt')[0]?.params).toEqual({
      threadId: FAKE_THREAD_ID,
      turnId: FAKE_TURN_ID,
    });

    // The `{}` reply acknowledged only; the run is still open.
    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    fake.push(turnCompleted('interrupted'));
    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted' });
    expect(runSink.texts()).toBe('partial');
  });

  it('still delivers output queued before the stop took effect', async () => {
    const { fake, session } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    await run.interrupt();
    // Deltas already in flight when the interrupt landed.
    fake.push(agentMessageDelta('queued '));
    fake.push(agentMessageDelta('output'));
    await flush();
    expect(runSink.texts()).toBe('queued output');

    fake.push(turnCompleted('interrupted'));
    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted' });
  });

  it('does not relabel a turn that genuinely completed first', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    await run.interrupt();
    // The server's own status is authoritative: the turn beat the stop.
    fake.push(turnCompleted('completed'));

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('sends exactly one stop for concurrent and repeated calls', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    await Promise.all([run.interrupt(), run.interrupt(), run.interrupt()]);
    await run.interrupt();
    await flush();

    expect(fake.requests('turn/interrupt')).toHaveLength(1);
  });

  it('surfaces a refused stop and lets an identical retry try again', async () => {
    const responders = defaultResponders();
    delete responders['turn/interrupt'];
    const { fake, session } = await openSession({}, responders);
    const run = await startRun(session, createSink());

    const first = run.interrupt();
    await flush();
    fake.respondWithError('turn/interrupt', -32603, 'busy');
    await expect(first).rejects.toThrow();

    // Intent was withdrawn, so a retry really is delivered.
    fake.setResponder('turn/interrupt', () => ({}));
    await expect(run.interrupt()).resolves.toBeUndefined();
    expect(fake.requests('turn/interrupt')).toHaveLength(2);

    fake.push(turnCompleted('interrupted'));
    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted' });
  });

  it('is a no-op once the run is terminal', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await run.completion;

    await expect(run.interrupt('too late')).resolves.toBeUndefined();
    expect(fake.requests('turn/interrupt')).toEqual([]);
  });

  it('leaves the session usable for a further run', async () => {
    const { fake, session } = await openSession();
    const first = await startRun(session, createSink());
    await first.interrupt();
    fake.push(turnCompleted('interrupted'));
    await expect(first.completion).resolves.toEqual({ outcome: 'interrupted' });

    fake.setResponder('turn/start', () => ({ turn: { id: 'turn-2', status: 'inProgress' } }));
    const secondSink = createSink();
    const second = await startRun(session, secondSink, 'again');
    fake.push(agentMessageDelta('second run', { turnId: 'turn-2' }));
    fake.push(turnCompleted('completed', { turnId: 'turn-2' }));
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(secondSink.texts()).toBe('second run');
  });
});

describe('connection loss', () => {
  it('fails an in-flight run on EOF and never infers success from it', async () => {
    const { fake, session, sessionSink } = await openSession();
    const runSink = createSink();
    const run = await startRun(session, runSink);

    fake.push(agentMessageDelta('partial'));
    await flush();
    fake.end();

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('unreachable');
    expect(termination.error.code).toBe('provider_unavailable');
    expect(termination.error.retryable).toBe(true);
    expect(sessionSink.ofType('diagnostic').length).toBeGreaterThan(0);
  });

  it('fails an in-flight run when the transport throws', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    fake.fail(Object.assign(new Error('the pipe broke at /home/alice'), { code: 'EPIPE' }));

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('unreachable');
    expect(termination.error.message).toContain('EPIPE');
    expect(termination.error.message).not.toContain('/home/alice');
  });

  it('does not relabel a run that had already settled', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await run.completion;

    fake.end();
    await flush();

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('refuses a new run once the connection has ended', async () => {
    const { fake, session } = await openSession();
    fake.end();
    await flush();

    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );
  });

  it('settles an interrupt-requested run as failed rather than inferring interruption', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    await run.interrupt('stop');
    // The connection dies before the server confirms the stop. The interrupt
    // may or may not have taken effect, so claiming `interrupted` would be an
    // inference from EOF.
    fake.end();

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
  });
});

describe('disposal', () => {
  it('closes the connection and settles an in-flight run as interrupted', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());

    await session.dispose();

    expect(fake.closeCalls).toBe(1);
    await expect(run.completion).resolves.toEqual({
      outcome: 'interrupted',
      reason: 'codex provider session disposed',
    });
  });

  it('is idempotent', async () => {
    const { fake, session } = await openSession();
    await session.dispose();
    await session.dispose();
    await session.dispose();
    expect(fake.closeCalls).toBe(1);
  });

  it('shares one teardown between concurrent callers', async () => {
    const { fake, session } = await openSession();
    const release = fake.holdNextClose();

    const first = session.dispose();
    const second = session.dispose();
    // The hold only arms once `close()` is actually entered, which happens a
    // microtask after `dispose()` returns.
    await flush();
    release();
    await Promise.all([first, second]);

    expect(fake.closeCalls).toBe(1);
  });

  it('refuses new runs from the moment disposal starts, before it completes', async () => {
    const { fake, session } = await openSession();
    const release = fake.holdNextClose();

    const disposing = session.dispose();
    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'session_closed',
    );
    release();
    await disposing;
  });

  it('keeps retry ownership when teardown rejects asynchronously', async () => {
    const { fake, session } = await openSession();
    fake.failNextClose(new Error('close failed'));

    await expect(session.dispose()).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_rejected',
    );

    // The identical retry must still be able to finish the teardown.
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(fake.closeCalls).toBe(2);
  });

  it('keeps retry ownership when teardown throws synchronously', async () => {
    const { fake, session } = await openSession();
    // A transport whose `close()` throws before returning a promise would, if
    // the shared attempt were cached first, make every later disposal reject
    // forever with the same stale error.
    fake.throwOnNextClose(new Error('sync close failure'));

    await expect(session.dispose()).rejects.toThrow();
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(fake.closeCalls).toBe(2);
  });

  it('never reports a failed teardown as success', async () => {
    const { fake, session } = await openSession();
    fake.failNextClose(new Error('close failed'));

    let reportedSuccess = false;
    await session.dispose().then(
      () => {
        reportedSuccess = true;
      },
      () => undefined,
    );
    expect(reportedSuccess).toBe(false);
  });

  it('settles an admitted run even when teardown eventually succeeds after a failure', async () => {
    const { fake, session } = await openSession();
    const run = await startRun(session, createSink());
    fake.failNextClose(new Error('close failed'));

    await session.dispose().catch(() => undefined);
    // Still unsettled: the connection was not actually released.
    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    await session.dispose();
    await expect(run.completion).resolves.toMatchObject({ outcome: 'interrupted' });
  });
});

describe('interactions', () => {
  it('declines a server-initiated request and records it', async () => {
    const { fake, session, sessionSink } = await openSession();
    await startRun(session, createSink());

    fake.push({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID, command: ['rm', '-rf', '/'] },
    });
    await flush();

    const reply = fake.sent.find((message) => 'id' in message && message.id === 77);
    expect(reply).toMatchObject({ id: 77, error: { code: -32601 } });

    const diagnostics = sessionSink.ofType('diagnostic');
    expect(diagnostics.some((event) => (event.payload as { message: string }).message.includes('declined'))).toBe(true);
    // The approval payload is not echoed into a durable event.
    expect(JSON.stringify(sessionSink.events)).not.toContain('rm');
  });

  it('rejects any interaction response, since it raises none', async () => {
    const { session } = await openSession();
    await expect(session.respondToInteraction('ref-1', { kind: 'approval', decision: 'approved' })).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
  });

  it('does not echo a caller-supplied interaction reference into the error', async () => {
    const { session } = await openSession();
    await session
      .respondToInteraction(FIXTURE_BEARER, { kind: 'approval', decision: 'denied' })
      .catch((error: unknown) => {
        expect(JSON.stringify(error)).not.toContain(FIXTURE_BEARER);
      });
  });

  // R3 — a server-controlled method string is metadata, not publishable prose.
  it('never copies an unrecognised server-request method into a durable diagnostic', async () => {
    const { fake, session, sessionSink } = await openSession();
    await startRun(session, createSink());
    const marker = `unsupported/${FIXTURE_BEARER}`;

    fake.push({ id: 78, method: marker, params: { threadId: FAKE_THREAD_ID } });
    await flush();

    // Still declined, exactly once, so the server is never left waiting.
    expect(fake.sent.find((message) => 'id' in message && message.id === 78)).toMatchObject({
      id: 78,
      error: { code: -32601 },
    });
    // …but nothing the server chose reaches the event log.
    expect(JSON.stringify(sessionSink.events)).not.toContain(FIXTURE_BEARER);
    expect(JSON.stringify(sessionSink.events)).not.toContain('unsupported/');
    const declined = sessionSink
      .ofType('diagnostic')
      .filter((event) => (event.payload as { message: string }).message.includes('declined'));
    expect(declined).toHaveLength(1);
    expect((declined[0]?.payload as { message: string }).message).toContain('unrecognised request');
  });

  it('names a server-request method that is on the pinned stable allowlist', async () => {
    const { fake, session, sessionSink } = await openSession();
    await startRun(session, createSink());

    fake.push({ id: 79, method: 'item/tool/requestUserInput', params: { threadId: FAKE_THREAD_ID } });
    await flush();

    const declined = sessionSink
      .ofType('diagnostic')
      .filter((event) => (event.payload as { message: string }).message.includes('declined'));
    expect((declined[0]?.payload as { message: string }).message).toContain('item/tool/requestUserInput');
  });
});

// ---------------------------------------------------------------------------
// R1 — pre-binding buffering must never lose the only terminal frame
// ---------------------------------------------------------------------------

describe('early turn traffic that overflows the pre-binding buffer', () => {
  /** Hold `turn/start` unanswered so every frame below arrives pre-binding. */
  async function heldTurnStart(): Promise<Opened & { readonly runSink: Sink }> {
    const responders = defaultResponders();
    delete responders['turn/start'];
    const opened = await openSession({}, responders);
    return { ...opened, runSink: createSink() };
  }

  it('keeps the terminal frame, so an admitted run still settles', async () => {
    const { fake, session, sessionSink, runSink } = await heldTurnStart();
    const starting = startRun(session, runSink);
    await flush();

    // Far more early output than the adapter buffers, then the one frame that
    // actually ends the turn.
    for (let index = 0; index < 600; index += 1) fake.push(agentMessageDelta(`chunk-${String(index)}`));
    fake.push(turnCompleted('completed'));
    await flush();

    fake.respond('turn/start', {
      turn: { id: FAKE_TURN_ID, items: [], itemsView: 'complete', status: 'inProgress', error: null },
    });
    const run = await starting;

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    // Lossy output is disclosed rather than silent.
    expect(
      sessionSink
        .ofType('diagnostic')
        .some((event) => (event.payload as { message: string }).message.includes('dropped')),
    ).toBe(true);
  });

  it('still settles when the terminal frame arrives after the buffer is already full', async () => {
    const { fake, session, runSink } = await heldTurnStart();
    const starting = startRun(session, runSink);
    await flush();

    for (let index = 0; index < 512; index += 1) fake.push(agentMessageDelta('x'));
    await flush();
    fake.push(turnCompleted('interrupted'));
    await flush();

    fake.respond('turn/start', {
      turn: { id: FAKE_TURN_ID, items: [], itemsView: 'complete', status: 'inProgress', error: null },
    });
    const run = await starting;

    await expect(run.completion).resolves.toMatchObject({ outcome: 'interrupted' });
  });

  it('fails closed and fences the session when unattributable terminal frames flood it', async () => {
    const { fake, session, sessionSink, runSink } = await heldTurnStart();
    const starting = startRun(session, runSink);
    await flush();

    // Terminal frames for turns this session never started. They cannot settle
    // the admitted run, and they must not be able to consume the bound either.
    for (let index = 0; index < 40; index += 1) {
      fake.push(turnCompleted('completed', { turnId: `turn-foreign-${String(index)}` }));
    }
    await flush();

    fake.respond('turn/start', {
      turn: { id: FAKE_TURN_ID, items: [], itemsView: 'complete', status: 'inProgress', error: null },
    });
    const run = await starting;

    await expect(run.completion).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'provider_contract_violation' },
    });
    // The native turn may still be running, so admission stays closed.
    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.providerCode === 'session_fenced',
    );
    expect(
      sessionSink
        .ofType('diagnostic')
        .some((event) => (event.payload as { message: string }).message.includes('accepts no further runs')),
    ).toBe(true);
    // Observable cleanup of the ambiguous native work was attempted.
    expect(fake.requests('turn/interrupt')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R2 — an uncertain `turn/start` must not reopen admission
// ---------------------------------------------------------------------------

describe('uncertain turn admission', () => {
  /** Fake timers, but `setImmediate` stays real so `flush()` still works. */
  function withTimeout(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  it('fences the session when `turn/start` never answers, rather than retrying the same native turn', async () => {
    withTimeout();
    try {
      const responders = defaultResponders();
      delete responders['turn/start'];
      const { fake, session, sessionSink } = await openSession({ requestTimeoutMs: 1000 }, responders);

      const first = startRun(session, createSink());
      const firstAssertion = expect(first).rejects.toSatisfy(
        (error: unknown) => isProviderRejection(error) && error.agentError.providerCode === 'request_timeout',
      );
      await vi.advanceTimersByTimeAsync(1001);
      await firstAssertion;

      // A lost response is not a server rejection: the first native turn may be
      // running right now, so a second run must not be admitted against it.
      await expect(startRun(session, createSink())).rejects.toSatisfy(
        (error: unknown) => isProviderRejection(error) && error.agentError.providerCode === 'session_fenced',
      );
      expect(fake.requests('turn/start')).toHaveLength(1);
      expect(
        sessionSink
          .ofType('diagnostic')
          .some((event) => (event.payload as { message: string }).message.includes('unknown state')),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the session usable when the server authoritatively rejects the turn', async () => {
    const responders = defaultResponders();
    delete responders['turn/start'];
    const { fake, session } = await openSession({}, responders);

    const rejected = startRun(session, createSink());
    await flush();
    fake.respondWithError('turn/start', -32600, 'no');
    await expect(rejected).rejects.toThrow();

    // The server said no. Nothing was admitted, so the session is still good.
    fake.setResponder('turn/start', () => ({
      turn: { id: FAKE_TURN_ID, items: [], itemsView: 'complete', status: 'inProgress', error: null },
    }));
    const second = await startRun(session, createSink());
    fake.push(turnCompleted('completed'));
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(fake.requests('turn/start')).toHaveLength(2);
  });

  it('fences the session when the server accepts a turn without a usable turn id', async () => {
    const responders = defaultResponders();
    responders['turn/start'] = () => ({ turn: { items: [], status: 'inProgress' } });
    const { fake, session } = await openSession({}, responders);

    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_contract_violation',
    );
    // The turn may exist natively even though its id is unusable.
    await expect(startRun(session, createSink())).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.providerCode === 'session_fenced',
    );
    expect(fake.requests('turn/start')).toHaveLength(1);
  });

  it('leaves disposal available and honest on a fenced session', async () => {
    const responders = defaultResponders();
    responders['turn/start'] = () => ({ turn: { items: [] } });
    const { fake, session } = await openSession({}, responders);
    await expect(startRun(session, createSink())).rejects.toThrow();

    await session.dispose();
    expect(fake.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R4 — a failed handshake whose teardown also fails keeps a callable owner
// ---------------------------------------------------------------------------

describe('abandoned connections', () => {
  /** A provider whose handshake always fails at `thread/start`. */
  function brokenHandshake(): {
    readonly fake: FakeTransport;
    readonly provider: ReturnType<typeof createCodexProvider>;
  } {
    const responders = defaultResponders();
    responders['thread/start'] = () => undefined;
    const fake = createFakeTransport({ responders });
    return { fake, provider: createCodexProvider({ transport: () => fake.transport }) };
  }

  async function failHandshake(
    fake: FakeTransport,
    provider: ReturnType<typeof createCodexProvider>,
  ): Promise<unknown> {
    const opening = provider.createSession({
      options: {},
      workspace: { root: '/workspace', ownership: 'borrowed' },
      sink: createSink().sink,
    });
    const caught = opening.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    fake.respondWithError('thread/start', -32603, 'nope');
    return await caught;
  }

  it('tracks the connection and reports the failure truthfully when teardown rejects', async () => {
    const { fake, provider } = brokenHandshake();
    fake.failNextClose(new Error('close failed'));

    const error = await failHandshake(fake, provider);
    expect(isProviderRejection(error) && error.agentError.providerCode).toBe('handshake_cleanup_pending');
    expect(fake.closeCalls).toBe(1);
    expect(provider.abandonedConnectionCount).toBe(1);

    await expect(provider.releaseAbandonedConnections()).resolves.toEqual({
      attempted: 1,
      released: 1,
      pending: 0,
    });
    expect(fake.closeCalls).toBe(2);
    expect(provider.abandonedConnectionCount).toBe(0);
  });

  it('treats a synchronous close throw the same way as a rejection', async () => {
    const { fake, provider } = brokenHandshake();
    fake.throwOnNextClose(new Error('close threw'));

    const error = await failHandshake(fake, provider);
    expect(isProviderRejection(error) && error.agentError.providerCode).toBe('handshake_cleanup_pending');
    expect(provider.abandonedConnectionCount).toBe(1);

    await expect(provider.releaseAbandonedConnections()).resolves.toMatchObject({ released: 1, pending: 0 });
  });

  it('keeps a connection tracked while it still cannot be released', async () => {
    const { fake, provider } = brokenHandshake();
    fake.failNextClose(new Error('close failed'));
    await failHandshake(fake, provider);

    fake.failNextClose(new Error('still failing'));
    await expect(provider.releaseAbandonedConnections()).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'provider_unavailable',
    );
    expect(provider.abandonedConnectionCount).toBe(1);

    // A later attempt still owns it, and succeeds.
    await expect(provider.releaseAbandonedConnections()).resolves.toMatchObject({ released: 1, pending: 0 });
    expect(provider.abandonedConnectionCount).toBe(0);
  });

  it('shares one sweep between concurrent retries, so nothing is closed twice', async () => {
    const { fake, provider } = brokenHandshake();
    fake.failNextClose(new Error('close failed'));
    await failHandshake(fake, provider);
    const closesAfterHandshake = fake.closeCalls;

    const releaseHeld = fake.holdNextClose();
    const first = provider.releaseAbandonedConnections();
    const second = provider.releaseAbandonedConnections();
    await flush();
    releaseHeld();

    expect(await first).toEqual(await second);
    expect(fake.closeCalls).toBe(closesAfterHandshake + 1);
    expect(provider.abandonedConnectionCount).toBe(0);
  });

  it('tracks nothing when a failed handshake tears its connection down cleanly', async () => {
    const { fake, provider } = brokenHandshake();

    const error = await failHandshake(fake, provider);
    // The original typed handshake failure survives; no cleanup claim is added.
    expect(isProviderRejection(error) && error.agentError.providerCode).not.toBe('handshake_cleanup_pending');
    expect(fake.closeCalls).toBe(1);
    expect(provider.abandonedConnectionCount).toBe(0);
    await expect(provider.releaseAbandonedConnections()).resolves.toEqual({
      attempted: 0,
      released: 0,
      pending: 0,
    });
  });
});
