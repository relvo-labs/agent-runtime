/**
 * `@relvo-labs/agent-protocol/schemas` — generated JSON Schema.
 *
 * This subpath exists so a non-TypeScript consumer (a Go service, a validator
 * in CI, an editor) can obtain the contract without depending on Zod. The
 * content is generated from the Zod schemas by `pnpm schema:generate`; a stale
 * or hand-edited file fails `pnpm schema:check`.
 */

import { JSON_SCHEMAS, JSON_SCHEMA_WIRE_VERSION } from './generated/json-schemas.ts';
import { PUBLISHED_SCHEMA_NAMES, type PublishedSchemaName } from './registry.ts';
import { schemaId } from './version.ts';

export { JSON_SCHEMAS, JSON_SCHEMA_WIRE_VERSION };
export type { PublishedSchemaName };

/** Every published schema, keyed by its stable `$id`. */
export function jsonSchemaById(): Readonly<Record<string, unknown>> {
  const byId: Record<string, unknown> = {};
  for (const name of PUBLISHED_SCHEMA_NAMES) {
    byId[schemaId(name)] = JSON_SCHEMAS[name];
  }
  return byId;
}

export function getJsonSchema(name: PublishedSchemaName): unknown {
  return JSON_SCHEMAS[name];
}
