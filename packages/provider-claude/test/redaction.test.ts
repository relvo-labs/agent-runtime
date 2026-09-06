/**
 * Public-string containment.
 *
 * Everything an `AgentError` or a `diagnostic` carries is durable, replayable
 * and consumer-visible. The SDK is a separate process whose error prose can
 * contain anything it happened to be holding: a native session id, a bearer
 * credential, an absolute path, or the prompt itself.
 *
 * The rule these tests enforce is structural rather than pattern-based —
 * upstream prose is never copied into a public DTO at all — so a secret shape
 * nobody anticipated still cannot escape.
 */

import { describe, expect, it } from 'vitest';

import type { ProviderEventInput, TurnInput } from '@relvo-labs/agent-protocol';
import { isProviderRejection } from '@relvo-labs/agent-provider';

import { createClaudeProvider } from '../src/index.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';

/** Values that must never appear in a public string, however they arrive. */
const bearer = ['sk', 'ant', 'A'.repeat(28)].join('-');
const opaque = `Bearer ${'Zx9'.repeat(12)}`;
const nativeSessionId = '9f1c0e2a-4b77-4c31-9a2e-2b7c1d5f8e04';
const secretPath = '/home/agent/.claude/credentials.json';
const promptText = 'refactor the billing module and keep the customer list private';
const hostile = `${bearer} ${opaque} session ${nativeSessionId} at ${secretPath} while doing: ${promptText}`;

function expectClean(value: string): void {
  for (const secret of [bearer, opaque, nativeSessionId, secretPath, promptText]) {
    expect(value).not.toContain(secret);
  }
}

function recordingSink() {
  const events: ProviderEventInput[] = [];
  return { events, sink: { emit: (input: ProviderEventInput): void => void events.push(input) } };
}

function textInput(text: string): TurnInput {
  return { parts: [{ type: 'text', text }] };
}

async function startedRun(fake: FakeQuery) {
  const provider = createClaudeProvider({ query: fake.query });
  const sessionRecorder = recordingSink();
  const session = await provider.createSession({
    options: {},
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: sessionRecorder.sink,
  });
  const runRecorder = recordingSink();
  const run = await session.startRun({ input: textInput(promptText), sink: runRecorder.sink, runRef: 'run-1' });
  await flush();
  return { session, run, events: runRecorder.events, sessionEvents: sessionRecorder.events };
}

function publicStrings(events: readonly ProviderEventInput[]): string {
  return JSON.stringify(events);
}

describe('claude public strings', () => {
  it('classifies a failed result instead of copying upstream error prose', async () => {
    const fake = createFakeQuery();
    const { run } = await startedRun(fake);
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [hostile],
      session_id: nativeSessionId,
      user_message_uuid: submittedUuid(fake),
    });

    const termination = await run.completion;
    if (termination.outcome !== 'failed') throw new Error('expected a failed termination');
    expectClean(termination.error.message);
    expectClean(JSON.stringify(termination.error.details ?? {}));
    expect(termination.error.message).toBe('claude ended the turn without completing it (error_during_execution)');
    expect(termination.error.providerCode).toBe('error_during_execution');
  });

  it('refuses to publish an unrecognised result subtype verbatim', async () => {
    const fake = createFakeQuery();
    const { run } = await startedRun(fake);
    fake.push({
      type: 'result',
      subtype: `error_${hostile}`,
      is_error: true,
      user_message_uuid: submittedUuid(fake),
    });

    const termination = await run.completion;
    if (termination.outcome !== 'failed') throw new Error('expected a failed termination');
    expectClean(termination.error.message);
    expectClean(termination.error.providerCode ?? '');
    expect(termination.error.providerCode).toBe('unrecognized_result');
  });

  it('classifies a dead stream without echoing its error text', async () => {
    const fake = createFakeQuery();
    const { run, sessionEvents } = await startedRun(fake);
    const failure = new Error(hostile);
    failure.name = 'ClaudeInternalError';
    fake.fail(failure);

    const termination = await run.completion;
    if (termination.outcome !== 'failed') throw new Error('expected a failed termination');
    expectClean(termination.error.message);
    expectClean(publicStrings(sessionEvents));
    expect(termination.error.code).toBe('provider_unavailable');
    expect(termination.error.message).toBe('the claude query stream failed (unknown)');
  });

  it('names a recognised system cause without any upstream prose', async () => {
    const fake = createFakeQuery();
    const { run } = await startedRun(fake);
    const failure: Error & { code?: string } = new Error(hostile);
    failure.code = 'EPIPE';
    fake.fail(failure);

    const termination = await run.completion;
    if (termination.outcome !== 'failed') throw new Error('expected a failed termination');
    expectClean(termination.error.message);
    expect(termination.error.message).toBe('the claude query stream failed (EPIPE)');
  });

  it('classifies interrupt and teardown failures', async () => {
    const fake = createFakeQuery();
    const { session, run } = await startedRun(fake);

    fake.failNextInterrupt(new Error(hostile));
    const interruptError = await rejection(run.interrupt('stop'));
    expectClean(interruptError);
    expect(interruptError).toBe('claude did not accept the interrupt (unknown)');

    fake.failNextReturn(new Error(hostile));
    const disposeError = await rejection(session.dispose());
    expectClean(disposeError);
    expect(disposeError).toBe('claude query teardown failed (unknown)');
  });

  it('bounds an assistant-level error to the SDK’s declared set', async () => {
    const fake = createFakeQuery();
    const { run, events } = await startedRun(fake);
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
      error: hostile,
      user_message_uuid: submittedUuid(fake),
    });
    await flush();

    expectClean(publicStrings(events));
    expect(events.map((event) => event.payload)).toEqual([
      { type: 'diagnostic', level: 'warning', message: 'claude reported an assistant error: unknown' },
    ]);

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake) });
    await run.completion;
  });

  it('sanitises a tool name before publishing it', async () => {
    const fake = createFakeQuery();
    const { run, events } = await startedRun(fake);
    fake.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: `mcp__vault__read ${bearer}`, input: {} }],
      },
      user_message_uuid: submittedUuid(fake),
    });
    await flush();

    expectClean(publicStrings(events));
    expect(events.map((event) => event.payload)).toEqual([
      { type: 'run.tool_activity', toolName: 'mcp__vault__read [redacted]', phase: 'invoked' },
    ]);

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake) });
    await run.completion;
  });

  it('does not echo an unknown interaction reference back into a public error', async () => {
    const fake = createFakeQuery();
    const { session } = await startedRun(fake);
    const message = await rejection(
      session.respondToInteraction(hostile, { kind: 'approval', decision: 'approved', mode: 'once' }),
    );
    expectClean(message);
    expectClean(JSON.stringify(await rejectionDetails(session, hostile)));
  });
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isProviderRejection(error)) return error.agentError.message;
    throw error;
  }
  throw new Error('expected a typed provider rejection');
}

async function rejectionDetails(
  session: { respondToInteraction(ref: string, response: never): Promise<void> },
  ref: string,
): Promise<unknown> {
  try {
    await session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' } as never);
  } catch (error) {
    if (isProviderRejection(error)) return error.agentError.details ?? {};
    throw error;
  }
  throw new Error('expected a typed provider rejection');
}
