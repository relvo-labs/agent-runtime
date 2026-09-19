/**
 * Structured questions, end to end, through a real `AgentRuntime` and a real
 * concrete adapter — the vertical that issues #35 and #36 are about.
 *
 * This file lives in the example app rather than in a package because it is the
 * only place both halves may meet: `@relvo-labs/agent-runtime` must never
 * import a concrete provider adapter (`pnpm dag:check` enforces it), and an
 * adapter sits below the runtime in the layer table. A consumer composes them,
 * so a consumer is where the composition is proven — through the same public
 * package specifiers a host would use, never a source path.
 *
 * What is real here: the Runtime, its store, its command receipts, the neutral
 * interaction contract, and the adapters' own translation and settlement code.
 * What is a fixture: the bytes the provider process would have produced. Both
 * adapters take an injected seam for exactly this reason, so the canonical gate
 * needs no credential, no network and no child process.
 *
 * **No authentic provider or model call is made by this file.** The frames
 * below are hand-built instances of the pinned official shapes
 * (`AskUserQuestionInput` from `@anthropic-ai/claude-agent-sdk@0.3.259`;
 * `ToolRequestUserInputParams` from codex-cli 0.153.4). They prove the adapter
 * handles the official shape; they do not prove the shipped provider emits it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandIdSchema,
  InteractionRequestSchema,
  SequenceSchema,
  createCounterIdFactory,
  createFixedClock,
  type Clock,
  type CommandId,
  type IdFactory,
  type InteractionId,
  type QuestionSetRequest,
  type SessionId,
} from '@relvo-labs/agent-protocol';
import {
  createAgentRuntime,
  createInMemoryStore,
  type AgentRuntime,
  type RuntimeStore,
} from '@relvo-labs/agent-runtime';
import type { AgentProvider } from '@relvo-labs/agent-provider';
import { createLocalWorkspaceProvider } from '@relvo-labs/agent-workspace';
import { createClaudeProvider } from '@relvo-labs/agent-provider-claude';
import { CODEX_BRIDGED_QUESTION, createCodexProvider } from '@relvo-labs/agent-provider-codex';

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relvo-questions-'));
  roots.push(root);
  return root;
}

/** A store whose next `commit` can be made to fail exactly once. */
function faultableStore(
  clock: Clock,
  idFactory: IdFactory,
): { store: RuntimeStore; failNextCommit: (phase?: 'before' | 'after') => void } {
  const base = createInMemoryStore({ clock, idFactory });
  let rejectNext: false | 'before' | 'after' = false;
  return {
    failNextCommit: (phase = 'before') => {
      rejectNext = phase;
    },
    store: {
      ...base,
      commit: (mutate) => {
        if (rejectNext) {
          const phase = rejectNext;
          rejectNext = false;
          if (phase === 'after')
            return base.commit((tx) => {
              mutate(tx);
              throw new Error('injected transient commit failure');
            });
          return Promise.reject(new Error('injected transient commit failure'));
        }
        return base.commit(mutate);
      },
    },
  };
}

function commandIds(): () => CommandId {
  let n = 0;
  return () => CommandIdSchema.parse(`question-${String(++n).padStart(8, '0')}`);
}

/**
 * Drain the microtask queue at a defined point, without a timer.
 *
 * Deliberately not `runtime.quiesce()`: a run parked on a question has not
 * finished, and quiescing would wait for an answer this helper is called
 * *before* giving.
 */
async function settle(_runtime: AgentRuntime): Promise<void> {
  for (let pass = 0; pass < 24; pass += 1) await Promise.resolve();
}

type Vertical = {
  readonly runtime: AgentRuntime;
  readonly sessionId: SessionId;
  readonly next: () => CommandId;
  readonly failNextCommit: (phase?: 'before' | 'after') => void;
};

async function buildRuntime(provider: AgentProvider, providerId: string): Promise<Vertical> {
  const borrowed = await workspaceRoot();
  // One clock and one id factory for the whole composition, as a host has.
  const clock = createFixedClock('2026-01-01T00:00:00.000Z');
  const idFactory = createCounterIdFactory();
  const { store, failNextCommit } = faultableStore(clock, idFactory);
  const runtime = createAgentRuntime({
    workspaces: createLocalWorkspaceProvider({
      baseDirectory: join(await workspaceRoot(), 'managed'),
      clock,
      idFactory,
    }),
    providers: [provider],
    clock,
    idFactory,
    store,
  });
  const next = commandIds();
  const opened = await runtime.openSession({
    commandId: next(),
    type: 'open_session',
    providerId,
    workspace: { kind: 'existing', path: borrowed },
  });
  if (opened.result?.type !== 'session_opened') {
    throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
  }
  return { runtime, sessionId: opened.result.sessionId, next, failNextCommit };
}

/** The single pending interaction the session projected, and its batch. */
async function pendingBatch(vertical: Vertical): Promise<{ interactionId: InteractionId; batch: QuestionSetRequest }> {
  const snapshot = await vertical.runtime.getSession(vertical.sessionId);
  const interactions = snapshot?.interactions.filter((entry) => entry.status === 'pending') ?? [];
  expect(interactions).toHaveLength(1);
  const interaction = interactions[0];
  if (interaction === undefined) throw new Error('no pending interaction');
  const request = InteractionRequestSchema.parse(interaction.request);
  if (request.kind !== 'question_set') throw new Error(`expected a batch, got \`${request.kind}\``);
  return { interactionId: interaction.interactionId, batch: request };
}

