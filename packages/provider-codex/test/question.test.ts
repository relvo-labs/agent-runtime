/**
 * The `item/tool/requestUserInput` bridge, end to end, with no process and no
 * credentials.
 *
 * Every frame below is a hand-built instance of the pinned 0.153.4
 * `ToolRequestUserInputParams` / `ToolRequestUserInputResponse` shapes, pushed
 * through the transport seam, so each ordering is a fact about the adapter
 * rather than a race that settled the right way.
 *
 * The properties that an event log cannot show afterwards: the native reply is
 * written **at most once**, it is written **only** from a complete host answer,
 * a request that cannot be mapped losslessly is declined on its own native id
 * rather than half-mapped, and no pending reply outlives the run that raised it.
 */

import { describe, expect, it } from 'vitest';

import {
  InteractionRequestSchema,
  ProviderEventInputSchema,
  checkResponseAgainstRequest,
  type AgentError,
  type InteractionResponse,
  type JsonObject,
  type ProviderEventInput,
  type QuestionAnswer,
  type QuestionSetRequest,
} from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { CODEX_BRIDGED_QUESTION, createCodexProvider } from '../src/index.ts';
import type { CodexProviderOptions } from '../src/options.ts';
import {
  FAKE_THREAD_ID,
  FAKE_TURN_ID,
  agentMessageDelta,
  createFakeTransport,
  flush,
  turnCompleted,
  type FakeTransport,
} from './fake-transport.ts';
import type { CodexClientMessage, CodexRequestId } from '../src/seam.ts';

const QUESTION_ID: CodexRequestId = 701;

type Sink = {
  readonly events: ProviderEventInput[];
  readonly sink: { emit(input: ProviderEventInput): void };
  ofType(type: string): ProviderEventInput[];
};

function createSink(): Sink {
  const events: ProviderEventInput[] = [];
  return {
    events,
    sink: {
      emit(input: ProviderEventInput): void {
        ProviderEventInputSchema.parse(input);
        events.push(input);
      },
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
  readonly runSink: Sink;
};

async function openSession(options: Omit<CodexProviderOptions, 'transport'> = {}): Promise<Opened> {
  const fake = createFakeTransport();
  const provider = createCodexProvider({ questions: 'bridge', ...options, transport: () => fake.transport });
  const sessionSink = createSink();
  const session = await provider.createSession({
    options: {} satisfies JsonObject,
    workspace: { root: '/workspace', ownership: 'borrowed' },
    sink: sessionSink.sink,
  });
  return { fake, session, sessionSink, runSink: createSink() };
}

async function running(options: Omit<CodexProviderOptions, 'transport'> = {}): Promise<Opened & { run: ProviderRun }> {
  const opened = await openSession(options);
  const run = await opened.session.startRun({
    input: { parts: [{ type: 'text', text: 'design the service' }] },
    sink: opened.runSink.sink,
    runRef: 'run-ref-1',
  });
  return { ...opened, run };
}

/** A well-formed `ToolRequestUserInputParams` for the active turn. */
function questionFrame(overrides: Record<string, unknown> = {}, id: CodexRequestId = QUESTION_ID): unknown {
  return {
    id,
    method: CODEX_BRIDGED_QUESTION,
    params: {
      threadId: FAKE_THREAD_ID,
      turnId: FAKE_TURN_ID,
      itemId: 'item-question-1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'native-q-a',
          header: 'Database',
          question: 'Which database should I use?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'PostgreSQL', description: 'Relational, strong consistency' },
            { label: 'SQLite', description: 'Embedded, zero operations' },
          ],
        },
        {
          id: 'native-q-b',
          header: 'Token',
          question: 'Paste the deploy token',
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
      ...overrides,
    },
  };
}

function repliesTo(fake: FakeTransport, id: CodexRequestId): readonly CodexClientMessage[] {
  return fake.sent.filter((message) => 'id' in message && message.id === id && !('method' in message));
}

function soleInteraction(sink: Sink): { readonly providerRef: string; readonly batch: QuestionSetRequest } {
  const raised = sink.ofType('interaction.requested');
  expect(raised).toHaveLength(1);
  const payload = raised[0]?.payload as { providerRef: string; request: unknown };
  const parsed = InteractionRequestSchema.parse(payload.request);
  if (parsed.kind !== 'question_set') throw new Error(`expected a question batch, got \`${parsed.kind}\``);
  return { providerRef: payload.providerRef, batch: parsed };
}

/** Raise one question batch on the active run and return its reference. */
async function raise(
  opened: Opened,
  frame: unknown = questionFrame(),
): Promise<{ providerRef: string; batch: QuestionSetRequest }> {
  opened.fake.push(frame);
  await flush();
  return soleInteraction(opened.runSink);
}

async function rejectionOf(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    if (isProviderRejection(error)) return error.agentError;
    throw error;
  }
  throw new Error('expected a typed provider rejection');
}

