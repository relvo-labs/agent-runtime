/**
 * The approval bridge, end to end, with no process and no credentials.
 *
 * The properties that matter most here are the ones an event log cannot show
 * you afterwards: a native approval callback is executed **at most once** and
 * **never without an explicit host grant**, a request that cannot be mapped
 * losslessly is declined on its own native request id rather than half-mapped,
 * and no callback outlives the run that raised it.
 *
 * Every frame is pushed by hand through the transport seam, so each ordering
 * below is a fact about the adapter rather than a race that happened to settle
 * the right way.
 */

import { describe, expect, it } from 'vitest';

import { ProviderEventInputSchema, type JsonObject, type ProviderEventInput } from '@relvo-labs/agent-protocol';
import { isProviderRejection, type ProviderRun, type ProviderSession } from '@relvo-labs/agent-provider';

import { createCodexProvider } from '../src/index.ts';
import { MAX_TRACKED_APPROVALS } from '../src/interaction.ts';
import type { CodexProviderOptions } from '../src/options.ts';
import {
  FAKE_THREAD_ID,
  FAKE_TURN_ID,
  FIXTURE_BEARER,
  createFakeTransport,
  defaultResponders,
  flush,
  turnCompleted,
  type FakeTransport,
  type Responder,
} from './fake-transport.ts';
import type { CodexClientMessage, CodexRequestId } from '../src/seam.ts';

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
        // The runtime parses synchronously during `emit`, so an interaction
        // this adapter could not actually emit must fail here, in the test.
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

async function openSession(
  options: Omit<CodexProviderOptions, 'transport'> = {},
  responders?: Record<string, Responder>,
): Promise<Opened> {
  const fake = createFakeTransport(responders === undefined ? {} : { responders });
  const provider = createCodexProvider({ approvals: 'bridge', ...options, transport: () => fake.transport });
  const sessionSink = createSink();
  const session = await provider.createSession({
    options: {} satisfies JsonObject,
    workspace: { root: '/workspace', ownership: 'borrowed' },
    sink: sessionSink.sink,
  });
  return { fake, session, sessionSink, runSink: createSink() };
}

async function startRun(opened: Opened): Promise<ProviderRun> {
  return opened.session.startRun({
    input: { parts: [{ type: 'text', text: 'tidy the workspace' }] },
    sink: opened.runSink.sink,
    runRef: 'run-ref-1',
  });
}

/** A session with one bound, running turn — the only state that admits one. */
async function running(options: Omit<CodexProviderOptions, 'transport'> = {}): Promise<Opened & { run: ProviderRun }> {
  const opened = await openSession(options);
  const run = await startRun(opened);
  return { ...opened, run };
}

const APPROVAL_METHOD = 'item/commandExecution/requestApproval';
const APPROVAL_ID = 501;

/** A well-formed `CommandExecutionRequestApprovalParams` for the active turn. */
function approvalFrame(overrides: Record<string, unknown> = {}, id: CodexRequestId = APPROVAL_ID): unknown {
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
      ...overrides,
    },
  };
}

/** Reply frames the adapter wrote for one native id. A reply carries no method. */
function repliesTo(fake: FakeTransport, id: CodexRequestId): readonly CodexClientMessage[] {
  return fake.sent.filter((message) => 'id' in message && message.id === id && !('method' in message));
}

function soleInteraction(sink: Sink): { readonly providerRef: string; readonly request: Record<string, unknown> } {
  const raised = sink.ofType('interaction.requested');
  expect(raised).toHaveLength(1);
  const payload = raised[0]?.payload as { providerRef: string; request: Record<string, unknown> };
  return { providerRef: payload.providerRef, request: payload.request };
}

/** Raise one approval on the active run and return its adapter reference. */
async function raise(opened: Opened, frame: unknown = approvalFrame()): Promise<string> {
  opened.fake.push(frame);
  await flush();
  return soleInteraction(opened.runSink).providerRef;
}

