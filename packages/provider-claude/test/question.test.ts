/**
 * The host question bridge.
 *
 * Every test drives the *real* adapter through the deterministic query seam:
 * no credentials, no network, no process, no timer decides ordering.
 * `fake.requestPermission('AskUserQuestion', input)` calls whatever the adapter
 * installed as `canUseTool`, exactly as the pinned SDK does, and throws when it
 * installed nothing — so "no question surface" can never be mistaken for "the
 * question was answered".
 *
 * The property under test throughout: a question is answered only by a complete
 * neutral `question_set` response, the answer reaches the SDK as the pinned
 * `updatedInput.answers` map, and the same run then continues. Everything else
 * — partial, unknown, stale, conflicting, unrepresentable, torn down — denies
 * or rejects, and never fabricates an answer.
 */

import { describe, expect, it } from 'vitest';

import {
  InteractionRequestSchema,
  ProviderEventInputSchema,
  checkResponseAgainstRequest,
  type AgentError,
  type InteractionResponse,
  type ProviderEventInput,
  type ProviderEventPayload,
  type QuestionSetRequest,
  type TurnInput,
} from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { createClaudeProvider, CLAUDE_QUESTION_TOOL } from '../src/index.ts';
import type { ClaudePermissionResult } from '../src/seam.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';

type Requested = Extract<ProviderEventPayload, { type: 'interaction.requested' }>;

/**
 * An `AskUserQuestion` input shaped exactly like the pinned
 * `AskUserQuestionInput`: 1–4 questions, each with 2–4 `{label, description}`
 * options and a `multiSelect` flag.
 */
function askInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which database should I use?',
        header: 'Database',
        options: [
          { label: 'PostgreSQL', description: 'Relational, strong consistency' },
          { label: 'SQLite', description: 'Embedded, zero operations' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which regions should it serve?',
        header: 'Regions',
        options: [
          { label: 'EU', description: 'Frankfurt' },
          { label: 'US', description: 'Oregon' },
        ],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}

function recordingSink() {
  const events: ProviderEventInput[] = [];
  return {
    events,
    sink: {
      emit(input: ProviderEventInput): void {
        expect(ProviderEventInputSchema.safeParse(input).success).toBe(true);
        events.push(input);
      },
    },
  };
}

function textInput(text: string): TurnInput {
  return { parts: [{ type: 'text', text }] };
}

function requestsIn(events: readonly ProviderEventInput[]): readonly Requested[] {
  return events
    .map((event) => event.payload)
    .filter((payload): payload is Requested => payload.type === 'interaction.requested');
}

function soleRequest(events: readonly ProviderEventInput[]): Requested {
  const requests = requestsIn(events);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request === undefined) throw new Error('no interaction was requested');
  return request;
}

function batchOf(request: Requested): QuestionSetRequest {
  const parsed = InteractionRequestSchema.parse(request.request);
  if (parsed.kind !== 'question_set') throw new Error(`expected a question batch, got \`${parsed.kind}\``);
  return parsed;
}

function pendingMarker(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  const mark = (): void => {
    state.settled = true;
  };
  void promise.then(mark, mark);
  return state;
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

/** Answers that select the first option of every choice question. */
function firstChoiceAnswers(batch: QuestionSetRequest): InteractionResponse {
  const answers: Record<string, { type: 'selection'; values: string[] }> = {};
  for (const question of batch.questions) {
    const first = question.choices?.[0];
    if (first === undefined) throw new Error('expected a choice question');
    answers[question.key] = { type: 'selection', values: [first.value] };
  }
  return { kind: 'question_set', answers };
}

type Bridged = {
  session: ProviderSession;
  run: ProviderRun;
  events: ProviderEventInput[];
  sessionEvents: ProviderEventInput[];
};

async function openBridged(
  fake: FakeQuery,
): Promise<{ session: ProviderSession; sessionEvents: ProviderEventInput[] }> {
  const provider = createClaudeProvider({ query: fake.query, questions: 'bridge' });
  const recorder = recordingSink();
  const session = await provider.createSession({
    options: {},
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: recorder.sink,
  });
  return { session, sessionEvents: recorder.events };
}

/** A bridged session with one run already bound to the stream. */
async function boundRun(fake: FakeQuery): Promise<Bridged> {
  const { session, sessionEvents } = await openBridged(fake);
  const recorder = recordingSink();
  const run = await session.startRun({ input: textInput('design the service'), sink: recorder.sink, runRef: 'run-1' });
  await flush();
  fake.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
    user_message_uuid: submittedUuid(fake, 0),
  });
  await flush();
  return { session, run, events: recorder.events, sessionEvents };
}