const COMPLETE_ANSWERS: Record<string, QuestionAnswer> = {
  q1: { type: 'selection', values: ['o1'] },
  q2: { type: 'text', text: 'tok-live-42' },
};

const COMPLETE: InteractionResponse = { kind: 'question_set', answers: { ...COMPLETE_ANSWERS } };

// ---------------------------------------------------------------------------
// Capability and negotiation
// ---------------------------------------------------------------------------

describe('codex question capability', () => {
  it('claims no question and declines the method by default', async () => {
    const descriptor = createCodexProvider().describe();
    expect(descriptor.interaction.question.supported).toBe(false);
    expect(descriptor.interaction.question.batch).toBe(false);

    const fake = createFakeTransport();
    const provider = createCodexProvider({ transport: () => fake.transport });
    const sessionSink = createSink();
    const session = await provider.createSession({
      options: {},
      workspace: { root: '/workspace', ownership: 'borrowed' },
      sink: sessionSink.sink,
    });
    const runSink = createSink();
    await session.startRun({
      input: { parts: [{ type: 'text', text: 'go' }] },
      sink: runSink.sink,
      runRef: 'run-ref-1',
    });
    fake.push(questionFrame());
    await flush();

    // Declined on its own native id: a blocking request must be answered, never
    // ignored, or the turn stalls forever.
    const [reply] = repliesTo(fake, QUESTION_ID);
    expect(reply).toMatchObject({ error: { code: -32601 } });
    expect(runSink.ofType('interaction.requested')).toHaveLength(0);
  });

  it('claims exactly what the pinned request declares when bridged', () => {
    const descriptor = createCodexProvider({ questions: 'bridge' }).describe();
    expect(descriptor.interaction.question).toEqual({
      supported: true,
      choices: true,
      // `ToolRequestUserInputQuestion` has no field that permits several
      // answers, so none is offered.
      multiSelect: false,
      batch: true,
      maxQuestions: null,
      freeText: true,
      sensitive: true,
    });
    expect(descriptor.interaction.settlementTimeoutMs).toBeNull();
  });

  it('enables no experimental capability and does not relax the approval policy', async () => {
    const opened = await openSession();
    const initialize = opened.fake.requests('initialize')[0]?.params as { capabilities?: unknown } | undefined;
    // `item/tool/requestUserInput` is on the pinned *stable* surface, so the
    // bridge needs no opt-in — and opting in would widen the approval params
    // the approval bridge parses strictly.
    expect(initialize?.capabilities).toBeNull();
    // Questions are not permission to act.
    expect(opened.fake.requests('thread/start')[0]?.params).toMatchObject({ approvalPolicy: 'never' });
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('codex question round trip', () => {
  it('carries every question, in order, with its own native facts', async () => {
    const opened = await running();
    const { batch } = await raise(opened);

    expect(batch.questions.map((question) => question.prompt)).toStrictEqual([
      'Which database should I use?',
      'Paste the deploy token',
    ]);
    expect(batch.questions.map((question) => question.header)).toStrictEqual(['Database', 'Token']);
    // `isOther` on a choice question, and a question with no options at all.
    expect(batch.questions.map((question) => question.allowFreeText)).toStrictEqual([true, true]);
    // `isSecret`.
    expect(batch.questions.map((question) => question.sensitive)).toStrictEqual([false, true]);
    expect(batch.questions[0]?.choices?.map((choice) => choice.label)).toStrictEqual(['PostgreSQL', 'SQLite']);
    expect(batch.questions[1]?.choices).toBeUndefined();
  });

  it('keeps native identity out of the interaction', async () => {
    const opened = await running();
    const { providerRef, batch } = await raise(opened);

    expect(batch.questions.map((question) => question.key)).toStrictEqual(['q1', 'q2']);
    const published = JSON.stringify({ providerRef, batch });
    expect(published).not.toContain('native-q-a');
    expect(published).not.toContain(FAKE_THREAD_ID);
    expect(published).not.toContain(FAKE_TURN_ID);
    expect(published).not.toContain('item-question-1');
  });

  it('answers the native request with the whole keyed map and lets the turn continue', async () => {
    const opened = await running();
    const { providerRef, batch } = await raise(opened);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);

    expect(checkResponseAgainstRequest(batch, COMPLETE)).toBeUndefined();
    await opened.session.respondToInteraction(providerRef, COMPLETE);

    const [reply] = repliesTo(opened.fake, QUESTION_ID);
    // Keyed by the *native* question id, with every question answered.
    expect(reply).toMatchObject({
      id: QUESTION_ID,
      result: {
        answers: {
          'native-q-a': { answers: ['PostgreSQL'] },
          'native-q-b': { answers: ['tok-live-42'] },
        },
      },
    });

    // Same thread, same turn, same run: the turn resumes and completes.
    opened.fake.push(agentMessageDelta('using PostgreSQL'));
    opened.fake.push(turnCompleted('completed'));
    await expect(opened.run.completion).resolves.toStrictEqual({ outcome: 'succeeded' });
    expect(opened.runSink.ofType('run.message_delta')).toHaveLength(1);
  });

  it('writes the native reply exactly once across redelivery', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    await opened.session.respondToInteraction(providerRef, COMPLETE);
    await opened.session.respondToInteraction(providerRef, COMPLETE);
    // Key order is not semantic.
    await opened.session.respondToInteraction(providerRef, {
      kind: 'question_set',
      answers: Object.fromEntries(Object.entries(COMPLETE_ANSWERS).reverse()),
    });
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });

  it('rejects a conflicting redelivery and leaves the first reply standing', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);
    await opened.session.respondToInteraction(providerRef, COMPLETE);

    const error = await rejectionOf(
      opened.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['o2'] },
          q2: { type: 'text', text: 'different' },
        },
      }),
    );
    expect(error.code).toBe('interaction_already_settled');
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation — the whole request, or nothing
// ---------------------------------------------------------------------------

