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

const INVALID_JSON_VALUE = Symbol('invalid JSON value');

function captureJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
  encodeKeys = false,
): JsonValue | typeof INVALID_JSON_VALUE {
  try {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return value as string | boolean;
    if (type === 'number') return Number.isFinite(value) ? (value as number) : INVALID_JSON_VALUE;
    if (type !== 'object') return INVALID_JSON_VALUE;

    const object = value as object;
    if (ancestors.has(object)) return INVALID_JSON_VALUE;
    const next = new Set(ancestors).add(object);

    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) return INVALID_JSON_VALUE;
      const length = object.length;
      const keys = Reflect.ownKeys(object);
      if (!Number.isSafeInteger(length) || keys.length !== length + 1 || !keys.includes('length')) {
        return INVALID_JSON_VALUE;
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          return INVALID_JSON_VALUE;
        }
        const child = captureJsonValue(descriptor.value, next, encodeKeys);
        if (child === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        output.push(child);
      }
      return output;
    }

    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON_VALUE;
    // A null prototype makes every JSON key data. In particular, assigning an
    // own `__proto__` key must not invoke Object.prototype's legacy setter and
    // silently erase data before validation or canonical fingerprinting.
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') return INVALID_JSON_VALUE;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        return INVALID_JSON_VALUE;
      }
      const child = captureJsonValue(descriptor.value, next, encodeKeys);
      if (child === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      output[encodeKeys ? `:${key}` : key] = child;
    }
    return output;
  } catch {
    return INVALID_JSON_VALUE;
  }
}

function decodeJsonKeys<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((child: JsonValue) => decodeJsonKeys(child)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const [encodedKey, child] of Object.entries(value)) {
    const key = encodedKey.slice(1);
    Object.defineProperty(output, key, {
      value: decodeJsonKeys(child),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output as T;
}

/**
 * The preprocess capture is an in-process JavaScript graph guard and snapshot.
 * JSON text and the JSON Schema instance model contain trees, not object
 * identity or cycles, so generated JSON Schema retains the structural shape.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z
  .preprocess(
    // Zod's record parser assigns into an ordinary object, where `__proto__`
    // would invoke the legacy inherited setter. Prefix every key during each
    // recursive parse and remove one prefix at each transform layer.
    (value) => captureJsonValue(value, new Set(), true),
    z.lazy(() => z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])),
  )
  .overwrite(decodeJsonKeys);

export const JsonObjectSchema: z.ZodType<JsonObject> = z
  .preprocess(
    (value) => captureJsonValue(value, new Set(), true),
    z.lazy(() => z.record(z.string(), JsonValueSchema)),
  )
  .overwrite(decodeJsonKeys);

/**
 * Structural guard used by the runtime before a provider-supplied payload is
 * committed to the event log. Ancestors are path-local so repeated references
 * in an acyclic graph remain valid. Reflection failures are rejected rather
 * than thrown; the caller decides whether a violation is a rejection or a
 * diagnostic.
 */
export function isJsonValue(value: unknown, seen: ReadonlySet<object> = new Set()): boolean {
  return captureJsonValue(value, seen) !== INVALID_JSON_VALUE;
}
