# Claude approval bridge plan (v1)

- **Issue:** #17
- **Branch:** `feat/issue-17-claude-approval-bridge`
- **Base:** `main@c549d891abfb7cf567ac5a1c11a0d0e4e48d1ecd`
- **Size / tier:** L / T3 — authorization decision path plus an asynchronous lifecycle/concurrency boundary
- **Writer:** one fresh Claude Agent SDK runner session, provider-native applied `claude-opus-5` / effort `high` (confirmed from runner state: `verifiedModel`, `verifiedEffort`, `nativeBindingEvidence`)

## Outcome

Bridge the pinned SDK's host permission callback (`@anthropic-ai/claude-agent-sdk@0.3.259`
`Options.canUseTool` under `permissionPrompts: 'host'`) to the neutral, already-existing
interaction contract: `interaction.requested` → runtime-assigned `InteractionId` →
`respond_to_interaction` → `ProviderSession.respondToInteraction(providerRef, response)`.
A tool call proceeds only after a matching neutral approval response says
`approved` / `once`. Nothing else about the adapter changes.

## Fixed decisions

- **Opt-in.** `createClaudeProvider({ approvals: 'bridge' })` enables the bridge. The
  default stays `'none'`: `permissionPrompts: 'none'`, no `canUseTool`, approval declared
  unsupported — so an existing host with no approval surface keeps today's fail-fast deny
  instead of parking runs in `awaiting_interaction` forever (`settlementTimeoutMs` is
  `null`; deadlines/withdrawal remain #3's contract, and neither `expired` nor `withdrawn`
  is faked here). The option is provider-level, not per session, because the capability
  descriptor is provider-level and must not lie about what a session will do.
- **Approval only, `once` only, blocking.** Declared as
  `approval: { supported: true, modes: ['once'], blocking: true }` when bridged. `session`
  and `persistent` are rejected, not silently downgraded; `updatedPermissions` suggestions
  from the SDK are ignored rather than half-honoured.
- **Question stays unsupported.** `AskUserQuestion` tool input, `onUserDialog`,
  `OnElicitation` and arbitrary upstream forms are not mapped into neutral questions.
- **Subject carries a sanitized tool name only.** `summary` is built from
  `sanitizeToolName()` (existing allowlist in `translate.ts`); no `detail`, so no tool
  arguments, paths, argv or URLs enter the durable event log. Category is an advisory
  allowlist mapping (`Bash` → `command`, `Write`/`Edit`/`NotebookEdit` → `file_write`,
  `WebFetch`/`WebSearch` → `network`, otherwise `tool`).
- **Fail closed everywhere else.** No auto-allow, no permissive fallback, no timeout-allow.
  Unattributable, unknown, cross-session, stale, already-settled-with-a-conflict and
  unsupported-kind/mode responses reject with typed allowlisted `AgentError`s that never
  echo the caller-controlled `providerRef`.

## Scope

Touched: `packages/provider-claude/src/{seam,options,provider,approvals}.ts`,
`packages/provider-claude/src/index.ts`, `packages/provider-claude/test/*`,
`packages/provider-claude/README.md`, `examples/consumer-smoke/src/index.ts`, one
changeset. Not touched: `packages/protocol`, `packages/provider`, `packages/runtime`,
`WIRE_VERSION`, generated schemas, workflows, versions, the SDK pin.

## Design

1. **Seam (`seam.ts`).** Add `ClaudePermissionResult`, `ClaudeToolPermissionRequest`,
   `ClaudeCanUseTool`, mirroring the pinned `PermissionResult` / `CanUseTool` shapes
   narrowed to what the adapter reads (`signal`, `toolUseID`) and writes
   (`{behavior:'allow'}` / `{behavior:'deny',message}`). Widen
   `ClaudeQueryOptions.permissionPrompts` to `'host' | 'none'` and add optional
   `canUseTool`. `sdk-contract.test.ts` gains the matching recorded types plus
   assignability assertions in both directions, so the seam still accepts the official
   `query` with no cast.
2. **Run-scoped registry (`approvals.ts`).** A session-scoped map of adapter-private
   `providerRef` (`approval-<n>`, never a native `toolUseID` or `requestId`) → pending
   entry, partitioned by an opaque run token. `canUseTool` registers an entry, emits
   `interaction.requested` on that run's sink, and awaits the entry's settlement.
