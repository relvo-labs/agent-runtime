/**
 * The host approval bridge.
 *
 * Every test here drives the *real* adapter through the deterministic query
 * seam: no credentials, no network, no process, and no timer decides ordering.
 * The SDK's permission callback is invoked exactly the way the pinned SDK
 * invokes it — `fake.requestPermission()` calls whatever the adapter installed
 * as `canUseTool`, and throws when it installed nothing, so "no permission
 * surface" can never be mistaken for "the tool was allowed".
 *
 * The property under test throughout is one-directional: a tool call proceeds
 * only after a matching neutral approval response says `approved` / `once`.
 * Everything else — unknown, stale, cross-session, conflicting, unsupported,
 * unattributable, torn down — denies.
 */

import { describe, expect, it } from 'vitest';

import {
  ProviderEventInputSchema,
  type AgentError,
  type InteractionResponse,
  type JsonObject,
  type ProviderEventInput,
  type ProviderEventPayload,
  type TurnInput,
} from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { createClaudeProvider } from '../src/index.ts';
import type { ClaudePermissionResult } from '../src/seam.ts';
import { createFakeQuery, flush, submittedUuid, type FakeQuery } from './fake-query.ts';

const WORKSPACE_ROOT = '/tmp/relvo-claude-workspace';
const APPROVED_ONCE = { kind: 'approval', decision: 'approved', mode: 'once' } as const;

type ApprovalRequested = Extract<ProviderEventPayload, { type: 'interaction.requested' }>;

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

function requestsIn(events: readonly ProviderEventInput[]): readonly ApprovalRequested[] {
  return events
    .map((event) => event.payload)
    .filter((payload): payload is ApprovalRequested => payload.type === 'interaction.requested');
}

/** The single approval the run raised, failing loudly when there is not one. */
function soleRequest(events: readonly ProviderEventInput[]): ApprovalRequested {
  const requests = requestsIn(events);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request === undefined) throw new Error('no interaction was requested');
  return request;
}

/**
 * Observe whether a promise has settled without waiting on it, so "still
 * pending" is asserted at a defined quiescent point rather than by a timer.
 */
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

type Bridged = {
  session: ProviderSession;
  run: ProviderRun;
  events: ProviderEventInput[];
  sessionEvents: ProviderEventInput[];
};

async function openBridged(
  fake: FakeQuery,
  options: JsonObject = {},
): Promise<{ session: ProviderSession; sessionEvents: ProviderEventInput[] }> {
  const provider = createClaudeProvider({ query: fake.query, approvals: 'bridge' });
  const recorder = recordingSink();
  const session = await provider.createSession({
    options,
    workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
    sink: recorder.sink,
  });
  return { session, sessionEvents: recorder.events };
}

/**
 * A bridged session with one run whose turn is already bound to the stream, so
 * a permission callback is attributable — the state a tool prompt actually
 * arrives in, since the SDK stamps the turn's first reply frame.
 */
async function boundRun(fake: FakeQuery): Promise<Bridged> {
  const { session, sessionEvents } = await openBridged(fake);
  const recorder = recordingSink();
  const run = await session.startRun({ input: textInput('do work'), sink: recorder.sink, runRef: 'run-1' });
  await flush();
  fake.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    user_message_uuid: submittedUuid(fake, 0),
  });
  await flush();
  return { session, run, events: recorder.events, sessionEvents };
}

/** Ask for permission and read back the reference the run raised for it. */
async function ask(
  fake: FakeQuery,
  bridged: Bridged,
  toolName = 'Bash',
  input: Record<string, unknown> = { command: 'rm -rf /srv/secrets' },
): Promise<{ decision: Promise<ClaudePermissionResult>; providerRef: string; request: ApprovalRequested }> {
  const decision = fake.requestPermission(toolName, input);
  await flush();
  const request = soleRequest(bridged.events);
  return { decision, providerRef: request.providerRef, request };
}

describe('claude approval capability', () => {
  it('declares no approval and offers no permission surface by default', async () => {
    const fake = createFakeQuery();
    const provider = createClaudeProvider({ query: fake.query });
    const descriptor = provider.describe();
    expect(descriptor.interaction.approval).toEqual({ supported: false, modes: [], blocking: true });
    expect(descriptor.interaction.question.supported).toBe(false);

    await provider.createSession({
      options: {},
      workspace: { root: WORKSPACE_ROOT, ownership: 'borrowed' },
      sink: recordingSink().sink,
    });
    expect(fake.calls[0]?.options.permissionPrompts).toBe('none');
    expect(fake.calls[0]?.options.canUseTool).toBeUndefined();
  });

  it('declares blocking `once` approval and installs the host callback when bridged', async () => {
    const fake = createFakeQuery();
    const descriptor = createClaudeProvider({ query: fake.query, approvals: 'bridge' }).describe();
    expect(descriptor.interaction.approval).toEqual({ supported: true, modes: ['once'], blocking: true });
    // Bridging approvals claims nothing about questions: the two bridges are
    // separate options, and `questions: 'bridge'` is what declares this block.
    expect(descriptor.interaction.question).toEqual({
      supported: false,
      choices: false,
      multiSelect: false,
      batch: false,
      maxQuestions: null,
      freeText: false,
      sensitive: false,
    });
    expect(descriptor.interaction.settlementTimeoutMs).toBeNull();

    await openBridged(fake);
    expect(fake.calls[0]?.options.permissionPrompts).toBe('host');
    expect(typeof fake.calls[0]?.options.canUseTool).toBe('function');
  });
});