/** Ask the question and read back the reference the run raised for it. */
async function ask(
  fake: FakeQuery,
  bridged: Bridged,
  input: Record<string, unknown> = askInput(),
): Promise<{ decision: Promise<ClaudePermissionResult>; providerRef: string; batch: QuestionSetRequest }> {
  const decision = fake.requestPermission(CLAUDE_QUESTION_TOOL, input);
  await flush();
  const request = soleRequest(bridged.events);
  return { decision, providerRef: request.providerRef, batch: batchOf(request) };
}

describe('claude question capability', () => {
  it('declares no question and denies AskUserQuestion by default', async () => {
    const fake = createFakeQuery();
    const provider = createClaudeProvider({ query: fake.query });
    expect(provider.describe().interaction.question.supported).toBe(false);
    expect(provider.describe().interaction.question.batch).toBe(false);

    await provider.createSession({
      options: {},
      workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
      sink: recordingSink().sink,
    });
    // No callback at all: the SDK's own fail-closed posture handles it.
    expect(fake.calls[0]?.options.permissionPrompts).toBe('none');
    expect(fake.calls[0]?.options.canUseTool).toBeUndefined();
  });

  it('declares exactly what AskUserQuestion can express when bridged', () => {
    const descriptor = createClaudeProvider({ query: createFakeQuery().query, questions: 'bridge' }).describe();
    expect(descriptor.interaction.question).toEqual({
      supported: true,
      choices: true,
      multiSelect: true,
      batch: true,
      // The pinned tool bound, not a guess.
      maxQuestions: 4,
      freeText: true,
      // `AskUserQuestion` has no secret-answer concept.
      sensitive: false,
    });
    expect(descriptor.interaction.settlementTimeoutMs).toBeNull();
  });

  it('installs the callback for questions without claiming any approval', async () => {
    const fake = createFakeQuery();
    const provider = createClaudeProvider({ query: fake.query, questions: 'bridge' });
    expect(provider.describe().interaction.approval.supported).toBe(false);

    await openBridged(fake);
    expect(fake.calls[0]?.options.permissionPrompts).toBe('host');
    expect(typeof fake.calls[0]?.options.canUseTool).toBe('function');

    // An ordinary tool prompt is still denied: enabling questions must not
    // widen what the agent may do.
    await expect(fake.requestPermission('Bash', { command: 'rm -rf /' })).resolves.toStrictEqual({
      behavior: 'deny',
      message: 'this session has no run that can be asked to approve tool use',
    });
  });
});