// ---------------------------------------------------------------------------
// Claude — `AskUserQuestion` through `canUseTool` / `updatedInput`
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for the SDK's `query()`.
 *
 * It exposes the `canUseTool` the adapter installed, so a test can invoke it
 * exactly as the pinned SDK does, and lets a test push reply frames.
 */
function fakeClaudeQuery() {
  type Message = Record<string, unknown>;
  const pending: Message[] = [];
  let deliver: ((message: Message) => void) | undefined;
  let finish: (() => void) | undefined;
  let installed: ((name: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>) | undefined;
  let promptUuid: string | undefined;

  async function* messages(): AsyncGenerator<Message> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      const received = await new Promise<Message | undefined>((resolve) => {
        deliver = resolve;
        finish = () => {
          resolve(undefined);
        };
      });
      if (received === undefined) return;
      yield received;
    }
  }

  return {
    get promptUuid(): string {
      if (promptUuid === undefined) throw new Error('no prompt was submitted');
      return promptUuid;
    },
    push(message: Message): void {
      if (deliver !== undefined) {
        const resolve = deliver;
        deliver = undefined;
        resolve(message);
        return;
      }
      pending.push(message);
    },
    end(): void {
      finish?.();
    },
    /**
     * Invoke the installed callback exactly as the pinned SDK does.
     *
     * The controller is exposed because withdrawal *is* an abort of that one
     * request's signal: the SDK gives each permission control request its own
     * `AbortController`, and aborting it is how it takes a question back.
     */
    askQuestion(input: Record<string, unknown>, controller = new AbortController()): Promise<unknown> {
      if (installed === undefined) throw new Error('the adapter installed no host callback');
      return installed('AskUserQuestion', input, { signal: controller.signal, toolUseID: 'toolu_fixture_1' });
    },
    query(params: { prompt: AsyncIterable<{ uuid?: string }>; options: Record<string, unknown> }) {
      installed = params.options.canUseTool as typeof installed;
      void (async () => {
        for await (const message of params.prompt) promptUuid ??= message.uuid;
      })();
      const handle = messages();
      return Object.assign(handle, {
        interrupt: () => Promise.resolve(undefined),
        return: () => Promise.resolve(undefined),
      });
    },
  };
}

/** The pinned `AskUserQuestionInput` shape. */
const CLAUDE_ASK_INPUT = {
  questions: [
    {
      question: 'Which database should I use?',
      header: 'Database',
      options: [
        { label: 'PostgreSQL', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which regions?',
      header: 'Regions',
      options: [
        { label: 'EU', description: 'Frankfurt' },
        { label: 'US', description: 'Oregon' },
      ],
      multiSelect: true,
    },
  ],
};

async function claudeRunning() {
  const fake = fakeClaudeQuery();
  const vertical = await buildRuntime(
    createClaudeProvider({ query: fake.query as never, questions: 'bridge' }),
    'claude',
  );
  const accepted = await vertical.runtime.submitTurn({
    commandId: vertical.next(),
    type: 'submit_turn',
    sessionId: vertical.sessionId,
    input: { parts: [{ type: 'text', text: 'design the service' }] },
  });
  if (accepted.result?.type !== 'turn_accepted') throw new Error('submit_turn failed');
  await settle(vertical.runtime);
  // Bind the stream to this turn, as the SDK's first reply frame does.
  fake.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
    user_message_uuid: fake.promptUuid,
  });
  await settle(vertical.runtime);
  return { ...vertical, fake, runId: accepted.result.runId };
}

async function claudeVertical(input: Record<string, unknown> = CLAUDE_ASK_INPUT, controller?: AbortController) {
  const running = await claudeRunning();
  const decision = running.fake.askQuestion(input, controller);
  await settle(running.runtime);
  return { ...running, decision };
}

