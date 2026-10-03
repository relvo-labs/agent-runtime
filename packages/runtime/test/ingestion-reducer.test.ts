/**
 * Issue #43 surface 1: deterministic transition proofs for the shadow session
 * ingestion reducer. Nothing here drives a provider, store or workspace; each
 * test feeds the reducer the outcomes those effects would report and inspects
 * the resulting FIFO, faults and cleanup decisions directly. Integrated
 * runtime behavior (A1-A10) is proven by later surfaces, not by these tables.
 */

import { describe, expect, it } from 'vitest';

import type { CommandId, RunId, SessionId, Timestamp, TurnId } from '@relvo-labs/agent-protocol';

import {
  FAILURE_COUNT_CEILING,
  PRE_ACTIVATION_LIMIT,
  SESSION_OPERATION_LIMIT,
  acceptEvent,
  advanceHead,
  beginCleanup,
  chooseTerminal,
  createSessionIngestion,
  ingestionFault,
  reserveEffect,
  reserveStart,
  retire,
  runPhase,
  settleEffect,
  type CleanupStep,
  type CommandIdentity,
  type Operation,
  type RunSinkFence,
  type SessionIngestion,
} from '../src/ingestion.ts';

type Body = string;
type Session = SessionIngestion<Body>;

const AT = '2026-10-03T00:00:00.000Z' as Timestamp;
const SESSION = 'session-00000001' as SessionId;

function identity(commandId: string, fingerprint = `fp:${commandId}`): CommandIdentity {
  return { commandId: commandId as CommandId, fingerprint, acceptedAt: AT };
}

function runIds(n: number): { readonly runId: RunId; readonly turnId: TurnId } {
  return { runId: `run-${String(n)}` as RunId, turnId: `turn-${String(n)}` as TurnId };
}

function describeOp(op: Operation<Body>): string {
  switch (op.kind) {
    case 'body':
      return op.demoted ? `${op.body}(demoted)` : op.body;
    case 'effect':
      return `${op.effect}:${op.state}${op.result === undefined ? '' : `:${op.result}`}`;
    case 'terminal':
      return `terminal:${op.intent.outcome}${op.intent.overflowed ? '(overflow)' : ''}${op.closingFirst ? '+closing-first' : ''}`;
    case 'closing':
      return 'closing';
    case 'closed':
      return `closed${op.interruptedActiveRun ? '(interrupted)' : ''}`;
  }
}

function queued(s: Session): string[] {
  return s.queue.map(describeOp);
}

/** Structural invariants every transition must preserve. */
function assertInvariants(s: Session): void {
  const violations: string[] = [];
  const counted = s.queue.filter((op) => op.kind === 'body' || op.kind === 'effect').length;
  if (s.counted !== counted) violations.push(`counted ${String(s.counted)} != ${String(counted)}`);
  if (s.counted > SESSION_OPERATION_LIMIT) violations.push('over budget');
  for (let index = 1; index < s.queue.length; index += 1) {
    if (s.queue[index]!.ordinal <= s.queue[index - 1]!.ordinal) violations.push(`ordinal order at ${String(index)}`);
  }
  for (const kind of ['terminal', 'closing', 'closed'] as const) {
    if (s.queue.filter((op) => op.kind === kind).length > 1) violations.push(`more than one ${kind}`);
  }
  if (!s.queue.every((op) => Object.isFrozen(op))) violations.push('mutable operation');
  expect(violations).toEqual([]);
}

/** Submit and commit until the head cannot advance; returns committed operations. */
function drain(s: Session): string[] {
  const committed: string[] = [];
  for (;;) {
    const step = advanceHead(s, { kind: 'submit' });
    if (step.kind !== 'submit') return committed;
    const advanced = advanceHead(s, { kind: 'committed', ordinal: step.op.ordinal });
    if (advanced.kind !== 'advanced') throw new Error(`commit refused: ${advanced.kind}`);
    committed.push(describeOp(advanced.op));
    assertInvariants(s);
  }
}

function opened(): Session {
  const s = createSessionIngestion<Body>(SESSION, identity('open'));
  const open = s.queue[0]!;
  settleEffect(s, { ordinal: open.ordinal, outcome: { kind: 'applied', result: 'opened' } });
  expect(drain(s)).toEqual(['open:applied:opened']);
  return s;
}

type Started = { readonly ordinal: number; readonly fence: RunSinkFence; readonly runId: RunId };

function reserve(s: Session, n: number): Started {
  const ids = runIds(n);
  const reserved = reserveStart(s, { ...ids, attempt: 1, identity: identity(`submit-${String(n)}`) });
  if (reserved.kind !== 'reserved') throw new Error(`start refused: ${JSON.stringify(reserved)}`);
  return { ordinal: reserved.ordinal, fence: reserved.fence, runId: ids.runId };
}

function running(s: Session, n: number): Started {
  const started = reserve(s, n);
  settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: `start-${String(n)}` } });
  drain(s);
  expect(runPhase(s)).toBe('R');
  return started;
}

/** Accept session-sink bodies until exactly the budget is used. */
function fillToCap(s: Session, label = 'fill'): void {
  let index = 0;
  while (s.counted < SESSION_OPERATION_LIMIT) {
    const result = acceptEvent(s, 'session', `${label}-${String(index)}`);
    expect(result.kind).toBe('accepted');
    index += 1;
  }
}

function fail(s: Session, verdict: 'absent' | 'unknown' | 'pending'): Operation<Body> {
  const step = advanceHead(s, { kind: 'submit', retry: true });
  if (step.kind !== 'submit') throw new Error(`submit refused: ${JSON.stringify(step)}`);
  const rejected = advanceHead(s, { kind: 'rejected', ordinal: step.op.ordinal });
  expect(rejected.kind).toBe('reconcile');
  if (verdict !== 'pending') advanceHead(s, { kind: 'reconciled', ordinal: step.op.ordinal, verdict });
  return step.op;
}

function completeCleanup(s: Session, first: CleanupStep): CleanupStep {
  let step = first;
  while (step.kind === 'attempt') {
    step = settleEffect(s, { cleanup: step.phase, outcome: 'succeeded' }).next ?? { kind: 'stopped', failed: [] };
  }
  return step;
}

// ---------------------------------------------------------------------------
// S1-01: owner start, one terminal owner, frozen terminal, close partial order
// ---------------------------------------------------------------------------

