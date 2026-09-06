/**
 * The error DTO.
 *
 * A native `Error` never crosses the public boundary: it is not JSON-safe, its
 * `stack` leaks host paths, and its prototype does not survive a transport. Any
 * failure that a consumer must react to is expressed as an `AgentError` with a
 * closed `code` set, so consumers can branch on a stable discriminant rather
 * than matching message text.
 */

import { z } from 'zod';
import { JsonObjectSchema } from './json.ts';

export const AgentErrorCodeSchema = z.enum([
  // --- caller mistakes -----------------------------------------------------
  'invalid_request',
  'unknown_session',
  'unknown_turn',
  'unknown_run',
  'unknown_interaction',
  'illegal_state_transition',
  'command_id_conflict',

  // --- lifecycle -----------------------------------------------------------
  'session_closed',
  'run_already_terminal',
  'interaction_already_settled',
  'interaction_expired',

  // --- capability ----------------------------------------------------------
  'capability_unsupported',

  // --- workspace -----------------------------------------------------------
  'workspace_unavailable',
  'workspace_ownership_violation',

  // --- provider ------------------------------------------------------------
  'provider_not_registered',
  'provider_rejected',
  'provider_unavailable',
  'provider_contract_violation',

  // --- store ---------------------------------------------------------------
  'store_conflict',
  'store_unavailable',

  // --- subscription --------------------------------------------------------
  'subscriber_overflow',
  'cursor_out_of_range',

  // --- fallback ------------------------------------------------------------
  'internal',
]);

export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

export const AgentErrorSchema = z.strictObject({
  code: AgentErrorCodeSchema,
  /** Human-readable, non-localised, safe to log. Never parsed by consumers. */
  message: z.string().min(1).max(2000),
  /** True when the identical request could succeed later without any change. */
  retryable: z.boolean().default(false),
  /** Structured, JSON-safe context. Must not contain provider-native handles. */
  details: JsonObjectSchema.optional(),
  /** Provider-supplied classification, preserved verbatim for diagnostics. */
  providerCode: z.string().max(200).optional(),
});

export type AgentError = z.infer<typeof AgentErrorSchema>;

/** Codes for which retrying the exact same command is meaningful. */
const RETRYABLE: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'provider_unavailable',
  'store_unavailable',
  'workspace_unavailable',
]);

export function agentError(
  code: AgentErrorCode,
  message: string,
  options: { readonly details?: Record<string, unknown>; readonly providerCode?: string } = {},
): AgentError {
  return AgentErrorSchema.parse({
    code,
    message,
    retryable: RETRYABLE.has(code),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.providerCode === undefined ? {} : { providerCode: options.providerCode }),
  });
}

/**
 * The single carrier used to throw an `AgentError` inside the process.
 *
 * The DTO — not this class — is what crosses the boundary. The class exists so
 * host code can `catch` with a type guard; `toJSON` guarantees that even an
 * accidental serialisation produces the DTO rather than an empty object.
 */
export class AgentRuntimeError extends Error {
  readonly error: AgentError;

  constructor(error: AgentError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = 'AgentRuntimeError';
    this.error = error;
  }

  get code(): AgentErrorCode {
    return this.error.code;
  }

  toJSON(): AgentError {
    return this.error;
  }
}

export function isAgentRuntimeError(value: unknown): value is AgentRuntimeError {
  return value instanceof AgentRuntimeError;
}

/**
 * Convert an arbitrary thrown value into the DTO.
 *
 * Deliberately lossy: a native error's `stack` is dropped rather than shipped.
 * Diagnostics belong in the host's logger, not in a replayable event.
 */
export function toAgentError(value: unknown, fallbackCode: AgentErrorCode = 'internal'): AgentError {
  if (isAgentRuntimeError(value)) return value.error;
  const parsed = AgentErrorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (value instanceof Error) {
    return agentError(fallbackCode, value.message || value.name);
  }
  return agentError(fallbackCode, typeof value === 'string' ? value : 'unknown error');
}
