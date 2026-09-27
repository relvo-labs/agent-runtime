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

Public changes require a compiling consumer example and compatibility classification. Wire changes start in Zod, regenerate JSON Schema with `pnpm schema:generate`, and include protocol tests. Package-output changes must pass real tarball installation, publint, and Are The Types Wrong. Published-package behavior changes require a Changeset. Publication uses the manual, explicitly scoped, environment-gated workflow documented in [`docs/release.md`](docs/release.md); contributors and agents do not initiate it.

All eight public packages have immutable `0.2.0` and `0.3.0` releases. A 2026-09-27
registry observation found `latest=0.3.0` for each; provider `0.4.0` is not published.
Never put either published version in a dispatch. Linked Changesets align packages that
enter a release plan; a leaf-adapter plan can contain only the Claude and Codex adapters.

## Pull-request expectations

Keep changes within the package DAG, describe the compatibility class, list the acceptance IDs exercised by tests, and report `pnpm gate`. Do not claim publication, provider integration, hosted CI success, or merge unless it actually happened.
