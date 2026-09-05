# ADR-0013: Strict pnpm supply-chain policy

Status: Accepted

## Context

Fresh package releases and dependency install scripts are high-leverage supply-chain surfaces. Floating direct ranges undermine reproducibility.

## Decision

Pin pnpm exactly and every third-party direct version once in the workspace catalog. Commit the lockfile. Enforce a strict 4,320-minute minimum release age with no broad exception list. Pin an older compatible release instead of weakening the window. Deny dependency lifecycle scripts by default; `onlyBuiltDependencies` is empty. Use frozen installs in CI.

## Consequences

Adopting a just-published fix waits up to three days unless separately reviewed. Install behavior and resolution remain inspectable.
