/**
 * Wire version and schema identity.
 *
 * `WIRE_VERSION` is deliberately independent of the npm package version. An npm
 * patch or minor release may ship with an unchanged wire contract; a wire change
 * always moves `WIRE_VERSION`. Consumers negotiate on `WIRE_VERSION`, never on
 * the package version.
 *
 * See docs/adr/ADR-0011-public-api-and-versioning.md.
 */

/**
 * The contract version carried on every envelope that crosses a boundary.
 *
 * `0.5` added the `question_set` member to the closed interaction request and
 * response unions and widened the strict `QuestionCapability` object. Both are
 * breaking for a pre-1.0 reader, which rejects rather than ignores an unknown
 * union member or property. See docs/adr/ADR-0018-structured-question-sets.md.
 */
export const WIRE_VERSION = '0.5';

/**
 * Stable base for generated JSON Schema `$id` values.
 *
 * This is an identity, not a URL that must resolve. It is versioned so two wire
 * versions can coexist in one schema store without collision.
 */
export const SCHEMA_ID_BASE = `https://schemas.relvo.dev/agent-runtime/${WIRE_VERSION}`;

/** Deterministic `$id` for a named schema. */
export function schemaId(name: string): string {
  return `${SCHEMA_ID_BASE}/${name}.json`;
}

/**
 * Pre-1.0 stability statement, exported so a consumer can assert on it rather
 * than discovering the constraint from a changelog.
 */
export const WIRE_STABILITY = 'unstable' as const;
