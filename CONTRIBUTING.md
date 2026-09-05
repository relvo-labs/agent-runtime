# Contributing

Read [AGENTS.md](AGENTS.md) before changing the repository. `.agents/skills/` is the single authoritative local instruction root; the ownership table in `AGENTS.md` identifies which skill must be read before each kind of change.

## Toolchain and checks

```bash
nvm use
pnpm install --frozen-lockfile
pnpm gate
```

Use the exact pnpm version declared by `packageManager`; Corepack is not a prerequisite.
Use pnpm only for workspace installs. Third-party versions are exact catalog pins,
lifecycle scripts are denied by default, and the three-day release-age policy must not
be weakened. Never add credentials or a live provider call to a test.

Public changes require a compiling consumer example and compatibility classification. Wire changes start in Zod, regenerate JSON Schema with `pnpm schema:generate`, and include protocol tests. Package-output changes must pass real tarball installation, publint, and Are The Types Wrong. Published-package behavior changes require a Changeset even though this repository has no publish workflow.

## Pull-request expectations

Keep changes within the package DAG, describe the compatibility class, list the acceptance IDs exercised by tests, and report `pnpm gate`. Do not claim publication, provider integration, hosted CI success, or merge unless it actually happened.
