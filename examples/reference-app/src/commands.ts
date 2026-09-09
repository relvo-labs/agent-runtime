/**
 * Turning an `unknown` JSON request body into the narrow set of fields this
 * app forwards into an SDK command.
 *
 * Everything else a caller might have supplied — `workspace`, `providerOptions`,
 * an executable, an environment — is never read here. The command actually
 * sent to the runtime is assembled by the route handler from these narrow,
 * typed results plus this app's own fixed policy (see `runtime-factory.ts`
 * and `routes.ts`), never from the raw body.
 */

import { CommandIdSchema } from '@relvo-labs/agent-protocol';

export type FieldError = { readonly status: number; readonly message: string };
export type FieldResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: FieldError };

function ok<T>(value: T): FieldResult<T> {
  return { ok: true, value };
}

function err(message: string, status = 400): FieldResult<never> {
  return { ok: false, error: { status, message } };
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * Caller-generated command identity. Validated against the SDK's own schema
 * so this app's notion of "a valid command id" can never drift from the
 * runtime's — the alternative is a second regex quietly going stale.
 */
export function readCommandId(body: unknown): FieldResult<string> {
  const record = asRecord(body);
  const raw = record?.commandId;
  if (typeof raw !== 'string') return err('commandId must be a string');
  const parsed = CommandIdSchema.safeParse(raw);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'invalid commandId');
  return ok(parsed.data);
}

export function readProviderId(body: unknown): FieldResult<string> {
  const record = asRecord(body);
  const raw = record?.providerId;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    return err('providerId must be a non-empty string');
  }
  return ok(raw);
}

/** The one piece of free text this app ever accepts from the browser. */
export function readTurnText(body: unknown): FieldResult<string> {
  const record = asRecord(body);
  const raw = record?.text;
  if (typeof raw !== 'string' || raw.length === 0) return err('text must be a non-empty string');
  if (raw.length > 100_000) return err('text is too long for this demo');
  return ok(raw);
}

export function readOptionalReason(body: unknown): FieldResult<string | undefined> {
  const record = asRecord(body);
  const raw = record?.reason;
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string' || raw.length > 2000) return err('reason must be a string');
  return ok(raw);
}

export function readIfRunActive(body: unknown): FieldResult<'interrupt' | 'reject' | undefined> {
  const record = asRecord(body);
  const raw = record?.ifRunActive;
  if (raw === undefined) return ok(undefined);
  if (raw !== 'interrupt' && raw !== 'reject') return err('ifRunActive must be "interrupt" or "reject"');
  return ok(raw);
}

/** Path segments are already URL-decoded by `URL`; bound their length here. */
export function readPathSegment(value: string | undefined, label: string): FieldResult<string> {
  if (value === undefined || value.length === 0 || value.length > 200) {
    return err(`${label} is missing or too long`, 404);
  }
  return ok(decodeURIComponent(value));
}
