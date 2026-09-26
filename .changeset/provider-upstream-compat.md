---
'@relvo-labs/agent-provider-claude': minor
'@relvo-labs/agent-provider-codex': minor
---

BREAKING: Consumers typed against `CLAUDE_AGENT_SDK_VERSION` or `CODEX_APP_SERVER_VERSION` as the previous string literals must accept `0.3.260` or `0.156.1`, respectively. The optional Claude Agent SDK peer now accepts the bounded, tested pre-latch window `>=0.3.259 <0.3.261` instead of requiring one exact version. Codex moves its stable app-server baseline from `0.153.4` to `0.156.1` without bundling the CLI; its separately verified compatible CLI window is documented and checked at initialization. Host-managed transports and test doubles must now return an `InitializeResponse.userAgent` beginning with `<clientInfo.name>/<supported-version> (`; missing, malformed and out-of-window values reject before `thread/start`. Claude `0.3.261+` is excluded: its ambiguous first-command queued-interrupt receipt needs a separately verified adapter design. Neither adapter claims authenticated model-run evidence. Neutral wire contracts are unchanged.
