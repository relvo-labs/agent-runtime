#!/usr/bin/env node
/**
 * Structural, ownership, relation and provenance validation for the canonical
 * local-skill root.
 *
 * Every rule here exists because a specific failure mode is cheap to introduce
 * and expensive to notice: a second skill root, a skill that claims ownership of
 * something another skill already owns, a relation pointing at a renamed skill,
 * or a provenance line claiming to have copied from an unlicensed source.
 *
 * Usage:
 *   node tools/skills/validate.ts [--root <repoRoot>] [--skill-root <rel>] [--json]
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CANONICAL_SKILL_ROOT,
  NON_INCORPORABLE_SOURCES,
  PERMISSIVE_LICENCES,
  RECIPROCAL_VERBS,
  RELATION_VERBS,
  REQUIRED_SECTIONS,
  REQUIRED_SKILLS,
  findCompetingSkillRoots,
  scanSkillRoot,
  type SkillDoc,
} from './lib/model.ts';

export type Finding = {
  readonly code: string;
  readonly skill?: string;
  readonly message: string;
};

export type ValidateOptions = {
  readonly repoRoot: string;
  readonly skillRoot?: string;
  /** Fixture roots are validated structurally without the repo-wide root scan. */
  readonly checkCompetingRoots?: boolean;
  /** Fixture roots do not have to contain the full production skill set. */
  readonly requireCanonicalSet?: boolean;
};

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PINNED_REV_RE = /@([0-9a-f]{40})\b/;
const REPO_REF_RE = /`([\w.-]+\/[\w.-]+)@[0-9a-f]{40}`/;
const LICENCE_RE = /\(([^)]+)\)/;
const STABILITIES = new Set(['experimental', 'stable', 'deprecated']);

/** Path-segment-aware prefix test: `a/b` contains `a/b/c` but not `a/bc`. */
function isPathPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function validateStructure(skill: SkillDoc, findings: Finding[]): void {
  const id = skill.dirName;

  if (skill.frontmatterError) {
    findings.push({
      code: 'FRONTMATTER_INVALID',
      skill: id,
      message: `${skill.relPath}: ${skill.frontmatterError}`,
    });
    return;
  }

  if (!skill.name) {
    findings.push({ code: 'FRONTMATTER_MISSING_FIELD', skill: id, message: `${skill.relPath}: missing \`name\`` });
  } else if (skill.name !== skill.dirName) {
    findings.push({
      code: 'NAME_MISMATCH',
      skill: id,
      message: `${skill.relPath}: front-matter name \`${skill.name}\` does not match directory \`${skill.dirName}\``,
    });
  }

  if (!skill.description || skill.description.length < 24) {
    findings.push({
      code: 'FRONTMATTER_MISSING_FIELD',
      skill: id,
      message: `${skill.relPath}: \`description\` must be present and describe when to use the skill (>= 24 chars)`,
    });
  } else if (skill.description.length > 320) {
    findings.push({
      code: 'DESCRIPTION_TOO_LONG',
      skill: id,
      message: `${skill.relPath}: \`description\` is ${skill.description.length} chars; keep it under 320`,
    });
  }

  if (!skill.version || !SEMVER_RE.test(skill.version)) {
    findings.push({
      code: 'FRONTMATTER_MISSING_FIELD',
      skill: id,
      message: `${skill.relPath}: \`version\` must be an exact semver like \`1.0.0\``,
    });
  }

  if (!skill.stability || !STABILITIES.has(skill.stability)) {
    findings.push({
      code: 'FRONTMATTER_MISSING_FIELD',
      skill: id,
      message: `${skill.relPath}: \`stability\` must be one of ${[...STABILITIES].join(', ')}`,
    });
  }

  for (const section of REQUIRED_SECTIONS) {
    const body = skill.sections.get(section);
    if (body === undefined) {
      findings.push({
        code: 'SECTION_MISSING',
        skill: id,
        message: `${skill.relPath}: missing required section \`## ${section}\``,
      });
    } else if (body.trim() === '') {
      findings.push({
        code: 'SECTION_EMPTY',
        skill: id,
        message: `${skill.relPath}: section \`## ${section}\` is empty`,
      });
    }
  }

  if (skill.sections.has('Owns') && skill.owns.length === 0) {
    findings.push({
      code: 'OWNS_EMPTY',
      skill: id,
      message: `${skill.relPath}: \`## Owns\` must list at least one \`- \\\`token\\\` — rationale\` bullet`,
    });
  }

  for (const entry of [...skill.owns, ...skill.doesNotOwn]) {
    if (entry.token === '') {
      findings.push({
        code: 'OWNERSHIP_MALFORMED',
        skill: id,
        message: `${skill.relPath}: ownership bullet must be \`- \\\`token\\\` — rationale\`, got: ${entry.raw}`,
      });
    }
  }

  const procedure = skill.sections.get('Procedure') ?? '';
  if (procedure && !procedure.includes('```') && !/^\s*\d+\./m.test(procedure)) {
    findings.push({
      code: 'PROCEDURE_NOT_EXECUTABLE',
      skill: id,
      message: `${skill.relPath}: \`## Procedure\` must contain numbered steps or a command block`,
    });
  }

  const verification = skill.sections.get('Verification') ?? '';
  if (verification && !verification.includes('```')) {
    findings.push({
      code: 'VERIFICATION_NOT_EXECUTABLE',
      skill: id,
      message: `${skill.relPath}: \`## Verification\` must contain a runnable command block`,
    });
  }
}

