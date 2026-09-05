/**
 * Adversarial tests for the local-skill validator.
 *
 * Strategy: one canonical *valid* fixture is committed under
 * `__fixtures__/valid`. Every adversarial case is derived from it by exactly one
 * mutation, materialised into a temp directory. This guarantees each test proves
 * the validator reacts to that single property and not to incidental fixture
 * noise, and it keeps the committed fixture surface small enough to audit.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { validateSkills, type Finding } from './validate.ts';
import { parseFrontmatter } from './lib/frontmatter.ts';
import { renderIndex } from './generate-index.ts';
import { scanSkillRoot } from './lib/model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const validFixture = join(here, '__fixtures__', 'valid');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Materialise the valid fixture into a temp dir, then apply `mutate`. */
function fixture(mutate?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-fixture-'));
  tempRoots.push(root);
  cpSync(validFixture, root, { recursive: true });
  mutate?.(root);
  return root;
}

function skillPath(root: string, name: string): string {
  return join(root, 'skills', name, 'SKILL.md');
}

function edit(root: string, name: string, replace: (source: string) => string): void {
  const path = skillPath(root, name);
  writeFileSync(path, replace(readFileSync(path, 'utf8')), 'utf8');
}

function check(root: string): Finding[] {
  return validateSkills({
    repoRoot: root,
    skillRoot: 'skills',
    requireCanonicalSet: false,
    checkCompetingRoots: false,
  });
}

function codes(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => f.code))].sort();
}

describe('baseline fixture', () => {
  it('reports no findings for the canonical valid fixture', () => {
    expect(check(fixture())).toEqual([]);
  });
});

describe('structural rules', () => {
  it('rejects front-matter that is never closed', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace(/^---\n/, '')));
    expect(codes(check(root))).toContain('FRONTMATTER_INVALID');
  });

  it('rejects a name that disagrees with its directory', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace('name: alpha-skill', 'name: renamed-skill')));
    expect(codes(check(root))).toContain('NAME_MISMATCH');
  });

  it('rejects two skills declaring the same name', () => {
    const root = fixture((r) => edit(r, 'beta-skill', (s) => s.replace('name: beta-skill', 'name: alpha-skill')));
    expect(codes(check(root))).toContain('NAME_DUPLICATE');
  });

  it('rejects a missing required section', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace(/## Verification[\s\S]*?(?=## Provenance)/, '')),
    );
    const findings = check(root);
    expect(codes(findings)).toContain('SECTION_MISSING');
    expect(findings.some((f) => f.message.includes('## Verification'))).toBe(true);
  });

  it('rejects a Verification section with no runnable command', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('```bash\necho alpha-ok\n```', 'Just look at it carefully.')),
    );
    expect(codes(check(root))).toContain('VERIFICATION_NOT_EXECUTABLE');
  });

  it('rejects a non-semver version', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace('version: 1.0.0', 'version: v1')));
    expect(codes(check(root))).toContain('FRONTMATTER_MISSING_FIELD');
  });

  it('rejects an empty Owns section', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('- `fixture/alpha` — the alpha surface', 'Nothing yet.')),
    );
    expect(codes(check(root))).toContain('OWNS_EMPTY');
  });
});

describe('rogue placement rules', () => {
  it('detects a nested skill below the legal depth', () => {
    const root = fixture((r) => {
      const nested = join(r, 'skills', 'alpha-skill', 'sub-skill');
      mkdirSync(nested, { recursive: true });
      cpSync(skillPath(r, 'alpha-skill'), join(nested, 'SKILL.md'));
    });
    expect(codes(check(root))).toContain('SKILL_NESTED');
  });

  it('detects a symlink under the skill root', () => {
    const root = fixture((r) => {
      symlinkSync(join(r, 'skills', 'beta-skill'), join(r, 'skills', 'gamma-skill'), 'dir');
    });
    expect(codes(check(root))).toContain('SKILL_SYMLINK');
  });

  it('detects a second active skill root', () => {
    const root = fixture((r) => {
      const second = join(r, '.claude', 'skills', 'sneaky-skill');
      mkdirSync(second, { recursive: true });
      cpSync(skillPath(r, 'alpha-skill'), join(second, 'SKILL.md'));
    });
    const findings = validateSkills({
      repoRoot: root,
      skillRoot: 'skills',
      requireCanonicalSet: false,
      checkCompetingRoots: true,
    });
    expect(codes(findings)).toContain('SKILL_ROOT_DUPLICATE');
  });
});

