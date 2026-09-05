/**
 * The JSON-safe value domain.
 *
 * Everything that crosses the public boundary must be expressible here. This is
 * what makes an envelope safe to persist, replay and ship over a transport
 * without a custom codec. Native `Error`, `Date`, `Map`, `Set`, `undefined`,
 * class instances and functions are all excluded on purpose.
 */

import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export const JsonPrimitiveSchema = z.union([
  // `z.number()` rejects NaN and Infinity, which are not representable in JSON.
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() => z.record(z.string(), JsonValueSchema));

/**
 * Structural guard used by the runtime before a provider-supplied payload is
 * committed to the event log. It is intentionally cheap and non-throwing: the
 * caller decides whether a violation is a rejection or a diagnostic.
 */
export function isJsonValue(value: unknown, seen: ReadonlySet<object> = new Set()): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;

  const object = value as object;
  if (seen.has(object)) return false; // a cycle is not JSON-safe
  const nextSeen = new Set(seen).add(object);

  if (Array.isArray(object)) {
    return object.every((entry) => isJsonValue(entry, nextSeen));
  }

  // Reject anything with a non-plain prototype: Date, Map, Set, Error, class
  // instances. They serialise lossily and would silently change shape on replay.
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) return false;

  return Object.entries(object).every(([, entry]) => isJsonValue(entry, nextSeen));
}
