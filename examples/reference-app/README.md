# Reference app — a runnable SDK integration walkthrough

This is a **private, unpublished example**, not an SDK package. It exists to show a consumer
exactly how to embed `@relvo-labs/agent-runtime` in a real application: one Node HTTP/JSON +
SSE backend that owns a single `AgentExecutor`, and one plain (no-framework) browser UI that
drives it. Every command, receipt, snapshot, and streamed event you see in the browser is
produced by the real SDK — nothing here fabricates an event or injects a fake transport.

> **Status:** this README documents the checkpoint slice that is implemented and tested today
> (the credential-free scripted lane, end to end). The opt-in real Codex/Claude profiles,
> the full adversarial test matrix, and packaging integration are tracked as pending follow-up
> work — see the note at the bottom of this file and `progress.md` in the issue's control
> directory for the exact remaining checklist.

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
message, and click **Send turn**. Watch the transcript, the receipt/event inspector, and the
session/run state badges update from real streamed events. Click **Interrupt run** or
**Close session** to exercise the rest of the lifecycle. Stop the server with <kbd>Ctrl-C</kbd>
— it shuts the runtime down cleanly (releases the provider session and deletes the managed
workspace directory) before exiting.

Configuration is environment-driven (see `src/config.ts`); useful for development:

```bash
REFERENCE_APP_PORT=0 pnpm --filter @relvo-labs/reference-app start   # ephemeral port
```

### Running the tests

```bash
pnpm --filter @relvo-labs/reference-app test        # this app's own tests
pnpm test                                            # root gate step; picks these up too
pnpm --filter @relvo-labs/reference-app typecheck
```

The test suite spins up this app's real HTTP server on an ephemeral loopback port and drives
it with `fetch`, exactly like a browser would — no fake transport, no injected provider.

## What this app is (and is not)

- One active session and one active run at a time, exactly as `AgentExecutor` models it.
  Multiple sequential turns on the same session retain the provider conversation.
- A **consumer-owned** transport: the HTTP/JSON/SSE server in `src/` is this app's own code,
  not an SDK package. A consumer is free to replace it with gRPC, WebSockets, or whatever
  fits their stack — the only requirement the SDK itself imposes is calling
  `AgentExecutor`'s command/read/subscribe methods correctly.
- Not a file browser, code editor, terminal, scheduler, workflow builder, or multi-tenant
  admin surface. It is intentionally minimal.

## Two lanes

### 1. Credential-free scripted demo (default, and the only lane implemented so far)

`providerId: "scripted-demo"` is the SDK's own public deterministic test double
(`createScriptedProvider` from `@relvo-labs/agent-provider/testing`), run through the exact
same `AgentExecutor`/`AgentRuntime` and the exact same HTTP/SSE transport as any other
provider would be. It proves **this application and the runtime are wired together
correctly** — command → receipt → event → projection → cleanup — end to end. It does **not**
prove anything about a real model provider: there is no network call, no model, and no
meaningful cancellation semantics (the response is a canned, deterministic script). The UI
labels this lane accordingly, and the provider's capability descriptor reports
`approval`/`question`/`recovery` as unsupported so the UI never offers a control the demo
cannot honour.

The scripted provider never advances on its own — that is the point of a deterministic
double for testing. This app's backend calls the provider's public `controller.drain()`
exactly once, right after a command that could make a run progress (`submit_turn`,
`interrupt_run`). Because the default script is short, a run typically reaches its terminal
state before the HTTP response for `submit_turn` even returns; clicking **Interrupt run**
against this lane will usually — truthfully — report `delivered: false` (the run was already
over). Genuinely _in-flight_ interruption is real runtime behaviour, exercised directly
against the scripted controller in this app's test suite (bypassing the auto-drain a human
clicking the UI would experience) rather than as a friendly UI demo — see `progress.md` for
the adversarial-test follow-up that expands this.

### 2. Opt-in real Codex / Claude profiles — not implemented yet