describe('claude structured questions through the runtime', () => {
  it('runs request → interaction → answer → native reply → the same run continues', async () => {
    const vertical = await claudeVertical();
    const { interactionId, batch } = await pendingBatch(vertical);

    // The run is parked on the question, not finished and not asking again.
    const parked = await vertical.runtime.getSession(vertical.sessionId);
    expect(parked?.runs.at(-1)?.state).toBe('awaiting_interaction');
    expect(batch.questions.map((question) => question.prompt)).toStrictEqual([
      'Which database should I use?',
      'Which regions?',
    ]);

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['o1'] },
          q2: { type: 'selection', values: ['o1', 'o2'] },
        },
      },
    });
    expect(receipt.disposition).toBe('applied');

    // The SDK callback resolved with the pinned answer route.
    const answered = (await vertical.decision) as { behavior: string; updatedInput?: Record<string, unknown> };
    expect(answered.behavior).toBe('allow');
    expect(answered.updatedInput?.answers).toStrictEqual({
      'Which database should I use?': 'PostgreSQL',
      'Which regions?': 'EU, US',
    });

    // Same run: it resumes and reaches its own terminal state.
    vertical.fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'using PostgreSQL' }] },
      user_message_uuid: vertical.fake.promptUuid,
    });
    vertical.fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: vertical.fake.promptUuid,
    });
    await settle(vertical.runtime);

    const final = await vertical.runtime.getSession(vertical.sessionId);
    expect(final?.runs.at(-1)?.runId).toBe(vertical.runId);
    expect(final?.runs.at(-1)?.state).toBe('succeeded');
    expect(final?.interactions[0]?.status).toBe('settled');
    expect(final?.interactions[0]?.settlement?.outcome).toBe('responded');
  });

  it('refuses a partial answer set without touching the SDK callback', async () => {
    const vertical = await claudeVertical();
    const { interactionId } = await pendingBatch(vertical);
    let settledEarly = false;
    void vertical.decision.then(() => {
      settledEarly = true;
    });

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: { kind: 'question_set', answers: { q1: { type: 'selection', values: ['o1'] } } },
    });
    expect(receipt.disposition).toBe('rejected');
    expect(receipt.error?.code).toBe('invalid_request');
    await settle(vertical.runtime);
    expect(settledEarly).toBe(false);

    // Still answerable: a refusal must not burn the one settlement.
    const applied = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'selection', values: ['o1'] } },
      },
    });
    expect(applied.disposition).toBe('applied');
  });

  it('commits an exact retry after a failed store commit without answering twice', async () => {
    const vertical = await claudeVertical();
    const { interactionId } = await pendingBatch(vertical);
    const command = {
      commandId: vertical.next(),
      type: 'respond_to_interaction' as const,
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set' as const,
        answers: {
          q1: { type: 'selection' as const, values: ['o1'] },
          q2: { type: 'selection' as const, values: ['o2'] },
        },
      },
    };

    vertical.failNextCommit();
    await expect(vertical.runtime.respondToInteraction(command)).rejects.toThrow('injected transient');

    // The provider side effect already happened: the SDK is unblocked exactly
    // once, with the answers the host gave.
    const answered = (await vertical.decision) as { behavior: string; updatedInput?: Record<string, unknown> };
    expect(answered.behavior).toBe('allow');
    expect(answered.updatedInput?.answers).toStrictEqual({
      'Which database should I use?': 'PostgreSQL',
      'Which regions?': 'US',
    });

    // A changed payload under the same command id is a conflict, not a second
    // delivery.
    const conflict = await vertical.runtime.respondToInteraction({
      ...command,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'text', text: 'other' }, q2: { type: 'text', text: 'other' } },
      },
    });
    expect(conflict.disposition).toBe('rejected');
    expect(conflict.error?.code).toBe('command_id_conflict');

    // The exact retry finishes the logical operation without reissuing it.
    const retried = await vertical.runtime.respondToInteraction(command);
    expect(retried.disposition).toBe('applied');
    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    expect(snapshot?.interactions[0]?.status).toBe('settled');
  });
});

// ---------------------------------------------------------------------------
// Codex — `item/tool/requestUserInput` over the app-server protocol
// ---------------------------------------------------------------------------

const CODEX_THREAD = 'thread-fixture-0001';
const CODEX_TURN = 'turn-fixture-0001';
const CODEX_REQUEST_ID = 901;

/**
 * A deterministic stand-in for the app-server stdio connection.
 *
 * Implements the adapter's `CodexTransport` seam directly: `send` is
 * synchronous and non-throwing, `incoming` yields already-decoded frames, and
 * ending the iteration is EOF. Handshake requests are answered inline so the
 * session opens without a process.
 */
function fakeCodexTransport() {
  const sent: Record<string, unknown>[] = [];
  const queued: unknown[] = [];
  let deliver: ((frame: unknown) => void) | undefined;
  let finish: (() => void) | undefined;
  let closed = false;

  function emit(frame: unknown): void {
    if (deliver !== undefined) {
      const resolve = deliver;
      deliver = undefined;
      resolve(frame);
      return;
    }
    queued.push(frame);
  }

  async function* incoming(): AsyncGenerator<unknown> {
    for (;;) {
      const next = queued.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (closed) return;
      const received = await new Promise<unknown>((resolve) => {
        deliver = resolve;
        finish = () => {
          resolve(undefined);
        };
      });
      if (received === undefined) return;
      yield received;
    }
  }

  const stream = incoming();

  return {
    sent,
    push(frame: Record<string, unknown>): void {
      emit(frame);
    },
    end(): void {
      closed = true;
      finish?.();
    },
    transport: {
      send(message: Record<string, unknown>): void {
        sent.push(message);
        const { id, method } = message;
        if (method === 'initialize') emit({ id, result: { userAgent: 'fixture' } });
        if (method === 'thread/start') emit({ id, result: { thread: { id: CODEX_THREAD } } });
        if (method === 'turn/start') emit({ id, result: { turn: { id: CODEX_TURN } } });
        if (method === 'turn/interrupt') emit({ id, result: {} });
      },
      get incoming(): AsyncIterable<unknown> {
        return stream;
      },
      close(): Promise<void> {
        closed = true;
        finish?.();
        return Promise.resolve();
      },
    },
  };
}

function codexQuestionFrame(): Record<string, unknown> {
  return {
    id: CODEX_REQUEST_ID,
    method: CODEX_BRIDGED_QUESTION,
    params: {
      threadId: CODEX_THREAD,
      turnId: CODEX_TURN,
      itemId: 'item-question-1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'native-a',
          header: 'Database',
          question: 'Which database should I use?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'PostgreSQL', description: 'Relational' },
            { label: 'SQLite', description: 'Embedded' },
          ],
        },
        { id: 'native-b', header: 'Token', question: 'Paste the token', isOther: false, isSecret: true, options: null },
      ],
    },
  };
}

function codexReplies(fake: ReturnType<typeof fakeCodexTransport>): readonly Record<string, unknown>[] {
  return fake.sent.filter((message) => message.id === CODEX_REQUEST_ID && message.method === undefined);
}

