---
name: alpha-skill
description: Baseline valid fixture skill used to derive adversarial mutants in validate.test.ts.
version: 1.0.0
stability: stable
tags: [fixture]
---

# Alpha skill

## Trigger

When the alpha surface changes.

## Counter-trigger

When the beta surface changes; use `beta-skill`.

## Owns

- `fixture/alpha` — the alpha surface

## Does not own

- `fixture/beta` — owned by `beta-skill`

## Relationships

- `boundary-with` → `beta-skill` — alpha and beta share the fixture seam.

## Procedure

1. Do the alpha thing.
2. Confirm the beta thing was not disturbed.

## Verification

```bash
echo alpha-ok
```

## Provenance

- Source: independent — authored as a validator fixture.
- Incorporated: `antfu/skills@a74f281a27dadc02397bc1a174b0f2c97531b6ae` (MIT) — fixture attribution shape.
