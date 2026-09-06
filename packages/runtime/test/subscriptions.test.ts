import { describe, expect, it } from 'vitest';

import {
  EventEnvelopeSchema,
  SessionIdSchema,
  SubscriptionRequestSchema,
  WIRE_VERSION,
  createCounterIdFactory,
  createFixedClock,
  type EventEnvelope,
} from '@relvo-labs/agent-protocol';

import { createInMemoryStore, type CommitResult, type RuntimeStore, type StoreTransaction } from '../src/store.ts';
import { bufferedEventCountForTesting, createSubscriptionHub } from '../src/subscriptions.ts';

function readableStore(events: EventEnvelope[]): RuntimeStore {
  return {
    revision: 0,
    commit<T>(_mutate: (tx: StoreTransaction) => T): Promise<{ value: T } & CommitResult> {
      return Promise.reject(new Error('commit is not used by this subscription test'));
    },
    read: () => Promise.resolve(undefined),
    readEvents(_sessionId, fromSequence, limit = 500) {
      const available = events.filter((event) => event.sequence > fromSequence);
      const page = available.slice(0, limit);
      return Promise.resolve({
        events: page,
        nextSequence: page.at(-1)?.sequence ?? fromSequence,
        revision: 0,
        hasMore: available.length > page.length,
      });
    },
    readInteraction: () => Promise.resolve(undefined),
    findReceipt: () => Promise.resolve(undefined),
    listSessions: () => Promise.resolve([]),
  };
}

function event(
  idFactory: ReturnType<typeof createCounterIdFactory>,
  clock: ReturnType<typeof createFixedClock>,
  sessionId: ReturnType<typeof SessionIdSchema.parse>,
  sequence: number,
): EventEnvelope {
  return EventEnvelopeSchema.parse({
    eventId: idFactory.next('event'),
    sessionId,
    sequence,
    occurredAt: clock.now(),
    wireVersion: WIRE_VERSION,
    payload: { type: 'diagnostic', level: 'info', message: `event ${String(sequence)}` },
  });
}

function terminalEvent(
  idFactory: ReturnType<typeof createCounterIdFactory>,
  clock: ReturnType<typeof createFixedClock>,
  sessionId: ReturnType<typeof SessionIdSchema.parse>,
  reason: 'requested' | 'failed',
): EventEnvelope {
  return EventEnvelopeSchema.parse({
    eventId: idFactory.next('event'),
    sessionId,
    sequence: 2,
    occurredAt: clock.now(),
    wireVersion: WIRE_VERSION,
    payload: {
      type: 'session.closed',
      reason,
      workspaceRelease: {
        leaseId: idFactory.next('workspaceLease'),
        ownership: 'borrowed',
        alreadyReleased: false,
        destructiveOperations: [],
        releasedAt: clock.now(),
      },
      ...(reason === 'failed'
        ? { error: { code: 'provider_contract_violation', message: 'failed session', retryable: false } }
        : {}),
    },
  });
}

describe('subscription hub buffering', () => {
  it('does not retain live notifications before the iterator is first consumed', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const store = createInMemoryStore({ clock, idFactory });
    const hub = createSubscriptionHub({ store, clock });
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const subscription = hub.subscribe(SubscriptionRequestSchema.parse({ sessionId, fromSequence: 0, bufferSize: 8 }));

    const events = Array.from({ length: 64 }, (_, index) => event(idFactory, clock, sessionId, index + 1));

    // Intentionally never call `next()`: merely obtaining a subscription must
    // not create an unbounded event-retention window.
    hub.publish(sessionId, events);
    expect(bufferedEventCountForTesting(hub)).toBe(0);

    await subscription.close();
    expect(hub.subscriberCount).toBe(0);
  });

  it('crosses from replay to live without gaps, duplicates, or reordering', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const events = [event(idFactory, clock, sessionId, 1), event(idFactory, clock, sessionId, 2)];
    const hub = createSubscriptionHub({ store: readableStore(events), clock, replayPageSize: 2 });
    const subscription = hub.subscribe(SubscriptionRequestSchema.parse({ sessionId, fromSequence: 0 }));
    const iterator = subscription[Symbol.asyncIterator]();

    const first = await iterator.next();
    events.push(event(idFactory, clock, sessionId, 3));
    hub.publish(sessionId, [events[2]!]);
    const second = await iterator.next();
    const third = await iterator.next();
    const caughtUp = await iterator.next();

    expect([first, second, third].map((result) => (result.done ? undefined : result.value))).toMatchObject([
      { type: 'event', event: { sequence: 1 }, replay: true },
      { type: 'event', event: { sequence: 2 }, replay: true },
      { type: 'event', event: { sequence: 3 }, replay: true },
    ]);
    expect(caughtUp).toMatchObject({ done: false, value: { type: 'caught_up', sequence: 3 } });

    events.push(event(idFactory, clock, sessionId, 4));
    hub.publish(sessionId, [events[3]!]);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { sequence: 4 }, replay: false },
    });

    await iterator.return?.();
    expect(hub.subscriberCount).toBe(0);
  });

  it('unregisters when an unstarted iterator is returned', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const store = createInMemoryStore({ clock, idFactory });
    const hub = createSubscriptionHub({ store, clock });
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const subscription = hub.subscribe(SubscriptionRequestSchema.parse({ sessionId }));
    const iterator = subscription[Symbol.asyncIterator]();

    expect(hub.subscriberCount).toBe(1);
    await iterator.return?.();
    expect(hub.subscriberCount).toBe(0);
  });

  it.each([
    ['requested', 'session_closed'],
    ['failed', 'session_failed'],
  ] as const)('closes a late subscriber after replaying an already-%s session', async (terminalReason, closeReason) => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const events = [event(idFactory, clock, sessionId, 1), terminalEvent(idFactory, clock, sessionId, terminalReason)];
    const hub = createSubscriptionHub({ store: readableStore(events), clock });
    const iterator = hub
      .subscribe(SubscriptionRequestSchema.parse({ sessionId, fromSequence: 0 }))
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { sequence: 1 } } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { sequence: 2, payload: { type: 'session.closed' } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'caught_up', sequence: 2 } });

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'closed', reason: closeReason } });
    expect(hub.subscriberCount).toBe(0);
  });
});
