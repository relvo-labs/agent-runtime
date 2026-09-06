# `@relvo-labs/agent-provider-claude`

A Claude adapter for the neutral provider SPI. Its single responsibility is translating
between `@relvo-labs/agent-provider` and the official Claude Agent SDK's structured
`query()` surface — no PTY, no terminal scraping, no ANSI parsing.

The runtime never imports this package; a host composes it.

```ts
import { createAgentRuntime } from '@relvo-labs/agent-runtime';
import { createClaudeProvider } from '@relvo-labs/agent-provider-claude';

const runtime = createAgentRuntime({
  workspaces,
  providers: [createClaudeProvider({ model: 'claude-sonnet-4-6' })],
});

await runtime.openSession({ commandId, providerId: 'claude', workspace });
await runtime.submitTurn({ commandId, sessionId, input: { parts: [{ type: 'text', text: 'hello' }] } });
```

## Installing the SDK

`@anthropic-ai/claude-agent-sdk` is an **optional peer dependency**, resolved at runtime
by the adapter's default binding. Install it in the host application:

```bash
pnpm add @relvo-labs/agent-provider-claude @anthropic-ai/claude-agent-sdk@0.3.259
```

The peer range is the exact pin the seam was derived from (`CLAUDE_AGENT_SDK_VERSION`).

It is a peer, not a dependency, because it is published under Anthropic's proprietary
terms and ships a per-platform native payload of roughly 200 MB. Making it a runtime
dependency would put a non-permissive licence into this repository's published closure and
force the download on every consumer, including those that inject their own binding.

Without it, `createSession` rejects with a retryable `provider_unavailable` error naming
the package. Nothing else in the adapter changes.

## What it maps

| SDK message                  | Provider event / outcome                            |
| ---------------------------- | --------------------------------------------------- |
| assistant `text` block       | `run.message_delta` (split at 100 000 chars)        |
| assistant `tool_use` block   | `run.tool_activity` `invoked`                       |
| user `tool_result` block     | `run.tool_activity` `succeeded` / `failed`          |
| assistant `error`            | `diagnostic` (`warning`)                            |
| `result` usage               | `run.usage`                                         |
| `result` `success`           | completion `succeeded`                              |
| `result` error subtype       | completion `failed` (`providerCode` = subtype)      |
| stream ends without a result | completion `failed` (`provider_contract_violation`) |
| stream throws                | completion `failed` (`provider_unavailable`)        |

A session is one SDK query in streaming-input mode, so successive turns continue the same
conversation and `interrupt()` — a control request the SDK offers only in that mode — ends
one run without ending the session.

### Which turn a frame belongs to

That one stream also carries turns this adapter never submitted: background and scheduled
work, and turns whose run has already finished. Every submitted message is therefore
stamped with a private client uuid, and the SDK echoes it back as `user_message_uuid` (or
inside `user_message_uuids` when a batch was coalesced) on the turn's first reply frame and
on its result. Frames are bound to a run through that stamp; anything unattributable is
dropped with a `debug` diagnostic rather than emitted into, or used to complete, the run in
front of it. A producer that never stamps — an older CLI — keeps the previous single-turn
behaviour, since demanding a stamp that cannot arrive would hang every run.

### Interrupt semantics

Interrupt is idempotent and coalescing: concurrent calls share one control request.
Intent is recorded before the round-trip, so a terminal result that arrives before the
acknowledgement is still reported as `interrupted` rather than `failed`, and output
produced before the stop is still delivered.

The SDK answers with an `interrupt_receipt_v1` receipt listing input that **survived** the
stop. The pinned public `interrupt()` takes no arguments, so `cancel_queued` cannot be
requested and a survivor cannot be recalled. When the run's own input is listed there, the
adapter reports the stop as not applied — a typed `provider_rejected` with
`details.reason === 'input_still_queued'`, plus a session warning — and leaves the run
active, so the turn that does run is reported for what it actually was. Retrying the
interrupt once the turn has started stops it normally.

Disposal fences new runs the instant it begins, shares one teardown between concurrent
callers, and stays retryable to success if teardown rejects.

## What it does not do

- **Interaction bridging.** No approval or question is raised, so none is declared.
  `permissionPrompts: 'none'` is set unconditionally: a prompt nobody can answer fails
  closed instead of hanging a run. Choose a `permissionMode` to pre-authorise tool use.
- **Non-text turn input.** A `file_ref` part is rejected with `capability_unsupported`
  rather than being invented into prose.
- **Recovery.** No recovery record is exported, so none is claimed.
- **Native identity.** Session ids, message uuids, tool-use ids, the client correlation
  uuid, the query handle and the child process stay inside the adapter. Tool arguments and
  results are never summarised into event detail, because they routinely contain workspace
  contents.
- **Upstream error prose.** `AgentError.message`, `providerCode` and diagnostics carry
  allowlisted classifications only — never SDK error text, which can contain credentials,
  native ids, paths or the prompt. A host that wants the raw text wraps `query` in its own
  binding, where it sees every SDK message and error without any of it reaching the durable
  event log.

## Testing against it

`ClaudeProviderOptions.query` is a typed injection seam. The official `query` export
satisfies it without a cast, and a test can pass a deterministic implementation instead,
which is how this package's own suite runs with no credentials and no network:

```ts
const provider = createClaudeProvider({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', is_error: false };
    },
    interrupt: () => Promise.resolve(undefined),
  }),
});
```

The seam mirrors `@anthropic-ai/claude-agent-sdk` **0.3.259** (`CLAUDE_AGENT_SDK_VERSION`).
See [`docs/provider-development.md`](../../docs/provider-development.md) for the SPI rules
this adapter follows.
