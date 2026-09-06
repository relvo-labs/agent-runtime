/**
 * Replay-then-live subscription semantics.
 *
 * Two failure modes drive this design.
 *
 * EV-01 — the gap. A naive implementation reads the stored log, then attaches a
 * live listener. Anything emitted between those two steps is lost forever, and
 * the loss is invisible. The contract therefore requires that a subscription
 * from sequence 0 observes *every* event, including ones emitted while the
 * replay was still running. Implementations attach the live listener first and
 * de-duplicate on `sequence`.
 *
 * EV-02 — the slow consumer. A subscriber that cannot keep up must not be able
 * to grow the runtime's memory without bound, and must not be silently starved
 * of events either. So buffering is bounded per subscriber, and when the bound
 * is exceeded the stream emits an explicit `overflow` message carrying a
 * resumable cursor. Durable events are never dropped — they remain in the store
 * and the cursor is the caller's way back to them.
 */

import { z } from 'zod';
import { CursorSchema, RunIdSchema, SequenceSchema, SessionIdSchema, TimestampSchema } from './ids.ts';
import { EventEnvelopeSchema, type EventType } from './events.ts';

export const OverflowPolicySchema = z.enum([
  /**
   * Emit an `overflow` message with a resume cursor and END the stream. The
   * caller decides whether to resubscribe. This is the default because it makes
   * the discontinuity impossible to ignore.
   */
  'signal_and_close',
  /**
   * Emit an `overflow` message and CONTINUE from the newest event. The gap is
   * explicit and the cursor lets the caller backfill from the store.
   */
  'signal_and_skip',
]);
export type OverflowPolicy = z.infer<typeof OverflowPolicySchema>;

export const SubscriptionRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  /**
   * Start position. `0` means "from the very beginning". A subscription always
   * begins with stored history and transitions to live without a gap.
   */
  fromSequence: SequenceSchema.default(0 as z.infer<typeof SequenceSchema>),
  /**
   * Maximum events held for this subscriber before overflow. Bounded on both
   * ends: unbounded buffering is a memory leak, and a buffer of 1 makes
   * overflow the normal case.
   */
  bufferSize: z.int().min(8).max(65_536).default(1024),
  overflowPolicy: OverflowPolicySchema.default('signal_and_close'),
  /** Optional server-side filter. Filtering does not affect sequence numbers. */
  types: z.array(z.string()).optional(),
});

export type SubscriptionRequest = z.infer<typeof SubscriptionRequestSchema>;
export type SubscriptionRequestInput = z.input<typeof SubscriptionRequestSchema>;

// ---------------------------------------------------------------------------
// Stream messages
// ---------------------------------------------------------------------------

const eventMessage = z.strictObject({
  type: z.literal('event'),
  event: EventEnvelopeSchema,
  /** Cursor to resume *after* this event. */
  cursor: CursorSchema,
  /** True while draining stored history, false once live. */
  replay: z.boolean(),
});

/**
 * Emitted exactly once, between the last replayed event and the first live one.
 *
 * Consumers that need "catch up, then react" — the common case for a UI — key
 * off this instead of guessing.
 */
const caughtUpMessage = z.strictObject({
  type: z.literal('caught_up'),
  cursor: CursorSchema,
  /** Sequence of the last replayed event; equals `fromSequence` if none. */
  sequence: SequenceSchema,
});

const overflowMessage = z.strictObject({
  type: z.literal('overflow'),
  /**
   * Resume here. Every event at or after this cursor is still durable in the
   * store; nothing has been lost, only un-delivered on this stream.
   */
  resumeCursor: CursorSchema,
  /** First sequence this subscriber did not receive. */
  droppedFromSequence: SequenceSchema,
  /** How many events were not delivered on this stream. */
  undeliveredCount: z.int().positive(),
  bufferSize: z.int().positive(),
  occurredAt: TimestampSchema,
});

/** The session reached a terminal state; no further events will ever arrive. */
const closedMessage = z.strictObject({
  type: z.literal('closed'),
  cursor: CursorSchema,
  reason: z.enum(['session_closed', 'session_failed', 'unsubscribed']),
});

export const SubscriptionMessageSchema = z.discriminatedUnion('type', [
  eventMessage,
  caughtUpMessage,
  overflowMessage,
  closedMessage,
]);

export type SubscriptionMessage = z.infer<typeof SubscriptionMessageSchema>;
export type EventMessage = z.infer<typeof eventMessage>;
export type CaughtUpMessage = z.infer<typeof caughtUpMessage>;
export type OverflowMessage = z.infer<typeof overflowMessage>;
export type ClosedMessage = z.infer<typeof closedMessage>;

export function isEventMessage(message: SubscriptionMessage): message is EventMessage {
  return message.type === 'event';
}

/** Narrow a stream message to a specific event payload type in one step. */
export function isEventMessageOfType<T extends EventType>(
  message: SubscriptionMessage,
  type: T,
): message is EventMessage & { event: { payload: { type: T } } } {
  return message.type === 'event' && message.event.payload.type === type;
}

// ---------------------------------------------------------------------------
// Store read contract
// ---------------------------------------------------------------------------

/**
 * A page of durable history. `nextSequence` is where the next page begins, so
 * a caller never has to reason about inclusive/exclusive bounds.
 */
export const EventPageSchema = z.strictObject({
  events: z.array(EventEnvelopeSchema),
  nextSequence: SequenceSchema,
  /** Store revision the page was read at (ST-01). */
  revision: z.int().nonnegative(),
  hasMore: z.boolean(),
});

export type EventPage = z.infer<typeof EventPageSchema>;

export const RunFilterSchema = z.strictObject({
  runId: RunIdSchema.optional(),
});
export type RunFilter = z.infer<typeof RunFilterSchema>;
