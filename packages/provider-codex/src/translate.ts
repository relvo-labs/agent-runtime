/**
 * Notification → provider event translation. Pure and synchronous.
 *
 * Four rules hold in every branch:
 *
 *  1. Only payload shapes the protocol already defines are produced. This
 *     adapter adds no wire variant.
 *  2. Provider-native identity — thread ids, turn ids, item ids — is read for
 *     correlation and then dropped. It never reaches an emitted payload.
 *  3. An unrecognised or malformed notification produces nothing. The
 *     app-server is a separate process whose stdout is untrusted input; a shape
 *     this adapter does not know must not be able to crash a run or forge an
 *     event.
 *  4. Upstream prose is never copied into a durable string. `TurnError.message`
 *     and `additionalDetails` routinely carry paths, native ids and prompt text,
 *     so only a closed-allowlist classification of `codexErrorInfo` is
 *     published. A host that needs raw text wraps the transport seam, where it
 *     sees every frame without any of it reaching the event log.
 */

import { agentError, type AgentError, type ProviderEventInput, type Usage } from '@relvo-labs/agent-protocol';
import type { ProviderRunTermination } from '@relvo-labs/agent-provider';

import { asId, asNonNegativeInteger, asRecord, asString } from './protocol.ts';

/** `run.message_delta.text` is bounded by the protocol; longer text is split. */
export const MAX_DELTA_CHARS = 100_000;

/**
 * Credential shapes that must never be copied out of a provider process into a
 * durable event log. The adapter cannot know what an upstream string contains,
 * so it redacts before it records.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}/gu,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];

export function redact(value: string): string {
  let result = value;
  for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * The `(threadId, turnId)` pair that owns a frame.
 *
 * Every turn-scoped notification in the stable surface carries both, either
 * directly (`item/*`, `error`, `thread/tokenUsage/updated`) or as
 * `threadId` + `turn.id` (`turn/started`, `turn/completed`). A frame this
 * cannot extract a complete pair from is unattributable and is dropped.
 */
export type TurnCorrelation = { readonly threadId: string; readonly turnId: string };

export function correlationOf(params: unknown): TurnCorrelation | undefined {
  const record = asRecord(params);
  if (record === undefined) return undefined;
  const threadId = asId(record.threadId);
  if (threadId === undefined) return undefined;
  const direct = asId(record.turnId);
  if (direct !== undefined) return { threadId, turnId: direct };
  const turnId = asId(asRecord(record.turn)?.id);
  if (turnId === undefined) return undefined;
  return { threadId, turnId };
}

export function sameTurn(a: TurnCorrelation, b: TurnCorrelation): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId;
}

// ---------------------------------------------------------------------------
// Streaming text
// ---------------------------------------------------------------------------

function chunk(text: string): readonly string[] {
  if (text.length <= MAX_DELTA_CHARS) return [text];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    parts.push(text.slice(index, index + MAX_DELTA_CHARS));
  }
  return parts;
}

/**
 * `item/agentMessage/delta` → zero or more `run.message_delta` events.
 *
 * The README's reconstruction rule is "concatenate `delta` values for the same
 * `itemId` in order", which is exactly the runtime's own delta contract, so the
 * text passes through unchanged. `itemId` is read only to confirm the frame is
 * well-formed; it is never emitted.
 */