describe('codex question validation', () => {
  it.each([
    { label: 'a non-blocking request', params: { isBlocking: false } },
    { label: 'a request asking for auto-resolution', params: { autoResolutionMs: 30_000 } },
    { label: 'no questions at all', params: { questions: [] } },
    {
      label: 'two questions with the same native id',
      params: {
        questions: [
          { id: 'same', header: 'A', question: 'First?', isOther: false, isSecret: false, options: null },
          { id: 'same', header: 'B', question: 'Second?', isOther: false, isSecret: false, options: null },
        ],
      },
    },
    {
      label: 'two options with the same label',
      params: {
        questions: [
          {
            id: 'q',
            header: 'H',
            question: 'Which?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'A', description: 'first' },
              { label: 'A', description: 'second' },
            ],
          },
        ],
      },
    },
    { label: 'an unknown member', params: { urgency: 'high' } },
    { label: 'a missing itemId', params: { itemId: undefined } },
    { label: 'a non-array questions member', params: { questions: 'all of them' } },
  ])('declines $label on its own native id, raising nothing', async ({ params }) => {
    const opened = await running();
    opened.fake.push(questionFrame(params));
    await flush();

    const [reply] = repliesTo(opened.fake, QUESTION_ID);
    expect(reply).toMatchObject({ error: { code: -32602 } });
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);

    // The refusal is classified, and carries no prompt, option or answer text.
    const diagnostics = opened.runSink.ofType('diagnostic');
    expect(diagnostics).toHaveLength(1);
    const message = diagnostics[0]?.payload.type === 'diagnostic' ? diagnostics[0].payload.message : '';
    expect(message).toContain('cannot map');
    expect(message).not.toContain('PostgreSQL');
    expect(message).not.toContain('deploy token');
  });

  it('declines a request that names another turn, without raising anything', async () => {
    const opened = await running();
    opened.fake.push(questionFrame({ turnId: 'turn-somebody-else' }));
    await flush();

    const [reply] = repliesTo(opened.fake, QUESTION_ID);
    expect(reply).toMatchObject({ error: { code: -32600 } });
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
  });

  it('declines a request that names another thread', async () => {
    const opened = await running();
    opened.fake.push(questionFrame({ threadId: 'thread-somebody-else' }));
    await flush();
    expect(repliesTo(opened.fake, QUESTION_ID)[0]).toMatchObject({ error: { code: -32600 } });
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
  });

  it('declines a request that arrives with no run to own it', async () => {
    const opened = await openSession();
    opened.fake.push(questionFrame());
    await flush();
    expect(repliesTo(opened.fake, QUESTION_ID)[0]).toMatchObject({ error: { code: -32600 } });
  });

  it.each([
    {
      label: 'a partial answer set',
      response: { kind: 'question_set', answers: { q1: { type: 'selection', values: ['o1'] } } },
      code: 'invalid_request',
    },
    {
      label: 'an unknown choice value',
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o9'] }, q2: { type: 'text', text: 'x' } },
      },
      code: 'invalid_request',
    },
    {
      label: 'an approval response',
      response: { kind: 'approval', decision: 'approved', mode: 'once' },
      code: 'capability_unsupported',
    },
    {
      label: 'a legacy single-question response',
      response: { kind: 'question', answer: 'PostgreSQL' },
      code: 'capability_unsupported',
    },
    {
      label: 'a malformed response',
      response: { kind: 'question_set', answers: { q1: { type: 'selection' } } },
      code: 'invalid_request',
    },
  ])('refuses $label and writes no native reply', async ({ response, code }) => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    const error = await rejectionOf(
      opened.session.respondToInteraction(providerRef, response as unknown as InteractionResponse),
    );
    expect(error.code).toBe(code);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);

    // Still answerable: a response the adapter could not apply must not burn
    // the single settlement.
    await opened.session.respondToInteraction(providerRef, COMPLETE);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });

  it('rejects a reference this session never issued', async () => {
    const opened = await running();
    await raise(opened);
    const error = await rejectionOf(opened.session.respondToInteraction('question-not-mine-1', COMPLETE));
    expect(error.code).toBe('unknown_interaction');
    expect(error.message).not.toContain('question-not-mine-1');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('codex question lifecycle', () => {
  it('retires an unanswered batch when the turn completes, and answers the server once', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    opened.fake.push(turnCompleted('completed'));
    await expect(opened.run.completion).resolves.toStrictEqual({ outcome: 'succeeded' });

    // The native request has no decline variant, so the wait is released with
    // an empty answer map: nothing is answered and nothing is invented.
    const [reply] = repliesTo(opened.fake, QUESTION_ID);
    expect(reply).toMatchObject({ id: QUESTION_ID, result: { answers: {} } });

    const error = await rejectionOf(opened.session.respondToInteraction(providerRef, COMPLETE));
    expect(error.code).toBe('unknown_interaction');
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });

  it('retires an unanswered batch on interrupt without resurrecting the run', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    await opened.run.interrupt('host asked to stop');
    opened.fake.push(turnCompleted('interrupted'));
    await opened.run.completion;

    const error = await rejectionOf(opened.session.respondToInteraction(providerRef, COMPLETE));
    expect(error.code).toBe('unknown_interaction');
  });

  it('retires an unanswered batch on disposal', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    await opened.session.dispose();
    const error = await rejectionOf(opened.session.respondToInteraction(providerRef, COMPLETE));
    expect(error.code).toBe('unknown_interaction');
  });

  it('survives the transport ending under an outstanding batch', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    opened.fake.end();
    await flush();
    await opened.run.completion.catch(() => undefined);

    // No dangling reference, and nothing throws on the way out.
    const error = await rejectionOf(opened.session.respondToInteraction(providerRef, COMPLETE));
    expect(error.code).toBe('unknown_interaction');
  });
});