The full issue asks for both an opt-in Codex profile (host-installed `codex-cli`, read-only
sandbox) and an opt-in Claude profile (host-installed `@anthropic-ai/claude-agent-sdk` optional
peer, `plan` permission mode), sharing this same UI and transport, each requiring separately
supplied host credentials/authentication and each making the setup-vs-real distinction
explicit (no silent fallback to the scripted lane on a real-provider error). **This checkpoint
does not yet wire either profile.** `src/runtime-factory.ts` registers only the scripted-demo
provider today; adding a provider is registering it alongside the scripted one and giving the
UI a way to select it — the transport and UI code already treat `providerId` and its
capability descriptor generically. This is tracked as the next stage of this work.

## Architecture

```
public/            plain HTML + CSS + vanilla JS browser UI (no build step, no framework)
src/
  config.ts          environment → typed config (loopback host, port, workspace base dir, body cap)
  runtime-factory.ts  composition root: createLocalWorkspaceProvider + createAgentRuntime + providers
  providers/
    scripted.ts        the scripted-demo provider's fixed script and identity
  commands.ts          narrow, typed extraction of the few fields this app accepts from a request body
  http/
    routes.ts            the one place an HTTP request becomes an AgentExecutor call
    security.ts           Host/Origin/anti-CSRF checks (see Security below)
    json-body.ts          bounded, content-type-checked JSON body reading
    sse.ts                 SubscriptionMessage → `data: <json>\n\n` framing, disconnect handling
    static-assets.ts       fixed allowlist of exact pathnames → files (no path-traversal surface)
  app.ts               wires config + runtime + HTTP server into one start/stop object
  server.ts            process entry point (env config, SIGINT/SIGTERM → clean shutdown)
test/
  reference-app.test.ts  end-to-end HTTP/SSE contract test against the real server
```

### Integration walkthrough (what the code actually does)

1. **Compose.** `runtime-factory.ts` builds a `WorkspaceProvider` via `createLocalWorkspaceProvider`
   (owning a base directory this app controls) and an `AgentRuntime` via `createAgentRuntime`,
   registering the scripted-demo provider. `@relvo-labs/agent-runtime` never imports a concrete
   provider — this file is where composition happens, exactly as the SDK's package boundaries
   require.
2. **`listProviders()`** — `GET /api/providers` — returns each registered provider's capability
   descriptor verbatim, so the UI can show an honest capability summary rather than assuming
   symmetry between providers.
3. **`openSession`** — `POST /api/sessions { commandId, providerId }` — the browser supplies only
   a caller-generated `commandId` and a `providerId` from the allowlist above; this app always
   supplies `workspace: { kind: "managed" }` itself (a browser can never name a path or borrow
   an existing directory) and forwards no `providerOptions` from the request body.
4. **`subscribe`** — `GET /api/sessions/:id/subscribe?fromSequence=0` — replay-then-live, framed
   as SSE. The browser does not use `EventSource` (it cannot attach the anti-CSRF header this
   transport requires); it reads the identical wire format from a `fetch()` response body.
   Disconnecting (closing the tab, `AbortController.abort()`) triggers this app's own
   `request.on('close', …)` handler, which calls `subscription.close()` — releasing the
   runtime's bounded per-subscriber buffer without touching the run itself.
5. **`submitTurn`** — `POST /api/sessions/:id/turns { commandId, text }` — the one piece of free
   text this app ever accepts. The receipt's `turnId`/`runId` and every subsequent event are
   the SDK's own identifiers; this app never mints or fabricates one.
