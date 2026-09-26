---
'@relvo-labs/agent-provider-claude': minor
'@relvo-labs/agent-provider-codex': minor
---

BREAKING: Hosts using the optional Claude Agent SDK peer must install `@anthropic-ai/claude-agent-sdk@0.3.280` instead of `0.3.259` to satisfy the updated exact peer. Consumers typed against `CLAUDE_AGENT_SDK_VERSION` or `CODEX_APP_SERVER_VERSION` as the previous string literals must accept `0.3.280` or `0.156.1`, respectively. Claude's first-command interrupt receipt now acknowledges a latched abort even when the run's uuid appears in `still_queued`; later-turn survivors still fail closed. Codex moves its stable app-server baseline from `0.153.4` to `0.156.1` without bundling the CLI. Neutral wire contracts are unchanged.