// ---------------------------------------------------------------------------
// `serverRequest/resolved`, independent opt-in, neutral bounds and hostile keys
// ---------------------------------------------------------------------------

const RESOLVED_NOTIFICATION = 'serverRequest/resolved';
const APPROVAL_METHOD = 'item/commandExecution/requestApproval';
const APPROVAL_ID: CodexRequestId = 801;

function resolvedFrame(requestId: CodexRequestId = QUESTION_ID, threadId: string = FAKE_THREAD_ID): unknown {
  // The pinned notification: a thread and a native request id, and no `turnId`
  // at all — so it cannot be correlated the way every other notification is.
  return { method: RESOLVED_NOTIFICATION, params: { threadId, requestId } };
}

function approvalFrame(id: CodexRequestId = APPROVAL_ID): unknown {
  return {
    id,
    method: APPROVAL_METHOD,
    params: {
      kind: 'command',
      threadId: FAKE_THREAD_ID,
      turnId: FAKE_TURN_ID,
      itemId: 'item-approval-1',
      startedAtMs: 1_700_000_000_000,
      environmentId: null,
      command: 'rm -rf ./build',
      cwd: '/workspace/project',
      reason: 'the build directory must be cleared first',
    },
  };
}

describe('codex server-side request resolution', () => {
  it('withdraws an unanswered request and fences every later reply', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);

    opened.fake.push(resolvedFrame());
    await flush();

    // Nothing is written on the native id: the server resolved it itself, and
    // a reply now would be a second reply on a retired request.
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);
    // The Runtime is told, on the same reference the request carried, so the
    // interaction settles `withdrawn` instead of staying pending forever.
    const withdrawn = opened.runSink.ofType('interaction.withdrawn');
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.payload).toStrictEqual({ type: 'interaction.withdrawn', providerRef });

    const error = await rejectionOf(opened.session.respondToInteraction(providerRef, COMPLETE));
    expect(error.code).toBe('unknown_interaction');
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);
  });

  it('treats a duplicate resolution as a no-op', async () => {
    const opened = await running();
    await raise(opened);

    opened.fake.push(resolvedFrame());
    opened.fake.push(resolvedFrame());
    await flush();

    expect(opened.runSink.ofType('interaction.withdrawn')).toHaveLength(1);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);
  });

  it('treats a resolution confirming an answer this adapter already sent as harmless', async () => {
    const opened = await running();
    const { providerRef } = await raise(opened);
    await opened.session.respondToInteraction(providerRef, COMPLETE);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);

    opened.fake.push(resolvedFrame());
    await flush();

    // A confirmation, not a withdrawal: the interaction is already settled and
    // nothing more is written or announced.
    expect(opened.runSink.ofType('interaction.withdrawn')).toHaveLength(0);
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
    // Identical redelivery stays a no-op rather than becoming unknown.
    await expect(opened.session.respondToInteraction(providerRef, COMPLETE)).resolves.toBeUndefined();
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });

  it('ignores a resolution for another thread or an untracked id', async () => {
    const opened = await running();
    await raise(opened);

    opened.fake.push(resolvedFrame(QUESTION_ID, 'thread-somebody-else'));
    opened.fake.push(resolvedFrame(9999));
    opened.fake.push({ method: RESOLVED_NOTIFICATION, params: { threadId: FAKE_THREAD_ID } });
    await flush();

    expect(opened.runSink.ofType('interaction.withdrawn')).toHaveLength(0);
    // Still answerable: nothing was retired.
    await expect(
      opened.session.respondToInteraction(soleInteraction(opened.runSink).providerRef, COMPLETE),
    ).resolves.toBeUndefined();
  });

  it('lets the turn ask again, and complete, after a withdrawal', async () => {
    const opened = await running();
    await raise(opened);
    opened.fake.push(resolvedFrame());
    await flush();

    const second = createSink();
    opened.fake.push(questionFrame({}, 702));
    await flush();
    const raised = opened.runSink.ofType('interaction.requested');
    expect(raised).toHaveLength(2);
    const next = raised[1]?.payload as { providerRef: string };
    await opened.session.respondToInteraction(next.providerRef, COMPLETE);
    expect(repliesTo(opened.fake, 702)).toHaveLength(1);
    expect(second.events).toHaveLength(0);

    opened.fake.push(turnCompleted('completed'));
    await expect(opened.run.completion).resolves.toStrictEqual({ outcome: 'succeeded' });
  });
});

