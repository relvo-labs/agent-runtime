---
'@relvo-labs/agent-protocol': patch
'@relvo-labs/agent-runtime': patch
'@relvo-labs/agent-provider-codex': patch
---

Reject invalid own question-answer keys before record parsing, including JSON-parsed
`__proto__`, without changing the existing key grammar or valid `constructor` and
`toString` answers. Keep missing-answer errors bounded for maximum-size batches so
Runtime returns a replayable `invalid_request` receipt and leaves the interaction
answerable. The input/output DTOs and wire 0.5 JSON Schemas are unchanged.

Retire correlated server-resolved Codex requests in the client reply ledger without
writing a reply. Connection-limit cleanup now excludes those IDs while preserving
duplicate protection and the existing tracking bound.
