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

const JSON_GRAPH_ERROR = 'JSON values must be acyclic plain data';

/**
 * The refinement is an in-process JavaScript graph guard. JSON text and the
 * JSON Schema instance model contain trees, not object identity or cycles, so
 * generated JSON Schema truthfully retains the structural JSON-value shape.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() => z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]))
  .refine(isJsonValue, JSON_GRAPH_ERROR);

export const JsonObjectSchema: z.ZodType<JsonObject> = z
  .lazy(() => z.record(z.string(), JsonValueSchema))
  .refine(isJsonValue, JSON_GRAPH_ERROR);

/**
 * Structural guard used by the runtime before a provider-supplied payload is
 * committed to the event log. Ancestors are path-local so repeated references
 * in an acyclic graph remain valid. Reflection failures are rejected rather
 * than thrown; the caller decides whether a violation is a rejection or a
 * diagnostic.
 */
export function isJsonValue(value: unknown, seen: ReadonlySet<object> = new Set()): boolean {
  try {
    if (value === null) return true;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(value);
    if (type !== 'object') return false;

    const object = value as object;
    if (seen.has(object)) return false; // a cycle is not JSON-safe
    const nextSeen = new Set(seen).add(object);

    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) return false;
      const length = object.length;
      const keys = Reflect.ownKeys(object);
      if (keys.length !== length + 1 || !keys.includes('length')) return false;
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true ||
          !isJsonValue(descriptor.value, nextSeen)
        ) {
          return false;
        }
      }
      return true;
    }

    // Reject anything with a non-plain prototype: Date, Map, Set, Error, class
    // instances. They serialise lossily and would silently change shape on replay.
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;

    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true ||
        !isJsonValue(descriptor.value, nextSeen)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    // Reflection or property access can throw for hostile accessors/proxies.
    return false;
  }
}