describe('codex approval bridging stays independently opt-in', () => {
  it('declines a command approval in questions-only mode without raising an interaction', async () => {
    const opened = await running();
    expect(createCodexProvider({ questions: 'bridge' }).describe().interaction.approval.supported).toBe(false);

    opened.fake.push(approvalFrame());
    await flush();

    // `-32601` is the same fail-closed decline a provider with no interaction
    // registry at all sends, which is what `approval: {}` promises.
    expect(repliesTo(opened.fake, APPROVAL_ID)[0]).toMatchObject({ error: { code: -32601 } });
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    // And no `decision` was ever sent on that id.
    expect(JSON.stringify(opened.fake.sent)).not.toContain('acceptForSession');
    expect(JSON.stringify(opened.fake.sent)).not.toContain('"decision"');
  });

  it('bridges both when both are opted into, and names both in the descriptor', async () => {
    const descriptor = createCodexProvider({ approvals: 'bridge', questions: 'bridge' }).describe();
    expect(descriptor.extensions).toMatchObject({
      bridgedServerRequests: [APPROVAL_METHOD, CODEX_BRIDGED_QUESTION],
    });
    expect(createCodexProvider({ questions: 'bridge' }).describe().extensions).toMatchObject({
      bridgedServerRequests: [CODEX_BRIDGED_QUESTION],
    });
    expect(createCodexProvider({ approvals: 'bridge' }).describe().extensions).toMatchObject({
      bridgedServerRequests: [APPROVAL_METHOD],
    });

    const opened = await running({ approvals: 'bridge' });
    opened.fake.push(approvalFrame());
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
  });
});

