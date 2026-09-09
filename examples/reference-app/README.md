# Reference app — a runnable SDK integration walkthrough

This is a **private, unpublished example**, not an SDK package. It exists to show a consumer
exactly how to embed `@relvo-labs/agent-runtime` in a real application: one Node HTTP/JSON +
SSE backend that owns a single `AgentExecutor`, and one plain (no-framework) browser UI that
drives it. Every command, receipt, snapshot, and streamed event you see in the browser is
produced by the real SDK — nothing here fabricates an event or injects a fake transport.

> **Manual real-provider evidence matrix.** This README documents what this app _implements and
> automatically tests_. Whether the opt-in Codex/Claude profiles actually succeed against a live,
> credentialed model is a separate, manually-run, separately-authorized evidence matrix — see
> [Opt-in real Codex / Claude profiles](#2-opt-in-real-codex--claude-profiles) — never counted
> from this app's own (credential-free) automated tests.

## Quick start

From a clean checkout, using this repository's pinned toolchain:

```bash
nvm use                 # Node 24.20.0, from .nvmrc
pnpm install            # pnpm 11.25.0, pinned by packageManager
pnpm build               # builds every @relvo-labs/* package this app imports
pnpm --filter @relvo-labs/reference-app start
```

Then open **http://127.0.0.1:4173** in a browser. Pick the `scripted-demo` provider (the only
one registered by default — see [Lanes](#two-lanes) below), click **Open session**, type a
message, and click **Send turn**. Nothing happens yet — click **Advance script** to actually
progress it (see why below), watch the transcript, receipt/event inspector, and session/run
state badges update from real streamed events, then try **Interrupt run** _before_ advancing to
see a genuine in-flight interrupt. Click **Close session** when done. Stop the server with
<kbd>Ctrl-C</kbd> — it shuts the runtime down cleanly (releases the provider session and deletes
the managed workspace directory) before exiting.

Configuration is environment-driven (see `src/config.ts`); useful for development:

```bash
REFERENCE_APP_PORT=0 pnpm --filter @relvo-labs/reference-app start   # ephemeral port
```

### Running the tests, typecheck, and build

```bash
pnpm --filter @relvo-labs/reference-app test        # this app's own tests (34+ cases, 5 files)
pnpm test                                            # root gate step; picks these up too

pnpm build                                           # required first — see below
pnpm --filter @relvo-labs/reference-app typecheck
pnpm --filter @relvo-labs/reference-app build
```

The test suite spins up this app's real HTTP server on an ephemeral loopback port and drives it
with `fetch`, exactly like a browser would — no fake transport, no injected provider, no
credential.

This app's own `typecheck` and `build` resolve every `@relvo-labs/*` import through the real
`node_modules` package resolution pnpm sets up from this app's declared `dependencies` — the same
path an external consumer's own project would take, through each package's published `exports`
map to its **built** `dist/*.d.ts`/`dist/*.js`. There is deliberately no TypeScript `paths` alias
into any package's `src/`: issue #14 explicitly forbids "TS path aliases to SDK source" and
"workspace-link-only proof" for this application. This means **`pnpm build` at the repository
root must run before either command** — without it, `node_modules/@relvo-labs/*` resolves to a
package whose `dist/` does not exist yet, and both commands fail with a clear "Cannot find
module" error, not a silent fallback to source. `pnpm --filter @relvo-labs/reference-app build`
is a genuine compile (`tsc -p tsconfig.build.json`, `noEmit: false`) that emits runnable JS to a
local, git-ignored `dist/` — not merely an alias for `typecheck`. Running the app (`pnpm start`)
still executes the `.ts` sources directly under Node's own native TypeScript support (see
[Packaging](#packaging) below); `dist/` from `pnpm build` is a correctness proof, not what `start`
runs.

### Packed-tarball installation proof

```bash
pnpm app-pack:check    # tools/repo/check-app-pack.ts
```

Packs all eight SDK packages, copies this app's `src/`/`public/` (never a workspace symlink) into
an isolated scratch consumer whose `node_modules` resolves every `@relvo-labs/*` import to those
tarballs with a clean pnpm store, typechecks and builds it there, then starts the built app for
real and drives a full scripted `open → turn → advance-script → close` HTTP lifecycle against it.
This is wired into `pnpm gate` (step `app-pack`, after `build`/`app-build`/`artifacts`).

### Real-browser check (not part of the canonical gate)

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome pnpm --filter @relvo-labs/reference-app browser-check
```

Drives a genuinely running instance of this app with `playwright-core` (a devDependency; no
browser download — see the `pnpm-workspace.yaml` catalog comment) against a **host-supplied**
Chromium/Chrome executable. Asserts, in a real browser: hostile prompt text renders as literal
text and never executes or becomes an element (a real XSS check, not a unit-test approximation);
**Close session** is reachable and activatable by keyboard alone; the page has no horizontal
overflow at a 375×812 mobile viewport. Missing the executable path is a clear, immediate failure,
never a silent skip — this check is intentionally **not** part of `pnpm gate` (a browser binary
is not something this workspace installs, and the canonical gate must stay deterministic and
environment-independent; see `.agents/skills/local-ci-parity/SKILL.md`). The coordinator's own
independent desktop/mobile browser pass is separate from, and does not depend on, this command.

## What this app is (and is not)

- **One active session at a time**, enforced server-side (`src/session-admission.ts`): a second,
  distinct `open_session` attempt is rejected with `409 session_already_open` while one is open;
  an exact retry of the same in-flight or already-open attempt is still admitted (the runtime's
  own idempotent receipt handling answers it, unaffected by this app's admission policy). The
  slot self-heals — a session that fails or is closed by any path frees it for the next open.
  Multiple sequential turns on the same session retain the provider conversation.
- A **consumer-owned** transport: the HTTP/JSON/SSE server in `src/` is this app's own code, not
  an SDK package. A consumer is free to replace it with gRPC, WebSockets, or whatever fits their
  stack — the only requirement the SDK itself imposes is calling `AgentExecutor`'s
  command/read/subscribe methods correctly.
- Not a file browser, code editor, terminal, scheduler, workflow builder, or multi-tenant admin
  surface. It is intentionally minimal.

## Two lanes

### 1. Credential-free scripted demo (default)

`providerId: "scripted-demo"` is the SDK's own public deterministic test double
(`createScriptedProvider` from `@relvo-labs/agent-provider/testing`), run through the exact same
`AgentExecutor`/`AgentRuntime` and the exact same HTTP/SSE transport as any other provider would
be. It proves **this application and the runtime are wired together correctly** — command →
receipt → event → projection → cleanup — end to end. It does **not** prove anything about a real
model provider: there is no network call, no model. The UI labels this lane accordingly, and the
provider's capability descriptor reports `approval`/`question`/`recovery` as unsupported so the
UI never offers a control the demo cannot honour.

**The scripted provider never paces itself.** This app's backend never calls the provider's
public `controller.drain()` automatically after `submit_turn`/`interrupt_run` — doing so would
let a run reach a terminal state before an HTTP response even returns, making genuine in-flight
interruption impossible to demonstrate through the transport. Instead, `POST
/api/sessions/:id/advance-script` (the UI's **Advance script** button, shown only when the open
session is using this provider) is the one, clearly-labelled affordance that calls `drain()`. This
means:

- Right after **Send turn**, the run genuinely sits in `running` — undrained, no events yet — for
  as long as you like. **Interrupt run** against it is a real, `delivered: true` in-flight
  interrupt, not the `delivered: false` "it was already over" you get from interrupting an
  already-terminal run (also demonstrable: interrupt again after the run finished).
- **Send a message that fails (scripted demo)** submits a fixed trigger phrase
  (`SCRIPTED_FAILURE_TRIGGER_TEXT` in `src/providers/scripted.ts`) whose script ends in a real
  `fail` step — clicking **Advance script** afterwards drives it to a genuine `run.finished`
  failure with a real, specific error, never an invented envelope.
- A subsequent turn on the same session works immediately after an interrupt — interrupting a run
  never ends the session.

### 2. Opt-in real Codex / Claude profiles

Both are **opt-in and off by default** — the canonical gate and this app's default first run stay
credential-free. Enabling one only _registers_ the adapter; it supplies no credential and reads
none itself (see `src/providers/codex.ts` / `src/providers/claude.ts`). Authentication is entirely
host-side, resolved by the adapter/SDK itself from the process environment — this app never
guesses, stores, or forwards one:

- **Codex** — `REFERENCE_APP_ENABLE_CODEX=1`, optionally `CODEX_EXECUTABLE=/path/to/codex`
  (defaults to `codex` on `PATH`). Sandbox mode is fixed at the conservative `read-only`. The
  spawned `codex app-server --stdio` process inherits this Node process's environment, so
  whatever the host already configured — an interactive `codex login` session under `CODEX_HOME`
  (default `~/.codex`), or `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` for non-interactive use — is what
  Codex itself resolves. Compatibility baseline: **codex-cli 0.153.4**. Live docs read during
  implementation: <https://developers.openai.com/codex/auth>,
  <https://developers.openai.com/codex/environment-variables>.
- **Claude** — `REFERENCE_APP_ENABLE_CLAUDE=1`, optionally `REFERENCE_APP_CLAUDE_MODEL=<model id>`
  (defaults to `claude-sonnet-4-6`, this repository's own documented example model). Permission
  mode is fixed at the conservative `plan` — never `acceptEdits`/`bypassPermissions`. Requires the
  host-installed optional peer `@anthropic-ai/claude-agent-sdk@0.3.259`
  (`pnpm add @anthropic-ai/claude-agent-sdk@0.3.259`); without it, `open_session` rejects with a
  retryable `provider_unavailable` naming the package — never a silent fallback to the scripted
  lane. The SDK itself reads `ANTHROPIC_API_KEY` (or an alternative provider's env flags — Bedrock,
  the Claude Platform on AWS, Vertex, Foundry) from this process's environment; this app never
  touches it. Live docs read during implementation:
  <https://code.claude.com/docs/en/agent-sdk/quickstart>.

```bash
REFERENCE_APP_ENABLE_CODEX=1 REFERENCE_APP_ENABLE_CLAUDE=1 pnpm --filter @relvo-labs/reference-app start
```

Both adapters share this app's UI/transport unchanged: `providerId` and its capability descriptor
are handled generically (see `updateCapabilitySummary` in `public/app.js`), so the UI never fakes
symmetry — the **Advance script** button, for example, is hidden for a real profile because a real
adapter paces itself. A missing executable/peer is a clean, retryable `open_session` rejection,
proven in `test/reference-app-cleanup.test.ts` without any credential (a nonexistent
`codexExecutable` override; the Claude peer's genuine absence from this workspace's own
`node_modules`, which the repository's own `check-static.ts` already keeps enforced — see
`.agents/skills/provider-adapter-development/SKILL.md`). **Actually completing a turn against a
live, credentialed model is a separate, manually-authorized exercise, outside this app's automated
tests and outside the canonical gate** — record that evidence (exact SDK/app commit, CLI/SDK
version, provider, success/failure/interrupt/cleanup observations, platform limits) in a matrix
kept outside this repository; mark any unrun lane **not verified**, never pass.

## Architecture

```
public/            plain HTML + CSS + vanilla JS browser UI (no build step, no framework)
src/
  config.ts             environment → typed config (loopback host/port, workspace base, real-profile opt-in)
  runtime-factory.ts     composition root: createLocalWorkspaceProvider + createAgentRuntime + providers
  session-admission.ts   server-side "one active session" enforcement, retry-safe
  providers/
    scripted.ts            the scripted-demo provider's fixed scripts (default, failure, burst-for-tests) and identity
    codex.ts, claude.ts     opt-in real-profile wrappers (conservative defaults; no auth logic)
  commands.ts            narrow, typed, strict-allowlist extraction of request-body fields
  http/
    routes.ts               the one place an HTTP request becomes an AgentExecutor call
    security.ts             Host(+port)/Origin/anti-CSRF checks + baseline response headers
    json-body.ts             bounded, content-type-checked JSON body reading
    query.ts                 strict (non-truncating) query-parameter parsing
    sse.ts                   SubscriptionMessage → `data: <json>\n\n` framing, backpressure, deadline, disconnect handling
    static-assets.ts         fixed allowlist of exact pathnames → files (no path-traversal surface)
  app.ts               wires config + runtime + HTTP server into one start/stop object; graceful SSE-aware shutdown
  server.ts            process entry point (env config, SIGINT/SIGTERM → clean shutdown)
scripts/
  browser-check.ts     real-browser Playwright check (see above; not part of `pnpm gate`)
test/
  helpers.ts                        shared real-HTTP/SSE test harness
  reference-app.test.ts             core lifecycle, admission, strict-field/security matrix
  reference-app-interrupt.test.ts   genuine in-flight interrupt, subsequent turn, scripted failure
  reference-app-reconnect.test.ts   overflow + backfill, reconnect-without-replay, disconnect-vs-cancel
  reference-app-cleanup.test.ts     cleanup-failure retry, shutdown+open-SSE, missing-provider setup failure
tsconfig.json         typecheck project (noEmit); no `paths` — resolves via real node_modules
tsconfig.build.json    build project (emits to dist/, git-ignored); extends tsconfig.json
```

### Integration walkthrough (what the code actually does)

1. **Compose.** `runtime-factory.ts` builds a `WorkspaceProvider` via `createLocalWorkspaceProvider`
   and an `AgentRuntime` via `createAgentRuntime`, registering the scripted-demo provider plus any
   opt-in real profile. `@relvo-labs/agent-runtime` never imports a concrete provider — this file
   is where composition happens.
2. **`listProviders()`** — `GET /api/providers` — returns each registered provider's capability
   descriptor verbatim.
3. **`openSession`** — `POST /api/sessions { commandId, providerId }` — strictly only these two
   fields (`src/commands.ts#readKnownFields`; an extra `workspace`/`providerOptions` key is
   rejected outright, not silently dropped). Blocked with `409` while another session is open
   (see [above](#what-this-app-is-and-is-not)). This app always supplies
   `workspace: { kind: "managed" }` itself.
4. **`subscribe`** — `GET /api/sessions/:id/subscribe?fromSequence=&bufferSize=&overflowPolicy=`
   — replay-then-live SSE. The browser does not use `EventSource` (it cannot attach the anti-CSRF
   header this transport requires); it reads the identical wire format from a `fetch()` response
   body, applying real backpressure (never pulling the next event until the previous write has
   actually drained, bounded by a write deadline). An `overflow` message is backfilled via
   `readEvents(fromSequence)` and the stream is reopened from the client's own last-consumed
   sequence — never from 0, so nothing is duplicated. **Disconnect stream**/**Reconnect stream**
   let you demonstrate this deliberately; disconnecting never cancels the run. A 404 (e.g. after a
   backend restart) resets the UI visibly rather than hanging — reconnect is not durable provider
   resume.
5. **`submitTurn`** — `POST /api/sessions/:id/turns { commandId, text }`.
6. **`POST /api/sessions/:id/advance-script`** — the scripted lane's explicit pacing affordance
   (see [Lane 1](#1-credential-free-scripted-demo-default)); `400` if the session's provider isn't
   the scripted one.
7. **`interruptRun`** — `POST /api/sessions/:id/runs/:runId/interrupt` — reports whatever the SDK
   reports, including a truthful `delivered: false` for an already-terminal run and `true` for a
   genuine in-flight one.
8. **`closeSession`** — `POST /api/sessions/:id/close` — disposes the provider session and
   releases the managed workspace lease. `closeSession` **rejects its promise** (not a
   `disposition: "rejected"` receipt) when cleanup fails, exactly so the same `commandId` retries
   the same logical attempt; this app answers that as a typed `503` JSON error naming the real,
   retryable cause (never a silent 200, never a generic 500) — see `callRuntimeCommand` in
   `src/http/routes.ts`.
9. **`getSession` / `readEvents`** — `GET /api/sessions/:id` and `GET /api/sessions/:id/events` —
   the same projections and durable history any consumer can read independent of a live
   subscription. Query values (`fromSequence`, `bufferSize`) are parsed strictly — `"1junk"` or
   `"1.5"` are rejected outright, never silently truncated to `1` the way `Number.parseInt` would.
10. **Process shutdown** (`Ctrl-C`, or `app.close()` in tests) calls `AgentRuntime#shutdown()`
    first, then gives every open SSE pipe a bounded grace period to end its own response normally
    (never destroying a live stream out from under its own cleanup), before closing the server.

Every command sent to the runtime includes an explicit `type` field and a caller-generated, unique
`commandId`. A retried `commandId` with the same payload returns the original
`disposition: "duplicate"` receipt; a retried `commandId` with a different payload returns
`disposition: "rejected"`, `error.code: "command_id_conflict"` — never a silent second effect.

## Security

This app binds **loopback only** (`127.0.0.1`, never `0.0.0.0`) and treats "it's on localhost" as
necessary, not sufficient. Every request is checked, in order:

1. **Host allowlist + exact port** — the `Host` header's hostname must be `127.0.0.1`,
   `localhost`, or `::1`, **and** its port must equal this server's own actual bound port (read
   back after `listen()`, not the requested configuration value — `port: 0` picks an ephemeral
   one). Checking only the hostname would accept a request whose `Host` header names a different
   port than the one actually serving it.
2. **Origin equality** — when an `Origin` header is present, it must equal `http://` + the
   request's own `Host` header exactly.
3. **Anti-CSRF header** — every `/api/*` request (including the SSE stream, since prompt/output
   text is treated as potentially sensitive) must carry a fixed custom header
   (`x-relvo-reference-app: 1`). A cross-origin `fetch` cannot add this header without a CORS
   preflight this server never grants (no `Access-Control-Allow-Origin` response header is ever
   sent); a plain HTML form or navigation cannot add a custom header at all.

Additional server-side controls, independent of the above:

- **Strict, allowlisted request bodies** — an unrecognised field (e.g. a client attempting to
  smuggle `workspace`/`providerOptions`/an executable path) is rejected outright with `400`, never
  silently ignored (`readKnownFields` in `src/commands.ts`). Path parameters (`sessionId`,
  `runId`) are validated against the SDK's own `SessionIdSchema`/`RunIdSchema` before ever
  reaching the runtime.
- **Strict, non-truncating numeric parsing** for every query value (`src/http/query.ts`) —
  `Number.parseInt` is never used in this app.
- **Bounded request bodies** (default 64 KiB; the test suite configures a smaller cap and asserts
  `413` past it), a `content-type: application/json` check, and a bounded request URI length.
- **Baseline response headers** on every answer: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive
  `Content-Security-Policy`. Never a wildcard or reflected CORS header.
- **Bounded SSE transport**: real backpressure (never buffering unboundedly ahead of a slow
  client) and a write deadline (a genuinely dead peer is released, not waited on forever); release
  tied to the _response_'s own lifecycle (`response.on('close')`), not the request's.
- **No arbitrary workspace path, executable, or unrestricted `providerOptions` from the browser** —
  `workspace` is always `{ kind: "managed" }`, decided by this app, never by the request body.
- **Safe rendering** — the browser UI only ever assigns untrusted text (prompts, assistant output,
  tool names, error messages) via `Node.textContent` / `Text.data`. Verified in a real browser by
  `scripts/browser-check.ts`, not only asserted in a unit test.
- **No secrets in the browser, ever** — the scripted lane never holds a credential; the real
  profiles' credentials are resolved by the adapter/SDK directly from the host environment and are
  never read, stored, or forwarded by this app, let alone sent to the browser.
- **Static assets served from a fixed allowlist** of exact pathnames — never by joining a request
  path onto a directory.

See the root [`SECURITY.md`](../../SECURITY.md) for the SDK-wide security model this app builds on.

## Packaging

This app is **private** (`"private": true`, no `publishConfig`) and is never built or packed by the
root `pnpm build` script (which filters to `./packages/*` only) or included in any SDK tarball.
`pnpm start`/`pnpm dev` run the `.ts` sources under Node's own native TypeScript support directly
(no bundler, no separate compile step needed to execute). This app's own `typecheck`/`build`
scripts and `pnpm app-pack:check` (see [above](#packed-tarball-installation-proof)) are the
progressively stronger proofs that this app's TypeScript compiles, and runs, against the SDK's
real, published, packed shape — never a source-tree shortcut.

This app's own **test suite** (`pnpm --filter @relvo-labs/reference-app test`) is a different case
again: it runs under Vitest, which — like every package's own `test/` suite in this monorepo
(`packages/*/test`) — resolves workspace dependencies to source via the shared root
`vitest.config.ts` `resolve.alias`, for fast iteration. That alias is repository-wide
infrastructure this app does not own or extend, and using it for this app's _own_ tests follows the
same convention every other package's tests already use; it is not the "TS path alias to SDK
source" the issue prohibits for this app's _consumer-facing_ typecheck/build.

## Known limits (by design)

- Default in-memory history survives a browser reconnect only while the same backend process
  lives; a backend restart loses it (a fresh `open_session` starts over) — this is not durable
  provider resume.
- `awaiting_interaction` is not exercised: neither the scripted lane (approval/question disabled
  on purpose) nor Codex/Claude support interaction bridging today, so there is no
  `respond_to_interaction` route.
- One session, one active run at a time, by this app's own product policy — the SDK itself does
  not impose that limit.
