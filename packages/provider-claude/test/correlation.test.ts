/**
 * Turn correlation.
 *
 * One SDK query carries the whole session, so its message stream is shared by
 * every turn this adapter submits *and* by turns it never submitted: background
 * tasks, scheduled/synthetic turns, and — after a stop that could not recall an
 * already-submitted message — its own retired input.
 *
 * The pinned SDK (0.3.259) makes those distinguishable: a client uuid stamped on
 * a submitted user message comes back as `user_message_uuid` on the turn's first
 * reply frame and on its result (`user_message_uuids` when a batch was
 * coalesced). These tests hold the adapter to that contract: a frame that is not
 * this run's may never emit into it, and may never complete it.
 */

import { describe, expect, it } from 'vitest';

import type { ProviderEventInput, TurnInput } from '@relvo-labs/agent-protocol';
import type { ProviderRun } from '@relvo-labs/agent-provider';

import { createClaudeProvider } from '../src/index.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';

function recordingSink() {
  const events: ProviderEventInput[] = [];
  return { events, sink: { emit: (input: ProviderEventInput): void => void events.push(input) } };
}

function textInput(text: string): TurnInput {
  return { parts: [{ type: 'text', text }] };
}

async function session(fake: FakeQuery) {
  const provider = createClaudeProvider({ query: fake.query });
  const sessionEvents = recordingSink();
  const providerSession = await provider.createSession({
    options: {},
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: sessionEvents.sink,
  });
  return { providerSession, sessionEvents: sessionEvents.events };
}

describe('claude turn correlation', () => {
  it('stamps every submitted message with a client uuid and never emits it', async () => {
    const fake = createFakeQuery();
    const { providerSession } = await session(fake);
    const recorder = recordingSink();
    const run = await providerSession.startRun({ input: textInput('hello'), sink: recorder.sink, runRef: 'run-1' });
    await flush();

    const uuid = submittedUuid(fake, 0);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      user_message_uuid: uuid,
    });
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(JSON.stringify(recorder.events)).not.toContain(uuid);
  });

  it('refuses to let a background turn result complete the current run', async () => {
    const fake = createFakeQuery();
    const { providerSession, sessionEvents } = await session(fake);

    const first = await providerSession.startRun({
      input: textInput('first'),
      sink: recordingSink().sink,
      runRef: 'run-1',
    });
    await flush();
    const firstUuid = submittedUuid(fake, 0);
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: firstUuid });
    await first.completion;

    const recorder = recordingSink();
    const second = await providerSession.startRun({
      input: textInput('second'),
      sink: recorder.sink,
      runRef: 'run-2',
    });
    await flush();
    const secondUuid = submittedUuid(fake, 1);

    // A scheduled/background turn: no client uuid at all.
    fake.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cron work' }] } });
    fake.push({ type: 'result', subtype: 'success', is_error: false });
    // A stale frame belonging to the run that already finished.
    fake.push({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuid: firstUuid });
    await flush();

    expect(await settled(second)).toBe(false);
    expect(recorder.events).toEqual([]);

    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mine' }] },
      user_message_uuid: secondUuid,
    });
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: secondUuid });
    await expect(second.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(recorder.events.map((event) => event.payload)).toEqual([{ type: 'run.message_delta', text: 'mine' }]);
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'debug',
      message: 'claude emitted a turn that does not belong to the active run; its output is not attributed',
    });
  });

  it('keeps a foreign turn’s later, unstamped frames out of the run', async () => {
    const fake = createFakeQuery();
    const { providerSession } = await session(fake);
    const recorder = recordingSink();
    const run = await providerSession.startRun({ input: textInput('mine'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);

    // Bind to this run, then let a foreign turn take over the stream.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mine-1' }] },
      user_message_uuid: uuid,
    });
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'foreign-1' }] },
      user_message_uuid: '11111111-1111-4111-8111-111111111111',
    });
    // Later frames of a turn carry no stamp; they must follow the foreign turn.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] },
    });
    fake.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'foreign-2' }] } });
    await flush();

    expect(recorder.events.map((event) => event.payload)).toEqual([{ type: 'run.message_delta', text: 'mine-1' }]);

    // The run's own turn resumes when its stamp reappears.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'mine-2' }] },
      user_message_uuid: uuid,
    });
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: uuid });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(recorder.events.map((event) => event.payload)).toEqual([
      { type: 'run.message_delta', text: 'mine-1' },
      { type: 'run.message_delta', text: 'mine-2' },
    ]);
  });

  it('correlates a turn that coalesced a batch of submitted messages', async () => {
    const fake = createFakeQuery();
    const { providerSession } = await session(fake);
    const recorder = recordingSink();
    const run = await providerSession.startRun({ input: textInput('batched'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    const uuid = submittedUuid(fake, 0);

    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'batched reply' }] },
      user_message_uuids: ['22222222-2222-4222-8222-222222222222', uuid],
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuids: ['22222222-2222-4222-8222-222222222222', uuid],
    });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(recorder.events.map((event) => event.payload)).toEqual([
      { type: 'run.message_delta', text: 'batched reply' },
    ]);
  });

  it('still works against a producer that never stamps a client uuid', async () => {
    // Older CLIs omit the correlation fields entirely. Requiring a stamp that
    // can never arrive would hang every run, so the adapter stays in the
    // legacy single-turn mode until it observes the producer stamping.
    const fake = createFakeQuery();
    const { providerSession } = await session(fake);
    const recorder = recordingSink();
    const run = await providerSession.startRun({ input: textInput('legacy'), sink: recorder.sink, runRef: 'run-1' });
    await flush();

    fake.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'legacy reply' }] } });
    fake.push({ type: 'result', subtype: 'success', is_error: false });

    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
    expect(recorder.events.map((event) => event.payload)).toEqual([
      { type: 'run.message_delta', text: 'legacy reply' },
    ]);
  });
});

/** Whether a run's completion has already settled, without hanging on it. */
async function settled(run: ProviderRun): Promise<boolean> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([run.completion, new Promise((resolve) => setImmediate(() => resolve(pending)))]);
  return outcome !== pending;
}