describe('codex neutral-bound refusals', () => {
  const question = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: 'native-q-a',
    header: 'Database',
    question: 'Which database should I use?',
    isOther: false,
    isSecret: false,
    options: [
      { label: 'PostgreSQL', description: 'Relational' },
      { label: 'SQLite', description: 'Embedded' },
    ],
    ...overrides,
  });

  const cases: readonly [string, Record<string, unknown>][] = [
    ['a prompt past the neutral bound', question({ question: 'p'.repeat(8001) })],
    ['a header past the neutral bound', question({ header: 'h'.repeat(201) })],
    ['an option label past the neutral bound', question({ options: [{ label: 'L'.repeat(401), description: 'a' }] })],
    [
      'an option description past the neutral bound',
      question({ options: [{ label: 'A', description: 'd'.repeat(2001) }] }),
    ],
    [
      'more options than a neutral choice list carries',
      question({
        options: Array.from({ length: 65 }, (_unused, index) => ({
          label: `option-${String(index)}`,
          description: '',
        })),
      }),
    ],
  ];

  for (const [name, hostile] of cases) {
    it(`refuses ${name} whole, on its own native id`, async () => {
      const opened = await running();
      opened.fake.push(questionFrame({ questions: [hostile] }));
      await flush();

      // The aggregate 16000-character check cannot see an individual field or
      // an option count, so only the neutral schema can refuse these.
      expect(repliesTo(opened.fake, QUESTION_ID)[0]).toMatchObject({ error: { code: -32602 } });
      expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
      const diagnostics = opened.runSink.ofType('diagnostic');
      expect(diagnostics).toHaveLength(1);
      const message = (diagnostics[0]?.payload as { message: string }).message;
      expect(message).toContain('neutral_bounds');
      expect(message).not.toContain('pppp');

      // The turn is still able to ask a question it *can* represent.
      opened.fake.push(questionFrame({}, 702));
      await flush();
      expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
    });
  }
});