async function codexVertical() {
  const fake = fakeCodexTransport();
  const vertical = await buildRuntime(
    createCodexProvider({ transport: () => fake.transport as never, questions: 'bridge' }),
    'codex',
  );
  const accepted = await vertical.runtime.submitTurn({
    commandId: vertical.next(),
    type: 'submit_turn',
    sessionId: vertical.sessionId,
    input: { parts: [{ type: 'text', text: 'design the service' }] },
  });
  if (accepted.result?.type !== 'turn_accepted') throw new Error('submit_turn failed');
  await settle(vertical.runtime);
  fake.push(codexQuestionFrame());
  await settle(vertical.runtime);
  return { ...vertical, fake, runId: accepted.result.runId };
}

describe('codex structured questions through the runtime', () => {
  it('runs request → interaction → answer → native reply → the same turn continues', async () => {
    const vertical = await codexVertical();
    const { interactionId, batch } = await pendingBatch(vertical);

    const parked = await vertical.runtime.getSession(vertical.sessionId);
    expect(parked?.runs.at(-1)?.state).toBe('awaiting_interaction');
    // Native per-question facts survived the crossing.
    expect(batch.questions.map((question) => question.sensitive)).toStrictEqual([false, true]);
    expect(batch.questions.map((question) => question.allowFreeText)).toStrictEqual([true, true]);
    // Native identity did not.
    expect(JSON.stringify(batch)).not.toContain('native-a');
    expect(JSON.stringify(batch)).not.toContain(CODEX_THREAD);

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'text', text: 'tok-live-42' } },
      },
    });
    expect(receipt.disposition).toBe('applied');

    // One native reply, keyed by the native question ids, complete.
    expect(codexReplies(vertical.fake)).toHaveLength(1);
    expect(codexReplies(vertical.fake)[0]).toMatchObject({
      result: { answers: { 'native-a': { answers: ['PostgreSQL'] }, 'native-b': { answers: ['tok-live-42'] } } },
    });

    // Same turn: it resumes and completes.
    vertical.fake.push({
      method: 'turn/completed',
      params: {
        threadId: CODEX_THREAD,
        turn: {
          id: CODEX_TURN,
          items: [],
          itemsView: 'complete',
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await settle(vertical.runtime);

    const final = await vertical.runtime.getSession(vertical.sessionId);
    expect(final?.runs.at(-1)?.runId).toBe(vertical.runId);
    expect(final?.runs.at(-1)?.state).toBe('succeeded');
    expect(final?.interactions[0]?.settlement?.outcome).toBe('responded');
  });

  it('commits an exact retry after a failed store commit without replying twice', async () => {
    const vertical = await codexVertical();
    const { interactionId } = await pendingBatch(vertical);
    const command = {
      commandId: vertical.next(),
      type: 'respond_to_interaction' as const,
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set' as const,
        answers: {
          q1: { type: 'selection' as const, values: ['o2'] },
          q2: { type: 'text' as const, text: 'tok-live-7' },
        },
      },
    };

    vertical.failNextCommit();
    await expect(vertical.runtime.respondToInteraction(command)).rejects.toThrow('injected transient');

    // The native reply was written exactly once, before the commit failed.
    expect(codexReplies(vertical.fake)).toHaveLength(1);
    expect(codexReplies(vertical.fake)[0]).toMatchObject({
      result: { answers: { 'native-a': { answers: ['SQLite'] }, 'native-b': { answers: ['tok-live-7'] } } },
    });

    const conflict = await vertical.runtime.respondToInteraction({
      ...command,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'text', text: 'changed' } },
      },
    });
    expect(conflict.disposition).toBe('rejected');
    expect(conflict.error?.code).toBe('command_id_conflict');

    const retried = await vertical.runtime.respondToInteraction(command);
    expect(retried.disposition).toBe('applied');
    // Still exactly one native reply: the retry finished the logical
    // operation, it did not reissue the side effect.
    expect(codexReplies(vertical.fake)).toHaveLength(1);
  });

  it('refuses a stale answer after the interaction is already settled', async () => {
    const vertical = await codexVertical();
    const { interactionId } = await pendingBatch(vertical);
    const response = {
      kind: 'question_set' as const,
      answers: { q1: { type: 'selection' as const, values: ['o1'] }, q2: { type: 'text' as const, text: 'tok' } },
    };
    await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response,
    });

    // A different caller, a different command id, the same interaction.
    const stale = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response,
    });
    expect(stale.disposition).toBe('rejected');
    expect(stale.error?.code).toBe('interaction_already_settled');
    expect(codexReplies(vertical.fake)).toHaveLength(1);
  });

  it('rejects an answer aimed at an interaction id this session never raised', async () => {
    const vertical = await codexVertical();
    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId: 'int_0000000000009999' as InteractionId,
      response: { kind: 'question_set', answers: { q1: { type: 'text', text: 'x' } } },
    });
    expect(receipt.disposition).toBe('rejected');
    expect(receipt.error?.code).toBe('unknown_interaction');
    expect(codexReplies(vertical.fake)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Withdrawal, neutral bounds, non-leak and independent opt-in — all through the
// real Runtime, because each of these failures is only observable there: the
// adapter reports success while the *session* is left with a pending
// interaction, a parked run, or a secret in a durable receipt.
// ---------------------------------------------------------------------------

/** Every event the session recorded, as one string, for a leak scan. */
async function allEventsText(vertical: Vertical): Promise<string> {
  const page = await vertical.runtime.readEvents(vertical.sessionId, SequenceSchema.parse(0), 10_000);
  return JSON.stringify(page);
}

/** The single interaction the session holds, whatever its status. */
async function soleInteraction(vertical: Vertical) {
  const snapshot = await vertical.runtime.getSession(vertical.sessionId);
  expect(snapshot?.interactions).toHaveLength(1);
  const interaction = snapshot?.interactions[0];
  if (interaction === undefined) throw new Error('no interaction');
  return interaction;
}

const CLAUDE_SECOND_ASK = {
  questions: [
    {
      question: 'Which cache?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'Remote' },
        { label: 'Memory', description: 'Local' },
      ],
      multiSelect: false,
    },
  ],
};