export function translateAgentMessageDelta(params: unknown): readonly ProviderEventInput[] {
  const record = asRecord(params);
  if (record === undefined) return [];
  if (asId(record.itemId) === undefined) return [];
  const delta = asString(record.delta);
  if (delta === undefined || delta === '') return [];
  return chunk(delta).map((text) => ({ payload: { type: 'run.message_delta', text } }) as const);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * `thread/tokenUsage/updated` → `run.usage`.
 *
 * `tokenUsage.last` is used rather than `tokenUsage.total`: the notification is
 * turn-correlated, and `total` is cumulative across every turn on the thread, so
 * publishing it would over-report a second run's usage as its own. Both are
 * plain non-negative counters — this is the only payload in the bounded surface
 * that carries no identifier, text or path.
 */
export function translateTokenUsage(params: unknown): readonly ProviderEventInput[] {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const last = asRecord(usage?.last);
  if (last === undefined) return [];
  const inputTokens = asNonNegativeInteger(last.inputTokens);
  const outputTokens = asNonNegativeInteger(last.outputTokens);
  const totalTokens = asNonNegativeInteger(last.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return [];
  const value: Usage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  return [{ payload: { type: 'run.usage', usage: value } }];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `CodexErrorInfo` variants in the pinned stable surface
 * (`typescript-stable/v2/CodexErrorInfo.ts`). Plain strings and single-key
 * tagged objects both appear; the tag is the classification either way.
 *
 * The README calls the category set open-ended, so anything outside this set
 * becomes `unclassified` rather than being copied through.
 */
const CODEX_ERROR_INFO: ReadonlySet<string> = new Set([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
  'other',
]);

export const UNCLASSIFIED_ERROR = 'unclassified';

/**
 * Reduce a `codexErrorInfo` to one allowlisted token.
 *
 * Never its message, never `additionalDetails`, never `misalignment` — those are
 * upstream prose. A tagged object contributes only its single key.
 */
export function classifyCodexErrorInfo(value: unknown): string {
  const direct = asString(value);
  if (direct !== undefined) return CODEX_ERROR_INFO.has(direct) ? direct : UNCLASSIFIED_ERROR;
  const record = asRecord(value);
  if (record === undefined) return UNCLASSIFIED_ERROR;
  const keys = Object.keys(record);
  const tag = keys.length === 1 ? keys[0] : undefined;
  return tag !== undefined && CODEX_ERROR_INFO.has(tag) ? tag : UNCLASSIFIED_ERROR;
}

/**
 * Codex categories that mean "the identical request could succeed later".
 *
 * Mapped to `provider_unavailable`, which the protocol marks retryable;
 * everything else is `provider_rejected`, which is not.
 */
const TRANSIENT: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'serverOverloaded',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'internalServerError',
]);

/** Map a `TurnError` to a durable `AgentError` carrying only a classification. */
export function translateTurnError(value: unknown): AgentError {
  const classification = classifyCodexErrorInfo(asRecord(value)?.codexErrorInfo);
  const code = TRANSIENT.has(classification) ? 'provider_unavailable' : 'provider_rejected';
  return agentError(code, `codex ended the turn without completing it (${classification})`, {
    providerCode: classification,
  });
}

// ---------------------------------------------------------------------------
// Terminal frame
// ---------------------------------------------------------------------------

/**
 * `turn/completed` → a terminal outcome, or `undefined` if the frame does not
 * carry one.
 *
 * `TurnStatus` is a closed four-value set. `inProgress` is not terminal, so a
 * `turn/completed` claiming it is a contract violation rather than a silent
 * success: the caller fails the run closed instead of leaving it hanging.
 */
export type TerminalTranslation =
  | { readonly kind: 'settled'; readonly termination: ProviderRunTermination }
  | { readonly kind: 'violation'; readonly reason: string };

export function translateTurnCompleted(params: unknown): TerminalTranslation {
  const turn = asRecord(asRecord(params)?.turn);
  const status = asString(turn?.status);
  switch (status) {
    case 'completed':
      return { kind: 'settled', termination: { outcome: 'succeeded' } };
    case 'interrupted':
      return { kind: 'settled', termination: { outcome: 'interrupted' } };
    case 'failed':
      return { kind: 'settled', termination: { outcome: 'failed', error: translateTurnError(turn?.error) } };
    case 'inProgress':
      return { kind: 'violation', reason: 'inProgress' };
    default:
      return { kind: 'violation', reason: 'unknown_status' };
  }
}

/**
 * The mid-turn `error` notification.
 *
 * It is explicitly *not* terminal: the README says it "may precede" the terminal
 * notification, which does not promise one follows, and the evidence does not
 * establish that one always does (research §10.3). So it produces a diagnostic
 * and the run keeps waiting for `turn/completed`, EOF or exit. `willRetry` is
 * reported because it is the server's own statement about whether it is still
 * trying.
 */
export function translateErrorNotification(params: unknown): readonly ProviderEventInput[] {
  const record = asRecord(params);
  if (record === undefined) return [];
  const classification = classifyCodexErrorInfo(asRecord(record.error)?.codexErrorInfo);
  const willRetry = record.willRetry === true;
  return [
    {
      payload: {
        type: 'diagnostic',
        level: 'warning',
        message: `codex reported a mid-turn error (${classification}); ${
          willRetry ? 'the server is retrying' : 'the server is not retrying'
        }`,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Thrown values
// ---------------------------------------------------------------------------

/**
 * System-level causes worth naming publicly. Bounded identifiers, not prose: a
 * value outside the set becomes `unknown` rather than being copied.
 */
const THROWN_CAUSES: ReadonlySet<string> = new Set([
  'ABORT_ERR',
  'EACCES',
  'ECONNRESET',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ETIMEDOUT',
]);

/** Classify a thrown value into one allowlisted token. Never its message. */
export function classifyThrown(error: unknown): string {
  const record = asRecord(error);
  const code = asString(record?.code);
  if (code !== undefined && THROWN_CAUSES.has(code)) return code;
  if (asString(record?.name) === 'AbortError') return 'ABORT_ERR';
  return 'unknown';
}