// ---------------------------------------------------------------------------
// A1 — capability truth and the pinned mapping table
// ---------------------------------------------------------------------------

describe('capability truth', () => {
  it('claims no interaction at all by default', async () => {
    const descriptor = createCodexProvider().describe();
    expect(descriptor.interaction.approval).toEqual({ supported: false, modes: [], blocking: true });
    expect(descriptor.interaction.question.supported).toBe(false);

    // …and the default posture still tells the server never to ask.
    const fake = createFakeTransport();
    const provider = createCodexProvider({ transport: () => fake.transport });
    await provider.createSession({
      options: {},
      workspace: { root: '/workspace', ownership: 'borrowed' },
      sink: createSink().sink,
    });
    expect(fake.requests('thread/start')[0]?.params).toMatchObject({ approvalPolicy: 'never' });
  });

  it('claims exactly the approval modes it can encode when bridging', async () => {
    const descriptor = createCodexProvider({ approvals: 'bridge' }).describe();
    expect(descriptor.interaction.approval).toEqual({
      supported: true,
      // `accept` and `acceptForSession`. `persistent` would need the
      // execpolicy-amendment decision variant, which is not bridged.
      modes: ['once', 'session'],
      blocking: true,
    });
    // No question shape in the pinned stable surface is bridged.
    expect(descriptor.interaction.question).toEqual({ supported: false, choices: false, multiSelect: false });
    expect(descriptor.interaction.settlementTimeoutMs).toBeNull();

    const { fake } = await openSession();
    expect(fake.requests('thread/start')[0]?.params).toMatchObject({ approvalPolicy: 'on-request' });
  });

  it('states that a denial reason cannot reach the model on this protocol', () => {
    const descriptor = createCodexProvider({ approvals: 'bridge' }).describe();
    // `CommandExecutionRequestApprovalResponse` carries `decision` and nothing
    // else, so a host's denial reason is not transmissible. Declared, not
    // silently dropped.
    expect(descriptor.extensions.approvalDenialReasonDelivered).toBe(false);
    expect(descriptor.extensions.bridgedServerRequests).toEqual([APPROVAL_METHOD]);
  });
});

// ---------------------------------------------------------------------------
// A2 — approvals fail closed
// ---------------------------------------------------------------------------