describe('claude question withdrawal through the runtime', () => {
  it('settles the interaction withdrawn, resumes the run, and lets it succeed', async () => {
    const controller = new AbortController();
    const vertical = await claudeVertical(CLAUDE_ASK_INPUT, controller);
    const { interactionId } = await pendingBatch(vertical);

    // The SDK takes the question back: it aborts that request's signal.
    controller.abort();
    await settle(vertical.runtime);

    await expect(vertical.decision).resolves.toMatchObject({ behavior: 'deny' });
    const withdrawn = await soleInteraction(vertical);
    expect(withdrawn.status).toBe('settled');
    expect(withdrawn.settlement?.outcome).toBe('withdrawn');
    expect(withdrawn.settlement?.response).toBeUndefined();

    // The run left `awaiting_interaction`, so its own success is a success.
    const resumed = await vertical.runtime.getSession(vertical.sessionId);
    expect(resumed?.runs.at(-1)?.state).toBe('running');
    expect(resumed?.runs.at(-1)?.pendingInteractionIds).toStrictEqual([]);

    // A competing answer arriving after the withdrawal fails safely.
    const late = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'selection', values: ['o1'] } },
      },
    });
    expect(late.disposition).toBe('rejected');
    expect(late.error?.code).toBe('interaction_already_settled');

    // No resurrection: still one interaction, still settled withdrawn.
    const unchanged = await soleInteraction(vertical);
    expect(unchanged.settlement?.outcome).toBe('withdrawn');

    vertical.fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: vertical.fake.promptUuid,
    });
    await settle(vertical.runtime);

    const final = await vertical.runtime.getSession(vertical.sessionId);
    expect(final?.runs.at(-1)?.runId).toBe(vertical.runId);
    expect(final?.runs.at(-1)?.state).toBe('succeeded');
    expect(final?.runs.at(-1)?.termination?.outcome).toBe('succeeded');
    // The defect this test exists for: a withdrawal the Runtime never heard
    // about turned this success into a contract violation.
    expect(await allEventsText(vertical)).not.toContain('provider_contract_violation');
  });

  it('asks and answers a further question after a withdrawal', async () => {
    const controller = new AbortController();
    const vertical = await claudeVertical(CLAUDE_ASK_INPUT, controller);
    await pendingBatch(vertical);
    controller.abort();
    await settle(vertical.runtime);

    const second = vertical.fake.askQuestion(CLAUDE_SECOND_ASK);
    await settle(vertical.runtime);
    const { interactionId, batch } = await pendingBatch(vertical);
    expect(batch.questions.map((question) => question.prompt)).toStrictEqual(['Which cache?']);

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: { kind: 'question_set', answers: { q1: { type: 'selection', values: ['o1'] } } },
    });
    expect(receipt.disposition).toBe('applied');
    await expect(second).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which cache?': 'Redis' } },
    });

    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    expect(snapshot?.interactions.map((entry) => entry.settlement?.outcome)).toStrictEqual(['withdrawn', 'responded']);
    expect(snapshot?.runs.at(-1)?.state).toBe('running');
  });
});

describe('neutral bounds refused before any interaction exists', () => {
  const OVERLONG = 'p'.repeat(8001);

  it('claude refuses an out-of-bounds AskUserQuestion whole and stays usable', async () => {
    const vertical = await claudeVertical({
      questions: [
        {
          question: OVERLONG,
          header: 'Database',
          options: [
            { label: 'PostgreSQL', description: 'Relational' },
            { label: 'SQLite', description: 'Embedded' },
          ],
          multiSelect: false,
        },
      ],
    });

    // Nothing pending, nothing malformed reached the store, and the run is not
    // parked on a question no host can be shown.
    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    expect(snapshot?.interactions).toStrictEqual([]);
    expect(snapshot?.runs.at(-1)?.state).toBe('running');
    await expect(vertical.decision).resolves.toMatchObject({ behavior: 'deny' });

    const events = await allEventsText(vertical);
    expect(events).toContain('neutral_bounds');
    // The refusal is a bounded token; the model-authored text never lands.
    expect(events).not.toContain('pppp');

    // Still able to ask something it can represent.
    const second = vertical.fake.askQuestion(CLAUDE_SECOND_ASK);
    await settle(vertical.runtime);
    const { interactionId } = await pendingBatch(vertical);
    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: { kind: 'question_set', answers: { q1: { type: 'selection', values: ['o1'] } } },
    });
    expect(receipt.disposition).toBe('applied');
    await expect(second).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('codex refuses an out-of-bounds requestUserInput on its own native id', async () => {
    const fake = fakeCodexTransport();
    const vertical = await buildRuntime(
      createCodexProvider({ transport: () => fake.transport as never, questions: 'bridge' }),
      'codex',
    );
    const accepted = await vertical.runtime.submitTurn({
      commandId: vertical.next(),
      type: 'submit_turn',
      sessionId: vertical.sessionId,
      input: { parts: [{ type: 'text', text: 'design the service' }] },
    });
    if (accepted.result?.type !== 'turn_accepted') throw new Error('submit_turn failed');
    await settle(vertical.runtime);

    const frame = codexQuestionFrame() as { params: { questions: Record<string, unknown>[] } };
    frame.params.questions = [
      {
        id: 'native-a',
        header: 'Database',
        question: OVERLONG,
        isOther: false,
        isSecret: false,
        options: [{ label: 'PostgreSQL', description: 'Relational' }],
      },
    ];
    fake.push(frame as unknown as Record<string, unknown>);
    await settle(vertical.runtime);

    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    expect(snapshot?.interactions).toStrictEqual([]);
    expect(snapshot?.runs.at(-1)?.state).toBe('running');
    // Answered on its own id — a blocking request left unanswered stalls the
    // turn — with `-32602`, not a half-mapped batch.
    expect(codexReplies(fake)[0]).toMatchObject({ error: { code: -32602 } });

    const events = await allEventsText(vertical);
    expect(events).toContain('neutral_bounds');
    expect(events).not.toContain('pppp');
  });
});