describe('claude approval bridge', () => {
  it('allows a tool only after a matching `once` approval, and names no native identity', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef, request } = await ask(fake, bridged);

    expect(request.request).toEqual({
      kind: 'approval',
      subject: { category: 'command', summary: 'claude requests approval to use the `Bash` tool' },
      allowedModes: ['once'],
      riskHint: 'medium',
    });
    // Neither the tool's arguments nor the SDK's tool-use id may reach the log.
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('secrets');
    expect(serialized).not.toContain('toolu_');
    expect(providerRef).not.toContain('toolu_');

    await expect(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE)).resolves.toBeUndefined();
    await expect(decision).resolves.toEqual({ behavior: 'allow' });

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('classifies the action for a host without describing it', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const decisions: Promise<ClaudePermissionResult>[] = [];
    for (const toolName of ['Write', 'WebFetch', 'Read']) {
      decisions.push(fake.requestPermission(toolName, { path: '/etc/shadow' }));
    }
    await flush();

    expect(requestsIn(bridged.events).map((payload) => payload.request)).toMatchObject([
      { subject: { category: 'file_write', summary: 'claude requests approval to use the `Write` tool' } },
      { subject: { category: 'network' } },
      { subject: { category: 'tool' } },
    ]);
    expect(JSON.stringify(bridged.events)).not.toContain('shadow');

    // Every one of them is a separate, separately settled request.
    const refs = requestsIn(bridged.events).map((payload) => payload.providerRef);
    expect(new Set(refs).size).toBe(3);
    await bridged.session.dispose();
    await Promise.all(decisions.map(async (decision) => expect(decision).resolves.toMatchObject({ behavior: 'deny' })));
  });

  it('denies when the host denies, and shows the model the host reason', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.session.respondToInteraction(providerRef, {
      kind: 'approval',
      decision: 'denied',
      reason: 'not on production data',
    });
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'not on production data' });
  });

  it('denies without a reason rather than inventing one', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'denied' });
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'the host denied this tool use' });
  });
});

describe('claude approval settlement failures', () => {
  it('rejects an approval mode it does not implement without settling the callback', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    for (const mode of ['session', 'persistent'] as const) {
      const error = await rejectionOf(
        bridged.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode }),
      );
      expect(error.code).toBe('capability_unsupported');
      expect(error.details).toEqual({ capability: 'interaction.approval.modes', supported: ['once'] });
    }

    // Still pending: a refused response must not consume the one settlement.
    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('rejects an approval that states no mode', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved' }),
    );
    expect(error.code).toBe('invalid_request');

    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('rejects a response of the wrong kind without settling the callback', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, { kind: 'question', answer: 'sure' }),
    );
    expect(error.code).toBe('capability_unsupported');

    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('rejects an unknown reference without echoing it', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    // A reference is caller-controlled text, so it may itself be sensitive.
    const callerRef = 'approval-from-a-caller-carrying-s3nsitive-text';

    const error = await rejectionOf(bridged.session.respondToInteraction(callerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');
    expect(JSON.stringify(error)).not.toContain('s3nsitive');
  });

  it('keeps two sessions holding simultaneous approvals isolated from each other', async () => {
    // Both sessions are at the same point in their own lives — each holding its
    // first pending approval — so a reference namespace shared by construction
    // would let one session's answer settle the other's tool call. The property
    // has to hold in the adapter, not only in the runtime's per-session routing.
    const firstFake = createFakeQuery();
    const secondFake = createFakeQuery();
    const first = await boundRun(firstFake);
    const second = await boundRun(secondFake);
    const a = await ask(firstFake, first, 'Bash');
    const b = await ask(secondFake, second, 'Write');
    expect(a.providerRef).not.toBe(b.providerRef);

    const pendingB = pendingMarker(b.decision);
    const error = await rejectionOf(second.session.respondToInteraction(a.providerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');
    expect(JSON.stringify(error)).not.toContain(a.providerRef);
    await flush();
    // The second session's own callback must still be waiting for its answer.
    expect(pendingB.settled).toBe(false);

    // And each still settles correctly on the session that raised it.
    await first.session.respondToInteraction(a.providerRef, APPROVED_ONCE);
    await expect(a.decision).resolves.toEqual({ behavior: 'allow' });
    await second.session.respondToInteraction(b.providerRef, { kind: 'approval', decision: 'denied' });
    await expect(b.decision).resolves.toEqual({ behavior: 'deny', message: 'the host denied this tool use' });

    await first.session.dispose();
    await second.session.dispose();
  });

  it('does not echo a caller-controlled kind or mode into a durable error', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    // A host driving the SPI directly is not bound by the runtime's schema, so
    // these fields are caller text exactly as `providerRef` is.
    const hostile = [
      { kind: 'question', answer: 'sure' } as unknown as InteractionResponse,
      { kind: 'w1ldkind', answer: 'sure' } as unknown as InteractionResponse,
      { kind: 'approval', decision: 'approved', mode: 'm0de-with-secrets' } as unknown as InteractionResponse,
    ];
    for (const response of hostile) {
      const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, response));
      expect(error.code).toBe('capability_unsupported');
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('w1ldkind');
      expect(serialized).not.toContain('m0de-with-secrets');
    }

    // None of them consumed the settlement.
    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('treats an identical redelivery as a no-op and refuses a conflicting one', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE)).resolves.toBeUndefined();
    await expect(decision).resolves.toEqual({ behavior: 'allow' });

    const error = await rejectionOf(
      bridged.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'denied' }),
    );
    expect(error.code).toBe('interaction_already_settled');
  });
});

