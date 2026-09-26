import { describe, expect, it } from 'vitest';

import {
  ProviderDescriptorSchema,
  ProviderEventInputSchema,
  type AgentError,
  type JsonObject,
  type ProviderEventInput,
  type TurnInput,
} from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderSession } from '@relvo-labs/agent-provider';

import { createClaudeProvider } from '../src/index.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';

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

function textInput(...texts: readonly string[]): TurnInput {
  return { parts: texts.map((text) => ({ type: 'text', text })) };
}

async function openSession(
  fake: FakeQuery,
  options: JsonObject = {},
): Promise<{ session: ProviderSession; events: ProviderEventInput[] }> {
  const provider = createClaudeProvider({ query: fake.query });
  const recorder = recordingSink();
  const session = await provider.createSession({
    options,
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: recorder.sink,
  });
  return { session, events: recorder.events };
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

describe('claude provider descriptor', () => {
  it('declares only the capabilities this adapter implements', () => {
    const descriptor = createClaudeProvider().describe();

    expect(ProviderDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor.providerId).toBe('claude');
    expect(descriptor.run.interrupt).toEqual({
      mode: 'cooperative',
      deliversPartialOutput: true,
      sessionRemainsUsable: true,
    });
    expect(descriptor.run.streaming).toEqual({ messageDeltas: true, toolActivity: true, incrementalUsage: false });
    expect(descriptor.run.maxConcurrentRunsPerSession).toBe(1);
    expect(descriptor.interaction.approval.supported).toBe(false);
    expect(descriptor.interaction.question.supported).toBe(false);
    expect(descriptor.workspace.requires).toBe('directory');
    expect(descriptor.recovery.exportsRecoveryRecord).toBe(false);
  });

  it('does not offer recovery export it cannot honour', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    expect('exportRecoveryRecord' in session).toBe(false);
  });
});

describe('claude text run', () => {
  async function startedRun(fake: FakeQuery, input: TurnInput = textInput('hello')) {
    const { session, events: sessionEvents } = await openSession(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input, sink: recorder.sink, runRef: 'run-1' });
    return { session, run, events: recorder.events, sessionEvents };
  }

  it('sends the turn text as streaming input and emits translated events', async () => {
    const fake = createFakeQuery();
    const { run, events } = await startedRun(fake, textInput('Summarise', 'this repo'));
    await flush();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options.cwd).toBe(WORKSPACE_ROOT);
    expect(fake.calls[0]?.options.permissionPrompts).toBe('none');
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['Summarise\n\nthis repo']);

    // The SDK stamps the turn's first reply frame and its result; the frames in
    // between carry no stamp and follow that binding.
    const uuid = submittedUuid(fake, 0);
    fake.push({ type: 'system', subtype: 'init', session_id: 'native-session-1' });
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      user_message_uuid: uuid,
    });
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
      session_id: 'native-session-1',
    });
    fake.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 5, output_tokens: 2 },
      session_id: 'native-session-1',
      user_message_uuid: uuid,
    });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(events.map((event) => event.payload)).toEqual([
      { type: 'run.message_delta', text: 'working' },
      { type: 'run.tool_activity', toolName: 'Read', phase: 'invoked' },
      { type: 'run.tool_activity', toolName: 'Read', phase: 'succeeded' },
      { type: 'run.usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    expect(JSON.stringify(events)).not.toContain('native-session');
    expect(JSON.stringify(events)).not.toContain('toolu_1');
  });

  it('rejects turn input it cannot represent and leaves the session usable', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const error = await rejectionOf(
      session.startRun({
        input: {
          parts: [
            { type: 'text', text: 'read' },
            { type: 'file_ref', path: 'src/index.ts' },
          ],
        },
        sink: recordingSink().sink,
        runRef: 'run-1',
      }),
    );

    expect(error.code).toBe('capability_unsupported');
    expect(fake.prompts).toHaveLength(0);

    const run = await session.startRun({ input: textInput('hello'), sink: recordingSink().sink, runRef: 'run-2' });
    await flush();
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('rejects a second run while one is still active', async () => {
    const fake = createFakeQuery();
    const { session } = await startedRun(fake);
    const error = await rejectionOf(
      session.startRun({ input: textInput('again'), sink: recordingSink().sink, runRef: 'run-2' }),
    );
    expect(error.code).toBe('illegal_state_transition');
  });

  it('keeps one conversation across runs instead of restarting the agent', async () => {
    const fake = createFakeQuery();
    const { session, run } = await startedRun(fake);
    await flush();
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await run.completion;

    const next = await session.startRun({ input: textInput('and again'), sink: recordingSink().sink, runRef: 'run-2' });
    await flush();
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 1) });
    await expect(next.completion).resolves.toEqual({ outcome: 'succeeded' });

    expect(fake.calls).toHaveLength(1);
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['hello', 'and again']);
  });

  it('maps an SDK error result to a failed completion', async () => {
    const fake = createFakeQuery();
    const { run } = await startedRun(fake);
    await flush();
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['model unavailable'],
      user_message_uuid: submittedUuid(fake, 0),
    });

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('expected failure');
    expect(termination.error.code).toBe('provider_rejected');
    expect(termination.error.providerCode).toBe('error_during_execution');
  });

  it('fails the run when the SDK stream itself dies', async () => {
    const fake = createFakeQuery();
    const { run, sessionEvents } = await startedRun(fake);
    await flush();
    fake.fail(new Error('claude process exited with code 1'));

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('expected failure');
    expect(termination.error.code).toBe('provider_unavailable');
    expect(termination.error.retryable).toBe(true);
    // The session, not just the run, is told that its query is gone.
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'warning',
      message: 'the claude query stream failed (unknown)',
    });
  });

  it('fails the run when the stream ends without a result', async () => {
    const fake = createFakeQuery();
    const { session, run, sessionEvents } = await startedRun(fake);
    await flush();
    fake.end();

    const termination = await run.completion;
    expect(termination.outcome).toBe('failed');
    if (termination.outcome !== 'failed') throw new Error('expected failure');
    expect(termination.error.code).toBe('provider_contract_violation');
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'warning',
      message: 'claude query stream ended',
    });

    // A session whose query has ended cannot start another run.
    const error = await rejectionOf(
      session.startRun({ input: textInput('again'), sink: recordingSink().sink, runRef: 'run-2' }),
    );
    expect(error.code).toBe('provider_unavailable');
  });
});

