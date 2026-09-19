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
twice: an unknown, retired or other session's reference is `unknown_interaction` (the
reference is not echoed on the error); a `session`/`persistent` mode or a non-approval
response is `capability_unsupported` and leaves the prompt answerable; an identical
redelivery is a no-op and a conflicting one is `interaction_already_settled`; and when a
run ends — result, interrupt, stream EOF, stream failure or disposal — its outstanding
prompts are denied and its references forgotten, so no callback dangles and a late answer
cannot resurrect it. Settlement is in-process, not crash-safe exactly-once.

No question capability is claimed or bridged. The approval subject carries a sanitized tool
name only, never tool input. New exported types: `ClaudeCanUseTool`,
`ClaudePermissionResult`, `ClaudeToolPermissionRequest`.