describe('rejected answers never reach a durable record', () => {
  // Split so the repository's own static scan does not read this fixture as an
  // assigned credential; it is a marker, and its only job is to be absent.
  const MARKER = ['SYNTHETIC', 'SECRET', 'MARKER'].join('_');

  it('claude: a rejected choice value is absent from the receipt and every event', async () => {
    const vertical = await claudeVertical();
    const { interactionId } = await pendingBatch(vertical);

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: [MARKER] },
          q2: { type: 'selection', values: ['o1'] },
        },
      },
    });
    expect(receipt.disposition).toBe('rejected');
    expect(receipt.error?.code).toBe('invalid_request');
    expect(JSON.stringify(receipt)).not.toContain(MARKER);
    expect(await allEventsText(vertical)).not.toContain(MARKER);

    // Rejecting must not burn the one settlement.
    const applied = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'selection', values: ['o1'] } },
      },
    });
    expect(applied.disposition).toBe('applied');
  });

  it('codex: a rejected unknown answer key is counted, never echoed', async () => {
    const vertical = await codexVertical();
    const { interactionId } = await pendingBatch(vertical);

    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: {
          q1: { type: 'selection', values: ['o1'] },
          q2: { type: 'text', text: 'tok' },
          UNASKED: { type: 'text', text: MARKER },
        },
      },
    });
    expect(receipt.disposition).toBe('rejected');
    expect(JSON.stringify(receipt)).not.toContain(MARKER);
    expect(JSON.stringify(receipt)).not.toContain('UNASKED');
    const events = await allEventsText(vertical);
    expect(events).not.toContain(MARKER);
    expect(events).not.toContain('UNASKED');
  });
});

describe('codex server-side resolution through the runtime', () => {
  const CODEX_RESOLVED = {
    method: 'serverRequest/resolved',
    params: { threadId: CODEX_THREAD, requestId: CODEX_REQUEST_ID },
  };

  it('withdraws an unanswered request, resumes the turn, and completes it', async () => {
    const vertical = await codexVertical();
    const { interactionId } = await pendingBatch(vertical);

    vertical.fake.push(CODEX_RESOLVED);
    await settle(vertical.runtime);

    const withdrawn = await soleInteraction(vertical);
    expect(withdrawn.settlement?.outcome).toBe('withdrawn');
    // Nothing was written on the native id: the server resolved it itself.
    expect(codexReplies(vertical.fake)).toHaveLength(0);

    const resumed = await vertical.runtime.getSession(vertical.sessionId);
    expect(resumed?.runs.at(-1)?.state).toBe('running');

    const late = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'text', text: 'tok' } },
      },
    });
    expect(late.disposition).toBe('rejected');
    expect(late.error?.code).toBe('interaction_already_settled');
    expect(codexReplies(vertical.fake)).toHaveLength(0);

    vertical.fake.push({
      method: 'turn/completed',
      params: {
        threadId: CODEX_THREAD,
        turn: {
          id: CODEX_TURN,
          items: [],
          itemsView: 'complete',
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await settle(vertical.runtime);

    const final = await vertical.runtime.getSession(vertical.sessionId);
    expect(final?.runs.at(-1)?.state).toBe('succeeded');
    expect(await allEventsText(vertical)).not.toContain('provider_contract_violation');
  });

  it('is idempotent across duplicate resolutions', async () => {
    const vertical = await codexVertical();
    await pendingBatch(vertical);
    vertical.fake.push(CODEX_RESOLVED);
    vertical.fake.push(CODEX_RESOLVED);
    await settle(vertical.runtime);

    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    expect(snapshot?.interactions).toHaveLength(1);
    expect(snapshot?.interactions[0]?.settlement?.outcome).toBe('withdrawn');
    expect(snapshot?.runs.at(-1)?.state).toBe('running');
  });

  it('treats a resolution after a host answer as a harmless confirmation', async () => {
    const vertical = await codexVertical();
    const { interactionId } = await pendingBatch(vertical);
    const receipt = await vertical.runtime.respondToInteraction({
      commandId: vertical.next(),
      type: 'respond_to_interaction',
      sessionId: vertical.sessionId,
      interactionId,
      response: {
        kind: 'question_set',
        answers: { q1: { type: 'selection', values: ['o1'] }, q2: { type: 'text', text: 'tok' } },
      },
    });
    expect(receipt.disposition).toBe('applied');

    vertical.fake.push(CODEX_RESOLVED);
    await settle(vertical.runtime);

    const settledInteraction = await soleInteraction(vertical);
    expect(settledInteraction.settlement?.outcome).toBe('responded');
    expect(codexReplies(vertical.fake)).toHaveLength(1);
  });
});

