import { describe, expect, it } from 'vitest';
import type { SessionId, SessionSnapshot } from '@relvo-labs/agent-protocol';

import { createSessionAdmission } from '../src/session-admission.ts';

const SID_A = 'ses_00000000000000A0' as SessionId;
const SID_B = 'ses_00000000000000B0' as SessionId;

function snapshotWithState(sessionId: SessionId, state: 'ready' | 'closed' | 'failed'): SessionSnapshot {
  return {
    session: {
      sessionId,
      state,
      providerId: 'scripted-demo',
      wireVersion: '0.4',
      workspace: {
        leaseId: 'wsl_00000000000000A0' as never,
        ownership: 'managed',
        root: '/tmp/x',
        acquiredAt: '2026-01-01T00:00:00.000Z' as never,
        released: state !== 'ready',
      },
      createdAt: '2026-01-01T00:00:00.000Z' as never,
      sequence: 1 as never,
      turnIds: [],
    },
    turns: [],
    runs: [],
    interactions: [],
    revision: 1,
  };
}

describe('session admission: one active session at a time', () => {
  it('admits the first open, then blocks a second distinct attempt', () => {
    const admission = createSessionAdmission();
    expect(admission.beginOpen('cmd-1')).toEqual({ ok: true });
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    const second = admission.beginOpen('cmd-2');
    expect(second).toEqual({ ok: false, reason: 'session_already_open', sessionId: SID_A });
  });

  it('always admits an exact retry of the commandId that is currently active', () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    expect(admission.beginOpen('cmd-1')).toEqual({ ok: true });
  });

  it('always admits a concurrent retry of the commandId that is still pending', () => {
    const admission = createSessionAdmission();
    expect(admission.beginOpen('cmd-1')).toEqual({ ok: true });
    // A second, distinct commandId is blocked while the first is still pending.
    expect(admission.beginOpen('cmd-2')).toEqual({ ok: false, reason: 'another_open_in_flight' });
    // But a duplicate of the still-pending one is admitted (runtime dedupes it).
    expect(admission.beginOpen('cmd-1')).toEqual({ ok: true });
  });

  it('frees the slot when the pending attempt is rejected, and admits a fresh open next', () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', undefined); // rejected receipt or thrown error

    expect(admission.beginOpen('cmd-2')).toEqual({ ok: true });
  });

  it('frees the slot on an explicit successful close, and admits a fresh open next', () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    admission.noteCloseOutcome(SID_A, true);
    expect(admission.beginOpen('cmd-2')).toEqual({ ok: true });
  });

  it('does not free the slot on a close outcome that did not actually close it', () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    admission.noteCloseOutcome(SID_A, false);
    expect(admission.beginOpen('cmd-2')).toEqual({ ok: false, reason: 'session_already_open', sessionId: SID_A });
  });

  it('self-heals via refresh() when the tracked session independently reached a terminal state', async () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    await admission.refresh(async (id) => {
      expect(id).toBe(SID_A);
      return snapshotWithState(SID_A, 'failed');
    });

    expect(admission.beginOpen('cmd-2')).toEqual({ ok: true });
  });

  it('refresh() is a no-op while the tracked session is still non-terminal', async () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    await admission.refresh(async () => snapshotWithState(SID_A, 'ready'));

    expect(admission.beginOpen('cmd-2')).toEqual({ ok: false, reason: 'session_already_open', sessionId: SID_A });
  });

  it('refresh() treats an unknown (evicted) session as terminal', async () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });

    await admission.refresh(async () => undefined);

    expect(admission.beginOpen('cmd-2')).toEqual({ ok: true });
  });

  it('tracks a second session correctly after the first is freed', () => {
    const admission = createSessionAdmission();
    admission.beginOpen('cmd-1');
    admission.settleOpen('cmd-1', { sessionId: SID_A });
    admission.noteCloseOutcome(SID_A, true);

    admission.beginOpen('cmd-2');
    admission.settleOpen('cmd-2', { sessionId: SID_B });

    expect(admission.beginOpen('cmd-3')).toEqual({ ok: false, reason: 'session_already_open', sessionId: SID_B });
  });
});