describe('relation rules', () => {
  it('rejects a relation pointing at a skill that does not exist', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('`beta-skill` — alpha', '`ghost-skill` — alpha')),
    );
    expect(codes(check(root))).toContain('RELATION_BROKEN');
  });

  it('rejects an unknown relation verb', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace('`boundary-with` →', '`vibes-with` →')));
    expect(codes(check(root))).toContain('RELATION_UNKNOWN_VERB');
  });

  it('rejects a one-sided boundary relation', () => {
    const root = fixture((r) =>
      edit(r, 'beta-skill', (s) =>
        s.replace(
          '- `boundary-with` → `alpha-skill` — beta and alpha share the fixture seam.',
          '- `depends-on` → `alpha-skill` — beta reads alpha output.',
        ),
      ),
    );
    expect(codes(check(root))).toContain('RELATION_NOT_RECIPROCAL');
  });

  it('rejects a self-relation', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace('→ `beta-skill`', '→ `alpha-skill`')));
    expect(codes(check(root))).toContain('RELATION_SELF');
  });

  it('rejects a malformed relation bullet', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) =>
        s.replace('- `boundary-with` → `beta-skill` — alpha and beta share the fixture seam.', '- see beta-skill'),
      ),
    );
    expect(codes(check(root))).toContain('RELATION_MALFORMED');
  });
});

describe('ownership rules', () => {
  it('rejects the same surface owned by two skills', () => {
    const root = fixture((r) =>
      edit(r, 'beta-skill', (s) => s.replace('- `fixture/beta` — the beta surface', '- `fixture/alpha` — also mine')),
    );
    expect(codes(check(root))).toContain('OWNERSHIP_DUPLICATE');
  });

  it('rejects an undeclared nested-surface overlap', () => {
    // beta claims a path *inside* alpha's surface, and the seam is not declared.
    const root = fixture((r) => {
      edit(r, 'beta-skill', (s) =>
        s
          .replace('- `fixture/beta` — the beta surface', '- `fixture/alpha/inner` — a slice of alpha')
          .replace(
            '- `boundary-with` → `alpha-skill` — beta and alpha share the fixture seam.',
            '- `depends-on` → `alpha-skill` — beta reads alpha output.',
          )
          .replace('- `fixture/alpha` — owned by `alpha-skill`', '- `fixture/other` — owned by `alpha-skill`'),
      );
      edit(r, 'alpha-skill', (s) =>
        s
          .replace(
            '- `boundary-with` → `beta-skill` — alpha and beta share the fixture seam.',
            '- `delegates-to` → `beta-skill` — alpha hands off.',
          )
          .replace('- `fixture/beta` — owned by `beta-skill`', '- `fixture/unrelated` — owned by `beta-skill`'),
      );
    });
    expect(codes(check(root))).toContain('OWNERSHIP_OVERLAP_UNDECLARED');
  });

  it('accepts a nested-surface overlap once the seam is declared', () => {
    const root = fixture((r) => {
      edit(r, 'beta-skill', (s) =>
        s.replace('- `fixture/beta` — the beta surface', '- `fixture/alpha/inner` — a slice of alpha'),
      );
      edit(r, 'alpha-skill', (s) =>
        s.replace('- `fixture/beta` — owned by `beta-skill`', '- `fixture/alpha/inner` — owned by `beta-skill`'),
      );
    });
    expect(codes(check(root))).not.toContain('OWNERSHIP_OVERLAP_UNDECLARED');
  });

  it('does not treat a sibling path prefix as an overlap', () => {
    // `fixture/alphabet` must not be considered inside `fixture/alpha`.
    const root = fixture((r) =>
      edit(r, 'beta-skill', (s) =>
        s
          .replace('- `fixture/beta` — the beta surface', '- `fixture/alphabet` — a different surface')
          .replace('- `fixture/alpha` — owned by `alpha-skill`', '- `fixture/alpha` — owned by `alpha-skill`'),
      ),
    );
    expect(codes(check(root))).not.toContain('OWNERSHIP_OVERLAP_UNDECLARED');
  });
});