describe('codex prototype-sensitive native question ids', () => {
  it('replies with own properties for `__proto__`, `constructor` and ordinary ids', async () => {
    const opened = await running();
    const hostile = (id: string): Record<string, unknown> => ({
      id,
      header: 'H',
      question: `Question ${id}?`,
      isOther: false,
      isSecret: false,
      options: null,
    });
    const { providerRef } = await raise(
      opened,
      questionFrame({ questions: [hostile('__proto__'), hostile('constructor'), hostile('native-ordinary')] }),
    );

    await opened.session.respondToInteraction(providerRef, {
      kind: 'question_set',
      answers: {
        q1: { type: 'text', text: 'first' },
        q2: { type: 'text', text: 'second' },
        q3: { type: 'text', text: 'third' },
      },
    });

    const [reply] = repliesTo(opened.fake, QUESTION_ID);
    if (reply === undefined || !('result' in reply)) throw new Error('the adapter wrote no result');
    const answers = (reply.result as { answers: Record<string, unknown> }).answers;
    expect(Object.hasOwn(answers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
    // Serialized through JSON, because an object literal `{ __proto__: … }` is
    // itself a prototype assignment — the trap this test exists for.
    const serialized = JSON.parse(JSON.stringify(answers)) as Record<string, { answers: string[] }>;
    // A `Map` so the lookup itself cannot be confused with a prototype read.
    const byKey = new Map(Object.entries(serialized));
    expect([...byKey.keys()].sort()).toStrictEqual(['__proto__', 'constructor', 'native-ordinary']);
    expect(byKey.get('__proto__')?.answers).toStrictEqual(['first']);
    expect(byKey.get('constructor')?.answers).toStrictEqual(['second']);
    expect(byKey.get('native-ordinary')?.answers).toStrictEqual(['third']);
  });
});

describe('codex request-aware settlement at the public SPI', () => {
  const invalid: readonly [string, InteractionResponse][] = [
    [
      'an answer for a question that was not asked',
      {
        kind: 'question_set',
        answers: { ...COMPLETE_ANSWERS, EXTRA_KEY: { type: 'text', text: 'smuggled' } },
      },
    ],
    [
      'two selections on a question that permits one',
      {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1', 'o2'] }, q2: { type: 'text', text: 'tok' } },
      },
    ],
    [
      'a repeated selection',
      {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1', 'o1'] }, q2: { type: 'text', text: 'tok' } },
      },
    ],
    [
      'a choice value this question does not offer',
      {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['SYNTHETIC_SECRET_MARKER'] },
          q2: { type: 'text', text: 'tok' },
        },
      },
    ],
  ];

  for (const [name, response] of invalid) {
    it(`rejects ${name} and leaves the batch answerable`, async () => {
      const opened = await running();
      const { providerRef } = await raise(opened);

      const error = await rejectionOf(opened.session.respondToInteraction(providerRef, response));
      expect(error.code).toBe('invalid_request');
      expect(error.message).not.toContain('SYNTHETIC_SECRET_MARKER');
      expect(error.message).not.toContain('EXTRA_KEY');
      expect(error.message).not.toContain('smuggled');
      // The one settlement was not consumed: nothing reached the server.
      expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);

      await opened.session.respondToInteraction(providerRef, COMPLETE);
      expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
    });
  }

  it('rejects free text for a question whose `isOther` is false', async () => {
    const opened = await running();
    const { providerRef, batch } = await raise(
      opened,
      questionFrame({
        questions: [
          {
            id: 'native-only-choices',
            header: 'Database',
            question: 'Which database should I use?',
            // No "Other" affordance, and options are present: typed text is
            // not an answer the server offered.
            isOther: false,
            isSecret: false,
            options: [
              { label: 'PostgreSQL', description: 'Relational' },
              { label: 'SQLite', description: 'Embedded' },
            ],
          },
        ],
      }),
    );
    expect(batch.questions[0]?.allowFreeText).toBe(false);

    const error = await rejectionOf(
      opened.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'SYNTHETIC_SECRET_MARKER' } },
      }),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('does not accept free text');
    expect(error.message).not.toContain('SYNTHETIC_SECRET_MARKER');
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);

    await opened.session.respondToInteraction(providerRef, {
      kind: 'question_set',
      answers: { q1: { type: 'selection', values: ['o1'] } },
    });
    expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(1);
  });
});

describe('server resolution retires the client reply ledger', () => {
  it.each(['correlated', 'foreign'] as const)(
    '%s resolution followed by request-limit cleanup writes only to still-pending IDs',
    async (correlation) => {
      const opened = await running();
      await raise(opened);
      opened.fake.push(resolvedFrame(QUESTION_ID, correlation === 'correlated' ? FAKE_THREAD_ID : 'another-thread'));
      await flush();
      expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);
      // A duplicate cannot re-admit a retired identity. Retired IDs still count
      // toward the connection's fixed bound; no eviction or reset is allowed.
      opened.fake.push(questionFrame());
      for (let index = 0; index < 4096; index += 1) {
        opened.fake.push({ id: `limit-${String(index)}`, method: 'unsupported', params: {} });
      }
      await flush();
      await expect(opened.run.completion).resolves.toMatchObject({ outcome: 'failed' });
      if (correlation === 'correlated') {
        expect(opened.runSink.ofType('interaction.withdrawn')).toHaveLength(1);
        expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(0);
      } else {
        expect(opened.runSink.ofType('interaction.withdrawn')).toHaveLength(0);
        expect(repliesTo(opened.fake, QUESTION_ID)).toMatchObject([{ error: { code: -32600 } }]);
      }
      expect(repliesTo(opened.fake, 'limit-4095')).toMatchObject([{ error: { code: -32600 } }]);
      await opened.session.dispose();
      expect(repliesTo(opened.fake, QUESTION_ID)).toHaveLength(correlation === 'correlated' ? 0 : 1);
    },
  );
});