describe('S1-01 run ownership and terminal linearization', () => {
  it('orders the owning start ahead of every run event captured before the provider start resolved', () => {
    const s = opened();
    const started = reserve(s, 1);
    expect(acceptEvent(s, started.fence, 'run-1:early')).toMatchObject({ kind: 'accepted' });
    expect(acceptEvent(s, 'session', 'session:diagnostic')).toMatchObject({ kind: 'accepted' });

    // The pending start occupies the head: nothing behind it may persist yet.
    expect(advanceHead(s, { kind: 'submit' })).toEqual({ kind: 'blocked', reason: 'awaiting-effect' });
    expect(runPhase(s)).toBe('S');

    settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: 'start-1' } });
    expect(drain(s)).toEqual(['start:applied:start-1', 'run-1:early', 'session:diagnostic']);
    expect(runPhase(s)).toBe('R');
    assertInvariants(s);
  });

  it('a rejected provider start leaves one rejected submit receipt and no start, run body or terminal', () => {
    const s = opened();
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:a');
    acceptEvent(s, 'session', 'session:a');
    acceptEvent(s, started.fence, 'run-1:b');

    const settled = settleEffect(s, {
      ordinal: started.ordinal,
      outcome: { kind: 'rejected', result: 'receipt:start-rejected' },
    });
    expect(settled.kind).toBe('filled');
    expect(s.run).toBeUndefined();
    expect(runPhase(s)).toBe('X');
    expect(queued(s)).toEqual(['start:rejected:receipt:start-rejected', 'session:a']);
    expect(chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' })).toEqual({
      kind: 'ignored',
      reason: 'stale',
    });
    expect(acceptEvent(s, started.fence, 'run-1:late')).toEqual({ kind: 'discarded', reason: 'stale-sink' });
    expect(drain(s)).toEqual(['start:rejected:receipt:start-rejected', 'session:a']);
    assertInvariants(s);
  });

  it('selects one terminal owner; a later completion is a duplicate and post-terminal run input is refused', () => {
    const s = opened();
    const started = running(s, 1);
    expect(chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' })).toMatchObject({
      kind: 'chosen',
      placed: true,
    });
    expect(chooseTerminal(s, { runId: started.runId, outcome: 'failed', cause: 'completion' })).toEqual({
      kind: 'ignored',
      reason: 'duplicate',
    });
    expect(acceptEvent(s, started.fence, 'run-1:after-terminal')).toEqual({
      kind: 'discarded',
      reason: 'post-terminal',
    });
    expect(runPhase(s)).toBe('T');
    expect(drain(s)).toEqual(['terminal:succeeded']);
    expect(runPhase(s)).toBe('X');
    expect(s.run).toBeUndefined();
  });

  it('overflow may fail an unsubmitted success intent but never rewrites a submitted or applied terminal', () => {
    // Before submission: an earlier body is in flight, the terminal is placed behind it.
    const before = opened();
    const one = running(before, 1);
    acceptEvent(before, one.fence, 'run-1:x');
    const inFlight = advanceHead(before, { kind: 'submit' });
    expect(inFlight.kind).toBe('submit');
    chooseTerminal(before, { runId: one.runId, outcome: 'succeeded', cause: 'completion' });
    fillToCap(before);
    expect(acceptEvent(before, 'session', 'excess')).toMatchObject({ kind: 'refused', reason: 'overflow' });
    expect(before.queue.find((op) => op.kind === 'terminal')).toMatchObject({
      intent: { outcome: 'failed', overflowed: true },
    });

    // After submission: the frozen in-flight terminal keeps its outcome, even across a failed retry.
    const after = opened();
    const two = running(after, 2);
    chooseTerminal(after, { runId: two.runId, outcome: 'succeeded', cause: 'completion' });
    const submitted = advanceHead(after, { kind: 'submit' });
    if (submitted.kind !== 'submit') throw new Error('terminal not submitted');
    fillToCap(after);
    expect(acceptEvent(after, 'session', 'excess')).toMatchObject({ kind: 'refused', reason: 'overflow' });
    expect(after.queue[0]).toBe(submitted.op);
    advanceHead(after, { kind: 'rejected', ordinal: submitted.op.ordinal });
    advanceHead(after, { kind: 'reconciled', ordinal: submitted.op.ordinal, verdict: 'absent' });
    const retried = advanceHead(after, { kind: 'submit', retry: true });
    expect(retried).toEqual({ kind: 'submit', op: submitted.op });
    expect(submitted.op).toMatchObject({ intent: { outcome: 'succeeded', overflowed: false } });

    // After application: the run has retired, so overflow is session-only with no run to target.
    const applied = opened();
    const three = running(applied, 3);
    chooseTerminal(applied, { runId: three.runId, outcome: 'succeeded', cause: 'completion' });
    expect(drain(applied)).toEqual(['terminal:succeeded']);
    fillToCap(applied);
    const refused = acceptEvent(applied, 'session', 'excess');
    expect(refused).toEqual({ kind: 'refused', reason: 'overflow' });
    expect(ingestionFault(applied)).toMatchObject({ kind: 'overflow', retryable: false, permanent: true });
  });

  it('close admitted after terminal submission orders closing after that terminal', () => {
    const s = opened();
    const started = running(s, 1);
    chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
    const submitted = advanceHead(s, { kind: 'submit' });
    if (submitted.kind !== 'submit') throw new Error('terminal not submitted');

    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    // The provider run already completed, so cleanup goes straight to disposal.
    expect(close).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'dispose' } });
    expect(queued(s)).toEqual(['terminal:succeeded', 'closing']);

    // The terminal acknowledgment arrives after close admission.
    advanceHead(s, { kind: 'committed', ordinal: submitted.op.ordinal });
    if (close.kind !== 'cleanup') throw new Error('close refused');
    expect(completeCleanup(s, close.step)).toEqual({ kind: 'complete', closed: 'queued' });
    expect(drain(s)).toEqual(['closing', 'closed']);
    expect(s.state).toBe('closed');
  });

  it('close admitted before an unsubmitted terminal persists closing first in the same frozen bundle', () => {
    const s = opened();
    const started = running(s, 1);
    acceptEvent(s, started.fence, 'run-1:x');
    const head = advanceHead(s, { kind: 'submit' });
    if (head.kind !== 'submit') throw new Error('head not submitted');
    chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
    const placed = s.queue.find((op) => op.kind === 'terminal');

    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    if (close.kind !== 'cleanup') throw new Error('close refused');
    const reordered = s.queue.find((op) => op.kind === 'terminal');
    expect(reordered?.ordinal).toBe(placed?.ordinal);
    expect(queued(s)).toEqual(['run-1:x', 'terminal:succeeded+closing-first']);

    advanceHead(s, { kind: 'committed', ordinal: head.op.ordinal });
    completeCleanup(s, close.step);
    expect(drain(s)).toEqual(['terminal:succeeded+closing-first', 'closed']);
  });

  it('close of a running run persists closing before the close-selected fallback terminal', () => {
    const s = opened();
    running(s, 1);
    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    expect(close).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'interrupt' } });
    expect(runPhase(s)).toBe('E');
    // No terminal yet: it is truthful only after interrupt or disposal succeeds.
    expect(queued(s)).toEqual(['closing']);

    const afterInterrupt = settleEffect(s, { cleanup: 'interrupt', outcome: 'succeeded' });
    expect(queued(s)).toEqual(['closing', 'terminal:interrupted']);
    expect(afterInterrupt.next).toEqual({ kind: 'attempt', phase: 'dispose' });
    completeCleanup(s, afterInterrupt.next!);
    expect(drain(s)).toEqual(['closing', 'terminal:interrupted', 'closed(interrupted)']);
  });
});

