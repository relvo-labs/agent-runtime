---
'@relvo-labs/agent-provider-claude': minor
'@relvo-labs/agent-provider-codex': patch
---

BREAKING: Hosts using the optional Claude Agent SDK peer must install `@anthropic-ai/claude-agent-sdk@0.3.280` instead of `0.3.259` to satisfy the updated exact peer; the adapter's public TypeScript and neutral wire contracts are unchanged. Refresh the Codex stable app-server compatibility baseline from `codex-cli 0.153.4` to `0.156.1` without bundling the CLI or changing the neutral protocol.