describe('claude approval attribution', () => {
  it('denies a permission request that belongs to no run of this session', async () => {
    const fake = createFakeQuery();
    const { session, sessionEvents } = await openBridged(fake);

    await expect(fake.requestPermission('Bash')).resolves.toEqual({
      behavior: 'deny',
      message: 'this session has no run that can be asked to approve tool use',
    });
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'debug',
      message: 'claude asked for tool permission outside an attributable run; it was denied',
    });
    await session.dispose();
  });

  it('announces unattributable permission traffic once, however much of it arrives', async () => {
    // The producer is an external process: a loop of prompts this session
    // cannot attribute must not be able to grow a durable event log.
    const fake = createFakeQuery();
    const { session, sessionEvents } = await openBridged(fake);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(fake.requestPermission('Bash')).resolves.toMatchObject({ behavior: 'deny' });
    }
    expect(
      sessionEvents.filter(
        (event) => event.payload.type === 'diagnostic' && event.payload.message.includes('outside an attributable run'),
      ),
    ).toHaveLength(1);
    await session.dispose();
  });

  it('raises no new approval once the run is being stopped', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);

    const release = fake.holdNextInterrupt();
    const interrupting = bridged.run.interrupt('stop');
    await flush();
    // The runtime treats an interaction raised after interruption begins as a
    // contract violation and will not route it, so the prompt would wait for an
    // answer that can never arrive.
    await expect(fake.requestPermission('Bash')).resolves.toMatchObject({ behavior: 'deny' });
    expect(requestsIn(bridged.events)).toHaveLength(0);

    release();
    await interrupting;
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['interrupted'],
      user_message_uuid: submittedUuid(fake, 0),
    });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'interrupted', reason: 'stop' });
  });

  it('resumes raising approvals when a refused stop withdraws its intent', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    // The submitted input survived the stop, so the turn still runs — and a
    // tool it then asks about is a tool this run really is about to use.
    fake.setInterruptReceipt({ still_queued: [submittedUuid(fake, 0)] });
    await rejectionOf(bridged.run.interrupt('stop'));

    const { decision, providerRef } = await ask(fake, bridged);
    await bridged.session.respondToInteraction(providerRef, APPROVED_ONCE);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('denies a permission request while the stream is bound to another turn', async () => {
    const fake = createFakeQuery();
    const { session, sessionEvents } = await openBridged(fake);
    const recorder = recordingSink();
    const run = await session.startRun({ input: textInput('mine'), sink: recorder.sink, runRef: 'run-1' });
    await flush();
    // A background or scheduled turn owns the wire; its tool call must not be
    // attributed to — or approved on behalf of — the run in front of it.
    fake.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'other turn' }] },
      user_message_uuid: '00000000-0000-4000-8000-00000000beef',
    });
    await flush();

    await expect(fake.requestPermission('Bash')).resolves.toMatchObject({ behavior: 'deny' });
    expect(requestsIn(recorder.events)).toHaveLength(0);
    expect(sessionEvents.map((event) => event.payload)).toContainEqual({
      type: 'diagnostic',
      level: 'debug',
      message: 'claude asked for tool permission outside an attributable run; it was denied',
    });

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });
});