3. **Binding.** A permission callback in 0.3.259 carries no `user_message_uuid`, so it is
   attributed by the session's single-active-run invariant plus the existing stream
   binding: denied outright when there is no active, unconcluded run, or when the wire is
   currently bound to a turn that is not that run. The limitation is documented, not
   papered over.
4. **Settlement.** `respondToInteraction` resolves the one matching entry exactly once:
   `approved` + `once` → `{behavior:'allow'}`; `denied` → `{behavior:'deny'}` with the
   caller's `reason` passed to the model only (never into an event or error). Re-delivery
   of an identical response is a no-op; a conflicting one is
   `interaction_already_settled`. Wrong kind or unsupported mode rejects
   `capability_unsupported` **without** settling, so a correct response can still arrive.
5. **Teardown.** `finalize()` (natural result, interrupt, stream EOF, stream failure) and
   `dispose()` deny-and-drop every entry owned by the run, then clear its settled-ref
   history. No pending promise and no registry entry survives a run; a late response for a
   retired ref is `unknown_interaction` and cannot resurrect anything.

## RED → GREEN

New `test/approval.test.ts`, deterministic, credential-free, no timers for ordering:
descriptor/query-option gating (both postures), approve, deny (with and without reason),
unsupported mode, wrong kind, unknown ref (with no ref echo), cross-session ref, duplicate
identical response, conflicting response, pending approval × interrupt / natural completion
/ stream EOF / stream failure / dispose, late response after each, unattributable and
no-active-run callbacks. RED command and intended failures recorded in
`evidence/writer/red.txt`; full logs stay outside the repository.

## Acceptance evidence

- `pnpm --filter @relvo-labs/agent-provider-claude test` and `… typecheck` pass.
- `pnpm --filter @relvo-labs/agent-runtime test -- persistence-windows` passes unchanged —
  it already proves a provider response is delivered exactly once across commit failure and
  a conflicting command id; no runtime or protocol change is needed for this slice.
- `pnpm --filter @relvo-labs/agent-provider test`, `pnpm dag:check`, `pnpm skills:check`.
- A real nonempty changeset for `@relvo-labs/agent-provider-claude` (pre-1.0 `minor`,
  additive), no version bump, no publish.
- Full `pnpm gate` and any PR/merge remain the coordinator's; this writer stops at one
  committed checkpoint.

## Risks

- **Attribution.** The pinned callback has no turn stamp; attribution rests on
  `maxConcurrentRunsPerSession: 1` plus stream binding. Mitigated by denying whenever the
  wire says another turn owns the stream, and stated in the README.
- **Parked runs.** A bridged session with no host answer waits indefinitely. Mitigated by
  the opt-in default and by deny-on-teardown so nothing dangles; real deadlines are #3.
- **In-process only.** Exactly-once here is process-local settlement, not crash-safe
  exactly-once. Stated in the README and the changeset.

## Repair after semantic review (`report-a70eb0e`)

One consolidated bounded repair, same slice, no new scope:

1. **Reference namespace (P2-1).** `providerRef` is `approval-<randomUUID nonce>-<n>`; the
   nonce is per registry, i.e. per session. The cross-session test now has both sessions
   holding a _simultaneous_ pending approval and asserts the foreign reference is
   `unknown_interaction`, that the other session's callback is still pending, and that each
   then settles correctly on its own session.
2. **SDK cancellation (P2-2).** The seam's per-request `signal` is passed to the registry.
   An abort denies once, detaches the listener and retires the reference; a prompt already
   aborted on arrival raises no interaction; the listener is also detached on ordinary
   settlement and on teardown, so nothing leaks either way.
3. **Disposal fence (P2-3).** `approvalOwner()` refuses while `disposing || disposed`,
   including the retry window after a rejected teardown.
4. **Bounded diagnostic (P2-4).** The unattributable-permission diagnostic is announced
   once per session, matching `noteUnattributedTurn`.
5. **Public-contract note (P2-5).** The changeset and README state the
   `ClaudeQueryOptions.permissionPrompts` union widening and the new optional `canUseTool`.
   Classification is unchanged: additive, pre-1.0 minor.
6. **No caller text in errors (P2-6).** `details.requested` is gone from both
   `capability_unsupported` rejections; a hostile-cast test asserts no echo.
7. **Faithful recording (P2-7).** `RecordedPermissionResult` carries optional
   `decisionClassification` on both branches; the adapter still does not return it.

## Rollback

Revert the single feature commit, or ship it and leave `approvals` unset — the default
posture is byte-for-byte today's behaviour. No wire version, schema, published version or
workflow is touched, so nothing outside this package needs coordination.