describe('provenance rules', () => {
  it('rejects an Incorporated claim against a licence-ambiguous source', () => {
    const root = fixture((r) =>
      edit(r, 'beta-skill', (s) =>
        s.replace(
          '- Reviewed-not-copied: `mindfold-ai/Trellis@88f4834449da9b4f607ec05e322408a0aa66f2ce` (licence ambiguous) — reviewed only.',
          '- Incorporated: `mindfold-ai/Trellis@88f4834449da9b4f607ec05e322408a0aa66f2ce` (MIT) — copied wholesale.',
        ),
      ),
    );
    expect(codes(check(root))).toContain('PROVENANCE_UNLICENSED_COPY');
  });

  it('rejects an Incorporated claim with no stated licence', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('(MIT) — fixture attribution shape.', '— fixture attribution shape.')),
    );
    expect(codes(check(root))).toContain('PROVENANCE_UNLICENSED_COPY');
  });

  it('rejects a copyleft licence on an Incorporated claim', () => {
    const root = fixture((r) => edit(r, 'alpha-skill', (s) => s.replace('(MIT)', '(GPL-3.0)')));
    expect(codes(check(root))).toContain('PROVENANCE_UNLICENSED_COPY');
  });

  it('rejects an unpinned upstream reference', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('@a74f281a27dadc02397bc1a174b0f2c97531b6ae', '@main')),
    );
    expect(codes(check(root))).toContain('PROVENANCE_UNPINNED');
  });

  it('rejects a Provenance section with no Source line', () => {
    const root = fixture((r) =>
      edit(r, 'alpha-skill', (s) => s.replace('- Source: independent — authored as a validator fixture.\n', '')),
    );
    expect(codes(check(root))).toContain('PROVENANCE_MISSING_SOURCE');
  });
});

describe('required canonical set', () => {
  it('reports every missing production skill when the canonical set is required', () => {
    const findings = validateSkills({ repoRoot: fixture(), skillRoot: 'skills', checkCompetingRoots: false });
    const missing = findings.filter((f) => f.code === 'REQUIRED_SKILL_MISSING');
    expect(missing).toHaveLength(9);
  });
});

describe('front-matter parser', () => {
  it('rejects nested YAML', () => {
    const result = parseFrontmatter('---\nname: x\nnested:\n  a: 1\n---\nbody\n');
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const result = parseFrontmatter('---\nname: x\nname: y\n---\n');
    expect(result).toMatchObject({ ok: false });
  });

  it('parses inline arrays and strips quotes', () => {
    const result = parseFrontmatter('---\nname: "x"\ntags: [a, b]\n---\nbody\n');
    expect(result.ok && result.data.values).toEqual({ name: 'x', tags: ['a', 'b'] });
  });
});

describe('index generation', () => {
  it('is deterministic across repeated renders', () => {
    const root = fixture();
    const { skills } = scanSkillRoot(root, 'skills');
    expect(renderIndex(skills, 'skills')).toBe(renderIndex(skills, 'skills'));
  });

  it('is stable under directory traversal order', () => {
    const a = scanSkillRoot(fixture(), 'skills').skills;
    const b = scanSkillRoot(fixture(), 'skills').skills;
    expect(renderIndex(a, 'skills')).toBe(renderIndex([...b].reverse(), 'skills'));
  });
});

describe('the real repository', () => {
  it('passes full validation with the canonical set and root scan', () => {
    expect(validateSkills({ repoRoot })).toEqual([]);
  });
});
