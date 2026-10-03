/**
 * Replay-then-live subscription delivery.
 *
 * Ordering of operations in `subscribe` is load-bearing:
 *
 *   1. attach a constant-space high-water listener FIRST, synchronously,
 *      before any await;
 *   2. then drain durable history from the store to that high-water mark;
 *   3. atomically switch the listener to bounded live buffering.
 *
 * Doing it the other way round — read the store, then attach — loses every
 * event emitted in between, silently. Attaching first can only ever produce
 * *overlap*, which the sequence cursor removes deterministically. Trading a
 * recoverable failure mode for an unrecoverable one is the whole design.
 *
 * Overflow can only be reported after `caught_up`. Before that point the store
 * is still the source, so a slow consumer costs latency, not events. After it,
 * the buffer is the source and its bound is real — so the stream says so
 * explicitly and hands back a cursor into durable storage.
 */

import {
  cursorFromSequence,
  type Clock,
  type EventEnvelope,
  type Sequence,
  type SessionId,
  type SubscriptionMessage,
  type SubscriptionRequest,
} from '@relvo-labs/agent-protocol';
import type { EventSubscription } from '@relvo-labs/agent-executor';

import type { RuntimeStore } from './store.ts';

type Subscriber = {
  readonly sessionId: SessionId;
  readonly bufferSize: number;
  readonly matches: (event: EventEnvelope) => boolean;
  buffer: EventEnvelope[];
  delivering: EventEnvelope | undefined;
  /** Set once the bound is crossed; counts everything not buffered since. */
  overflow: { from: Sequence; through: Sequence; count: number } | undefined;
  /** Pending/replay retain only a high-water sequence; live uses the buffer. */
  phase: 'pending' | 'replaying' | 'live';
  highestPublishedSequence: number;
  closed: boolean;
  terminal: 'session_closed' | 'session_failed' | undefined;
  wake: (() => void) | undefined;
};

export type SubscriptionHub = {
  subscribe(request: SubscriptionRequest): EventSubscription;
  /** Called after a commit, with the events that commit appended. */
  publish(sessionId: SessionId, events: readonly EventEnvelope[]): void;
  /** Release every subscriber. Idempotent. */
  closeAll(): void;
  readonly subscriberCount: number;
};

export type SubscriptionHubOptions = {
  readonly store: RuntimeStore;
  readonly clock: Clock;
  readonly replayPageSize?: number;
  /** Runtime guard for a process-local provider ingestion fault. */
  readonly checkReplayReady?: (sessionId: SessionId) => Promise<void> | void;
};

const subscriberSets = new WeakMap<SubscriptionHub, ReadonlySet<Subscriber>>();

/** @internal Deterministic memory-bound diagnostic for contract tests. */
export function bufferedEventCountForTesting(hub: SubscriptionHub): number {
  const subscribers = subscriberSets.get(hub);
  if (subscribers === undefined) throw new Error('subscription hub was not created by createSubscriptionHub');
  let count = 0;
  for (const subscriber of subscribers)
    count += subscriber.buffer.length + (subscriber.delivering === undefined ? 0 : 1);
  return count;
}

/** Throws while a session's history cannot be certified (ingestion fault A, O or F). */
type IngestionFaultGuard = (sessionId: SessionId) => void;

const faultGuardInstallers = new WeakMap<
  SubscriptionHub,
  (guard: IngestionFaultGuard) => (sessionId: SessionId) => void
>();

/**
 * @internal Module-internal ingestion fault notifier (issue #43). Deliberately
 * not a member of the public `SubscriptionHub` type and not re-exported from
 * the package entry point.
 *
 * Installs `guard` on a hub created by `createSubscriptionHub` and returns the
 * notifier that wakes that session's idle subscribers. The guard runs before
 * and after every replay page, before and after every replay delivery, before
 * the live switch, before each buffered live event, after every wake (also one
 * that closed the subscriber) and before every `closed` marker. When it throws,
 * the subscriber's pending `next()` rejects with that error instead of hanging
 * or yielding a healthy-looking page or `closed` marker. A hub without an
 * installed guard behaves exactly as before.
 */
export function installIngestionFaultGuard(
  hub: SubscriptionHub,
  guard: IngestionFaultGuard,
): (sessionId: SessionId) => void {
  const install = faultGuardInstallers.get(hub);
  if (install === undefined) throw new Error('subscription hub was not created by createSubscriptionHub');
  return install(guard);
}