// ---------------------------------------------------------------------------
// S1-02: shared FIFO, count-only cap, activation bound, retired sinks
// ---------------------------------------------------------------------------

describe('S1-02 shared sink ordering and capacity', () => {
  it('session and run sinks share one FIFO in acceptance order', () => {
    const s = opened();
    const started = running(s, 1);
    const order = ['run-1:a', 'session:b', 'run-1:c', 'session:d', 'run-1:e'];
    const ordinals = order.map((body) => {
      const result = acceptEvent(s, body.startsWith('run') ? started.fence : 'session', body);
      if (result.kind !== 'accepted') throw new Error(body);
      return result.ordinal;
    });
    expect([...ordinals].sort((left, right) => left - right)).toEqual(ordinals);
    expect(drain(s)).toEqual(order);
  });

  it('counts the in-flight head and refuses the 1,024th operation before acceptance', () => {
    const s = opened();
    acceptEvent(s, 'session', 'head');
    const head = advanceHead(s, { kind: 'submit' });
    if (head.kind !== 'submit') throw new Error('head not submitted');
    fillToCap(s);
    expect(s.counted).toBe(SESSION_OPERATION_LIMIT);
    expect(acceptEvent(s, 'session', 'excess')).toEqual({ kind: 'refused', reason: 'overflow' });
    expect(s.counted).toBe(SESSION_OPERATION_LIMIT);
    expect(s.queue.some((op) => op.kind === 'body' && op.body === 'excess')).toBe(false);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', retryable: false, permanent: true });

    // Freed capacity does not reopen ingress: O fences fresh input, the prefix still drains.
    advanceHead(s, { kind: 'committed', ordinal: head.op.ordinal });
    expect(acceptEvent(s, 'session', 'after-overflow')).toEqual({ kind: 'refused', reason: 'overflowed' });
    expect(drain(s)).toHaveLength(SESSION_OPERATION_LIMIT - 1);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow' });
    assertInvariants(s);
  });

  it('shares the budget with pre-effect reservations; filling a reservation takes no second slot', () => {
    const s = opened();
    const started = running(s, 1);
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    expect(s.counted).toBe(1);
    fillToCap(s);
    settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(s.counted).toBe(SESSION_OPERATION_LIMIT);
    expect(acceptEvent(s, started.fence, 'run-1:excess')).toMatchObject({ kind: 'refused', reason: 'overflow' });
    assertInvariants(s);
  });

  it('keeps one terminal slot outside the 1,023 nonterminal budget and interrupts the overflowing run once', () => {
    const s = opened();
    const started = running(s, 1);
    for (let index = 0; index < SESSION_OPERATION_LIMIT; index += 1) {
      expect(acceptEvent(s, started.fence, `run-1:${String(index)}`).kind).toBe('accepted');
    }
    expect(acceptEvent(s, started.fence, 'run-1:excess')).toEqual({
      kind: 'refused',
      reason: 'overflow',
      interrupt: started.runId,
    });
    // Interrupt once: a second refusal does not ask for another provider interrupt.
    expect(acceptEvent(s, 'session', 'session:excess')).toEqual({ kind: 'refused', reason: 'overflowed' });
    settleEffect(s, { cleanup: 'interrupt', outcome: 'succeeded' });

    expect(chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' })).toMatchObject({
      kind: 'chosen',
      placed: true,
    });
    expect(s.queue).toHaveLength(SESSION_OPERATION_LIMIT + 1);
    expect(s.queue.at(-1)).toMatchObject({ kind: 'terminal', intent: { outcome: 'failed', overflowed: true } });
    assertInvariants(s);
  });

  it('applies the 256 pre-activation bound to a run sink inside the session budget', () => {
    const s = opened();
    const started = reserve(s, 1);
    for (let index = 0; index < PRE_ACTIVATION_LIMIT; index += 1) {
      expect(acceptEvent(s, started.fence, `run-1:${String(index)}`).kind).toBe('accepted');
    }
    // Excess refused before acceptance; the start is still pending, so the interrupt is deferred.
    expect(acceptEvent(s, started.fence, 'run-1:excess')).toEqual({ kind: 'refused', reason: 'activation-overflow' });
    expect(s.counted).toBe(PRE_ACTIVATION_LIMIT + 1);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', permanent: false });

    const resolved = settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: 'start-1' } });
    expect(resolved.next).toEqual({ kind: 'attempt', phase: 'interrupt' });
    advanceHead(s, {
      kind: 'committed',
      ordinal: (advanceHead(s, { kind: 'submit' }) as { op: Operation<Body> }).op.ordinal,
    });
    // The owner start committed: the overflow is now permanent history loss.
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', permanent: true });
    expect(drain(s)).toHaveLength(PRE_ACTIVATION_LIMIT);
  });

  it('applies the 256 pre-activation bound to the session sink before session.opened commits', () => {
    const s = createSessionIngestion<Body>(SESSION, identity('open'));
    for (let index = 0; index < PRE_ACTIVATION_LIMIT; index += 1) {
      expect(acceptEvent(s, 'session', `session:${String(index)}`).kind).toBe('accepted');
    }
    expect(acceptEvent(s, 'session', 'session:excess')).toEqual({ kind: 'refused', reason: 'activation-overflow' });
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', permanent: true });
    assertInvariants(s);
  });

  it('the activation bound is a guard inside the budget, not 256 extra slots', () => {
    const s = opened();
    for (let index = 0; index < 900; index += 1) acceptEvent(s, 'session', `session:${String(index)}`);
    const started = reserve(s, 1);
    let accepted = 0;
    for (;;) {
      const result = acceptEvent(s, started.fence, `run-1:${String(accepted)}`);
      if (result.kind !== 'accepted') {
        expect(result).toEqual({ kind: 'refused', reason: 'overflow' });
        break;
      }
      accepted += 1;
    }
    expect(accepted).toBe(SESSION_OPERATION_LIMIT - 901);
    expect(accepted).toBeLessThan(PRE_ACTIVATION_LIMIT);
    expect(s.counted).toBe(SESSION_OPERATION_LIMIT);
  });

  it('a retired run sink takes no slot and a session-sink overflow targets the current starting run', () => {
    const s = opened();
    const one = running(s, 1);
    chooseTerminal(s, { runId: one.runId, outcome: 'succeeded', cause: 'completion' });
    drain(s);

    const two = reserve(s, 2);
    fillToCap(s);
    // The stale emitter is discarded before counting: no slot and no overflow marker.
    expect(acceptEvent(s, one.fence, 'run-1:late')).toEqual({ kind: 'discarded', reason: 'stale-sink' });
    expect(ingestionFault(s)).toBeUndefined();

    expect(acceptEvent(s, 'session', 'session:excess')).toEqual({ kind: 'refused', reason: 'overflow' });
    expect(s.run?.runId).toBe(two.runId);
    expect(s.run?.fenced).toBe(true);
    const resolved = settleEffect(s, { ordinal: two.ordinal, outcome: { kind: 'applied', result: 'start-2' } });
    expect(resolved.next).toEqual({ kind: 'attempt', phase: 'interrupt' });
    expect(s.run?.interrupt).toBe('in-flight');
  });

  it('caps operation count, not bytes', () => {
    const s = opened();
    const large = 'x'.repeat(1 << 20);
    expect(acceptEvent(s, 'session', large).kind).toBe('accepted');
    expect(s.counted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S1-03: pre-effect reservation
// ---------------------------------------------------------------------------

describe('S1-03 pre-effect reservation', () => {
  it('reserves ordinal, capacity and identity before the effect and fills the same slot', () => {
    const s = opened();
    const started = running(s, 1);
    acceptEvent(s, started.fence, 'run-1:a');
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    acceptEvent(s, started.fence, 'run-1:b');

    // Completion cannot place a terminal ahead of the pending response.
    expect(chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' })).toMatchObject({
      kind: 'chosen',
      placed: false,
    });
    expect(runPhase(s)).toBe('E');

    settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(s.queue.find((op) => op.ordinal === response.ordinal)).toMatchObject({ state: 'applied' });
    expect(runPhase(s)).toBe('T');
    expect(drain(s)).toEqual(['run-1:a', 'response:applied:settled', 'run-1:b', 'terminal:succeeded']);
  });

  it('completion, close, withdrawal and overflow cannot overtake a pending response', () => {
    const s = opened();
    const started = running(s, 1);
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');

    const withdrawal = acceptEvent(s, started.fence, 'run-1:withdrawn', {
      role: 'withdrawal',
      subject: 'interaction-1',
    });
    expect(withdrawal.kind === 'accepted' && withdrawal.ordinal > response.ordinal).toBe(true);
    chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });

    // The provider may still be using the session: disposal waits, close returns promptly.
    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    expect(close).toEqual({ kind: 'cleanup', step: { kind: 'stopped', pending: 'effect', failed: [] } });

    fillToCap(s);
    expect(acceptEvent(s, 'session', 'excess')).toMatchObject({ kind: 'refused', reason: 'overflow' });
    expect(s.queue[0]).toMatchObject({ ordinal: response.ordinal, state: 'pending' });
    expect(advanceHead(s, { kind: 'submit' })).toEqual({ kind: 'blocked', reason: 'awaiting-effect' });

    const settled = settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(settled.next).toEqual({ kind: 'attempt', phase: 'dispose' });
    const committed = drain(s);
    expect(committed.slice(0, 3)).toEqual(['response:applied:settled', 'run-1:withdrawn', 'closing']);
    // The terminal is the last operation: it waited for the reservation, and its
    // success intent was unsubmitted when the overflow occurred.
    expect(committed.at(-1)).toBe('terminal:failed(overflow)');
  });

  it('definite rejection releases the body burden but keeps the ordered receipt placeholder', () => {
    const s = opened();
    const started = running(s, 1);
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    acceptEvent(s, started.fence, 'run-1:b');
    const before = s.counted;
    settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'rejected', result: 'receipt:rejected' } });
    expect(s.counted).toBe(before);
    expect(s.queue[0]).toMatchObject({ ordinal: response.ordinal, state: 'rejected', result: 'receipt:rejected' });
    expect(drain(s)).toEqual(['response:rejected:receipt:rejected', 'run-1:b']);
  });

  it('a provider-delivered response cannot be admitted after the effect without its prior reservation', () => {
    const s = opened();
    const started = running(s, 1);
    const body = acceptEvent(s, started.fence, 'run-1:a');
    if (body.kind !== 'accepted') throw new Error('body refused');
    expect(settleEffect(s, { ordinal: 9999, outcome: { kind: 'applied', result: 'late' } })).toEqual({
      kind: 'refused',
      reason: 'not-reserved',
    });
    expect(settleEffect(s, { ordinal: body.ordinal, outcome: { kind: 'applied', result: 'late' } })).toEqual({
      kind: 'refused',
      reason: 'not-reserved',
    });

    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'again' } })).toEqual({
      kind: 'refused',
      reason: 'not-reserved',
    });

    // Once fenced, no reservation exists, so integration must not call the provider at all.
    beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    expect(
      reserveEffect(s, {
        effect: 'response',
        identity: identity('respond-2'),
        runId: started.runId,
        subject: 'interaction-2',
      }),
    ).toEqual({ kind: 'refused', reason: 'closing' });
    assertInvariants(s);
  });

  it('exact retry shares the reservation, changed payload conflicts and a competing settlement is refused', () => {
    const s = opened();
    const started = running(s, 1);
    const input = {
      effect: 'response' as const,
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    };
    const first = reserveEffect(s, input);
    if (first.kind !== 'reserved') throw new Error('response refused');
    expect(reserveEffect(s, input)).toMatchObject({ kind: 'existing', op: { ordinal: first.ordinal } });
    expect(reserveEffect(s, { ...input, identity: identity('respond-1', 'fp:changed') })).toEqual({
      kind: 'refused',
      reason: 'command-conflict',
    });
    expect(reserveEffect(s, { ...input, identity: identity('respond-2') })).toEqual({
      kind: 'refused',
      reason: 'subject-busy',
    });
    expect(s.counted).toBe(1);
  });

  it('a withdrawal ordered ahead of a response refuses that response', () => {
    const s = opened();
    const started = running(s, 1);
    acceptEvent(s, started.fence, 'run-1:withdrawn', { role: 'withdrawal', subject: 'interaction-1' });
    expect(
      reserveEffect(s, {
        effect: 'response',
        identity: identity('respond-1'),
        runId: started.runId,
        subject: 'interaction-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'subject-busy' });
  });

  it('an ambiguous provider outcome stays unresolved and blocks persistence and terminal placement', () => {
    const s = opened();
    const started = running(s, 1);
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    expect(settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'unknown' } }).kind).toBe('unresolved');
    expect(advanceHead(s, { kind: 'submit' })).toEqual({ kind: 'blocked', reason: 'awaiting-effect' });
    chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
    expect(s.queue.some((op) => op.kind === 'terminal')).toBe(false);
    settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(drain(s)).toEqual(['response:applied:settled', 'terminal:succeeded']);
  });

  it('an interrupt_run effect that reached the provider is never redelivered by close', () => {
    const s = opened();
    const started = running(s, 1);
    const interrupt = reserveEffect(s, {
      effect: 'interrupt',
      identity: identity('interrupt-1'),
      runId: started.runId,
    });
    if (interrupt.kind !== 'reserved') throw new Error('interrupt refused');
    settleEffect(s, { ordinal: interrupt.ordinal, outcome: { kind: 'applied', result: 'delivered' } });
    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    expect(close).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'dispose' } });
  });
});