function validateRelations(skills: readonly SkillDoc[], findings: Finding[]): void {
  const byName = new Map<string, SkillDoc>();
  for (const skill of skills) byName.set(skill.name ?? skill.dirName, skill);

  for (const skill of skills) {
    const id = skill.dirName;
    const self = skill.name ?? skill.dirName;

    if (skill.sections.has('Relationships') && skill.relations.length === 0) {
      findings.push({
        code: 'RELATION_MISSING',
        skill: id,
        message: `${skill.relPath}: \`## Relationships\` must name at least one related skill`,
      });
    }

    for (const relation of skill.relations) {
      if (relation.verb === '' || relation.target === '') {
        findings.push({
          code: 'RELATION_MALFORMED',
          skill: id,
          message: `${skill.relPath}: relation must be \`- \\\`verb\\\` → \\\`skill-name\\\` — rationale\`, got: ${relation.raw}`,
        });
        continue;
      }
      if (!RELATION_VERBS.includes(relation.verb)) {
        findings.push({
          code: 'RELATION_UNKNOWN_VERB',
          skill: id,
          message: `${skill.relPath}: unknown relation verb \`${relation.verb}\`; allowed: ${RELATION_VERBS.join(', ')}`,
        });
      }
      if (relation.target === self) {
        findings.push({
          code: 'RELATION_SELF',
          skill: id,
          message: `${skill.relPath}: skill declares a relation to itself`,
        });
        continue;
      }
      const target = byName.get(relation.target);
      if (!target) {
        findings.push({
          code: 'RELATION_BROKEN',
          skill: id,
          message: `${skill.relPath}: relation \`${relation.verb}\` points at unknown skill \`${relation.target}\``,
        });
        continue;
      }
      if (RECIPROCAL_VERBS.includes(relation.verb)) {
        const mirrored = target.relations.some((r) => r.verb === relation.verb && r.target === self);
        if (!mirrored) {
          findings.push({
            code: 'RELATION_NOT_RECIPROCAL',
            skill: id,
            message: `${skill.relPath}: \`${relation.verb}\` → \`${relation.target}\` is not mirrored back from \`${relation.target}\``,
          });
        }
      }
    }
  }
}

