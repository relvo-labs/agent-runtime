---
'@relvo-labs/agent-provider-claude': minor
---

Bridge Claude tool-permission prompts to the neutral approval interaction.

`createClaudeProvider({ approvals: 'bridge' })` sets the SDK's `permissionPrompts: 'host'`
and installs its `canUseTool` callback, so a tool call the permission mode, rules and hooks
did not already decide is raised as `interaction.requested` (`kind: 'approval'`) on the run
that asked, and proceeds only after a `{ decision: 'approved', mode: 'once' }` response
reaches `respondToInteraction`. The provider then declares
`interaction.approval = { supported: true, modes: ['once'], blocking: true }`.

The default is unchanged: with `approvals` unset the adapter still sends
`permissionPrompts: 'none'`, declares no approval capability, and a prompt fails closed
inside the SDK rather than parking a run — this adapter imposes no settlement deadline, so
bridging is opt-in for hosts that actually settle interactions.

Everything other than that one grant fails closed and never executes the SDK callback
twice: an unknown, retired or other session's reference is `unknown_interaction`; a
`session`/`persistent` mode or a non-approval response is `capability_unsupported` and
leaves the prompt answerable; an identical redelivery is a no-op and a conflicting one is
`interaction_already_settled`; and when a run ends — result, interrupt, stream EOF, stream
failure or disposal — its outstanding prompts are denied and its references forgotten, so
no callback dangles and a late answer cannot resurrect it. A prompt the SDK itself
withdraws (it aborts that request's signal) is denied once and its reference retired, and
no new prompt is raised once disposal has begun. References are namespaced per session with
an adapter-generated nonce, so one session's reference is never a valid token in another.
Settlement is in-process, not crash-safe exactly-once.

Errors never echo caller-controlled text: neither the interaction reference nor a rejected
response's `kind`/`mode` appears in a durable error, which states only what this adapter
supports.

No question capability is claimed or bridged. The approval subject carries a sanitized tool
name only, never tool input.

Public surface: three new exported types — `ClaudeCanUseTool`, `ClaudePermissionResult`,
`ClaudeToolPermissionRequest`. Note also that `ClaudeQueryOptions` — the type an injected
`query` binding _receives_ — now declares `permissionPrompts: 'host' | 'none'` instead of
the literal `'none'`, and an optional `canUseTool`. A host binding that annotated its own
parameter with the narrow literal must widen it; one that infers the type is unaffected.
Additive pre-1.0 minor.
