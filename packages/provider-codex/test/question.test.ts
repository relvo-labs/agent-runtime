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
