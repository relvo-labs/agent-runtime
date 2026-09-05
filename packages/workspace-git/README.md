# `@relvo-labs/agent-workspace-git`

Git-backed workspace boundary with an injected command runner. Borrowed workspaces accept only three exact query argv templates enforced by private immutable keys, forced through `--no-pager` and `--no-optional-locks`; the exported catalog is a deeply frozen detached snapshot and cannot widen enforcement. Output paths, config injection, external diff/textconv, and arbitrary argv are rejected before the runner. This package never discovers or owns credentials.
