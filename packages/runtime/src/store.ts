/**
 * The runtime store seam.
 *
 * ST-01 in one sentence: **projected state is a fold of the event log, computed
 * inside the same commit that allocates the sequence and appends the event.**
 *
 * That is why `commit` hands out a transaction whose only way to change
 * anything is `emit`. There is no API for "update the state without an event"
 * or "append an event without updating the state", so the two cannot drift. A
 * mutation that throws part-way discards the whole draft, including any
 * sequence numbers it had allocated.
 *
 * Commits are serialised through a promise chain. A durable implementation
 * would swap this for a transaction against real storage; the interface is
 * shaped so that substitution does not change any caller.
 */

import {
  AgentRuntimeError,
  agentError,
  cursorFromSequence,
  type AgentInteraction,
  type AgentRun,
  type AgentSession,
  type AgentTurn,
  type Clock,
  type CommandId,
  type CommandReceipt,
  type EventEnvelope,
  type EventId,
  type EventPage,
  type EventPayload,
  type IdFactory,
  type InteractionId,
  type RunId,
  type Sequence,
  type SessionId,
  type SessionSnapshot,
  type TurnId,
  WIRE_VERSION,
} from '@relvo-labs/agent-protocol';

import { applyEvent } from './projection.ts';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type SessionRecord = {
  session: AgentSession;
  turns: Map<TurnId, AgentTurn>;
  runs: Map<RunId, AgentRun>;
  interactions: Map<InteractionId, AgentInteraction>;
  events: EventEnvelope[];
};

export type ReceiptRecord = {
  /** Canonical fingerprint of the command payload, minus the id. */
  readonly fingerprint: string;
  readonly receipt: CommandReceipt;
};

export type EmitInput = {
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly payload: EventPayload;
};

export type StoreTransaction = {
  /** Read-only view of a session as it stands inside this transaction. */
  session(sessionId: SessionId): SessionRecord;
  hasSession(sessionId: SessionId): boolean;

  /** Create a session record. The caller must then emit `session.opened`. */
  createSession(session: AgentSession): void;

  /**
   * Allocate a sequence, stamp an envelope, append it, and fold it into the
   * projection — atomically. The only mutation primitive there is.
   */
  emit(input: EmitInput): EventEnvelope;

  /** Record a command receipt so a redispatch can be answered without effect. */
  recordReceipt(commandId: CommandId, record: ReceiptRecord): void;
  findReceipt(commandId: CommandId): ReceiptRecord | undefined;
};

export type CommitResult = {
  /** Monotonic store revision. Advances by exactly one per successful commit. */
  readonly revision: number;
  /** Events appended by this commit, in order. */
  readonly events: readonly EventEnvelope[];
};

export type RuntimeStore = {
  readonly revision: number;
  commit<T>(mutate: (tx: StoreTransaction) => T): Promise<{ value: T } & CommitResult>;
  read(sessionId: SessionId): Promise<SessionSnapshot | undefined>;
  readEvents(sessionId: SessionId, fromSequence: Sequence, limit?: number): Promise<EventPage>;
  readInteraction(sessionId: SessionId, interactionId: InteractionId): Promise<AgentInteraction | undefined>;
  findReceipt(commandId: CommandId): Promise<ReceiptRecord | undefined>;
  listSessions(): Promise<readonly SessionId[]>;
};

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

type StoreState = {
  revision: number;
  sessions: Map<SessionId, SessionRecord>;
  receipts: Map<CommandId, ReceiptRecord>;
};

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    session: { ...record.session },
    turns: new Map(record.turns),
    runs: new Map(record.runs),
    interactions: new Map(record.interactions),
    events: [...record.events],
  };
}

export type InMemoryStoreOptions = {
  readonly clock: Clock;
  readonly idFactory: IdFactory;
  readonly defaultPageSize?: number;
};