6. **`interruptRun`** — `POST /api/sessions/:id/runs/:runId/interrupt` — reports whatever the SDK
   reports, including a truthful `delivered: false` for an already-terminal run (see
   [Lanes](#two-lanes)).
7. **`closeSession`** — `POST /api/sessions/:id/close` — disposes the provider session and
   releases the managed workspace lease; a failed cleanup is retryable with the same
   `commandId` and is never hidden behind a false success.
8. **`getSession` / `readEvents`** — `GET /api/sessions/:id` and `GET /api/sessions/:id/events` —
   the same projections and durable history any consumer can read independent of a live
   subscription.
9. **Process shutdown** (`Ctrl-C`) calls `AgentRuntime#shutdown()`, which stops new admissions,
   drains in-flight commands, closes every open session (interrupting any active run per its
   `ifRunActive` policy), and only then releases the HTTP server.

Every command sent to the runtime includes an explicit `type` field and a caller-generated,
unique `commandId` — see `src/commands.ts` and `src/http/routes.ts`. A retried `commandId` with
the same payload returns the original `disposition: "duplicate"` receipt; a retried `commandId`
with a different payload returns `disposition: "rejected"`, `error.code: "command_id_conflict"`
— never a silent second effect. This app's own test suite exercises both cases against the
real runtime.

## Security

This app binds **loopback only** (`127.0.0.1`, never `0.0.0.0`) and treats "it's on localhost"
as necessary, not sufficient. Every request is checked, in order:

1. **Host allowlist** — the `Host` header must name `127.0.0.1`, `localhost`, or `::1`.
   Rejects DNS rebinding: a public name that resolves to the loopback address still fails
   this check, because its `Host` header does not match.
2. **Origin equality** — when an `Origin` header is present, it must equal `http://` + the
   request's own `Host` header exactly. Rejects a cross-origin page's `fetch` even though it
   reached the right address.
3. **Anti-CSRF header** — every `/api/*` request (including the SSE stream, since prompt/output
   text is treated as potentially sensitive) must carry a fixed custom header
   (`x-relvo-reference-app: 1`). A cross-origin `fetch` cannot add this header without a CORS
   preflight this server never grants (no `Access-Control-Allow-Origin` response header is
   ever sent); a plain HTML form or navigation cannot add a custom header at all.

Additional server-side controls, independent of the above:

- **Bounded request bodies** (`REFERENCE_APP_...` default 64 KiB; the test suite configures a
  smaller cap and asserts `413` past it) and a `content-type: application/json` check.
- **No arbitrary workspace path, executable, or unrestricted `providerOptions` from the
  browser** — `workspace` is always `{ kind: "managed" }`, decided by this app, never by the
  request body (see `src/http/routes.ts`).
- **Safe rendering** — the browser UI only ever assigns untrusted text (prompts, assistant
  output, tool names, error messages) via `Node.textContent` / `Text.data`. Nothing is ever
  parsed or inserted as HTML.
- **No secrets in the browser** — this checkpoint's only lane never holds a credential in the
  first place. When the real provider profiles are added, credentials remain host-side only
  (environment / provider-native config), never sent to or readable from the browser.
- **Static assets served from a fixed allowlist** of exact pathnames (`src/http/static-assets.ts`)
  — never by joining a request path onto a directory, so there is no path-traversal surface to
  get wrong.

See the root [`SECURITY.md`](../../SECURITY.md) for the SDK-wide security model this app builds on.

## Packaging

This app is **private** (`"private": true`, no `publishConfig`) and is never built or packed by
the root `pnpm build` script (which filters to `./packages/*` only) or included in any SDK
tarball. Its own typecheck (`pnpm --filter @relvo-labs/reference-app typecheck`) resolves the
SDK to source via a local `paths` map — exactly like the root workspace typecheck — so it can
be developed without a prior `pnpm build`; running the app for real (`pnpm start`) resolves the
SDK through real `node_modules` and therefore does require `pnpm build` first. Proving this app
against **packed tarballs** (extending `tools/repo/check-artifacts.ts`, per the issue's
acceptance criteria) is tracked as pending follow-up work, not yet wired.

## What's next (tracked, not yet in this checkpoint)

See `progress.md` in the issue's control directory for the exact list. In short: opt-in
Codex/Claude profiles; the full adversarial test matrix (duplicate/conflict edge cases beyond
the one already covered, controlled in-flight interrupt via the scripted controller directly,
reconnect/replay/overflow-backfill, missing-provider and cleanup-failure-retry paths, the full
Host/Origin/CSRF/shape/size negative matrix); packed-tarball installation proof; a scripted
end-to-end browser test command; and a manual real-provider evidence matrix.