export function createSubscriptionHub(options: SubscriptionHubOptions): SubscriptionHub {
  const replayPageSize = options.replayPageSize ?? 500;
  const subscribers = new Set<Subscriber>();
  let faultGuard: IngestionFaultGuard | undefined;

  function notify(subscriber: Subscriber): void {
    const { wake } = subscriber;
    if (wake) {
      subscriber.wake = undefined;
      wake();
    }
  }

  function push(subscriber: Subscriber, event: EventEnvelope): void {
    if (subscriber.closed) return;

    subscriber.highestPublishedSequence = Math.max(subscriber.highestPublishedSequence, event.sequence);
    // The durable log is authoritative until replay catches its high-water
    // mark. Retaining the event object here would let a subscription that is
    // never iterated consume memory without bound.
    if (subscriber.phase !== 'live') return;
    if (!subscriber.matches(event)) return;

    if (subscriber.overflow) {
      subscriber.overflow.count += 1;
      subscriber.overflow.through = event.sequence;
      return;
    }
    if (subscriber.buffer.length + (subscriber.delivering === undefined ? 0 : 1) >= subscriber.bufferSize) {
      subscriber.overflow = { from: event.sequence, through: event.sequence, count: 1 };
      return;
    }
    subscriber.buffer.push(event);
  }

  const hub: SubscriptionHub = {
    get subscriberCount(): number {
      return subscribers.size;
    },

    publish(sessionId: SessionId, events: readonly EventEnvelope[]): void {
      for (const subscriber of subscribers) {
        if (subscriber.sessionId !== sessionId) continue;
        for (const event of events) {
          push(subscriber, event);
          if (event.payload.type === 'session.closed') {
            subscriber.terminal = event.payload.reason === 'failed' ? 'session_failed' : 'session_closed';
          }
        }
        notify(subscriber);
      }
    },

    subscribe(request: SubscriptionRequest): EventSubscription {
      const wanted = request.types === undefined ? undefined : new Set(request.types);
      const matches = (event: EventEnvelope): boolean => wanted === undefined || wanted.has(event.payload.type);
      // ---- step 1: attach live BEFORE any await -----------------------------
      const subscriber: Subscriber = {
        sessionId: request.sessionId,
        bufferSize: request.bufferSize,
        matches,
        buffer: [],
        delivering: undefined,
        overflow: undefined,
        phase: 'pending',
        highestPublishedSequence: request.fromSequence,
        closed: false,
        terminal: undefined,
        wake: undefined,
      };
      subscribers.add(subscriber);

      let lastEmitted: number = request.fromSequence;

      function detach(): void {
        subscriber.closed = true;
        subscribers.delete(subscriber);
        notify(subscriber);
      }

      // Keep asynchronous cancellation observable without asking static flow
      // analysis to model mutation performed by `close`, `return`, or closeAll.
      function isClosed(): boolean {
        return subscriber.closed;
      }

      /** Rejects this subscriber's pending `next()` while its session has an ingestion fault. */
      function checkFault(): void {
        faultGuard?.(request.sessionId);
      }

      async function* iterate(): AsyncGenerator<SubscriptionMessage> {
        try {
          if (isClosed()) return;
          subscriber.phase = 'replaying';

          // ---- step 2: durable history -------------------------------------
          for (;;) {
            await options.checkReplayReady?.(request.sessionId);
            checkFault();
            const page = await options.store.readEvents(
              request.sessionId,
              lastEmitted as Sequence,
              Math.min(replayPageSize, subscriber.bufferSize),
            );
            await options.checkReplayReady?.(request.sessionId);
            // A fault that arrived while this page read was held must not let it look healthy.
            checkFault();
            if (isClosed()) return;
            for (const event of page.events) {
              if (event.sequence <= lastEmitted) continue; // step 3
              lastEmitted = event.sequence;
              if (event.payload.type === 'session.closed') {
                subscriber.terminal = event.payload.reason === 'failed' ? 'session_failed' : 'session_closed';
              }
              if (!matches(event)) continue;
              // Before every replay delivery: a fault that arrived while this generator was
              // suspended inside a page must not let the page's remaining events through.
              checkFault();
              yield {
                type: 'event',
                event,
                cursor: cursorFromSequence(event.sequence),
                replay: true,
              };
              checkFault();
              if (isClosed()) return;
            }
            if (page.hasMore) continue;

            // `publish` updates this mark synchronously. No task can interleave
            // between this comparison and the phase transition, so an event is
            // either included by another durable read or enters the live
            // buffer after the transition — never neither and never both.
            if (subscriber.highestPublishedSequence > lastEmitted) continue;
            const readiness = options.checkReplayReady?.(request.sessionId);
            if (readiness !== undefined) await readiness;
            checkFault();
            if (subscriber.highestPublishedSequence > lastEmitted) continue;
            subscriber.phase = 'live';
            break;
          }

          // Transition before yielding the marker. An async generator pauses at
          // `yield`; setting this afterward would leave a window where events
          // are buffered without the advertised bound even though the caller
          // has already observed `caught_up`.
          yield {
            type: 'caught_up',
            cursor: cursorFromSequence(lastEmitted),
            sequence: lastEmitted as Sequence,
          };

          // Only now does the bounded buffer become the source of truth, so
          // only now can overflow be a real loss of delivery.
          // ---- live --------------------------------------------------------
          while (!isClosed()) {
            // Before a buffered event, after every wake and before `closed`: an
            // ingestion fault rejects instead of extending a gapped history.
            checkFault();
            const event = subscriber.buffer.shift();
            if (event !== undefined) {
              if (event.sequence <= lastEmitted) continue; // step 3
              lastEmitted = event.sequence;
              subscriber.delivering = event;
              yield {
                type: 'event',
                event,
                cursor: cursorFromSequence(event.sequence),
                replay: false,
              };
              subscriber.delivering = undefined;
              continue;
            }

            if (subscriber.overflow) {
              const { from, through, count } = subscriber.overflow;
              subscriber.overflow = undefined;
              yield {
                type: 'overflow',
                // Resume *after* the last event we actually delivered, so the
                // caller can backfill the gap from durable storage.
                resumeCursor: cursorFromSequence(from - 1),
                droppedFromSequence: from,
                undeliveredCount: count,
                bufferSize: subscriber.bufferSize,
                occurredAt: options.clock.now(),
              };
              if (request.overflowPolicy === 'signal_and_close') return;
              // `signal_and_skip`: continue from wherever the log now is.
              lastEmitted = Math.max(lastEmitted, through);
              continue;
            }

            // Filtered events still belong to the observed durable prefix.
            // Advance only after all earlier matching bodies have drained.
            lastEmitted = Math.max(lastEmitted, subscriber.highestPublishedSequence);

            if (subscriber.terminal !== undefined) {
              const reason = subscriber.terminal;
              checkFault();
              detach();
              yield {
                type: 'closed',
                cursor: cursorFromSequence(lastEmitted),
                reason,
              };
              return;
            }

            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
            });
            // After every wake, even one that also closed the subscriber (a fault
            // notification followed synchronously by `closeAll()`).
            checkFault();
          }

          // Never yield a healthy-looking `closed` marker while the session is faulted.
          checkFault();
          yield {
            type: 'closed',
            cursor: cursorFromSequence(lastEmitted),
            reason: 'unsubscribed',
          };
        } finally {
          detach();
        }
      }

      const generator = iterate();

      const iterator: AsyncIterator<SubscriptionMessage> = {
        next: () => generator.next(),
        async return(): Promise<IteratorResult<SubscriptionMessage>> {
          // Async-generator `finally` blocks do not execute when `return()` is
          // called before the generator starts, so detach explicitly first.
          detach();
          return generator.return(undefined);
        },
        async throw(error?: unknown): Promise<IteratorResult<SubscriptionMessage>> {
          detach();
          return generator.throw(error);
        },
      };

      return {
        [Symbol.asyncIterator](): AsyncIterator<SubscriptionMessage> {
          return iterator;
        },
        async close(): Promise<void> {
          detach();
          // `return()` runs the generator's `finally`, releasing it even if the
          // consumer abandoned a `for await` without breaking cleanly.
          await generator.return(undefined);
        },
      };
    },

    closeAll(): void {
      for (const subscriber of [...subscribers]) {
        subscriber.closed = true;
        subscribers.delete(subscriber);
        notify(subscriber);
      }
    },
  };

  subscriberSets.set(hub, subscribers);
  faultGuardInstallers.set(hub, (guard) => {
    if (faultGuard !== undefined) throw new Error('an ingestion fault guard is already installed on this hub');
    faultGuard = guard;
    return (sessionId) => {
      for (const subscriber of subscribers) if (subscriber.sessionId === sessionId) notify(subscriber);
    };
  });
  return hub;
}