export function createInMemoryStore(options: InMemoryStoreOptions): RuntimeStore {
  const defaultPageSize = options.defaultPageSize ?? 1000;

  let state: StoreState = { revision: 0, sessions: new Map(), receipts: new Map() };

  // Serialises commits. Without this, two concurrent `commit` calls could each
  // read the same base revision and one would silently lose its events.
  let queue: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(task: () => T): Promise<T> {
    const result = queue.then(task, task);
    // Keep the chain alive even if a commit rejects.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    get revision(): number {
      return state.revision;
    },

    commit<T>(mutate: (tx: StoreTransaction) => T): Promise<{ value: T } & CommitResult> {
      return runExclusive(() => {
        // Copy-on-write draft. Nothing observable changes until the swap below.
        const draftSessions = new Map(state.sessions);
        const draftReceipts = new Map(state.receipts);
        const touched = new Set<SessionId>();
        const appended: EventEnvelope[] = [];

        function draftOf(sessionId: SessionId): SessionRecord {
          const existing = draftSessions.get(sessionId);
          if (!existing) {
            throw new AgentRuntimeError(agentError('unknown_session', `unknown session \`${sessionId}\``));
          }
          if (!touched.has(sessionId)) {
            const copy = cloneRecord(existing);
            draftSessions.set(sessionId, copy);
            touched.add(sessionId);
            return copy;
          }
          return existing;
        }

        const tx: StoreTransaction = {
          session: draftOf,
          hasSession: (sessionId) => draftSessions.has(sessionId),

          createSession(session: AgentSession): void {
            if (draftSessions.has(session.sessionId)) {
              throw new AgentRuntimeError(
                agentError('invalid_request', `session \`${session.sessionId}\` already exists`),
              );
            }
            draftSessions.set(session.sessionId, {
              session,
              turns: new Map(),
              runs: new Map(),
              interactions: new Map(),
              events: [],
            });
            touched.add(session.sessionId);
          },

          emit(input: EmitInput): EventEnvelope {
            const record = draftOf(input.sessionId);
            const sequence = (record.session.sequence + 1) as Sequence;

            const envelope: EventEnvelope = {
              eventId: options.idFactory.next('event') as EventId,
              sessionId: input.sessionId,
              ...(input.runId === undefined ? {} : { runId: input.runId }),
              sequence,
              occurredAt: options.clock.now(),
              wireVersion: WIRE_VERSION,
              payload: input.payload,
            };

            record.events.push(envelope);
            record.session = { ...record.session, sequence };
            // Sequence allocation, the event body and the projection all land
            // in this same draft. There is no window in which they disagree.
            applyEvent(record, envelope);
            appended.push(envelope);
            return envelope;
          },

          recordReceipt(commandId: CommandId, receiptRecord: ReceiptRecord): void {
            draftReceipts.set(commandId, receiptRecord);
          },

          findReceipt: (commandId: CommandId) => draftReceipts.get(commandId),
        };

        // If `mutate` throws, we simply never swap. The draft — including every
        // sequence number it allocated — is discarded with it.
        const value = mutate(tx);

        state = { revision: state.revision + 1, sessions: draftSessions, receipts: draftReceipts };
        return { value, revision: state.revision, events: appended };
      });
    },

    read(sessionId: SessionId): Promise<SessionSnapshot | undefined> {
      const record = state.sessions.get(sessionId);
      if (!record) return Promise.resolve(undefined);
      return Promise.resolve({
        session: { ...record.session },
        turns: [...record.turns.values()],
        runs: [...record.runs.values()],
        interactions: [...record.interactions.values()],
        revision: state.revision,
      });
    },

    readEvents(sessionId: SessionId, fromSequence: Sequence, limit?: number): Promise<EventPage> {
      const record = state.sessions.get(sessionId);
      const pageSize = limit ?? defaultPageSize;
      if (!record) {
        return Promise.resolve({
          events: [],
          nextSequence: fromSequence,
          revision: state.revision,
          hasMore: false,
        });
      }
      // `fromSequence` is a POSITION, not an index: it means "everything after
      // this point". `0` therefore means "from the beginning".
      const matching = record.events.filter((event) => event.sequence > fromSequence);
      const page = matching.slice(0, pageSize);
      const last = page.at(-1);
      return Promise.resolve({
        events: page,
        nextSequence: last?.sequence ?? fromSequence,
        revision: state.revision,
        hasMore: matching.length > page.length,
      });
    },

    readInteraction(sessionId: SessionId, interactionId: InteractionId): Promise<AgentInteraction | undefined> {
      return Promise.resolve(state.sessions.get(sessionId)?.interactions.get(interactionId));
    },

    findReceipt(commandId: CommandId): Promise<ReceiptRecord | undefined> {
      return Promise.resolve(state.receipts.get(commandId));
    },

    listSessions(): Promise<readonly SessionId[]> {
      return Promise.resolve([...state.sessions.keys()]);
    },
  };
}

/** Cursor for "resume after this sequence". */
export function cursorAt(sequence: number): ReturnType<typeof cursorFromSequence> {
  return cursorFromSequence(sequence);
}
