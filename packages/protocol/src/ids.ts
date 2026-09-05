/**
 * Identity.
 *
 * Session, Turn, Run and Interaction are four distinct identities with four
 * distinct prefixes, so an ID can never be silently used in the wrong position:
 * a `RunId` passed where a `TurnId` is expected fails both at compile time
 * (brands) and at parse time (prefix).
 *
 * Command IDs are caller-generated and therefore deliberately permissive in
 * shape — the runtime must accept a caller's UUID, ULID or KSUID — but they are
 * still branded and length-bounded.
 */

import { z } from 'zod';

/** Prefixes are part of the wire contract; changing one is a breaking change. */
export const ID_PREFIX = {
  session: 'ses',
  turn: 'trn',
  run: 'run',
  interaction: 'int',
  event: 'evt',
  workspaceLease: 'wsl',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const SUFFIX_PATTERN = '[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{16,32}';

function prefixedId(kind: IdKind) {
  const pattern = new RegExp(`^${ID_PREFIX[kind]}_${SUFFIX_PATTERN}$`);
  return z.string().regex(pattern, `expected a ${kind} id of the form \`${ID_PREFIX[kind]}_<16-32 base32 chars>\``);
}

export const SessionIdSchema = prefixedId('session').brand<'SessionId'>();
export const TurnIdSchema = prefixedId('turn').brand<'TurnId'>();
export const RunIdSchema = prefixedId('run').brand<'RunId'>();
export const InteractionIdSchema = prefixedId('interaction').brand<'InteractionId'>();
export const EventIdSchema = prefixedId('event').brand<'EventId'>();
export const WorkspaceLeaseIdSchema = prefixedId('workspaceLease').brand<'WorkspaceLeaseId'>();

export type SessionId = z.infer<typeof SessionIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type InteractionId = z.infer<typeof InteractionIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type WorkspaceLeaseId = z.infer<typeof WorkspaceLeaseIdSchema>;

/**
 * Caller-generated. The runtime does not mint these; it only deduplicates on
 * them. Accepts any opaque token a caller's ID library produces.
 */
export const CommandIdSchema = z
  .string()
  .min(8, 'a command id shorter than 8 characters is too collision-prone to deduplicate on')
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'command ids must be URL- and log-safe')
  .brand<'CommandId'>();

export type CommandId = z.infer<typeof CommandIdSchema>;

/**
 * Monotonic per-session event position. Allocated by the store, never by a
 * provider or a caller. Sequence 0 is the position *before* the first event, so
 * `fromSequence: 0` means "everything".
 */
export const SequenceSchema = z.int().nonnegative().brand<'Sequence'>();
export type Sequence = z.infer<typeof SequenceSchema>;

/** Opaque, resumable subscription position. */
export const CursorSchema = z
  .string()
  .regex(/^cur_\d+$/, 'a cursor must be an opaque `cur_<sequence>` token')
  .brand<'Cursor'>();
export type Cursor = z.infer<typeof CursorSchema>;

export function cursorFromSequence(sequence: number): Cursor {
  return `cur_${String(sequence)}` as Cursor;
}

export function sequenceFromCursor(cursor: Cursor): number {
  return Number.parseInt(cursor.slice('cur_'.length), 10);
}

/** RFC 3339 UTC instant. Stamped by the runtime clock, never by a provider. */
export const TimestampSchema = z.iso.datetime({ offset: false }).brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Deterministic ID minting seam.
 *
 * The runtime takes this as a dependency so contract tests can assert exact IDs
 * instead of matching regexes. Production callers pass a random implementation.
 */
export type IdFactory = {
  readonly next: (kind: IdKind) => string;
};

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic, collision-free within a process; used by tests and by default. */
export function createCounterIdFactory(seed = 0): IdFactory {
  let counter = seed;
  return {
    next(kind: IdKind): string {
      counter += 1;
      let remaining = counter;
      let suffix = '';
      for (let i = 0; i < 16; i += 1) {
        suffix = BASE32.charAt(remaining % 32) + suffix;
        remaining = Math.floor(remaining / 32);
      }
      return `${ID_PREFIX[kind]}_${suffix}`;
    },
  };
}

/** Wall-clock seam, injected for the same reason as {@link IdFactory}. */
export type Clock = {
  readonly now: () => Timestamp;
};

/** Advances by a fixed step per call so event ordering is reproducible. */
export function createFixedClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1): Clock {
  let current = Date.parse(startIso);
  return {
    now(): Timestamp {
      const value = new Date(current).toISOString() as Timestamp;
      current += stepMs;
      return value;
    },
  };
}

export function createSystemClock(): Clock {
  return { now: (): Timestamp => new Date().toISOString() as Timestamp };
}
