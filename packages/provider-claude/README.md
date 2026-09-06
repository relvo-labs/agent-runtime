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
pnpm add @relvo-labs/agent-provider-claude @anthropic-ai/claude-agent-sdk
```

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
one run without ending the session. Interrupt is idempotent, delivers output produced
before it, and never disposes the session.

## What it does not do

- **Interaction bridging.** No approval or question is raised, so none is declared.
  `permissionPrompts: 'none'` is set unconditionally: a prompt nobody can answer fails
  closed instead of hanging a run. Choose a `permissionMode` to pre-authorise tool use.
- **Non-text turn input.** A `file_ref` part is rejected with `capability_unsupported`
  rather than being invented into prose.
- **Recovery.** No recovery record is exported, so none is claimed.
- **Native identity.** Session ids, message uuids, tool-use ids, the query handle and the
  child process stay inside the adapter. Tool arguments and results are never summarised
  into event detail, because they routinely contain workspace contents.

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
