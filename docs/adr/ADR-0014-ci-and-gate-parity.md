# ADR-0014: One credential-free local and hosted gate

Status: Accepted

## Context

CI-only checks cannot be reproduced locally, and local-only checks provide no merge evidence.

## Decision

`tools/repo/gate.ts` is the ordered gate definition. `pnpm gate` and GitHub Actions invoke
it unchanged. The gate requires no provider, publish, or elevated GitHub credential. CI
grants read-only contents permission and exercises the bounded supported majors: Node 22,
24, and 26. Node 20 and Node 27+ are unsupported and unclaimed.

Every action is pinned to an immutable commit. Checkout does not persist credentials.
It fetches complete history and materializes `refs/heads/main` from
`refs/remotes/origin/main`, because Changesets resolves its configured base with
`git merge-base main HEAD`; a remote-tracking ref alone is insufficient in a pull-request
checkout. The workflow validator fails closed if either checkout property disappears.
`pnpm/setup` installs exact pnpm 11.25.0 and the selected matrix runtime, restores its
content-addressed cache, requires the committed lockfile, and leaves installation to an
explicit `pnpm install --frozen-lockfile` step. This avoids relying on Corepack, which is
not present in every supported Node distribution.

## Consequences

Artifact installation makes the gate slower but honest. A workflow cannot add hidden validation logic outside the canonical command.
