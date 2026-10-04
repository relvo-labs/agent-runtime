/**
 * Point-in-time capture of provider sink input (ADR-0016).
 *
 * Shared by the live runtime and the issue #43 ingress seam so both apply the
 * same graph guard, schema parse and freeze before `emit()` returns. Moved
 * verbatim from `runtime.ts`; behavior is unchanged.
 */

import { ProviderEventInputSchema, isJsonValue, type ProviderEventInput } from '@relvo-labs/agent-protocol';

export type CapturedProviderEvent =
  { readonly valid: true; readonly input: ProviderEventInput } | { readonly valid: false; readonly diagnostic: string };

function freezeProviderValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeProviderValue(child, seen);
  return Object.freeze(value);
}

/** Capture validity and values before control returns to provider code. */
export function captureProviderEvent(input: ProviderEventInput): CapturedProviderEvent {
  try {
    if (!isJsonValue(input)) {
      return { valid: false, diagnostic: 'provider emitted an invalid event: input is not acyclic plain JSON data' };
    }
    const parsed = ProviderEventInputSchema.safeParse(input);
    return parsed.success
      ? { valid: true, input: freezeProviderValue(parsed.data) }
      : {
          valid: false,
          diagnostic: `provider emitted an invalid event: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
        };
  } catch {
    return { valid: false, diagnostic: 'provider emitted an invalid event: input could not be inspected safely' };
  }
}