describe('codex approval bridging stays independently opt-in through the runtime', () => {
  it('declines a command approval in questions-only mode and raises nothing', async () => {
    const vertical = await codexVertical();
    const approvalId = 802;
    vertical.fake.push({
      id: approvalId,
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'command',
        threadId: CODEX_THREAD,
        turnId: CODEX_TURN,
        itemId: 'item-approval-1',
        startedAtMs: 1_700_000_000_000,
        environmentId: null,
        command: 'rm -rf ./build',
        cwd: '/workspace',
        reason: 'clear the build directory',
      },
    });
    await settle(vertical.runtime);

    const snapshot = await vertical.runtime.getSession(vertical.sessionId);
    // Exactly the one question batch; no approval interaction was created.
    expect(snapshot?.interactions.map((entry) => entry.request.kind)).toStrictEqual(['question_set']);
    const reply = vertical.fake.sent.find((message) => message.id === approvalId && message.method === undefined);
    expect(reply).toMatchObject({ error: { code: -32601 } });
    expect(JSON.stringify(vertical.fake.sent)).not.toContain('"decision"');
  });
});

describe('command schema confidentiality through real adapters and Runtime', () => {
  for (const adapter of ['claude', 'codex'] as const) {
    for (const level of ['response', 'answer', 'path'] as const) {
      it(`${adapter}: ${level} schema failure has stable replayable errors without caller text`, async () => {
        const vertical = adapter === 'claude' ? await claudeVertical() : await codexVertical();
        const { interactionId } = await pendingBatch(vertical);
        const marker = ['SYNTHETIC', 'SCHEMA', 'PRIVATE'].join('_');
        const response = {
          kind: 'question_set',
          answers: {
            q1: { type: 'selection', values: ['o1'] },
            q2: adapter === 'claude' ? { type: 'selection', values: ['o1'] } : { type: 'text', text: 'provided' },
          },
        };
        const malformed =
          level === 'response'
            ? { ...response, [marker]: marker }
            : level === 'answer'
              ? { ...response, answers: { ...response.answers, q1: { ...response.answers.q1, [marker]: marker } } }
              : { ...response, answers: { ...response.answers, [marker]: { type: marker, text: marker } } };
        const command = {
          commandId: vertical.next(),
          type: 'respond_to_interaction',
          sessionId: vertical.sessionId,
          interactionId,
          response: malformed,
        };
        const rejected = await vertical.runtime.respondToInteraction(command as never);
        expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
        expect(JSON.stringify(rejected)).not.toContain(marker);
        expect(await vertical.runtime.respondToInteraction(command as never)).toEqual(rejected);
        expect(await allEventsText(vertical)).not.toContain(marker);
        expect((await soleInteraction(vertical)).status).toBe('pending');
        expect(
          await vertical.runtime.respondToInteraction({ ...command, commandId: vertical.next(), response } as never),
        ).toMatchObject({ disposition: 'applied' });
      });
    }
  }
});

describe('native withdrawal commit failures through real adapters and Runtime', () => {
  for (const adapter of ['claude', 'codex'] as const) {
    for (const phase of ['before', 'after'] as const) {
      for (const finish of ['completion', 'cleanup'] as const) {
        it(`${adapter}: ${phase}-mutation failure retains withdrawal through ${finish}`, async () => {
          const controller = new AbortController();
          const claude = adapter === 'claude' ? await claudeVertical(CLAUDE_ASK_INPUT, controller) : undefined;
          const codex = adapter === 'codex' ? await codexVertical() : undefined;
          const vertical = claude ?? codex!;
          const { interactionId } = await pendingBatch(vertical);
          const withdraw = () => {
            if (claude) controller.abort();
            else
              codex!.fake.push({
                method: 'serverRequest/resolved',
                params: { threadId: CODEX_THREAD, requestId: CODEX_REQUEST_ID },
              });
          };
          const complete = () => {
            if (claude)
              claude.fake.push({
                type: 'result',
                subtype: 'success',
                is_error: false,
                user_message_uuid: claude.fake.promptUuid,
              });
            else
              codex!.fake.push({
                method: 'turn/completed',
                params: {
                  threadId: CODEX_THREAD,
                  turn: {
                    id: CODEX_TURN,
                    items: [],
                    itemsView: 'complete',
                    status: 'completed',
                    error: null,
                    startedAt: 1,
                    completedAt: 2,
                    durationMs: 1,
                  },
                },
              });
          };
          vertical.failNextCommit(phase);
          withdraw();
          await settle(vertical.runtime);
          expect((await soleInteraction(vertical)).status).toBe('pending');
          if (claude) await expect(claude.decision).resolves.toMatchObject({ behavior: 'deny' });
          if (codex) expect(codexReplies(codex.fake)).toHaveLength(0);
          const command = {
            commandId: vertical.next(),
            type: 'respond_to_interaction' as const,
            sessionId: vertical.sessionId,
            interactionId,
            response: {
              kind: 'question_set' as const,
              answers: {
                q1: { type: 'selection' as const, values: ['o1'] },
                q2:
                  adapter === 'claude'
                    ? { type: 'selection' as const, values: ['o1'] }
                    : { type: 'text' as const, text: 'provided' },
              },
            },
          };
          const rejected = await vertical.runtime.respondToInteraction(command);
          expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'interaction_already_settled' } });
          expect(await vertical.runtime.respondToInteraction(command)).toEqual(rejected);
          // Native duplicate notifications are consumed by the concrete adapter;
          // Runtime must retain its original withdrawal without relying on redelivery.
          withdraw();
          await settle(vertical.runtime);
          if (finish === 'cleanup') await vertical.runtime.shutdown();
          complete();
          await settle(vertical.runtime);
          const snapshot = await vertical.runtime.getSession(vertical.sessionId);
          expect(snapshot?.interactions).toHaveLength(1);
          expect(snapshot?.interactions[0]?.settlement).toMatchObject({ outcome: 'withdrawn' });
          expect(snapshot?.runs.at(-1)).toMatchObject({
            runId: vertical.runId,
            state: finish === 'completion' ? 'succeeded' : 'interrupted',
          });
          expect(await allEventsText(vertical)).not.toContain('provider_contract_violation');
          const page = await vertical.runtime.readEvents(vertical.sessionId, SequenceSchema.parse(0), 1000);
          expect(page.events.filter((event) => event.payload.type === 'interaction.settled')).toHaveLength(1);
          if (codex) expect(codexReplies(codex.fake)).toHaveLength(0);
          await vertical.runtime.shutdown();
          expect((await vertical.runtime.getSession(vertical.sessionId))?.session.state).toBe('closed');
        });
      }
    }
  }
});

