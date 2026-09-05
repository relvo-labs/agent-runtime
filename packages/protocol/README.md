# `@relvo-labs/agent-protocol`

Authoritative Zod schemas, inferred TypeScript types, and generated JSON Schema for the Relvo Agent Runtime wire contract. The `/schemas` export exposes deterministic generated schemas for non-TypeScript consumers. Zod additionally rejects cyclic in-process JavaScript graphs; generated JSON Schema describes parsed JSON instances, where object identity and cycles do not exist.
