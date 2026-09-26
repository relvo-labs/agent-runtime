# ADR-0013: Strict pnpm supply-chain policy

Status: Accepted

## Context

Fresh package releases and dependency install scripts are high-leverage supply-chain surfaces. Floating direct ranges undermine reproducibility.

## Decision

Pin pnpm exactly and every third-party direct version once in the workspace catalog. Commit the lockfile. Enforce a strict 4,320-minute minimum release age with no broad exception list. Pin an older compatible release instead of weakening the window. Deny dependency lifecycle scripts by default; `onlyBuiltDependencies` is empty. Use frozen installs in CI.

The host-installed, optional Claude Agent SDK **peer declaration** is a deliberately
reviewed exception: its published compatibility range is `>=0.3.259 <0.3.261`.
It does not resolve or download into this workspace; the catalog still pins
`0.3.260` exactly as the recorded seam baseline. `check-supply-chain` permits
only this package/field/name/range, while `check-static` also requires the
peer to remain optional. This does not exempt any installed dependency from
the three-day cooldown or permit an unbounded peer range.

## Consequences

Adopting a just-published fix waits up to three days unless separately reviewed. Install behavior and resolution remain inspectable.
