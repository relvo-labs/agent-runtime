# Contributing

Read [AGENTS.md](AGENTS.md) before changing the repository, then read the owning
skill listed in its ownership table and the [skill index](.agents/skills/INDEX.md).
`.agents/skills/` is the only repository skill root.

## Toolchain and installation

Use Node **24.20.0** from `.nvmrc` and exact **pnpm 11.25.0** from `packageManager`.
Start with a clean clone and run from the repository root in Bash:

```bash
source ~/.nvm/nvm.sh
nvm use
pnpm --version
pnpm install --frozen-lockfile
pnpm gate
```

Install the pinned pnpm tool first if needed; the [root quick start](README.md#quick-start-a-credential-free-http-response)
shows user-space installation without Corepack. Use pnpm only for workspace
dependency installs. Third-party versions are exact `catalog:` pins; dependency
lifecycle scripts are denied by default. Preserve the strict three-day release-age
policy in [pnpm-workspace.yaml](pnpm-workspace.yaml). Never add provider credentials
or live model calls to tests.

The declared Node range is `^22.18.0 || ^24.11.0 || ^26.0.0`. Hosted jobs use exact
representatives **22.18.0**, **24.20.0** and **26.8.1**, each running the whole gate.

## The canonical gate

[`tools/repo/gate.ts`](tools/repo/gate.ts) defines the ordered checks used locally and
in CI. The gate stops on the first failing step and requires no provider or publish
credential; artifact installs and the production audit use the npm registry.

| Order | Checks |
| --- | --- |
| 1–5 | Prettier, ESLint, reference-app browser JS syntax, workspace typecheck, engines/workflow policy |
| 6–10 | Generated schema drift, skill index/validation, dependency DAG, static boundaries, release-workflow structure |
| 11–14 | Supply-chain policy, production licenses, deterministic tests (including reference app), public package builds |
| 15–18 | Reference-app typecheck/build, packed SDK artifacts, packed reference-app integration |
| 19–20 | Changeset coverage/version-transition proof, production high-severity dependency audit |

Artifact checks install real tarballs into isolated consumers, typecheck public
entry points with [consumer-smoke](examples/consumer-smoke), and run publint and
Are The Types Wrong. The packed app check builds and runs the copied reference
app against those tarballs and exercises a scripted HTTP lifecycle.

Useful individual commands, run from the root after installation:

```bash
pnpm schema:generate
pnpm schema:check
pnpm skills:index
pnpm skills:check
pnpm dag:check
pnpm changeset:status
```

Regenerate schemas after changing authoritative Zod schemas, then include protocol
tests. Regenerate the skill index after editing a skill; never edit `INDEX.md` by
hand. Generation commands should produce no diff on an unchanged checkout.

For public API changes, include a compiling consumer example and classify the
compatibility change. Keep the package DAG acyclic; runtime must never import a
concrete provider adapter. Borrowed workspaces must never be destructively mutated.

## Changesets and releases

Root `README.md`, `CONTRIBUTING.md`, `docs/`, tools and governance files are not
published in SDK tarballs, so changes limited to them require no Changeset.
A package README **is** published: changing it requires a **patch** Changeset,
as enforced by the gate and tracked in [#49](https://github.com/relvo-labs/agent-runtime/issues/49).
Every package whose published output changes needs nonempty version intent.

For pre-1.0 packages, additive and breaking public changes use `minor`; fixes
without a surface change and published documentation changes use `patch`.
Breaking Changeset notes must begin with `BREAKING:` and state the migration.
Record intent in `.changeset/` using the format in the
[Changesets skill](.agents/skills/changesets-release/SKILL.md). Linked Changesets
align only packages entering a plan; a leaf-adapter plan can contain just Claude
and Codex. Never run version preparation on a feature branch: versioning belongs
to a dedicated release PR and publication is a separate human decision.

Publication uses only the manual, explicitly scoped
[release workflow](.github/workflows/release.yml) on `main`, with a credential-free
gate and fail-closed preflight before an `npm-release` environment approval.
**Agents never initiate publication.** Never republish or name an already-published
version in a dispatch. Read the [release runbook](docs/release.md) and
[versioning rules](docs/versioning.md) before release work. The root README records
the dated current registry observation; older governance statements are tracked
in [#51](https://github.com/relvo-labs/agent-runtime/issues/51).

## Pull-request expectations and CI

Keep scope within the package DAG. Describe the problem, resulting behavior,
compatibility class (or why no public API changes), acceptance IDs exercised by
tests where applicable, and the exact gate result and toolchain. For documentation,
reproduce the commands, check links and distinguish observed behavior from plans.
Report a failure reproduced on unmodified base as pre-existing, with evidence;
keep unrelated repairs in their own issue/change.

[`gate.yml`](.github/workflows/gate.yml) runs only on `workflow_dispatch` and
`pull_request: ready_for_review`. Opening a draft, pushing commits or editing a PR
does not trigger it. Cite a real run URL and SHA when reporting hosted success;
configuration alone is not a passing run.

Do not claim publication, provider integration, hosted CI success, or merge unless
it actually happened.
