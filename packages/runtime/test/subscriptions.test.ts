import { describe, expect, it } from 'vitest';

import {
  EventEnvelopeSchema,
  SessionIdSchema,
  SubscriptionRequestSchema,
  WIRE_VERSION,
  cursorFromSequence,
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
  it('switches to live without yielding after the final synchronous fault check', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    let releaseQueuedFault!: () => void;
    const queuedFault = new Promise<void>((resolve) => {
      releaseQueuedFault = resolve;
    });
    let checks = 0;
    let faulted = false;
    let retainedAtFault = -1;
    const hub = createSubscriptionHub({
      store: readableStore([]),
      clock,
      checkReplayReady: () => {
        if (faulted) throw new Error('ingestion fault');
        if (++checks === 3) {
          void Promise.resolve().then(() => {
            faulted = true;
            hub.publish(sessionId, [event(idFactory, clock, sessionId, 1)]);
            retainedAtFault = bufferedEventCountForTesting(hub);
            releaseQueuedFault();
          });
        }
      },
    });
    const iterator = hub
      .subscribe(SubscriptionRequestSchema.parse({ sessionId, fromSequence: 0 }))
      [Symbol.asyncIterator]();
    const next = iterator.next();
    void next.catch(() => undefined);
    await queuedFault;
    expect(retainedAtFault).toBe(1);
    await expect(next).resolves.toMatchObject({ value: { type: 'caught_up' } });
    await iterator.return?.();
  });

  it('keeps each replay page within the subscriber retention capacity', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const events = Array.from({ length: 20 }, (_, index) => event(idFactory, clock, sessionId, index + 1));
    const base = readableStore(events);
    const limits: (number | undefined)[] = [];
    const store: RuntimeStore = {
      ...base,
      readEvents: (id, from, limit) => {
        limits.push(limit);
        return base.readEvents(id, from, limit);
      },
    };
    const hub = createSubscriptionHub({ store, clock, replayPageSize: 500 });
    const iterator = hub
      .subscribe(
        SubscriptionRequestSchema.parse({
          sessionId,
          fromSequence: 0,
          bufferSize: 8,
        }),
      )
      [Symbol.asyncIterator]();
    await iterator.next();
    expect(limits).toEqual([8]);
    await iterator.return?.();
  });

  it('ignores unrelated live traffic without overflowing and advances the observed cursor', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const hub = createSubscriptionHub({ store: readableStore([]), clock });
    const iterator = hub
      .subscribe(
        SubscriptionRequestSchema.parse({
          sessionId,
          fromSequence: 0,
          bufferSize: 8,
          types: ['run.message_delta'],
        }),
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'caught_up' } });
    hub.publish(
      sessionId,
      Array.from({ length: 20 }, (_, index) => event(idFactory, clock, sessionId, index + 1)),
    );
    expect(bufferedEventCountForTesting(hub)).toBe(0);
    const matching = EventEnvelopeSchema.parse({
      eventId: idFactory.next('event'),
      sessionId,
      sequence: 21,
      occurredAt: clock.now(),
      wireVersion: WIRE_VERSION,
      payload: { type: 'run.message_delta', text: 'hello' },
    });
    hub.publish(sessionId, [matching]);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { sequence: 21 } } });
    expect(bufferedEventCountForTesting(hub)).toBeLessThanOrEqual(8);
    hub.publish(sessionId, [
      EventEnvelopeSchema.parse({
        ...terminalEvent(idFactory, clock, sessionId, 'requested'),
        sequence: 22,
      }),
    ]);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'closed', cursor: cursorFromSequence(22) },
    });
    await iterator.return?.();
  });

  it('counts the paused delivery event and pending events against one capacity', async () => {
    const clock = createFixedClock();
    const idFactory = createCounterIdFactory();
    const sessionId = SessionIdSchema.parse(idFactory.next('session'));
    const hub = createSubscriptionHub({ store: readableStore([]), clock });
    const iterator = hub
      .subscribe(
        SubscriptionRequestSchema.parse({
          sessionId,
          fromSequence: 0,
          bufferSize: 8,
        }),
      )
      [Symbol.asyncIterator]();
    await iterator.next(); // caught up
    hub.publish(
      sessionId,
      Array.from({ length: 8 }, (_, index) => event(idFactory, clock, sessionId, index + 1)),
    );
    await iterator.next(); // paused while delivering event 1
    expect(bufferedEventCountForTesting(hub)).toBe(8);
    hub.publish(
      sessionId,
      [9, 10].map((n) => event(idFactory, clock, sessionId, n)),
    );
    expect(bufferedEventCountForTesting(hub)).toBeLessThanOrEqual(8);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { sequence: 2 } } });
    for (let sequence = 3; sequence <= 8; sequence += 1) {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'event', event: { sequence } } });
    }
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'overflow', droppedFromSequence: 9 } });
    await iterator.return?.();
  });

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
