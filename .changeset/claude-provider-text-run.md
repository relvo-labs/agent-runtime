---
'@relvo-labs/agent-provider-claude': minor
---

BREAKING: `CLAUDE_ADAPTER_STATUS` is now `'live'` instead of `'scaffold'`, and
`ClaudeProviderOptions` is a structured options object instead of an alias for
`JsonObject`; pass `{ model, maxTurns, permissionMode, allowedTools, disallowedTools,
query }` and read the status as `'live'`. Failure text also changed shape: an
`AgentError` from this adapter now carries an allowlisted classification
(`claude ended the turn without completing it (error_max_turns)`) instead of upstream
error prose, so do not match on the old message text.

Activate the Claude adapter: `createClaudeProvider()` executes text turns through the
official Claude Agent SDK `query()` surface — streaming assistant text, tool activity,
usage and terminal outcomes into the existing provider event shapes, with cooperative,
idempotent run interrupt that leaves the session usable.

Each submitted turn is stamped with a private client uuid and correlated through the SDK's
`user_message_uuid` / `user_message_uuids` fields, so a background, scheduled or already
retired turn on the shared session stream can never emit into — or complete — the run in
front of it. That holds before the session has correlated anything: an unstamped frame is
not evidence of a producer that cannot stamp, since a background turn is unstamped for the
same reason, so a host bound to a genuinely non-stamping producer declares it with
`createClaudeProvider({ correlation: 'legacy-unstamped' })` and the declaration lapses as
soon as a stamp appears.

Interrupts coalesce into one control request and record intent before the round-trip, so a
cancellation result that arrives first is still reported as an interruption — but that
intent is provisional: a result that lands while the request is in flight closes the run to
further output and settles only once the request answers, so an interrupt that is refused,
or that reads `interrupt_receipt_v1` as "input still queued", leaves the turn's own outcome
standing instead of relabelling it. When the submitted input survived the stop and will
still run, the interrupt is reported as not applied rather than claiming an interruption
that would mislabel the turn still to come. Disposal fences new runs the moment it starts,
shares one teardown between concurrent callers, and stays retryable to success after a
rejection — including a teardown that throws synchronously rather than rejecting — without
leaving a run that can hang.

`@anthropic-ai/claude-agent-sdk` (pinned at 0.3.259) is an **optional peer dependency**:
install it in the host to use the default binding, or inject your own `ClaudeQuery`.
Without either, `createSession()` rejects with a retryable `provider_unavailable` error
naming the package. It is a peer rather than a dependency because it is published under
proprietary terms and carries a ~200 MB per-platform native payload.

Only implemented capabilities are declared. Approvals and questions are not bridged
(`permissionPrompts: 'none'` fails closed instead of hanging), non-text turn input is
rejected with `capability_unsupported`, and no recovery record is exported. An assistant
frame the SDK flagged with `error` is published as its allowlisted classification alone;
the blocks that arrived with it are the upstream error body rather than model output, so
they are not emitted as `run.message_delta`. No wire schema, protocol DTO or runtime
dependency changed.