describe('claude question round trip', () => {
  it('carries every question, in order, with its own facts', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { batch } = await ask(fake, bridged);

    expect(batch.questions.map((question) => question.prompt)).toStrictEqual([
      'Which database should I use?',
      'Which regions should it serve?',
    ]);
    expect(batch.questions.map((question) => question.header)).toStrictEqual(['Database', 'Regions']);
    expect(batch.questions.map((question) => question.multiSelect)).toStrictEqual([false, true]);
    // The SDK's guidance is that a host offers "Other" and sends the typed
    // text, so free text is always acceptable.
    expect(batch.questions.every((question) => question.allowFreeText)).toBe(true);
    expect(batch.questions.every((question) => !question.sensitive)).toBe(true);
    expect(batch.questions[0]?.choices?.map((choice) => choice.label)).toStrictEqual(['PostgreSQL', 'SQLite']);
    expect(batch.questions[0]?.choices?.map((choice) => choice.description)).toStrictEqual([
      'Relational, strong consistency',
      'Embedded, zero operations',
    ]);
  });

  it('publishes no native identity on the interaction', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { providerRef, batch } = await ask(fake, bridged);

    // Keys are this adapter's ordinals, never the question text the native
    // answer map is keyed by, and never a `toolUseID`.
    expect(batch.questions.map((question) => question.key)).toStrictEqual(['q1', 'q2']);
    expect(providerRef).not.toContain('toolu_');
    expect(JSON.stringify(batch)).not.toContain('toolu_');
  });

  it('answers the SDK with the pinned updatedInput map and lets the run continue', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged);

    const marker = pendingMarker(decision);
    await flush();
    // The SDK is still blocked: the run has not moved on without an answer.
    expect(marker.settled).toBe(false);

    const response: InteractionResponse = {
      kind: 'question_set',
      answers: {
        q1: { type: 'selection', values: ['o1'] },
        q2: { type: 'selection', values: ['o1', 'o2'] },
      },
    };
    expect(checkResponseAgainstRequest(batch, response)).toBeUndefined();
    await bridged.session.respondToInteraction(providerRef, response);

    const result = await decision;
    expect(result.behavior).toBe('allow');
    if (result.behavior !== 'allow') throw new Error('unreachable');
    // The pinned answer route: question text → answer string, with multi-select
    // comma-joined, alongside the original questions array.
    expect(result.updatedInput?.answers).toStrictEqual({
      'Which database should I use?': 'PostgreSQL',
      'Which regions should it serve?': 'EU, US',
    });
    expect(Array.isArray(result.updatedInput?.questions)).toBe(true);

    // Same run, same session: the turn resumes and completes.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'using PostgreSQL in EU and US' }] },
      user_message_uuid: submittedUuid(fake, 0),
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: submittedUuid(fake, 0),
    });
    await expect(bridged.run.completion).resolves.toStrictEqual({ outcome: 'succeeded' });
    const deltas = bridged.events
      .map((event) => event.payload)
      .filter((payload) => payload.type === 'run.message_delta');
    expect(deltas.map((delta) => delta.text)).toContain('using PostgreSQL in EU and US');
  });

  it('sends typed text verbatim as the answer for an Other choice', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged);

    const response: InteractionResponse = {
      kind: 'question_set',
      answers: {
        q1: { type: 'text', text: 'DuckDB' },
        q2: { type: 'selection', values: ['o2'] },
      },
    };
    expect(checkResponseAgainstRequest(batch, response)).toBeUndefined();
    await bridged.session.respondToInteraction(providerRef, response);

    const result = await decision;
    if (result.behavior !== 'allow') throw new Error('expected an allow');
    // The user's own text, not the word "Other".
    expect(result.updatedInput?.answers).toStrictEqual({
      'Which database should I use?': 'DuckDB',
      'Which regions should it serve?': 'US',
    });
  });

  it('settles the SDK callback exactly once across redelivery', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged);
    const response = firstChoiceAnswers(batch);

    await bridged.session.respondToInteraction(providerRef, response);
    const first = await decision;
    // Identical redelivery is a no-op, not a second application.
    await expect(bridged.session.respondToInteraction(providerRef, response)).resolves.toBeUndefined();
    // Key order is not semantic: the same answers, collected differently, are
    // still the same answer.
    const reordered: InteractionResponse = {
      kind: 'question_set',
      answers: Object.fromEntries(Object.entries(response.kind === 'question_set' ? response.answers : {}).reverse()),
    };
    await expect(bridged.session.respondToInteraction(providerRef, reordered)).resolves.toBeUndefined();
    expect(first.behavior).toBe('allow');
  });

  it('rejects a conflicting redelivery without touching the callback again', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged);

    await bridged.session.respondToInteraction(providerRef, firstChoiceAnswers(batch));
    const applied = await decision;
    if (applied.behavior !== 'allow') throw new Error('expected an allow');

    const conflicting: InteractionResponse = {
      kind: 'question_set',
      answers: {
        q1: { type: 'selection', values: ['o2'] },
        q2: { type: 'selection', values: ['o2'] },
      },
    };
    const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, conflicting));
    expect(error.code).toBe('interaction_already_settled');
    // The first answer stands.
    expect(applied.updatedInput?.answers).toStrictEqual({
      'Which database should I use?': 'PostgreSQL',
      'Which regions should it serve?': 'EU',
    });
  });
});