// ---------------------------------------------------------------------------
// S1-04: F/O/A faults, precedence and reachable phase combinations
// ---------------------------------------------------------------------------

type Phase = 'S' | 'R' | 'E' | 'T' | 'X';

/** Build a session in the given phase with a submittable head. */
function inPhase(phase: Phase): { s: Session; started?: Started } {
  const s = opened();
  switch (phase) {
    case 'S': {
      acceptEvent(s, 'session', 'session:head');
      const started = reserve(s, 1);
      return { s, started };
    }
    case 'R': {
      const started = running(s, 1);
      acceptEvent(s, started.fence, 'run-1:head');
      return { s, started };
    }
    case 'E': {
      const started = running(s, 1);
      acceptEvent(s, started.fence, 'run-1:head');
      reserveEffect(s, {
        effect: 'response',
        identity: identity('respond-1'),
        runId: started.runId,
        subject: 'interaction-1',
      });
      chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
      return { s, started };
    }
    case 'T': {
      const started = running(s, 1);
      acceptEvent(s, started.fence, 'run-1:head');
      chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
      return { s, started };
    }
    case 'X': {
      const started = running(s, 1);
      chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
      drain(s);
      acceptEvent(s, 'session', 'session:head');
      return { s };
    }
  }
}

describe('S1-04 faults and reachable transitions', () => {
  const phases: readonly Phase[] = ['S', 'R', 'E', 'T', 'X'];

  it.each(phases)('phase %s: recoverable F retains the exact head and only an explicit retry resubmits it', (phase) => {
    const { s } = inPhase(phase);
    const failed = fail(s, 'absent');
    expect(runPhase(s)).toBe(phase);
    expect(ingestionFault(s)).toEqual({
      kind: 'failure',
      retryable: true,
      permanent: false,
      ordinal: failed.ordinal,
      failureCount: 1,
    });
    expect(advanceHead(s, { kind: 'submit' })).toEqual({ kind: 'blocked', reason: 'faulted' });
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'submit', op: failed });
    advanceHead(s, { kind: 'committed', ordinal: failed.ordinal });
    expect(ingestionFault(s)).toBeUndefined();
    // A blocked head blocks new runs; after it clears only the active run does.
    assertInvariants(s);
  });

  it.each(phases)('phase %s: A is recorded before reconciliation and its head is never resubmitted', (phase) => {
    const { s } = inPhase(phase);
    const step = advanceHead(s, { kind: 'submit' });
    if (step.kind !== 'submit') throw new Error('head not submitted');
    const rejected = advanceHead(s, { kind: 'rejected', ordinal: step.op.ordinal });
    // Synchronously visible: no reconciliation result has been supplied yet.
    expect(rejected).toMatchObject({ kind: 'reconcile', op: step.op });
    expect(ingestionFault(s)).toMatchObject({ kind: 'ambiguous', retryable: false, permanent: false });
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'blocked', reason: 'ambiguous' });

    advanceHead(s, { kind: 'reconciled', ordinal: step.op.ordinal, verdict: 'unknown' });
    expect(ingestionFault(s)).toMatchObject({ kind: 'ambiguous', retryable: false, permanent: true });
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'blocked', reason: 'ambiguous' });
    expect(advanceHead(s, { kind: 'reconciled', ordinal: step.op.ordinal, verdict: 'applied' })).toEqual({
      kind: 'refused',
      reason: 'not-head',
    });
    // Safe cleanup is independent of the fail-closed store head.
    const close = beginCleanup(s, { ifRunActive: 'interrupt' });
    expect(close.kind).toBe('cleanup');
    expect(runPhase(s) === phase || runPhase(s) === 'E').toBe(true);
  });

  it.each(phases)('phase %s: overflow is permanent O with the phase-specific run reaction', (phase) => {
    const { s, started } = inPhase(phase);
    fillToCap(s);
    const refused = acceptEvent(s, 'session', 'excess');
    expect(refused.kind).toBe('refused');
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', retryable: false });
    switch (phase) {
      case 'S':
        // Fence now; no handle exists, so the interrupt is deferred to start resolution.
        expect(refused).toEqual({ kind: 'refused', reason: 'overflow' });
        expect(s.run?.fenced).toBe(true);
        expect(
          settleEffect(s, { ordinal: started!.ordinal, outcome: { kind: 'applied', result: 'start-1' } }).next,
        ).toEqual({ kind: 'attempt', phase: 'interrupt' });
        break;
      case 'R':
        expect(refused).toEqual({ kind: 'refused', reason: 'overflow', interrupt: started!.runId });
        expect(acceptEvent(s, started!.fence, 'again')).toEqual({ kind: 'refused', reason: 'overflowed' });
        break;
      case 'E':
        // Completion already ended the provider run; the earlier reservation is preserved.
        expect(refused).toEqual({ kind: 'refused', reason: 'overflow' });
        expect(s.queue.some((op) => op.kind === 'effect' && op.state === 'pending')).toBe(true);
        break;
      case 'T':
        expect(s.queue.find((op) => op.kind === 'terminal')).toMatchObject({
          intent: { outcome: 'failed', overflowed: true },
        });
        break;
      case 'X':
        // Session-only O: no retired run is targeted.
        expect(refused).toEqual({ kind: 'refused', reason: 'overflow' });
        expect(s.run).toBeUndefined();
        break;
    }
    // O fences new runs and new effects but the accepted prefix still drains.
    expect(reserveStart(s, { ...runIds(9), attempt: 1, identity: identity('submit-9') }).kind).toBe('refused');
    expect(advanceHead(s, { kind: 'submit' }).kind).toBe('submit');
  });

  it('precedence is A > O > F, F+O reports O, and retry reports F then O', () => {
    const s = opened();
    acceptEvent(s, 'session', 'head');
    const head = fail(s, 'absent');
    expect(ingestionFault(s)).toMatchObject({ kind: 'failure', retryable: true });
    fillToCap(s);
    acceptEvent(s, 'session', 'excess');
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', retryable: false });

    // Retry: the recoverable head fails again — A first, then O+F after absence is proven.
    fail(s, 'pending');
    expect(ingestionFault(s)).toMatchObject({ kind: 'ambiguous' });
    advanceHead(s, { kind: 'reconciled', ordinal: head.ordinal, verdict: 'absent' });
    expect(s.faults.failure?.count).toBe(2);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow' });

    // Retry succeeds: F clears, O remains.
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'submit', op: head });
    advanceHead(s, { kind: 'committed', ordinal: head.ordinal });
    expect(s.faults.failure).toBeUndefined();
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', permanent: true });
  });

  it('reconciliation that proves application publishes exactly once', () => {
    const s = opened();
    acceptEvent(s, 'session', 'head');
    const head = fail(s, 'pending');
    const applied = advanceHead(s, { kind: 'reconciled', ordinal: head.ordinal, verdict: 'applied' });
    expect(applied).toMatchObject({ kind: 'advanced', op: head, publish: true });
    expect(advanceHead(s, { kind: 'committed', ordinal: head.ordinal })).toEqual({
      kind: 'refused',
      reason: 'not-head',
    });
    expect(ingestionFault(s)).toBeUndefined();
  });

  it('saturates the recoverable failure count', () => {
    const s = opened();
    acceptEvent(s, 'session', 'head');
    fail(s, 'absent');
    s.faults.failure = { ordinal: s.faults.failure!.ordinal, count: FAILURE_COUNT_CEILING - 1 };
    fail(s, 'absent');
    fail(s, 'absent');
    expect(ingestionFault(s)?.failureCount).toBe(FAILURE_COUNT_CEILING);
  });

  it('E/start success: a delayed start under a close fence commits before its bodies and stays fenced', () => {
    const s = opened();
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:early');
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'cleanup',
      step: { kind: 'stopped', pending: 'start', failed: [] },
    });
    const resolved = settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: 'start-1' } });
    expect(resolved.next).toEqual({ kind: 'attempt', phase: 'interrupt' });
    expect(drain(s)).toEqual(['start:applied:start-1', 'run-1:early', 'closing']);
    expect(runPhase(s)).toBe('E');
  });

  it('E/start commit failure retains the same start bundle and retries it unchanged', () => {
    const s = opened();
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:early');
    beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: 'start-1' } });
    const head = fail(s, 'absent');
    expect(head).toMatchObject({ kind: 'effect', effect: 'start', ordinal: started.ordinal });
    expect(runPhase(s)).toBe('S');
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'submit', op: head });
    advanceHead(s, { kind: 'committed', ordinal: head.ordinal });
    expect(runPhase(s)).toBe('E');
  });

  it('E/start provider rejection under a close fence discards staging and proceeds to disposal', () => {
    const s = opened();
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:early');
    beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    const rejected = settleEffect(s, {
      ordinal: started.ordinal,
      outcome: { kind: 'rejected', result: 'receipt:start-rejected' },
    });
    expect(rejected.next).toEqual({ kind: 'attempt', phase: 'dispose' });
    expect(queued(s)).toEqual(['start:rejected:receipt:start-rejected', 'closing']);
  });
});

