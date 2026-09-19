---
'@relvo-labs/agent-protocol': patch
'@relvo-labs/agent-runtime': patch
---

Retain provider question withdrawals across transient store failures, fence competing
answers, and persist the withdrawn outcome during redelivery, completion or cleanup.
Retention is bounded by routed interactions in one Runtime process and is not crash durable.

Command schema rejections now use a stable `invalid_request` classification without
copying caller-controlled keys, paths or values into receipt errors. Question sets
with valid prototype-named keys such as `constructor` and `toString` require own
answers and reject incomplete batches without throwing. These are compatible
implementation fixes; schemas, public signatures and wire 0.5 are unchanged.