describe('claude approval lifecycle', () => {
  /** Every terminal path must leave no pending callback and no live reference. */
  async function expectTornDown(
    session: ProviderSession,
    decision: Promise<ClaudePermissionResult>,
    providerRef: string,
  ): Promise<void> {
    await expect(decision).resolves.toEqual({
      behavior: 'deny',
      message: 'the run that asked for this approval ended before it was answered',
    });
    const error = await rejectionOf(session.respondToInteraction(providerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');
  }

  it('denies a pending approval when the turn completes on its own', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'succeeded' });
    await expectTornDown(bridged.session, decision, providerRef);
  });

  it('denies a pending approval when the run is interrupted', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.run.interrupt('user asked to stop');
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['interrupted'],
      user_message_uuid: submittedUuid(fake, 0),
    });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'interrupted', reason: 'user asked to stop' });
    await expectTornDown(bridged.session, decision, providerRef);
  });

  it('denies a pending approval when the stream ends without a result', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.end();
    const termination = await bridged.run.completion;
    expect(termination.outcome).toBe('failed');
    await expectTornDown(bridged.session, decision, providerRef);
  });

  it('denies a pending approval when the stream fails', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.fail(new Error('claude process exited with code 1'));
    const termination = await bridged.run.completion;
    expect(termination.outcome).toBe('failed');
    await expectTornDown(bridged.session, decision, providerRef);
  });

  it('denies a pending approval when the session is disposed, and stays disposed', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    await bridged.session.dispose();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    const termination = await bridged.run.completion;
    expect(termination.outcome).toBe('interrupted');

    const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');
  });

  it('settles a prompt the SDK itself cancelled, and refuses the reference afterwards', async () => {
    // The pinned SDK cancels an outstanding permission control request by
    // aborting that request's own signal; it keeps awaiting this promise, so a
    // bridge that ignores the signal leaves the host holding a prompt nobody is
    // listening to any more.
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);
    const pending = pendingMarker(decision);
    await flush();
    expect(pending.settled).toBe(false);

    fake.cancelPermission();
    await expect(decision).resolves.toEqual({
      behavior: 'deny',
      message: 'claude withdrew this permission request before it was answered',
    });

    // The reference is retired: a late answer settles nothing, and no
    // auto-allow appears on the cancellation path.
    const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');

    // The run is untouched and still finishes on its own terms.
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('denies a prompt that is already cancelled when it arrives', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);

    await expect(fake.requestPermission('Bash', {}, { aborted: true })).resolves.toMatchObject({ behavior: 'deny' });
    // Nothing was raised for a request that was already withdrawn.
    expect(requestsIn(bridged.events)).toHaveLength(0);
  });

  it('settles a cancelled prompt exactly once, whatever order teardown arrives in', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.cancelPermission();
    fake.cancelPermission();
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    // Run teardown must not try to settle the same callback a second time.
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await expect(bridged.run.completion).resolves.toEqual({ outcome: 'succeeded' });
    const error = await rejectionOf(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE));
    expect(error.code).toBe('unknown_interaction');
  });

  it('raises no approval while the session is disposing', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const release = fake.holdNextReturn();
    const disposal = bridged.session.dispose();
    await flush();

    await expect(fake.requestPermission('Bash')).resolves.toMatchObject({ behavior: 'deny' });
    expect(requestsIn(bridged.events)).toHaveLength(0);

    release();
    await disposal;
  });

  it('raises no approval in the retry window after a rejected disposal', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    fake.failNextReturn(new Error('teardown failed'));
    await expect(bridged.session.dispose()).rejects.toThrow();

    await expect(fake.requestPermission('Bash')).resolves.toMatchObject({ behavior: 'deny' });
    expect(requestsIn(bridged.events)).toHaveLength(0);

    // Disposal is still retryable to success, unchanged by the refusal above.
    await expect(bridged.session.dispose()).resolves.toBeUndefined();
  });

  it('does not let a late approval resurrect a finished run', async () => {
    const fake = createFakeQuery();
    const bridged = await boundRun(fake);
    const { decision, providerRef } = await ask(fake, bridged);

    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 0) });
    await bridged.run.completion;
    await decision;

    await rejectionOf(bridged.session.respondToInteraction(providerRef, APPROVED_ONCE));
    // The next run is a clean slate: no reference, no callback, no state from
    // the approval the finished run never got an answer to.
    const recorder = recordingSink();
    const next = await bridged.session.startRun({ input: textInput('next'), sink: recorder.sink, runRef: 'run-2' });
    await flush();
    const second = fake.requestPermission('Bash');
    await flush();
    const request = soleRequest(recorder.events);
    expect(request.providerRef).not.toBe(providerRef);

    await bridged.session.respondToInteraction(request.providerRef, APPROVED_ONCE);
    await expect(second).resolves.toEqual({ behavior: 'allow' });
    fake.push({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: submittedUuid(fake, 1) });
    await expect(next.completion).resolves.toEqual({ outcome: 'succeeded' });
  });
});
