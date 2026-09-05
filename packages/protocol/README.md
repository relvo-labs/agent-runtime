# `@relvo-labs/agent-protocol`

Authoritative Zod schemas, inferred TypeScript types, and generated JSON Schema for the Relvo Agent Runtime wire contract. The `/schemas` export exposes deterministic input-mode schemas for non-TypeScript consumers, so omitted values that Zod default-fills are optional in both validators. Zod additionally rejects cyclic, accessor-backed, or otherwise hostile in-process JavaScript graphs without throwing; generated JSON Schema describes parsed JSON instances, where object identity, accessors, proxies, and cycles do not exist.
