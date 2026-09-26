# Provider compatibility windows (local candidate)

Base: PR #39 candidate `9985dc9c0c70c2362f9025d97a51df00f628ff3e`. Isolated local worktree/branch `feat/provider-compatibility-windows-20260926`. Do not push, merge or publish; the existing PR remains untouched remotely.

User correction: support a bounded _range_ of Codex app-server and Claude Code/Agent SDK versions, not a single release. Distinguish the SDK npm version (actual adapter integration) from separately installed Claude Code CLI version: the provider does not spawn `claude` on PATH.

Acceptance:

1. Claude optional peer accepts a narrow proven pre-latch interval only, `>=0.3.259 <0.3.261`; the exact SDK baseline for source recording remains `0.3.260`. Verify both actual published declarations with a strict isolated harness, and exclude `0.3.261+` until interrupt receipt ambiguity is resolved. Do not claim arbitrary standalone Claude Code CLI support.
2. Codex app-server support accepts only stable releases in a bounded interval (`>=0.153.4 <=0.156.1`) if each published stable release within it passes no-credential initialize/thread-start and adapter-relevant generated stable schema comparison. Exclude prereleases, older, newer and malformed versions. Detect the app-server's version at session initialization before `thread/start` using a validated response; do not trust a configured executable path/constant alone. If userAgent version is not reliable across versions, do not advertise runtime-enforced compatibility without a different safe detection method.
3. Keep Codex a host-supplied executable, Claude SDK a proprietary optional peer; keep catalog exact for workspace resolution and separate published peer range. Public literal API additions need consumer compile proof and an appropriate Changeset. Keep recorded historical evidence pinned.
4. Tests cover inclusive boundaries, malformed/prerelease/out-of-range, no thread start on failure, injected transport, failure cleanup. Run frozen install, package tests, `pnpm gate`, prod audit/licenses and fresh review on final exact candidate. Do not report schema/handshake as authenticated model execution.

Stop if the proof does not support the full interval; narrow the interval or report the blocker, never guess coverage.

Evidence: `/opt/data/cache/provider-window-evidence/REPORT.md` and `evidence.json` contain stable schemas and isolated initialize/thread-start for every Codex release in the allowlist; all adapter-reachable methods are present. The adapter itself completed a no-model session open/dispose with official 0.153.4 and 0.156.1 binaries. Claude 0.3.259 and 0.3.260 both compiled against the seam in an isolated strict typecheck; the published packed manifest retained the bounded optional peer. The first independent read-only review found a P1 in the reference-app fake initializer, which was repaired and re-run green. No authenticated provider model run or turn sandboxing is claimed. After the project-local supply-chain skill/index update, `pnpm install --frozen-lockfile`, all 20 `pnpm gate` steps, production audit and license checks passed. No remote change is authorized.
