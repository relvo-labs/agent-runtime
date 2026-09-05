# `@relvo-labs/agent-workspace-git`

Git-backed workspace boundary with an injected command runner. Borrowed workspaces accept only three exact query argv templates, forced through `--no-pager` and `--no-optional-locks`; output paths, config injection, external diff/textconv, and arbitrary argv are rejected before the runner. This package never discovers or owns credentials.