describe('claude question validation', () => {
  it('refuses an approval response to a question', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { providerRef } = await ask(fake, bridged);
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    );
    expect(error.code).toBe('capability_unsupported');
  });

  it('refuses a legacy single-question response to a batch', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { providerRef } = await ask(fake, bridged);
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, { kind: 'question', answer: 'PostgreSQL' }),
    );
    expect(error.code).toBe('capability_unsupported');
  });

  it('refuses a partial batch rather than answering some questions', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged);
    const marker = pendingMarker(decision);

    const partial: InteractionResponse = {
      kind: 'question_set',
      answers: { q1: { type: 'selection', values: ['o1'] } },
    };
    // The protocol refuses it before the adapter is ever asked …
    expect(checkResponseAgainstRequest(batch, partial)).toContain('unanswered');
    // … and the adapter refuses it too, for a caller driving the SPI directly.
    const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, partial));
    expect(error.code).toBe('invalid_request');
    await flush();
    // No partial reply reached the SDK, and the question is still answerable.
    expect(marker.settled).toBe(false);
    await bridged.session.respondToInteraction(providerRef, firstChoiceAnswers(batch));
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('refuses a selection naming a choice the question does not offer', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);
    const marker = pendingMarker(decision);
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['o9'] },
          q2: { type: 'selection', values: ['o1'] },
        },
      }),
    );
    expect(error.code).toBe('invalid_request');
    await flush();
    expect(marker.settled).toBe(false);
  });

  it('rejects a reference this session never issued', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    await ask(fake, bridged);
    const error = await rejectionOf(
      bridged.session.respondToInteraction('question-not-mine-1', {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'x' } },
      }),
    );
    expect(error.code).toBe('unknown_interaction');
    // The caller-controlled reference is classified, never echoed.
    expect(error.message).not.toContain('question-not-mine-1');
  });

  it.each([
    { label: 'an option preview this adapter never requested', input: () => previewInput() },
    { label: 'more questions than the tool declares', input: () => askInput({ questions: tooManyQuestions() }) },
    { label: 'a question with too few options', input: () => askInput({ questions: [oneOptionQuestion()] }) },
    { label: 'two questions with the same text', input: () => askInput({ questions: duplicateQuestions() }) },
    { label: 'two options with the same label', input: () => askInput({ questions: [duplicateOptions()] }) },
    { label: 'answers already filled in', input: () => askInput({ answers: { 'Which database?': 'PostgreSQL' } }) },
    { label: 'an unknown member', input: () => askInput({ urgency: 'high' }) },
    { label: 'no questions at all', input: () => ({ questions: [] }) },
    { label: 'a non-object input', input: () => [] as unknown as Record<string, unknown> },
  ])('denies $label whole, raising nothing', async ({ input }) => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);

    const result = await fake.requestPermission(CLAUDE_QUESTION_TOOL, input());
    await flush();
    expect(result.behavior).toBe('deny');
    // Nothing was raised: a request that cannot be shown faithfully must not
    // become an interaction a host is asked to answer.
    expect(requestsIn(bridged.events)).toHaveLength(0);
    // The refusal is classified and carries no prompt or option text.
    const diagnostics = bridged.events.map((event) => event.payload).filter((payload) => payload.type === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    const message = diagnostics[0]?.type === 'diagnostic' ? diagnostics[0].message : '';
    expect(message).toContain('cannot represent');
    expect(message).not.toContain('PostgreSQL');
    expect(message).not.toContain('Which database');
  });
});

describe('claude question lifecycle', () => {
  it('denies and retires an outstanding question when the run is interrupted', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.run.interrupt('host asked to stop');
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      user_message_uuid: submittedUuid(fake, 0),
    });
    await expect(decision).resolves.toStrictEqual({
      behavior: 'deny',
      message: 'the run that asked this question ended before it was answered',
    });
    await bridged.run.completion;

    // A late answer settles nothing and cannot resurrect the run.
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'late' }, q2: { type: 'text', text: 'late' } },
      }),
    );
    expect(error.code).toBe('unknown_interaction');
  });

  it('denies and retires an outstanding question on disposal', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.session.dispose();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'late' }, q2: { type: 'text', text: 'late' } },
      }),
    );
    expect(error.code).toBe('unknown_interaction');
  });

  it('denies once when the SDK withdraws the question by aborting its signal', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.cancelPermission();
    await expect(decision).resolves.toStrictEqual({
      behavior: 'deny',
      message: 'claude withdrew this question before it was answered',
    });

    // Retiring only this module's own entry would leave the Runtime holding a
    // pending interaction and the run parked in `awaiting_interaction` for the
    // rest of its life, so the withdrawal is propagated on the same reference.
    const withdrawn = bridged.events.filter((event) => event.payload.type === 'interaction.withdrawn');
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.payload).toStrictEqual({ type: 'interaction.withdrawn', providerRef });
    // The reference is retired, so a host cannot answer into a withdrawn call.
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'too late' }, q2: { type: 'text', text: 'too late' } },
      }),
    );
    expect(error.code).toBe('unknown_interaction');
  });

  it('raises nothing for a question the SDK had already withdrawn', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);

    const result = await fake.requestPermission(CLAUDE_QUESTION_TOOL, askInput(), { aborted: true });
    await flush();
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: 'claude withdrew this question before it was answered',
    });
    expect(requestsIn(bridged.events)).toHaveLength(0);
  });

  it('denies a question that belongs to no attributable run', async () => {
    const fake = createFakeQuery();
    // A session with no run bound to the stream at all.
    await openBridged(fake);
    const result = await fake.requestPermission(CLAUDE_QUESTION_TOOL, askInput());
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: 'this session has no run that can be asked this question',
    });
  });
});

