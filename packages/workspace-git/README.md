# `@relvo-labs/agent-workspace-git`

Git-backed workspace boundary with an injected command runner. Borrowed workspaces accept only ordinary arrays of primitive strings matching three private exact query templates, forced through `--no-pager` and `--no-optional-locks`; execution uses a detached validated copy, and the exported catalog cannot widen enforcement. Serialization hooks, prototype tricks, output paths, config injection, external diff/textconv, and arbitrary argv are rejected before the runner. This package never discovers or owns credentials.
