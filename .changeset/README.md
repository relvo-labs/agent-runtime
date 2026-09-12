# Changesets

Changesets record future version intent only. Nothing here publishes: `changeset version`
belongs to a separate reviewed release PR, and `changeset publish` is never run — the
release workflow publishes an explicitly named `name@version` scope instead, and refuses
to run at all while any changeset in this directory is still pending.

Run `pnpm changeset:status` to inspect pending intent. See `docs/release.md`.
