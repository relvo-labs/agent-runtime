/**
 * Strict parsing for untrusted query-string values.
 *
 * `Number.parseInt` is deliberately not used anywhere in this app:
 * `Number.parseInt('1junk', 10)` silently truncates to `1`, and
 * `Number.parseInt('1.5', 10)` silently truncates to `1`. Both are invalid
 * input, not `1` — a truncating parse would accept garbage a caller may not
 * have intended, which is exactly the class of bug a strict boundary exists
 * to prevent.
 */

export type QueryParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const MAX_NUMERIC_PARAM_LENGTH = 20; // generous for any value this app's schemas accept

/** Every digit, no sign, no fraction, no leading zero unless the value is exactly `0`. */
const STRICT_NON_NEGATIVE_INT = /^(?:0|[1-9]\d*)$/u;

export function parseStrictNonNegativeInt(raw: string | null, fallback: number): QueryParseResult<number> {
  if (raw === null) return { ok: true, value: fallback };
  if (raw.length === 0 || raw.length > MAX_NUMERIC_PARAM_LENGTH) {
    return { ok: false, message: 'value must be a non-negative integer' };
  }
  if (!STRICT_NON_NEGATIVE_INT.test(raw)) {
    return { ok: false, message: 'value must be a non-negative integer (no sign, fraction, or extra characters)' };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'value is out of range' };
  return { ok: true, value };
}

export function parseStrictEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): QueryParseResult<T> {
  if (raw === null) return { ok: true, value: fallback };
  if (!(allowed as readonly string[]).includes(raw)) {
    return { ok: false, message: `value must be one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: raw as T };
}