describe('approval request', () => {
  it('raises exactly one neutral approval on the run that owns the turn', async () => {
    const opened = await running();
    opened.fake.push(approvalFrame());
    await flush();

    // Nothing is answered yet: the host decides, and the server waits.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);
    // It belongs to the run's sink, not the session's.
    expect(opened.sessionSink.ofType('interaction.requested')).toHaveLength(0);

    const { request, providerRef } = soleInteraction(opened.runSink);
    expect(request).toMatchObject({
      kind: 'approval',
      allowedModes: ['once', 'session'],
      subject: { category: 'command' },
    });
    const subject = request.subject as { summary: string; detail?: Record<string, unknown> };
    // The reviewable subject is carried faithfully — that is the whole point of
    // asking a human — but native identity is not.
    expect(subject.detail).toMatchObject({ command: 'rm -rf ./build', cwd: '/workspace/project' });
    expect(subject.summary).toContain('rm -rf ./build');

    const serialized = JSON.stringify(opened.runSink.events);
    expect(serialized).not.toContain(FAKE_THREAD_ID);
    expect(serialized).not.toContain(FAKE_TURN_ID);
    expect(serialized).not.toContain('item-approval-1');
    expect(providerRef).not.toContain(FAKE_TURN_ID);
    expect(providerRef).not.toContain(String(APPROVAL_ID));
  });

  it('applies approve once, denies, and grants a session mode — each exactly once', async () => {
    for (const [response, decision] of [
      [{ kind: 'approval' as const, decision: 'approved' as const, mode: 'once' as const }, 'accept'],
      [{ kind: 'approval' as const, decision: 'approved' as const, mode: 'session' as const }, 'acceptForSession'],
      [{ kind: 'approval' as const, decision: 'denied' as const }, 'decline'],
    ] as const) {
      const opened = await running();
      const providerRef = await raise(opened);
      await expect(opened.session.respondToInteraction(providerRef, response)).resolves.toBeUndefined();
      await flush();
      expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision } }]);
    }
  });

  it('never auto-approves: a denial is `decline`, which does not interrupt the turn', async () => {
    const opened = await running();
    const providerRef = await raise(opened);
    await opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'denied' });
    await flush();
    // `cancel` would also deny, but it interrupts the turn as a side effect.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    expect(opened.fake.requests('turn/interrupt')).toHaveLength(0);
  });

  it('refuses a mode it cannot encode and leaves the approval answerable', async () => {
    const opened = await running();
    const providerRef = await raise(opened);

    await expect(
      opened.session.respondToInteraction(providerRef, {
        kind: 'approval',
        decision: 'approved',
        mode: 'persistent',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'capability_unsupported',
    );
    // Validation happened before settlement was consumed.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).resolves.toBeUndefined();
    await flush();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'accept' } }]);
  });

  it('refuses a wrong-kind response and an approval with no mode', async () => {
    const opened = await running();
    const providerRef = await raise(opened);

    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'question', answer: 'yes' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'capability_unsupported',
    );
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved' }),
    ).rejects.toSatisfy((error: unknown) => isProviderRejection(error) && error.agentError.code === 'invalid_request');
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);
  });

  it('treats identical redelivery as a no-op and a conflicting answer as a conflict', async () => {
    const opened = await running();
    const providerRef = await raise(opened);
    const approve = { kind: 'approval' as const, decision: 'approved' as const, mode: 'once' as const };

    await opened.session.respondToInteraction(providerRef, approve);
    await opened.session.respondToInteraction(providerRef, approve);
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'denied' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'interaction_already_settled',
    );
    await flush();
    // One grant, one native callback. Ever.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });

  it('does not echo a caller-supplied reference into a durable error', async () => {
    const opened = await running();
    await expect(
      opened.session.respondToInteraction(FIXTURE_BEARER, { kind: 'approval', decision: 'denied' }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isProviderRejection(error) &&
        error.agentError.code === 'unknown_interaction' &&
        !JSON.stringify(error.agentError).includes(FIXTURE_BEARER)
      );
    });
  });
});

// ---------------------------------------------------------------------------
// A1/A3 — everything that does not map is declined on its own native id
// ---------------------------------------------------------------------------

