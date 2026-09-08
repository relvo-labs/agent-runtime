# Plan — Activate the Codex provider text-run vertical slice

Version: 1
Issue: relvo-labs/agent-runtime#11
Base: `main@59e6edbc724d5d13ac007733d0e2addb56e4c590` (PR #10 merge commit)
Branch / worktree: `feat/codex-provider-text-run` @ `/opt/data/worktrees/agent-runtime-issue-11-codex-provider`
Risk / size: **L / T3** — production subprocess + protocol integration, streaming/cancellation/cleanup lifecycle, third-party boundary, additive public API.
Writer: single fresh Claude exact-session. Assigned configuration is **Claude Opus 5 / high**, the delivery-contract default for T3. The writer cannot self-verify its own model binding; provider-native requested/applied model and effort evidence is the coordinator's to capture.

## Bounded outcome

Replace the `@relvo-labs/agent-provider-codex` scaffold with a production adapter that lets a
host execute one text turn through the **unchanged** neutral Runtime SPI, over a structured
Codex app-server stdio JSONL transport — no PTY, no shell interpolation — with a deterministic
injected seam, `(threadId, turnId)` correlation, cooperative interrupt, and observable
retryable cleanup.

## Protocol evidence and version

- **Provenance of the research summary.** The separate researcher lane did **not** deliver
  `codex-protocol-research.md`. This exact Claude writer session paused with the blocker,
  then authored the summary itself from the pinned official evidence before making any
  production protocol decision. No external researcher delivered it, and nothing in this
  slice rests on an unpinned or remembered protocol claim.
- Research summary: `/opt/data/agent-runtime-control/continuation-20260908/codex-protocol-research.md`.
  It is a _derived_ document; where it and the generated schemas disagree, the schemas win.
- **Primary evidence** (authoritative): `.../codex-protocol-evidence-0.153.4/json-schema-stable/`
  and `.../typescript-stable/` — `codex-cli 0.153.4`, binary sha256 `56ef98ab…4d62da`,
  upstream `openai/codex` source commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`
  (`rust-v0.153.4`). Every wire shape in `seam.ts` and every test fixture is derived from a
  named file in those two directories, cited at the point of use.
- **Stable, non-experimental surface only.** `capabilities` is sent as `null` at
  `initialize`, which by construction cannot opt into `experimentalApi` or
  `requestAttestation`. No experimental method or field is used.
- Read directly from the generated stable schemas before planning: `ClientRequest.ts:104`
  (`initialize` / `thread/start` / `turn/start` / `turn/interrupt` all stable),
  `ClientNotification.ts` (`initialized`, no params), `v2/TurnInterruptResponse.ts`
  (`Record<string, never>`), `v2/TurnStatus.ts` (`completed|interrupted|failed|inProgress`),
  `v2/UserInput.ts` with `codex_app_server_protocol.v2.schemas.json` (`text_elements` has
  `"default": []` and is not required). Corroborated from the pinned implementation source:
  `protocol-rpc.rs` (no `jsonrpc` member), `transport-stdio.rs` (JSONL framing, EOF),
  `transport-mod.rs:208-216` (malformed line is logged and **ignored**, no error reply),
  `message_processor.rs:900` (`Not initialized`).

**No protocol-wire expansion and no Runtime change are required**: the bounded surface maps
onto provider DTOs the protocol package already defines. If that
turns out to be false mid-implementation, stop and replan rather than widening.

## Conversation and turn ownership (Issue #11 governs)

One provider session owns **one** app-server connection and **one** workspace-bound thread,
created once by `thread/start` with `cwd` = the acquired lease root. Each Runtime run owns
**exactly one** correlated native turn on that same thread.

The research summary's "Narrow activation recommendation" suggests process-per-run. That is a
recommendation, not a finding, and Issue #11 governs: the conversation is **not** reset per
run, no process is respawned per run, and a second run appends a second turn to the same
thread. `ephemeral: true` keeps that thread in memory only; it does not scope it to a run.

## Slices

1. **Protocol codec** (`src/protocol.ts`) — pure. JSONL line framing, `JSON.parse`, and
   classification into request / notification / response / error by member presence. Never
   emits `jsonrpc`. Hostile input is rejected, never thrown past the boundary.
2. **Seam** (`src/seam.ts`) — hand-authored types for the injected transport: `send`,
   an async-iterable of decoded-but-unvalidated inbound values, and `close`. No upstream
   package is imported; there is no Codex npm dependency.
3. **Production transport** (`src/transport.ts`) — spawns the Codex binary with an argv
   **array** `['app-server', '--stdio']`. No shell, no `exec*`, no PTY, no ANSI. stdout is
   parsed as bounded JSONL; stderr is drained but never parsed or published.
4. **Client** (`src/client.ts`) — request/response correlation over the seam, monotonic
   integer ids never reused, bounded per-request deadline, fail-closed replies to inbound
   server requests, and settlement of every pending request on EOF / exit / transport error.
5. **Translation** (`src/translate.ts`) — pure notification → `ProviderEventInput` mapping,
   closed-allowlist error classification, credential redaction.
6. **Provider** (`src/provider.ts`) — descriptor, session (one process, one `thread/start`
   bound to the acquired workspace root), run (one `turn/start` per Runtime run),
   interrupt, dispose.
7. **Surface, docs, packaging** — `src/index.ts` exports, README, `docs/provider-development.md`,
   root `README.md`, consumer-smoke, changeset.

## Acceptance mapping

| Issue acceptance                                                   | How this plan satisfies it                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text run through unchanged neutral Runtime SPI                     | Adapter implements `AgentProvider` only; zero edits under `packages/runtime`, `packages/protocol`, `packages/provider`.                                                                                                                                                                                                                      |
| Workspace + session/turn correlation                               | One `thread/start` per session carries `cwd` = lease root and is reused by every run; each run owns exactly one `turn/start` on it; every frame matched on `(threadId, turnId)`.                                                                                                                                                             |
| Foreign/late traffic cannot contaminate the active **or next** run | Settled turn ids are remembered, so a retired turn's tail is discarded on arrival rather than buffered against the next run. An unknown notification method is ignored, not treated as a fatal error for the active run.                                                                                                                     |
| Settle exactly once, never hang                                    | Single `finalize()` guarded by `terminated`; settled by `turn/completed`, EOF, exit, transport error, or dispose — whichever is first.                                                                                                                                                                                                       |
| Observable retryable cleanup                                       | `dispose()` rethrows a typed rejection and leaves `disposed = false`, so an identical retry still owns teardown; admission stays fenced.                                                                                                                                                                                                     |
| Descriptor advertises only tested behavior                         | `messageDeltas: true`, `incrementalUsage: true`, `toolActivity: **false**`, `interrupt.mode: 'cooperative'`, `recovery: {}`, approvals/questions unsupported. `workspace.writes` is always `true` and `extensions.isolatesConfiguredTooling` is `false`, because a read-only policy does not bound configured MCP servers, hooks or plugins. |
| Credential-free deterministic tests                                | All canonical tests drive the injected seam or a locally spawned Node fake; no credentials, no network, no real Codex binary.                                                                                                                                                                                                                |
| Packed consumer proof                                              | `examples/consumer-smoke` exercises the Codex public surface against packed `.d.ts`.                                                                                                                                                                                                                                                         |

## Verification (focused; canonical `pnpm gate` is the coordinator's)

- `pnpm --filter @relvo-labs/agent-provider-codex test`
- `pnpm --filter @relvo-labs/agent-provider-codex typecheck`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm static:check`, `pnpm dag:check`, `pnpm skills:check`
- `pnpm build`, `pnpm artifacts:check`
- `pnpm changeset:status`

## Exclusions

Approvals, questions, elicitation, dynamic tool calls, attestation, token refresh; tool-activity
mapping (payloads carry commands/paths and need a redaction contract this slice does not build);
durable recovery/export/resume (#6); workspace-free operation (#5); Runtime edge hardening (#3);
validator/CI hardening (#4); publication and release workflow; multi-turn steering, `thread/resume`,
`thread/fork`; websocket/unix transports; experimental API surface; live-model tests.

## Deliberate boundary decision (recorded, not silent)

`tools/repo/check-static.ts` currently asserts the Codex package contains **no** live
integration (`node:child_process`, `spawn(`, `exec(`, `fetch(`), and
`.agents/skills/provider-adapter-development/SKILL.md` states Codex "must stay non-live until
its own issue lands". **Issue #11 is that issue.** Both encode the scaffold status this slice is
chartered to lift, so both are updated here — the static check is _re-pointed_, not weakened:
the scaffold assertion is replaced with live-adapter invariants (no PTY module, no shell-bearing
`exec*`/`spawnSync`, no `shell: true`, no ANSI escapes, argv-array spawn only), matching the
shape already used for the Claude adapter. `tools/repo/check-static.ts` is owned by no skill and
is explicitly disclaimed by `local-ci-parity` (which owns `gate.ts`, not this check). The gate
step list is **not** modified. This is a mechanical consequence of the charter, not scope
expansion; it is called out here so a reviewer can reject it explicitly if they disagree.

## Rollback

Every change is additive within `packages/provider-codex/**` plus the narrowly scoped edits
listed above. Rollback is `git checkout main -- packages/provider-codex tools/repo/check-static.ts
.agents/skills/provider-adapter-development examples/consumer-smoke/src/index.ts docs README.md`
and deleting `.changeset/codex-provider-text-run.md`; no other package, schema, or gate step is
touched, so reverting cannot destabilise the merged Claude slice or the Runtime.
