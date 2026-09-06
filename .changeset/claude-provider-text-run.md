---
'@relvo-labs/agent-provider-claude': minor
---

Activate the Claude adapter: `createClaudeProvider()` executes text turns through the
official Claude Agent SDK `query()` surface — streaming assistant text, tool activity,
usage and terminal outcomes into the existing provider event shapes, with cooperative,
idempotent run interrupt that leaves the session usable.

BREAKING: `CLAUDE_ADAPTER_STATUS` is now `'live'` instead of `'scaffold'`, and
`ClaudeProviderOptions` is a structured options object instead of an alias for
`JsonObject`; pass `{ model, maxTurns, permissionMode, allowedTools, disallowedTools,
query }` and read the status as `'live'`.

`@anthropic-ai/claude-agent-sdk` (pinned at 0.3.259) is an **optional peer dependency**:
install it in the host to use the default binding, or inject your own `ClaudeQuery`.
Without either, `createSession()` rejects with a retryable `provider_unavailable` error
naming the package. It is a peer rather than a dependency because it is published under
proprietary terms and carries a ~200 MB per-platform native payload.

Only implemented capabilities are declared. Approvals and questions are not bridged
(`permissionPrompts: 'none'` fails closed instead of hanging), non-text turn input is
rejected with `capability_unsupported`, and no recovery record is exported. No wire
schema, protocol DTO or runtime dependency changed.