describe('claude run interrupt', () => {
  it('is cooperative, idempotent, and leaves the session usable', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input: textInput('long job'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      user_message_uuid: uuid,
    });
    await flush();

    await run.interrupt('user asked to stop');
    await run.interrupt('user asked to stop');
    expect(fake.interruptCalls).toBe(1);
    expect(fake.returnCalls).toBe(0);

    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['interrupted'],
      user_message_uuid: uuid,
    });
    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted', reason: 'user asked to stop' });
    // Partial output produced before the interrupt is still delivered.
    expect(recorder.events.map((event) => event.payload)).toContainEqual({
      type: 'run.message_delta',
      text: 'partial',
    });

    const next = await session.startRun({ input: textInput('next'), sink: recordingSink().sink, runRef: 'run-2' });
    await flush();
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 1) });
    await expect(next.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(fake.calls).toHaveLength(1);
  });

  it('is a no-op once the run has already terminated', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await run.completion;

    await expect(run.interrupt('too late')).resolves.toBeUndefined();
    expect(fake.interruptCalls).toBe(0);
  });

  it('reports a cancellation result that beats the interrupt acknowledgement as interrupted', async () => {
    // The pinned SDK writes the receipt before the interrupted turn's result on
    // a clean stop, but a turn that crashes during interrupt handling emits its
    // error result first. Intent must be recorded before the round-trip, or a
    // stop looks like a failure forever.
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('long job'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    const release = fake.holdNextInterrupt();
    const interrupted = run.interrupt('user asked to stop');
    await flush();
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['aborted'],
      user_message_uuid: submittedUuid(fake, 0),
    });
    await flush();
    release();
    await interrupted;

    await expect(run.completion).resolves.toEqual({ outcome: 'interrupted', reason: 'user asked to stop' });
  });

  it('coalesces concurrent interrupts into one control request', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('long job'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    const release = fake.holdNextInterrupt();
    const attempts = [run.interrupt('stop'), run.interrupt('stop again'), run.interrupt('stop once more')];
    await flush();
    release();
    await Promise.all(attempts);

    expect(fake.interruptCalls).toBe(1);
    expect(fake.returnCalls).toBe(0);
  });

  it('refuses to claim interruption while the submitted input is still queued', async () => {
    // `still_queued` lists client uuids that survived the stop and WILL run.
    // The pinned public `interrupt()` takes no arguments, so the survivor cannot
    // be recalled; claiming `interrupted` would mislabel the turn that follows.
    const fake = createFakeQuery();
    const { session, events: sessionEvents } = await openSession(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input: textInput('queued job'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake);
    fake.setInterruptReceipt({ still_queued: [uuid] });

    const error = await rejectionOf(run.interrupt('stop'));
    expect(error.code).toBe('provider_rejected');
    expect(error.details?.reason).toBe('input_still_queued');
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'warning',
      message: 'claude could not recall input that was already submitted; the turn will still run',
    });

    // The turn then runs to completion, and is reported for what it was.
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('does not label a later result interrupted after a failed interrupt', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    fake.failNextInterrupt(new Error('control channel closed'));
    await rejectionOf(run.interrupt('stop'));

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake) });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('surfaces a failed interrupt as a typed rejection and allows an exact retry', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    fake.failNextInterrupt(new Error('control channel closed'));
    const error = await rejectionOf(run.interrupt('stop'));
    expect(error.code).toBe('provider_rejected');

    await run.interrupt('stop');
    expect(fake.interruptCalls).toBe(2);
    expect(fake.returnCalls).toBe(0);
  });
});

