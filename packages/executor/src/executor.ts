/**
 * `AgentExecutor` — the consumer-facing contract.
 *
 * Everything mutating is a command with a caller-generated id and returns a
 * receipt; everything observational is either a projection read or a
 * subscription. There is no method that both mutates and streams, because that
 * combination is what makes retry semantics impossible to reason about.
 *
 * The interface is deliberately small. A host application composes it; it does
 * not subclass it.
 */

import type {
  AgentCommandInput,
  CloseSessionCommandInput,
  CommandReceipt,
  EventPage,
  InterruptRunCommandInput,
  OpenSessionCommandInput,
  ProviderDescriptor,
  RespondToInteractionCommandInput,
  Sequence,
  SessionId,
  SessionSnapshot,
  SubmitTurnCommandInput,
  SubscriptionMessage,
  SubscriptionRequestInput,
} from '@relvo-labs/agent-protocol';

/**
 * A subscription is an async iterable with an explicit release.
 *
 * `close()` exists because `for await … break` only releases the iterator on a
 * well-behaved consumer, and a leaked subscriber is exactly what the bounded
 * buffer is trying to protect against.
 */
export type EventSubscription = AsyncIterable<SubscriptionMessage> & {
  close(): Promise<void>;
};

export type AgentExecutor = {
  // --- commands ------------------------------------------------------------

  /** Acquire a workspace lease and a provider session. */
  openSession(command: OpenSessionCommandInput): Promise<CommandReceipt>;

  /** Submit caller input as a new turn, starting its first run. */
  submitTurn(command: SubmitTurnCommandInput): Promise<CommandReceipt>;

  /**
   * End one run. The session survives and remains able to accept a new turn.
   * This is NOT `closeSession`.
   */
  interruptRun(command: InterruptRunCommandInput): Promise<CommandReceipt>;

  /** Settle a pending interaction. Settling twice is idempotent. */
  respondToInteraction(command: RespondToInteractionCommandInput): Promise<CommandReceipt>;

  /** Dispose the provider session and release the workspace lease. Terminal. */
  closeSession(command: CloseSessionCommandInput): Promise<CommandReceipt>;

  /**
   * Uniform entry point for callers that already hold a discriminated command
   * (a transport handler, a queue consumer). Dispatches on `command.type`.
   */
  dispatch(command: AgentCommandInput): Promise<CommandReceipt>;

  // --- projections ---------------------------------------------------------

  /** Current projected read model, or `undefined` if the session is unknown. */
  getSession(sessionId: SessionId): Promise<SessionSnapshot | undefined>;

  /** Durable history. Always available, independent of any subscription. */
  readEvents(sessionId: SessionId, fromSequence: Sequence, limit?: number): Promise<EventPage>;

  /** Registered providers and their capability descriptors. */
  listProviders(): readonly ProviderDescriptor[];

  // --- subscription --------------------------------------------------------

  /**
   * Replay from `fromSequence`, then continue live with no gap and no
   * duplicate. See `@relvo-labs/agent-protocol` subscription semantics.
   */
  subscribe(request: SubscriptionRequestInput): EventSubscription;

  /** Release every session, lease and provider. Idempotent. */
  shutdown(): Promise<void>;
};
