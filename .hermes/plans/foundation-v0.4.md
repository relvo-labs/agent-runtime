# Foundation v0.4 implementation plan

- **Issue:** #1
- **Branch:** `foundation/runtime-v0.4`
- **Base:** `main@aac2450ebeb896b71d95c37f7ee148c285372305`
- **Tier:** L — new public SDK, public wire contract, package/release and concurrency semantics
- **Authority:** Relvo Agent Runtime initial plan v0.3 plus the reviewed corrections captured by Issue #1

## Outcome

Establish a compiling, tested and publishability-checked TypeScript monorepo foundation for a provider-neutral, No-PTY Agent Execution SDK without implementing production Codex or Claude adapters.

## Fixed decisions

- Public GitHub repository under `relvo-labs/agent-runtime`.
- Apache-2.0 project license.
- `pnpm` workspace managed under repository `.nvmrc` and an exact package-manager pin.
- Provider control paths are structured and No-PTY; terminal scraping and PTY emulation are excluded from core.
- Runtime composition imports neutral SPIs; it does not import concrete provider adapters.
- Initial contract separates Session, Turn, Run and Interaction identities.
- Existing workspaces are borrowed and never destructively cleaned by Runtime.
- No npm publication, provider credentials, live model calls, repository merge or administrative settings changes in this delivery.

## Package DAG

```text
@relvo-labs/agent-protocol
  ↑
  ├─ @relvo-labs/agent-executor
  ├─ @relvo-labs/agent-provider
  └─ @relvo-labs/agent-workspace
       ↑
       └─ @relvo-labs/agent-workspace-git

@relvo-labs/agent-runtime
  ├─ agent-protocol
  ├─ agent-executor
  ├─ agent-provider
  └─ agent-workspace

future concrete provider adapters depend on protocol + provider SPI;
runtime never depends on concrete adapters.
```

## Delivery graph

### F0 — Governance and repository-local skills

Create one canonical local-skill root, a deterministic index, provenance records, a validator and focused validator tests. Skills must be single-purpose and define trigger, counter-trigger, Owns, Does not own, named relations and executable verification.

Required skills:

- runtime-contract-evolution
- provider-adapter-development
- workspace-lifecycle
- package-architecture
- public-api-evolution
- package-artifact-validation
- pnpm-supply-chain
- changesets-release
- local-ci-parity

Professional external skills are reference inputs only. Licensed copied semantics retain attribution and a pinned source revision; unlicensed or ambiguous sources are not copied.

### F1 — Architecture and protocol authority

Create Architecture Foundation v0.4 and ADRs covering:

- Session / Turn / Run identity and state machines
- correlated Interaction lifecycle and discriminated responses
- command IDs, receipts and idempotency
- replay-then-live cursor semantics and subscriber overflow
- atomic sequence/event/state persistence boundary
- provider handle versus serializable recovery record
- interrupt versus close/dispose
- workspace lease ownership and cleanup
- structured capability descriptors
- wire-version versus npm-version compatibility
- third-party in-process provider trust boundary

Zod schemas are the source of TypeScript types and JSON Schema. Wire DTOs use recursive JSON-safe values; native Error objects and provider-native IDs do not cross the public boundary.

### F2 — Monorepo and package contracts

Establish repository-root toolchain/configuration and working packages:

- protocol schemas, inferred types and JSON Schema generation
- consumer `AgentExecutor` contract
- provider SPI with non-serializable run handles and Runtime-stamped event inputs
- workspace SPI with borrowed/managed leases
- Runtime composition root, provider registry and deterministic in-memory store seam sufficient for contract tests
- workspace-git package boundary without GitHub/API credential ownership

Public entry points must be explicit package exports; consumers must not import internal source paths.

### F3 — Verification and CI

Local and hosted gates:

- formatting/lint
- typecheck
- unit and contract tests
- build
- JSON Schema generation/drift check
- package DAG check
- local-skill validation and adversarial fixtures
- `pnpm pack` artifact inspection
- `publint`
- Are The Types Wrong
- clean packed-tarball consumer smoke
- dependency/license/security audit appropriate for a credential-free foundation

CI must not require provider credentials or publish packages.

### F4 — Delivery and review

Inspect the complete diff, commit and push only the working branch, open a Draft PR linked to Issue #1, run one canonical local gate pass, then obtain one fresh read-only semantic review of the frozen head. Important reproduced release blockers receive one consolidated repair; other findings become deduplicated follow-up issues. Human owns merge.

## Acceptance IDs

- **ID-01:** Session, Turn, Run and Interaction have distinct IDs and complete schemas.
- **LC-01:** Published state tables define legal commands, exactly-one run terminal outcome and interrupt/close separation.
- **CM-01:** Commands carry caller IDs; duplicate dispatch produces an idempotent receipt.
- **EV-01:** replay-then-live from sequence zero cannot miss events emitted before subscription.
- **EV-02:** bounded subscriber overflow returns a resumable cursor and never silently drops durable events.
- **ST-01:** sequence allocation, events and projected state share an atomic revision boundary.
- **WS-01:** borrowed workspace release performs no destructive operation; managed cleanup is idempotent and ownership-bound.
- **PK-01:** package imports match the declared acyclic DAG.
- **SC-01:** every required local skill passes structural, ownership, relation and provenance validation.
- **PA-01:** every publishable package passes tarball, export and declaration consumer checks.
- **CI-01:** the exact credential-free canonical gate runs locally and in GitHub Actions.

## Risk and rollback

- Public protocol is pre-1.0 and explicitly unstable; no package is published in this PR.
- Tool-specific choices that are not required by a tested contract remain ADR candidates, not permanent claims.
- If a provider-native shape cannot map without loss, capabilities expose the limitation; core does not invent false symmetry.
- Rollback is branch deletion and Draft PR closure; `main` remains at its initial GitHub-generated commit until human review and merge.