describe('claude session disposal', () => {
  it('ends the query once, settles an active run, and stays idempotent', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    await session.dispose();
    await session.dispose();

    expect(fake.returnCalls).toBe(1);
    expect(fake.calls[0]?.options.abortController.signal.aborted).toBe(true);
    const termination = await run.completion;
    expect(termination.outcome).toBe('interrupted');

    const error = await rejectionOf(
      session.startRun({ input: textInput('after'), sink: recordingSink().sink, runRef: 'run-2' }),
    );
    expect(error.code).toBe('session_closed');
  });

  it('fences new runs as soon as disposal starts, not when it finishes', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const release = fake.holdNextReturn();
    const disposal = session.dispose();
    await flush();

    // Input is already closed here; admitting a run would hang it forever.
    const error = await rejectionOf(
      session.startRun({ input: textInput('too late'), sink: recordingSink().sink, runRef: 'run-1' }),
    );
    expect(error.code).toBe('session_closed');

    release();
    await disposal;
  });

  it('coalesces concurrent disposal into one teardown', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const release = fake.holdNextReturn();
    const attempts = [session.dispose(), session.dispose(), session.dispose()];
    await flush();
    release();
    await Promise.all(attempts);

    expect(fake.returnCalls).toBe(1);
  });

  it('settles an active run when the stream ends during a failed disposal', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const run = await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    fake.failNextReturn(new Error('teardown failed'));
    await expect(session.dispose()).rejects.toThrow();
    fake.end();

    // Disposal failed, but the run can never produce a result now: leaving it
    // unsettled would hang the runtime's cleanup instead of failing it.
    const termination = await run.completion;
    expect(termination.outcome).toBe('interrupted');
  });

  it('stays retryable after a rejected disposal', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    await session.startRun({ input: textInput('hi'), sink: recordingSink().sink, runRef: 'run-1' });
    await flush();

    fake.failNextReturn(new Error('teardown failed'));
    await expect(session.dispose()).rejects.toThrow();
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(fake.returnCalls).toBe(2);
  });

  it('rejects an interaction response it never asked for', async () => {
    const fake = createFakeQuery();
    const { session } = await openSession(fake);
    const error = await rejectionOf(
      session.respondToInteraction('whatever', { kind: 'approval', decision: 'approved', mode: 'once' }),
    );
    expect(error.code).toBe('unknown_interaction');
  });
});

describe('claude session options', () => {
  it('applies validated per-session overrides to the SDK call', async () => {
    const fake = createFakeQuery();
    await openSession(fake, { model: 'claude-sonnet-4-6', maxTurns: 3, permissionMode: 'acceptEdits' });
    expect(fake.calls[0]?.options.model).toBe('claude-sonnet-4-6');
    expect(fake.calls[0]?.options.maxTurns).toBe(3);
    expect(fake.calls[0]?.options.permissionMode).toBe('acceptEdits');
    expect(fake.calls[0]?.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('marks a bypassing permission mode explicitly for the SDK', async () => {
    const fake = createFakeQuery();
    await openSession(fake, { permissionMode: 'bypassPermissions' });
    expect(fake.calls[0]?.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it('rejects session options it does not understand', async () => {
    const fake = createFakeQuery();
    const provider = createClaudeProvider({ query: fake.query });
    for (const options of [{ unknownKey: true }, { maxTurns: -1 }, { permissionMode: 'yolo' }]) {
      const error = await rejectionOf(
        provider.createSession({
          options,
          workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
          sink: recordingSink().sink,
        }),
      );
      expect(error.code).toBe('invalid_request');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a workspace it was told not to write into', async () => {
    const fake = createFakeQuery();
    const provider = createClaudeProvider({ query: fake.query });
    const error = await rejectionOf(
      provider.createSession({
        options: {},
        workspace: { root: '', ownership: 'borrowed' },
        sink: recordingSink().sink,
      }),
    );
    expect(error.code).toBe('invalid_request');
  });
});