describe('unsupported native requests', () => {
  it.each([
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'applyPatchApproval',
    'execCommandApproval',
  ])('declines `%s` once, with no interaction raised', async (method) => {
    const opened = await running();
    opened.fake.push({ id: 900, method, params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID } });
    await flush();

    expect(repliesTo(opened.fake, 900)).toMatchObject([{ id: 900, error: { code: -32601 } }]);
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
  });

  it('never chooses one question out of many, and answers none of them', async () => {
    const opened = await running();
    opened.fake.push({
      id: 901,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: 'item-q',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          { id: 'q1', header: 'Branch', question: 'Which branch?', isOther: false, isSecret: false, options: null },
          { id: 'q2', header: 'Force', question: 'Force push?', isOther: false, isSecret: false, options: null },
        ],
      },
    });
    await flush();

    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    const replies = repliesTo(opened.fake, 901);
    expect(replies).toMatchObject([{ id: 901, error: { code: -32601 } }]);
    // Not a partial answer, and not an empty one either.
    expect(JSON.stringify(replies)).not.toContain('answers');
  });

  it.each([
    ['a stdin write rather than a command', { kind: 'writeStdin' }],
    ['an unknown approval kind', { kind: 'somethingNew' }],
    ['no reviewable command', { command: null }],
    ['an empty command', { command: '' }],
    ['a non-string command', { command: ['rm', '-rf'] }],
    ['a proposed execpolicy amendment', { proposedExecpolicyAmendment: ['rm'] }],
    ['a proposed network policy amendment', { proposedNetworkPolicyAmendments: [{ host: 'example.com' }] }],
    ['managed-network context', { networkApprovalContext: { host: 'example.com' } }],
  ])('declines a command approval carrying %s', async (_label, overrides) => {
    const opened = await running();
    opened.fake.push(approvalFrame(overrides));
    await flush();

    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ id: APPROVAL_ID, error: { code: -32602 } }]);
  });

  it('never copies upstream approval prose or a server-chosen method into a diagnostic', async () => {
    const opened = await running();
    opened.fake.push(approvalFrame({ command: `echo ${FIXTURE_BEARER}`, kind: 'writeStdin' }));
    opened.fake.push({ id: 902, method: `custom/${FIXTURE_BEARER}`, params: { threadId: FAKE_THREAD_ID } });
    await flush();

    expect(JSON.stringify(opened.sessionSink.events)).not.toContain(FIXTURE_BEARER);
    expect(JSON.stringify(opened.runSink.events)).not.toContain(FIXTURE_BEARER);
    expect(repliesTo(opened.fake, 902)).toMatchObject([{ id: 902, error: { code: -32601 } }]);
  });
});

// ---------------------------------------------------------------------------
// A4 — correlation and settlement
// ---------------------------------------------------------------------------

