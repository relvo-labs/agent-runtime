# Provider upstream compatibility refresh

**Scope:** `relvo-labs/agent-runtime`, branch `chore/provider-upstream-compat-20260926`, baseline `main@47eb3bef1b35b9921d2c31827e60e0f8a3b6817d`. One writer owns this branch. No publication, deployment, credentials or merge.

**Authority:** user requested updating Claude and Codex, verifying, then opening a PR. No open upgrade issue/PR found. Historical release notes and ADR evidence remain pinned to the releases they describe.

**Decision and acceptance**

1. Respect the workspace's three-day supply-chain age: Claude Agent SDK `0.3.280` is the newest mature stable release; Codex CLI/app-server `0.156.1` is the newest mature stable CLI release at the verification cutoff. Do not install Codex as a workspace runtime dependency or bundle the proprietary Claude SDK.
2. Compare authentic upstream declarations and generated stable app-server schemas with the bounded adapter seams. Preserve approval/question separation, fail-closed unknown requests, explicit capability opt-out, no provider-native IDs in public DTOs, and no expanded workspace writes.
3. Update the catalog peer and version diagnostics plus living docs/recorded tests; add a real changeset. Keep lockfile frozen/no-op if the optional peer isn't resolved into it. Add code/test changes only for verified incompatibilities.
4. Validate with Node from `.nvmrc`, `pnpm install --frozen-lockfile`, `pnpm gate`, production audit/license check, independent read-only compatibility review, and real no-credential Codex app-server protocol handshake. No model invocation is implied by schema/handshake verification.
5. Only after green evidence, push an isolated branch and open a PR; verify remote head and PR read-back. Leave merge/publication to the human.

**Rollback:** revert the PR before any future version-only release; the existing `0.3.0` published-version fields are not changed here.

**Process note:** this concise plan was written after initial bounded pin/documentation edits rather than before the first mutation. The provider, supply-chain, Changesets and CI skills were read before those edits; the public-API skill was read after changing an exported version constant. The compatibility class is a required optional-peer pin change (minor pre-1.0 with a `BREAKING:` migration), plus a changed Codex diagnostic constant (patch intent). Packed consumer declarations are verified by the artifact gate. Review the already-written diff explicitly; this note is not retroactive sequencing compliance.