function validateOwnership(skills: readonly SkillDoc[], findings: Finding[]): void {
  type Claim = { skill: SkillDoc; token: string };
  const claims: Claim[] = [];
  for (const skill of skills) {
    for (const entry of skill.owns) {
      if (entry.token !== '') claims.push({ skill, token: entry.token });
    }
  }

  const boundaryPairs = new Set<string>();
  for (const skill of skills) {
    const self = skill.name ?? skill.dirName;
    for (const relation of skill.relations) {
      if (relation.verb === 'boundary-with' || relation.verb === 'narrows') {
        boundaryPairs.add([self, relation.target].sort().join('::'));
      }
    }
  }

  const disclaimed = new Map<string, Set<string>>();
  for (const skill of skills) {
    const self = skill.name ?? skill.dirName;
    for (const entry of skill.doesNotOwn) {
      if (entry.token === '') continue;
      const set = disclaimed.get(entry.token) ?? new Set<string>();
      set.add(self);
      disclaimed.set(entry.token, set);
    }
  }

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.skill === b.skill) continue;

      const nameA = a.skill.name ?? a.skill.dirName;
      const nameB = b.skill.name ?? b.skill.dirName;

      if (a.token === b.token) {
        findings.push({
          code: 'OWNERSHIP_DUPLICATE',
          skill: a.skill.dirName,
          message: `\`${a.token}\` is owned by both \`${nameA}\` and \`${nameB}\`; exactly one skill must own it`,
        });
        continue;
      }

      const overlaps = isPathPrefix(a.token, b.token) || isPathPrefix(b.token, a.token);
      if (!overlaps) continue;

      const pair = [nameA, nameB].sort().join('::');
      const narrower = isPathPrefix(a.token, b.token) ? b : a;
      const broader = narrower === a ? b : a;
      const narrowerName = narrower.skill.name ?? narrower.skill.dirName;
      const broaderName = broader.skill.name ?? broader.skill.dirName;
      const broaderDisclaims = disclaimed.get(narrower.token)?.has(broaderName) ?? false;

      if (!boundaryPairs.has(pair) && !broaderDisclaims) {
        findings.push({
          code: 'OWNERSHIP_OVERLAP_UNDECLARED',
          skill: narrower.skill.dirName,
          message:
            `\`${narrowerName}\` owns \`${narrower.token}\` which is inside \`${broaderName}\`'s \`${broader.token}\`; ` +
            `declare the seam with a \`boundary-with\`/\`narrows\` relation or a \`Does not own\` bullet`,
        });
      }
    }
  }
}

function validateProvenance(skill: SkillDoc, findings: Finding[]): void {
  const id = skill.dirName;
  if (!skill.sections.has('Provenance')) return;

  const kinds = skill.provenance.map((entry) => entry.kind);
  if (!kinds.includes('Source')) {
    findings.push({
      code: 'PROVENANCE_MISSING_SOURCE',
      skill: id,
      message: `${skill.relPath}: \`## Provenance\` must contain a \`- Source:\` line`,
    });
  }

  for (const entry of skill.provenance) {
    if (entry.kind === '') {
      findings.push({
        code: 'PROVENANCE_MALFORMED',
        skill: id,
        message: `${skill.relPath}: provenance bullet must be \`- Kind: detail\`, got: ${entry.raw}`,
      });
      continue;
    }

    if (entry.kind !== 'Incorporated' && entry.kind !== 'Reviewed-not-copied') continue;

    const repoRef = REPO_REF_RE.exec(entry.raw);
    if (!repoRef || !PINNED_REV_RE.test(entry.raw)) {
      findings.push({
        code: 'PROVENANCE_UNPINNED',
        skill: id,
        message: `${skill.relPath}: \`${entry.kind}\` must cite \`owner/repo@<40-hex-sha>\`: ${entry.raw}`,
      });
      continue;
    }

    const repo = repoRef[1]!;

    if (entry.kind === 'Incorporated') {
      if (NON_INCORPORABLE_SOURCES.includes(repo)) {
        findings.push({
          code: 'PROVENANCE_UNLICENSED_COPY',
          skill: id,
          message: `${skill.relPath}: \`${repo}\` has absent/ambiguous licensing and must never appear on an \`Incorporated:\` line`,
        });
        continue;
      }
      const licence = LICENCE_RE.exec(entry.raw)?.[1]?.trim();
      if (!licence) {
        findings.push({
          code: 'PROVENANCE_UNLICENSED_COPY',
          skill: id,
          message: `${skill.relPath}: \`Incorporated\` line must state the upstream licence in parentheses: ${entry.raw}`,
        });
      } else if (!PERMISSIVE_LICENCES.includes(licence)) {
        findings.push({
          code: 'PROVENANCE_UNLICENSED_COPY',
          skill: id,
          message: `${skill.relPath}: licence \`${licence}\` is not in the permitted set (${PERMISSIVE_LICENCES.join(', ')})`,
        });
      }
    }
  }
}

