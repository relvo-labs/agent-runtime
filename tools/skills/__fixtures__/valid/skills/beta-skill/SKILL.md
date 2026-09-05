---
name: beta-skill
description: Second baseline fixture skill; provides the reciprocal boundary for alpha-skill.
version: 1.0.0
stability: stable
tags: [fixture]
---

# Beta skill

## Trigger

When the beta surface changes.

## Counter-trigger

When the alpha surface changes; use `alpha-skill`.

## Owns

- `fixture/beta` — the beta surface

## Does not own

- `fixture/alpha` — owned by `alpha-skill`

## Relationships

- `boundary-with` → `alpha-skill` — beta and alpha share the fixture seam.

## Procedure

1. Do the beta thing.

## Verification

```bash
echo beta-ok
```

## Provenance

- Source: independent — authored as a validator fixture.
- Reviewed-not-copied: `mindfold-ai/Trellis@88f4834449da9b4f607ec05e322408a0aa66f2ce` (licence ambiguous) — reviewed only.