// ---------------------------------------------------------------------------
// Hostile / unrepresentable inputs
// ---------------------------------------------------------------------------

function previewInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which layout?',
        header: 'Layout',
        options: [
          { label: 'Compact', description: 'Dense', preview: '<div>compact</div>' },
          { label: 'Roomy', description: 'Airy' },
        ],
        multiSelect: false,
      },
    ],
  };
}

function question(text: string): Record<string, unknown> {
  return {
    question: text,
    header: 'H',
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
    multiSelect: false,
  };
}

function tooManyQuestions(): readonly Record<string, unknown>[] {
  return ['one', 'two', 'three', 'four', 'five'].map((name) => question(`Question ${name}?`));
}

function oneOptionQuestion(): Record<string, unknown> {
  return { question: 'Only one?', header: 'H', options: [{ label: 'A', description: 'a' }], multiSelect: false };
}

function duplicateQuestions(): readonly Record<string, unknown>[] {
  return [question('Same?'), question('Same?')];
}

function duplicateOptions(): Record<string, unknown> {
  return {
    question: 'Which?',
    header: 'H',
    options: [
      { label: 'A', description: 'first' },
      { label: 'A', description: 'second' },
    ],
    multiSelect: false,
  };
}

// ---------------------------------------------------------------------------
// Neutral bounds, prototype-sensitive keys, and request-aware settlement
//
// Three classes of defect that a schema-shaped `AskUserQuestionInput` cannot
// catch: a tool call that is legal for the *tool* and illegal for the neutral
// contract, a native answer key that is legal text and hostile as a JavaScript
// property, and a response that is a valid `InteractionResponse` but not a
// valid answer to *this* batch.
// ---------------------------------------------------------------------------

/** Longer than `QuestionItem.prompt`'s 8000-character bound. */
const OVERLONG_PROMPT = 'p'.repeat(8001);

function boundedInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Which?',
        header: 'H',
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
        multiSelect: false,
        ...overrides,
      },
    ],
  };
}

describe('claude neutral-bound refusals', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['a prompt past the neutral bound', boundedInput({ question: OVERLONG_PROMPT })],
    ['a header past the neutral bound', boundedInput({ header: 'h'.repeat(201) })],
    [
      'an option label past the neutral bound',
      boundedInput({
        options: [
          { label: 'L'.repeat(401), description: 'a' },
          { label: 'B', description: 'b' },
        ],
      }),
    ],
    [
      'an option description past the neutral bound',
      boundedInput({
        options: [
          { label: 'A', description: 'd'.repeat(2001) },
          { label: 'B', description: 'b' },
        ],
      }),
    ],
  ];

  for (const [name, input] of cases) {
    it(`refuses ${name} whole, raising nothing`, async () => {
      const fake = createFakeQuery();
      const bridged = await boundRun(fake);

      // The pinned tool declares counts but no lengths, so this is a perfectly
      // well-formed `AskUserQuestionInput`. Only the neutral schema can refuse
      // it — and it must refuse before any entry is retained, or the runtime
      // discards the malformed event as a diagnostic while the SDK stays
      // blocked on a question no host will ever see.
      const result = await fake.requestPermission(CLAUDE_QUESTION_TOOL, input);
      await flush();
      expect(result).toStrictEqual({
        behavior: 'deny',
        message: 'this host cannot display that question faithfully; ask in your reply instead',
      });
      expect(requestsIn(bridged.events)).toHaveLength(0);

      const diagnostics = bridged.events.filter((event) => event.payload.type === 'diagnostic');
      expect(diagnostics).toHaveLength(1);
      const message = (diagnostics[0]?.payload as { message: string }).message;
      expect(message).toContain('neutral_bounds');
      // A bounded token, never the model-authored text that caused it.
      expect(message).not.toContain('pppp');
    });
  }

  it('stays able to raise the next, valid question', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    await fake.requestPermission(CLAUDE_QUESTION_TOOL, boundedInput({ question: OVERLONG_PROMPT }));
    await flush();

    const { batch } = await ask(fake, bridged);
    expect(batch.questions).toHaveLength(2);
  });
});