export function validateSkills(options: ValidateOptions): Finding[] {
  const repoRoot = resolve(options.repoRoot);
  const skillRoot = options.skillRoot ?? CANONICAL_SKILL_ROOT;
  const findings: Finding[] = [];

  const scan = scanSkillRoot(repoRoot, skillRoot);

  if (scan.skills.length === 0) {
    findings.push({ code: 'SKILL_ROOT_EMPTY', message: `no SKILL.md found under \`${skillRoot}\`` });
  }

  for (const nested of scan.nestedSkillPaths) {
    findings.push({
      code: 'SKILL_NESTED',
      message: `rogue nested skill at \`${skillRoot}/${nested}\`; skills must live at \`${skillRoot}/<name>/SKILL.md\``,
    });
  }

  for (const link of scan.symlinkPaths) {
    findings.push({
      code: 'SKILL_SYMLINK',
      message: `symlink under the skill root at \`${skillRoot}/${link}\`; skill content must be real files`,
    });
  }

  const seen = new Map<string, string>();
  for (const skill of scan.skills) {
    const declared = skill.name;
    if (declared) {
      const previous = seen.get(declared);
      if (previous) {
        findings.push({
          code: 'NAME_DUPLICATE',
          skill: skill.dirName,
          message: `duplicate skill name \`${declared}\` in \`${previous}\` and \`${skill.dirName}\``,
        });
      } else {
        seen.set(declared, skill.dirName);
      }
    }
    validateStructure(skill, findings);
    validateProvenance(skill, findings);
  }

  validateRelations(scan.skills, findings);
  validateOwnership(scan.skills, findings);

  if (options.requireCanonicalSet !== false) {
    const present = new Set(scan.skills.map((s) => s.name ?? s.dirName));
    for (const required of REQUIRED_SKILLS) {
      if (!present.has(required)) {
        findings.push({ code: 'REQUIRED_SKILL_MISSING', message: `required skill \`${required}\` is absent` });
      }
    }
  }

  if (options.checkCompetingRoots !== false) {
    for (const competing of findCompetingSkillRoots(repoRoot, skillRoot)) {
      findings.push({
        code: 'SKILL_ROOT_DUPLICATE',
        message: `\`${competing}\` is a second active skill root; \`${skillRoot}\` must be the only one`,
      });
    }
  }

  return findings.sort((a, b) =>
    `${a.code}${a.skill ?? ''}${a.message}` < `${b.code}${b.skill ?? ''}${b.message}` ? -1 : 1,
  );
}

function main(argv: readonly string[]): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultRepoRoot = resolve(here, '../..');

  const rootIndex = argv.indexOf('--root');
  const skillRootIndex = argv.indexOf('--skill-root');
  const repoRoot = rootIndex === -1 ? defaultRepoRoot : resolve(argv[rootIndex + 1]!);
  const skillRoot = skillRootIndex === -1 ? CANONICAL_SKILL_ROOT : argv[skillRootIndex + 1]!;

  const findings = validateSkills({ repoRoot, skillRoot });

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length === 0) {
    const { skills } = scanSkillRoot(repoRoot, skillRoot);
    process.stdout.write(`skills: OK — ${skills.length} skills validated under ${skillRoot}\n`);
  } else {
    process.stderr.write(`skills: ${findings.length} finding(s)\n`);
    for (const finding of findings) {
      process.stderr.write(`  [${finding.code}]${finding.skill ? ` (${finding.skill})` : ''} ${finding.message}\n`);
    }
  }

  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