// ---------------------------------------------------------------------------
// S1-05: cleanup fencing, independence and phase retry
// ---------------------------------------------------------------------------

describe('S1-05 cleanup', () => {
  it('fences a pending start without waiting and stays promptly retryable without release', () => {
    const s = opened();
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:early');
    const pending = { kind: 'cleanup', step: { kind: 'stopped', pending: 'start', failed: [] } };
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual(pending);
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual(pending);
    expect(beginCleanup(s, { identity: identity('close-2'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'refused',
      reason: 'busy',
    });
    expect(beginCleanup(s, { identity: identity('close-1', 'fp:changed'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'refused',
      reason: 'command-conflict',
    });
    // Shutdown's internal close shares the same fence and is equally prompt.
    expect(beginCleanup(s, { ifRunActive: 'interrupt' })).toEqual(pending);
    expect(s.close).toMatchObject({ dispose: 'idle', release: 'idle', closedQueued: false });
    expect(queued(s)).toEqual(['start:pending', 'run-1:early', 'closing']);
  });

  it('a late successful start is quarantined and cleaned up even while the store head is fail-closed', () => {
    const s = opened();
    acceptEvent(s, 'session', 'session:head');
    const started = reserve(s, 1);
    acceptEvent(s, started.fence, 'run-1:early');
    // The earlier head then fails with an outcome that can never be reconciled.
    fail(s, 'unknown');
    expect(ingestionFault(s)).toMatchObject({ kind: 'ambiguous', permanent: true });
    expect(reserveStart(s, { ...runIds(2), attempt: 1, identity: identity('submit-2') })).toEqual({
      kind: 'refused',
      reason: 'run-active',
    });

    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'cleanup',
      step: { kind: 'stopped', pending: 'start', failed: [] },
    });
    const resolved = settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'applied', result: 'start-1' } });
    expect(resolved.next).toEqual({ kind: 'attempt', phase: 'interrupt' });
    expect(completeCleanup(s, resolved.next!)).toEqual({ kind: 'complete', closed: 'queued' });
    expect(s.close).toMatchObject({ dispose: 'succeeded', release: 'succeeded', interruptedActiveRun: true });

    // Cleanup effects finished, but no history or close receipt may bypass the fail-closed head.
    expect(queued(s)).toEqual([
      'session:head',
      'start:applied:start-1',
      'run-1:early',
      'closing',
      'terminal:interrupted',
      'closed(interrupted)',
    ]);
    expect(advanceHead(s, { kind: 'submit', retry: true })).toEqual({ kind: 'blocked', reason: 'ambiguous' });
    expect(s.state).toBe('open');
  });

  it('a late rejected start discards only its staging, keeps session-sink O, and still disposes and releases', () => {
    const s = opened();
    const started = reserve(s, 1);
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1)
      acceptEvent(s, started.fence, `run-1:${String(index)}`);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow', permanent: false });
    beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });

    const rejected = settleEffect(s, {
      ordinal: started.ordinal,
      outcome: { kind: 'rejected', result: 'receipt:start-rejected' },
    });
    // O caused solely by unowned staging rolls back.
    expect(ingestionFault(s)).toBeUndefined();
    expect(completeCleanup(s, rejected.next!)).toEqual({ kind: 'complete', closed: 'queued' });
    expect(drain(s)).toEqual(['start:rejected:receipt:start-rejected', 'closing', 'closed']);

    // An independent session-sink overflow during the same pending start survives the rollback.
    const other = opened();
    const second = reserve(other, 2);
    fillToCap(other);
    acceptEvent(other, 'session', 'session:excess');
    settleEffect(other, { ordinal: second.ordinal, outcome: { kind: 'rejected', result: 'receipt:start-rejected' } });
    expect(ingestionFault(other)).toMatchObject({ kind: 'overflow', permanent: true });
  });

  it('never releases before confirmed disposal and retries only failed phases', () => {
    const s = opened();
    running(s, 1);
    const close = { identity: identity('close-1'), ifRunActive: 'interrupt' as const };
    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'interrupt' } });
    expect(settleEffect(s, { cleanup: 'interrupt', outcome: 'failed' }).next).toEqual({
      kind: 'attempt',
      phase: 'dispose',
    });
    expect(settleEffect(s, { cleanup: 'dispose', outcome: 'failed' }).next).toEqual({
      kind: 'stopped',
      failed: ['interrupt', 'dispose'],
    });
    expect(s.close?.release).toBe('idle');

    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'interrupt' } });
    expect(settleEffect(s, { cleanup: 'interrupt', outcome: 'succeeded' }).next).toEqual({
      kind: 'attempt',
      phase: 'dispose',
    });
    expect(settleEffect(s, { cleanup: 'dispose', outcome: 'failed' }).next).toEqual({
      kind: 'stopped',
      failed: ['dispose'],
    });

    // The observed interrupt success is never invoked again.
    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'dispose' } });
    expect(settleEffect(s, { cleanup: 'dispose', outcome: 'succeeded' }).next).toEqual({
      kind: 'attempt',
      phase: 'release',
    });
    expect(settleEffect(s, { cleanup: 'release', outcome: 'failed' }).next).toEqual({
      kind: 'stopped',
      failed: ['release'],
    });
    expect(s.queue.some((op) => op.kind === 'closed')).toBe(false);

    // Nor is the observed dispose success.
    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'release' } });
    expect(settleEffect(s, { cleanup: 'release', outcome: 'succeeded' }).next).toEqual({
      kind: 'complete',
      closed: 'queued',
    });
    expect(drain(s)).toEqual(['closing', 'terminal:interrupted', 'closed(interrupted)']);
  });

  it('a successful dispose makes a failed interrupt moot and supplies the truthful fallback terminal', () => {
    const s = opened();
    running(s, 1);
    beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    settleEffect(s, { cleanup: 'interrupt', outcome: 'failed' });
    expect(s.queue.some((op) => op.kind === 'terminal')).toBe(false);
    const disposed = settleEffect(s, { cleanup: 'dispose', outcome: 'succeeded' });
    expect(disposed.next).toEqual({ kind: 'attempt', phase: 'release' });
    expect(queued(s)).toEqual(['closing', 'terminal:interrupted']);
    expect(settleEffect(s, { cleanup: 'release', outcome: 'succeeded' }).next).toEqual({
      kind: 'complete',
      closed: 'queued',
    });
  });

  it('an in-flight cleanup call is never invoked again by a concurrent attempt', () => {
    const s = opened();
    running(s, 1);
    const close = { identity: identity('close-1'), ifRunActive: 'interrupt' as const };
    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'interrupt' } });
    // The interrupt never settles; a retry skips it and disposes (disposal with a run in flight is legal).
    expect(beginCleanup(s, close)).toEqual({ kind: 'cleanup', step: { kind: 'attempt', phase: 'dispose' } });
    expect(beginCleanup(s, close)).toEqual({
      kind: 'cleanup',
      step: { kind: 'stopped', pending: 'in-flight', failed: [] },
    });
    expect(s.run?.interrupt).toBe('in-flight');
    expect(s.close?.dispose).toBe('in-flight');
  });

  it('a settling effect continues cleanup only with never-attempted phases, never retrying a failure', () => {
    const s = opened();
    const started = running(s, 1);
    const response = reserveEffect(s, {
      effect: 'response',
      identity: identity('respond-1'),
      runId: started.runId,
      subject: 'interaction-1',
    });
    if (response.kind !== 'reserved') throw new Error('response refused');
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'cleanup',
      step: { kind: 'attempt', phase: 'interrupt' },
    });
    expect(settleEffect(s, { cleanup: 'interrupt', outcome: 'failed' }).next).toEqual({
      kind: 'stopped',
      pending: 'effect',
      failed: ['interrupt'],
    });

    // No caller retried: the failed interrupt is not reissued, the never-attempted dispose is.
    const settled = settleEffect(s, { ordinal: response.ordinal, outcome: { kind: 'applied', result: 'settled' } });
    expect(settled.next).toEqual({ kind: 'attempt', phase: 'dispose' });
    expect(s.run?.interrupt).toBe('failed');
    expect(settleEffect(s, { cleanup: 'dispose', outcome: 'failed' }).next).toEqual({
      kind: 'stopped',
      failed: ['interrupt', 'dispose'],
    });

    // The explicit retry re-arms exactly the failed calls.
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'cleanup',
      step: { kind: 'attempt', phase: 'interrupt' },
    });
  });

  it('a close re-arms an overflow interrupt that already failed', () => {
    const s = opened();
    const started = running(s, 1);
    fillToCap(s);
    expect(acceptEvent(s, started.fence, 'excess')).toMatchObject({ interrupt: started.runId });
    settleEffect(s, { cleanup: 'interrupt', outcome: 'failed' });
    expect(acceptEvent(s, started.fence, 'again')).toEqual({ kind: 'refused', reason: 'overflowed' });
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' })).toEqual({
      kind: 'cleanup',
      step: { kind: 'attempt', phase: 'interrupt' },
    });
  });

  it('ifRunActive reject refuses a starting run without fencing it', () => {
    const s = opened();
    const started = reserve(s, 1);
    expect(beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'reject' })).toEqual({
      kind: 'reject-active',
      runId: started.runId,
    });
    expect(s.close).toBeUndefined();
    expect(s.run?.fenced).toBe(false);
    expect(acceptEvent(s, started.fence, 'run-1:still-live').kind).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// S1-06: retirement