describe('claude prototype-sensitive native answer keys', () => {
  const hostile = (text: string): Record<string, unknown> => ({
    question: text,
    header: 'H',
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
    multiSelect: false,
  });

  it('answers questions whose text is `__proto__`, `constructor` or ordinary', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, batch } = await ask(fake, bridged, {
      questions: [hostile('__proto__'), hostile('constructor'), hostile('Which database?')],
    });

    expect(bridged.session.respondToInteraction(providerRef, firstChoiceAnswers(batch))).toBeInstanceOf(Promise);
    const result = (await decision) as { behavior: string; updatedInput?: { answers?: Record<string, string> } };
    expect(result.behavior).toBe('allow');
    const answers = result.updatedInput?.answers ?? {};

    // Own data properties, not a reassigned prototype: `answers.__proto__ = x`
    // would leave `{}` here and answer nothing while reporting success.
    expect(Object.hasOwn(answers, '__proto__')).toBe(true);
    expect(Object.hasOwn(answers, 'constructor')).toBe(true);
    expect(Object.hasOwn(answers, 'Which database?')).toBe(true);
    // Compared through JSON rather than an object literal, because a literal
    // `{ __proto__: 'A' }` is itself a prototype assignment — the very trap
    // this test exists for.
    const serialized = JSON.parse(JSON.stringify(answers)) as Record<string, string>;
    // A `Map` so the lookup itself cannot be confused with a prototype read.
    const byKey = new Map(Object.entries(serialized));
    expect([...byKey.keys()].sort()).toStrictEqual(['Which database?', '__proto__', 'constructor']);
    expect(byKey.get('__proto__')).toBe('A');
    expect(byKey.get('constructor')).toBe('A');
    expect(byKey.get('Which database?')).toBe('A');
    // The object's own prototype is untouched.
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
  });
});

describe('claude request-aware settlement at the public SPI', () => {
  /**
   * `ProviderSession.respondToInteraction` is publicly callable. The Runtime
   * validates against its own copy of the request first, but a host holding a
   * session can call this directly, so the adapter applies the same
   * request-aware checks before consuming its one settlement.
   */
  const invalid: readonly [string, () => InteractionResponse][] = [
    [
      'an answer for a question that was not asked',
      () => ({
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['o1'] },
          q2: { type: 'selection', values: ['o1'] },
          EXTRA_KEY: { type: 'text', text: 'smuggled' },
        },
      }),
    ],
    [
      'two selections on a single-select question',
      () => ({
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1', 'o2'] }, q2: { type: 'selection', values: ['o1'] } },
      }),
    ],
    [
      'a repeated selection',
      () => ({
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'selection', values: ['o1', 'o1'] } },
      }),
    ],
    [
      'a choice value this question does not offer',
      () => ({
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['SYNTHETIC_SECRET_MARKER'] },
          q2: { type: 'selection', values: ['o1'] },
        },
      }),
    ],
  ];

  for (const [name, build] of invalid) {
    it(`rejects ${name} and leaves the question answerable`, async () => {
      const fake = createFakeQuery();
      const bridged = await boundRun(fake);
      const { decision, providerRef, batch } = await ask(fake, bridged);
      const settled = pendingMarker(decision);

      const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, build()));
      expect(error.code).toBe('invalid_request');
      // Bounded classification only: no answer value, no unknown key.
      expect(error.message).not.toContain('SYNTHETIC_SECRET_MARKER');
      expect(error.message).not.toContain('EXTRA_KEY');
      expect(error.message).not.toContain('smuggled');
      await flush();
      // The single settlement was not consumed by an answer nobody can act on.
      expect(settled.settled).toBe(false);

      await bridged.session.respondToInteraction(providerRef, firstChoiceAnswers(batch));
      const result = (await decision) as { behavior: string };
      expect(result.behavior).toBe('allow');
    });
  }

  it('rejects a response that is not an interaction response at all', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { providerRef } = await ask(fake, bridged);
    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: [] } },
      } as unknown as InteractionResponse),
    );
    expect(error.code).toBe('invalid_request');
  });
});