describe('invalid own answer keys through concrete adapters and Runtime', () => {
  for (const adapter of ['claude', 'codex'] as const) {
    it.each([
      { key: '__proto__', answer: { type: 'invalid', text: 'not asked' } },
      { key: '__proto__', answer: { type: 'text', text: 'not asked' } },
      { key: 'bad key', answer: { type: 'text', text: 'not asked' } },
    ])(
      `${adapter}: rejects JSON-parsed $key with $answer.type, then continues the same run`,
      async ({ key, answer }) => {
        const claude = adapter === 'claude' ? await claudeVertical() : undefined;
        const codex = adapter === 'codex' ? await codexVertical() : undefined;
        const vertical = claude ?? codex!;
        const { interactionId } = await pendingBatch(vertical);
        let nativeSettlements = 0;
        if (claude)
          void claude.decision.then(() => {
            nativeSettlements += 1;
          });
        const response = {
          kind: 'question_set' as const,
          answers: {
            q1: { type: 'selection' as const, values: ['o1'] },
            q2:
              adapter === 'claude'
                ? { type: 'selection' as const, values: ['o1'] }
                : { type: 'text' as const, text: 'provided' },
          },
        };
        const malformed: unknown = JSON.parse(
          JSON.stringify({
            ...response,
            answers: Object.fromEntries([...Object.entries(response.answers), [key, answer]]),
          }),
        );
        const command = {
          commandId: vertical.next(),
          type: 'respond_to_interaction' as const,
          sessionId: vertical.sessionId,
          interactionId,
          response: malformed,
        };
        const rejected = await vertical.runtime.respondToInteraction(command as never);
        expect(rejected).toMatchObject({ disposition: 'rejected', error: { code: 'invalid_request' } });
        expect(await vertical.runtime.respondToInteraction(command as never)).toEqual(rejected);
        await settle(vertical.runtime);
        expect(nativeSettlements).toBe(0);
        if (codex) expect(codexReplies(codex.fake)).toHaveLength(0);
        expect((await soleInteraction(vertical)).status).toBe('pending');
        expect((await vertical.runtime.getSession(vertical.sessionId))?.runs.at(-1)?.state).toBe(
          'awaiting_interaction',
        );
        const corrected = await vertical.runtime.respondToInteraction({
          ...command,
          commandId: vertical.next(),
          response,
        });
        expect(corrected.disposition).toBe('applied');
        if (claude) {
          await expect(claude.decision).resolves.toMatchObject({
            behavior: 'allow',
            updatedInput: {
              answers: { 'Which database should I use?': 'PostgreSQL', 'Which regions?': 'EU' },
            },
          });
          expect(nativeSettlements).toBe(1);
          claude.fake.push({
            type: 'result',
            subtype: 'success',
            is_error: false,
            user_message_uuid: claude.fake.promptUuid,
          });
        }
        if (codex) {
          expect(codexReplies(codex.fake)).toHaveLength(1);
          expect(codexReplies(codex.fake)[0]).toMatchObject({
            result: {
              answers: {
                'native-a': { answers: ['PostgreSQL'] },
                'native-b': { answers: ['provided'] },
              },
            },
          });
          codex.fake.push({
            method: 'turn/completed',
            params: {
              threadId: CODEX_THREAD,
              turn: {
                id: CODEX_TURN,
                items: [],
                itemsView: 'complete',
                status: 'completed',
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
              },
            },
          });
        }
        await settle(vertical.runtime);
        expect((await vertical.runtime.getSession(vertical.sessionId))?.runs.at(-1)).toMatchObject({
          runId: vertical.runId,
          state: 'succeeded',
        });
        expect((await soleInteraction(vertical)).settlement?.outcome).toBe('responded');
        await vertical.runtime.shutdown();
      },
    );
  }
});