// ---------------------------------------------------------------------------

describe('S1-06 retirement', () => {
  it('many completed turns retain no per-run bookkeeping; old sinks keep only their immutable fence', () => {
    const s = opened();
    const fences: RunSinkFence[] = [];
    const shape = (): string => JSON.stringify(Object.keys(s).sort());
    const initialShape = shape();
    for (let turn = 1; turn <= 500; turn += 1) {
      const started = running(s, turn);
      acceptEvent(s, started.fence, `run-${String(turn)}:output`);
      chooseTerminal(s, { runId: started.runId, outcome: 'succeeded', cause: 'completion' });
      drain(s);
      fences.push(started.fence);
      expect(s.run).toBeUndefined();
      expect(s.queue).toHaveLength(0);
      expect(s.counted).toBe(0);
      expect(shape()).toBe(initialShape);
    }
    for (const fence of fences) {
      expect(Object.isFrozen(fence)).toBe(true);
      expect(acceptEvent(s, fence, 'late')).toEqual({ kind: 'discarded', reason: 'stale-sink' });
    }
    expect(s.counted).toBe(0);
  });

  it('keeps only a minimal tombstone for an unresolved receipt and drops it after commit', () => {
    const s = opened();
    acceptEvent(s, 'session', 'session:head');
    const started = reserve(s, 1);
    for (let index = 0; index < 3; index += 1) acceptEvent(s, started.fence, 'y'.repeat(1 << 16));
    // The earlier head fails recoverably, so the receipt below cannot commit yet.
    fail(s, 'absent');
    settleEffect(s, { ordinal: started.ordinal, outcome: { kind: 'rejected', result: 'receipt:start-rejected' } });
    expect(s.run).toBeUndefined();
    expect(queued(s)).toEqual(['session:head', 'start:rejected:receipt:start-rejected']);
    expect(Object.keys(s.queue[1]!).sort()).toEqual(['effect', 'identity', 'kind', 'ordinal', 'result', 'state']);

    advanceHead(s, {
      kind: 'committed',
      ordinal: (advanceHead(s, { kind: 'submit', retry: true }) as { op: Operation<Body> }).op.ordinal,
    });
    expect(drain(s)).toEqual(['start:rejected:receipt:start-rejected']);
    expect(s.queue).toHaveLength(0);
  });

  it('refused close identities do not accumulate', () => {
    const s = opened();
    reserve(s, 1);
    beginCleanup(s, { identity: identity('close-0'), ifRunActive: 'interrupt' });
    for (let index = 1; index <= 100; index += 1) {
      expect(beginCleanup(s, { identity: identity(`close-${String(index)}`), ifRunActive: 'interrupt' })).toEqual({
        kind: 'refused',
        reason: 'busy',
      });
    }
    expect(s.close?.identity?.commandId).toBe('close-0');
  });

  it('after close only the permanent overflow marker survives retirement', () => {
    const s = opened();
    fillToCap(s);
    acceptEvent(s, 'session', 'excess');
    const close = beginCleanup(s, { identity: identity('close-1'), ifRunActive: 'interrupt' });
    if (close.kind !== 'cleanup') throw new Error('close refused');
    expect(completeCleanup(s, close.step)).toEqual({ kind: 'complete', closed: 'queued' });
    drain(s);
    expect(s.state).toBe('closed');
    expect(retire(s)).toEqual({ overflow: true });
    expect(acceptEvent(s, 'session', 'after-close')).toEqual({ kind: 'discarded', reason: 'session-ended' });

    const healthy = opened();
    const healthyClose = beginCleanup(healthy, { identity: identity('close-2'), ifRunActive: 'interrupt' });
    if (healthyClose.kind !== 'cleanup') throw new Error('close refused');
    completeCleanup(healthy, healthyClose.step);
    drain(healthy);
    expect(retire(healthy)).toBeUndefined();
  });

  it('a failed session open is discarded without a ghost fault marker', () => {
    const s = createSessionIngestion<Body>(SESSION, identity('open'));
    for (let index = 0; index <= PRE_ACTIVATION_LIMIT; index += 1)
      acceptEvent(s, 'session', `session:${String(index)}`);
    expect(ingestionFault(s)).toMatchObject({ kind: 'overflow' });
    expect(settleEffect(s, { ordinal: 0, outcome: { kind: 'rejected', result: 'receipt:open-rejected' } }).kind).toBe(
      'discarded',
    );
    expect(s.state).toBe('discarded');
    expect(s.queue).toHaveLength(0);
    expect(retire(s)).toBeUndefined();
  });
});