describe('correlation', () => {
  it.each([
    ['another thread', { threadId: 'thread-other' }],
    ['another turn', { turnId: 'turn-other' }],
    ['no thread at all', { threadId: undefined }],
    ['an empty turn id', { turnId: '' }],
  ])('refuses an approval addressed to %s', async (_label, overrides) => {
    const opened = await running();
    opened.fake.push(approvalFrame(overrides));
    await flush();

    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
    expect(repliesTo(opened.fake, APPROVAL_ID)[0]).toHaveProperty('error');
  });

  it('refuses an approval that arrives before any run is admitted', async () => {
    const opened = await openSession();
    opened.fake.push(approvalFrame());
    await flush();

    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ id: APPROVAL_ID, error: { code: -32600 } }]);
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
  });

  it('refuses an approval that races the `turn/start` reply, before the turn is bound', async () => {
    // The turn id is not known yet, so the correlation cannot be checked at
    // all. Guessing is the one thing that must not happen here.
    const opened = await openSession({}, { ...defaultResponders(), 'turn/start': () => undefined });
    void opened.session.startRun({
      input: { parts: [{ type: 'text', text: 'tidy the workspace' }] },
      sink: opened.runSink.sink,
      runRef: 'run-ref-1',
    });
    await flush();

    opened.fake.push(approvalFrame());
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ id: APPROVAL_ID, error: { code: -32600 } }]);
  });

  it('refuses an approval once the per-session bound is full, rather than growing', async () => {
    const opened = await running();
    for (let index = 0; index < MAX_TRACKED_APPROVALS; index += 1) {
      opened.fake.push(approvalFrame({}, 2_000 + index));
    }
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(MAX_TRACKED_APPROVALS);

    opened.fake.push(approvalFrame({}, 9_999));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(MAX_TRACKED_APPROVALS);
    expect(repliesTo(opened.fake, 9_999)).toMatchObject([{ id: 9_999, error: { code: -32600 } }]);
  });

  it('cannot settle one session approval with another session reference', async () => {
    const first = await running();
    const providerRef = await raise(first);
    const second = await running();

    await expect(
      second.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    await flush();
    // The first session's request is still outstanding and still answerable.
    expect(repliesTo(first.fake, APPROVAL_ID)).toHaveLength(0);
    await expect(
      first.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).resolves.toBeUndefined();
  });

  it('refuses an approval for a turn that already concluded, and cannot revive it', async () => {
    const opened = await running();
    opened.fake.push(turnCompleted('completed'));
    await flush();
    await expect(opened.run.completion).resolves.toMatchObject({ outcome: 'succeeded' });

    opened.fake.push(approvalFrame());
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ id: APPROVAL_ID, error: { code: -32600 } }]);
  });

  it('raises nothing once interruption has begun', async () => {
    const opened = await running();
    void opened.run.interrupt('stop');
    await flush();

    opened.fake.push(approvalFrame());
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });

  it('answers a duplicated native request id exactly once and raises one approval', async () => {
    const opened = await running();
    opened.fake.push(approvalFrame());
    opened.fake.push(approvalFrame({ command: 'curl http://example.com' }));
    await flush();

    // A second request reusing an outstanding id cannot create a second
    // interaction, and must not be answered on that id either — that frame
    // would settle the first request.
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);

    const providerRef = soleInteraction(opened.runSink).providerRef;
    await opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'denied' });
    await flush();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });

  it('keeps server-request replies out of the adapter own request correlation', async () => {
    const opened = await running();
    // The adapter's own outbound requests are numbered from 1; a server request
    // that reuses one of those ids must not settle the adapter's pending call.
    const outbound = opened.fake.requests('turn/start')[0];
    expect(outbound).toBeDefined();
    opened.fake.push(approvalFrame({}, outbound?.id ?? 1));
    await flush();

    // The run is still running: nothing resolved its `turn/start` twice, and
    // the approval was handled on its own side of the wire.
    const raised = opened.runSink.ofType('interaction.requested');
    expect(raised).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A5 — teardown and terminal cleanup
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('declines a pending approval when the turn completes naturally', async () => {
    const opened = await running();
    const providerRef = await raise(opened);

    opened.fake.push(turnCompleted('completed'));
    await flush();

    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    // The reference is retired: a late answer can neither settle nor revive.
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    await flush();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });

  it('declines a pending approval when the turn fails', async () => {
    const opened = await running();
    await raise(opened);
    opened.fake.push(turnCompleted('failed', { error: { codexErrorInfo: 'internalServerError' } }));
    await flush();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
  });

  it('declines a pending approval when the run is interrupted', async () => {
    const opened = await running();
    await raise(opened);
    await opened.run.interrupt('stop');
    opened.fake.push(turnCompleted('interrupted'));
    await flush();

    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    await expect(opened.run.completion).resolves.toMatchObject({ outcome: 'interrupted' });
  });

  it('retires a pending approval on EOF without inventing a grant', async () => {
    const opened = await running();
    const providerRef = await raise(opened);
    opened.fake.end();
    await flush();

    // The stream is gone, so no frame can be written — but nothing may be left
    // dangling, and nothing may be granted.
    expect(repliesTo(opened.fake, APPROVAL_ID).some((message) => JSON.stringify(message).includes('accept'))).toBe(
      false,
    );
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
  });

  it('declines a pending approval on disposal, before the connection is released', async () => {
    const opened = await running();
    const providerRef = await raise(opened);

    await expect(opened.session.dispose()).resolves.toBeUndefined();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    await expect(
      opened.session.respondToInteraction(providerRef, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
  });

  it('keeps disposal retryable after a failed teardown without re-answering a callback', async () => {
    const opened = await running();
    await raise(opened);
    opened.fake.failNextClose(new Error('close failed'));

    await expect(opened.session.dispose()).rejects.toSatisfy((error: unknown) => isProviderRejection(error));
    await expect(opened.session.dispose()).resolves.toBeUndefined();
    // Retrying teardown must not write a second decision for the same request.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });
});

// R1 regressions: pinned schema validation, retirement and interrupt windows.
describe('R1 approval boundaries', () => {
  it.each([
    ['null kind', { kind: null }],
    ['missing itemId', { itemId: undefined }],
    ['non-string itemId', { itemId: 7 }],
    ['missing timestamp', { startedAtMs: undefined }],
    ['fractional timestamp', { startedAtMs: 0.5 }],
    ['non-finite timestamp', { startedAtMs: Infinity }],
    ['unsafe timestamp', { startedAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['object cwd', { cwd: { path: '/private' } }],
    ['object reason', { reason: { text: 'private' } }],
    ['malformed callback identity', { approvalId: {} }],
    ['remote environment', { environmentId: 'remote-production' }],
    ['malformed environment', { environmentId: {} }],
    ['object network amendments', { proposedNetworkPolicyAmendments: {} }],
    ['non-array actions', { commandActions: {} }],
    ['unknown action variant', { commandActions: [{ type: 'newAction', nativeId: 'private-native-id' }] }],
    ['extra action metadata', { commandActions: [{ type: 'unknown', command: 'ls', nativeId: 'private-native-id' }] }],
    ['read missing path', { commandActions: [{ type: 'read', command: 'cat x', name: 'x' }] }],
    ['listFiles invalid path', { commandActions: [{ type: 'listFiles', command: 'ls', path: {} }] }],
    ['search invalid query', { commandActions: [{ type: 'search', command: 'rg x', query: [] }] }],
    ['action missing command', { commandActions: [{ type: 'unknown' }] }],
    ['unknown execution context', { futureContext: { environmentId: 'private-native-id' } }],
  ])('rejects %s before publishing or retaining an approval', async (_label, overrides) => {
    const opened = await running();
    opened.fake.push(approvalFrame(overrides));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(0);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ error: { code: -32602 } }]);
    expect(JSON.stringify(opened.runSink.events)).not.toContain('private-native-id');
    await opened.session.dispose();
  });

  it('reconstructs all four pinned command actions and keeps optional defaults', async () => {
    const opened = await running();
    const actions = [
      { type: 'read', command: 'cat x', name: 'x', path: '/workspace/x' },
      { type: 'listFiles', command: 'ls', path: null },
      { type: 'search', command: 'rg x', query: 'x', path: '/workspace' },
      { type: 'unknown', command: 'do-something' },
      { type: 'listFiles', command: 'ls' },
      { type: 'search', command: 'rg' },
    ];
    await raise(
      opened,
      approvalFrame({
        kind: undefined,
        environmentId: undefined,
        approvalId: 'private-native-id',
        commandActions: actions,
      }),
    );
    expect(soleInteraction(opened.runSink).request).toMatchObject({ subject: { detail: { commandActions: actions } } });
    expect(JSON.stringify(opened.runSink.events)).not.toContain('private-native-id');
    actions[0]!.command = 'changed after admission';
    expect(JSON.stringify(opened.runSink.events)).not.toContain('changed after admission');
    await opened.session.dispose();
  });

  it.each(['once', 'session', 'persistent'] as const)('keeps a %s mode-bearing denial answerable', async (mode) => {
    const opened = await running();
    const ref = await raise(opened);
    await expect(
      opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'denied', mode }),
    ).rejects.toSatisfy((error: unknown) => isProviderRejection(error) && error.agentError.code === 'invalid_request');
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);
    await opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'denied' });
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    await opened.session.dispose();
  });

  it.each([
    { kind: 'approval', decision: 'unexpected' },
    { kind: 'approval', decision: 'denied', reason: 123 },
    { kind: 'approval', decision: 'denied', extra: 'private' },
  ])('validates the complete neutral response before consumption: %j', async (response) => {
    const opened = await running();
    const ref = await raise(opened);
    await expect(opened.session.respondToInteraction(ref, response as never)).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'invalid_request',
    );
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(0);
    await opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' });
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
    await opened.session.dispose();
  });

  it('retires approvals before awaiting interrupt acknowledgement or completion', async () => {
    const opened = await running();
    const ref = await raise(opened);
    opened.fake.setResponder('turn/interrupt', () => undefined);
    const interrupt = opened.run.interrupt('stop');
    // No await between initiation and the observation of the native decline.
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    await expect(
      opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    opened.fake.respond('turn/interrupt', {});
    await interrupt;
    await expect(
      opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
    opened.fake.push(turnCompleted('interrupted'));
    await expect(opened.run.completion).resolves.toMatchObject({ outcome: 'interrupted' });
    await opened.session.dispose();
  });

  it('retries a rejected interrupt without reopening approvals on the old run', async () => {
    const opened = await running();
    const ref = await raise(opened);
    opened.fake.setResponder('turn/interrupt', () => undefined);
    const first = opened.run.interrupt('stop');
    const rejection = expect(first).rejects.toSatisfy((error: unknown) => isProviderRejection(error));
    opened.fake.respondWithError('turn/interrupt', -32603);
    await rejection;
    await expect(
      opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    opened.fake.push(approvalFrame({}, 502));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
    expect(repliesTo(opened.fake, 502)).toMatchObject([{ error: { code: -32600 } }]);
    const retry = opened.run.interrupt('stop');
    expect(opened.fake.requests('turn/interrupt')).toHaveLength(2);
    opened.fake.respond('turn/interrupt', {}, 1);
    await retry;
    expect(repliesTo(opened.fake, APPROVAL_ID)).toEqual([{ id: APPROVAL_ID, result: { decision: 'decline' } }]);
    opened.fake.push(turnCompleted('interrupted'));
    await opened.run.completion;
    await opened.session.dispose();
  });

  it('ignores identical and conflicting native replay before and after settlement, including later runs', async () => {
    const opened = await running();
    const ref = await raise(opened);
    for (const overrides of [{}, { command: 'changed' }]) opened.fake.push(approvalFrame(overrides));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
    await opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'denied' });
    for (const overrides of [{}, { command: 'changed' }]) opened.fake.push(approvalFrame(overrides));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(1);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
    opened.fake.push(turnCompleted('completed'));
    await opened.run.completion;
    const nextTurn = 'next-native-turn';
    opened.fake.setResponder('turn/start', () => ({ turn: { id: nextTurn } }));
    await startRun(opened);
    opened.fake.push(approvalFrame());
    opened.fake.push(approvalFrame({ turnId: nextTurn, command: 'changed' }));
    opened.fake.push(approvalFrame({ turnId: nextTurn }, 502));
    await flush();
    expect(opened.runSink.ofType('interaction.requested')).toHaveLength(2);
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
    await opened.session.dispose();
  });
});

describe('R1 native retirement overflow with an outstanding approval', () => {
  it('explicitly rejects pending callbacks, fences the session and retains retryable disposal', async () => {
    const opened = await running();
    const ref = await raise(opened);
    for (let index = 0; index < 4096; index += 1) {
      opened.fake.push({ id: `unsupported-${String(index)}`, method: 'unsupported', params: {} });
    }
    await flush();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toMatchObject([{ error: { code: -32600 } }]);
    await expect(opened.run.completion).resolves.toMatchObject({ outcome: 'failed' });
    await expect(
      opened.session.respondToInteraction(ref, { kind: 'approval', decision: 'approved', mode: 'once' }),
    ).rejects.toSatisfy(
      (error: unknown) => isProviderRejection(error) && error.agentError.code === 'unknown_interaction',
    );
    await expect(startRun(opened)).rejects.toSatisfy((error: unknown) => isProviderRejection(error));
    opened.fake.failNextClose(new Error('injected close failure'));
    await expect(opened.session.dispose()).rejects.toSatisfy((error: unknown) => isProviderRejection(error));
    await opened.session.dispose();
    expect(repliesTo(opened.fake, APPROVAL_ID)).toHaveLength(1);
  });
});
