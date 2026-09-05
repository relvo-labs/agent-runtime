/**
 * Discovery and structural parsing of the canonical skill root.
 *
 * This module is intentionally side-effect free and takes every path as an
 * argument so the validator can be pointed at adversarial fixture roots.
 */

import { readdirSync, readFileSync, lstatSync, existsSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseFrontmatter, readList, readString } from './frontmatter.ts';

export const CANONICAL_SKILL_ROOT = '.agents/skills';

export const REQUIRED_SKILLS: readonly string[] = [
  'changesets-release',
  'local-ci-parity',
  'package-architecture',
  'package-artifact-validation',
  'pnpm-supply-chain',
  'provider-adapter-development',
  'public-api-evolution',
  'runtime-contract-evolution',
  'workspace-lifecycle',
];

export const REQUIRED_SECTIONS: readonly string[] = [
  'Trigger',
  'Counter-trigger',
  'Owns',
  'Does not own',
  'Relationships',
  'Procedure',
  'Verification',
  'Provenance',
];

export const RELATION_VERBS: readonly string[] = [
  'boundary-with',
  'delegates-to',
  'depends-on',
  'escalates-to',
  'narrows',
];

/** `boundary-with` asserts a shared seam, so both sides must acknowledge it. */
export const RECIPROCAL_VERBS: readonly string[] = ['boundary-with'];

export const PERMISSIVE_LICENCES: readonly string[] = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

/**
 * Upstream sources that were reviewed but whose licensing is absent or
 * ambiguous. Claiming to have *incorporated* material from these is a
 * validation failure, not a warning.
 */
export const NON_INCORPORABLE_SOURCES: readonly string[] = ['mindfold-ai/Trellis', 'OpenRouterTeam/typescript-agent'];

/** Directories that must never become a second active skill root. */
export const FORBIDDEN_SKILL_ROOTS: readonly string[] = [
  '.claude/skills',
  '.cursor/skills',
  '.cursor/rules',
  '.github/skills',
  '.codex/skills',
  '.windsurf/skills',
  'skills',
  'docs/skills',
  '.agents/rules',
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store']);

export type Relation = {
  readonly verb: string;
  readonly target: string;
  readonly rationale: string;
  readonly raw: string;
};

export type OwnershipEntry = {
  readonly token: string;
  readonly rationale: string;
  readonly raw: string;
};

export type ProvenanceEntry = {
  readonly kind: string;
  readonly raw: string;
};

export type SkillDoc = {
  readonly dirName: string;
  readonly filePath: string;
  readonly relPath: string;
  readonly source: string;
  // Explicitly `| undefined`: with `exactOptionalPropertyTypes`, a parsed skill
  // that is simply missing a field must still be representable.
  readonly frontmatterError?: string | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly version?: string | undefined;
  readonly stability?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly sections: ReadonlyMap<string, string>;
  readonly owns: readonly OwnershipEntry[];
  readonly doesNotOwn: readonly OwnershipEntry[];
  readonly relations: readonly Relation[];
  readonly provenance: readonly ProvenanceEntry[];
};

export type RootScan = {
  readonly skillRoot: string;
  readonly skills: readonly SkillDoc[];
  /** SKILL.md files found at an illegal depth under the root. */
  readonly nestedSkillPaths: readonly string[];
  /** Symlinks of any kind found under the root. */
  readonly symlinkPaths: readonly string[];
};

function walk(dir: string, onEntry: (absolute: string, isSymlink: boolean, isDir: boolean) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const isSymlink = entry.isSymbolicLink();
    let isDir = entry.isDirectory();
    if (isSymlink) {
      // Do not traverse symlinks; report them instead.
      isDir = false;
    }
    onEntry(absolute, isSymlink, isDir);
    if (isDir && !IGNORED_DIRS.has(entry.name)) {
      walk(absolute, onEntry);
    }
  }
}

function containsInstructionFile(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && (entry.name === 'SKILL.md' || entry.name.endsWith('.mdc'))) return true;
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && containsInstructionFile(join(dir, entry.name))) {
      return true;
    }
  }
  return false;
}

function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let current: string | undefined;
  let buffer: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current !== undefined) sections.set(current, buffer.join('\n').trim());
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      buffer = [];
    } else if (current !== undefined) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** `- \`token\` — rationale` */
const OWNERSHIP_RE = /^-\s+`([^`]+)`\s*[—-]{1,2}\s*(.+)$/;
/** `- \`verb\` → \`target\` — rationale` */
const RELATION_RE = /^-\s+`([^`]+)`\s*(?:→|->)\s*`([^`]+)`\s*[—-]{1,2}\s*(.+)$/;
/** `- Kind: detail` */
const PROVENANCE_RE = /^-\s+([A-Za-z][A-Za-z-]*)\s*:\s*(.+)$/;

function parseListSection<T>(section: string | undefined, parse: (line: string) => T | undefined): T[] {
  if (!section) return [];
  const out: T[] = [];
  let inFence = false;
  for (const rawLine of section.split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const parsed = parse(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

export function parseSkillFile(dirName: string, filePath: string, repoRoot: string, source: string): SkillDoc {
  const relPath = relative(repoRoot, filePath).split(sep).join('/');
  const fm = parseFrontmatter(source);

  if (!fm.ok) {
    return {
      dirName,
      filePath,
      relPath,
      source,
      frontmatterError: fm.reason,
      sections: new Map(),
      owns: [],
      doesNotOwn: [],
      relations: [],
      provenance: [],
    };
  }

  const sections = extractSections(fm.data.body);

  const owns = parseListSection<OwnershipEntry>(sections.get('Owns'), (line) => {
    const m = OWNERSHIP_RE.exec(line);
    return m ? { token: m[1]!.trim(), rationale: m[2]!.trim(), raw: line } : { token: '', rationale: '', raw: line };
  });

  const doesNotOwn = parseListSection<OwnershipEntry>(sections.get('Does not own'), (line) => {
    const m = OWNERSHIP_RE.exec(line);
    return m ? { token: m[1]!.trim(), rationale: m[2]!.trim(), raw: line } : { token: '', rationale: '', raw: line };
  });

  const relations = parseListSection<Relation>(sections.get('Relationships'), (line) => {
    const m = RELATION_RE.exec(line);
    return m
      ? { verb: m[1]!.trim(), target: m[2]!.trim(), rationale: m[3]!.trim(), raw: line }
      : { verb: '', target: '', rationale: '', raw: line };
  });

  const provenance = parseListSection<ProvenanceEntry>(sections.get('Provenance'), (line) => {
    const m = PROVENANCE_RE.exec(line);
    return m ? { kind: m[1]!.trim(), raw: line } : { kind: '', raw: line };
  });

  return {
    dirName,
    filePath,
    relPath,
    source,
    name: readString(fm.data, 'name'),
    description: readString(fm.data, 'description'),
    version: readString(fm.data, 'version'),
    stability: readString(fm.data, 'stability'),
    tags: readList(fm.data, 'tags'),
    sections,
    owns,
    doesNotOwn,
    relations,
    provenance,
  };
}

export function scanSkillRoot(repoRoot: string, skillRoot: string): RootScan {
  const absoluteRoot = join(repoRoot, skillRoot);
  const skills: SkillDoc[] = [];
  const nestedSkillPaths: string[] = [];
  const symlinkPaths: string[] = [];

  if (!existsSync(absoluteRoot)) {
    return { skillRoot, skills: [], nestedSkillPaths: [], symlinkPaths: [] };
  }

  walk(absoluteRoot, (absolute, isSymlink) => {
    const rel = relative(absoluteRoot, absolute).split(sep).join('/');
    if (isSymlink) {
      symlinkPaths.push(rel);
      return;
    }
    if (!absolute.endsWith('SKILL.md')) return;

    const segments = rel.split('/');
    if (segments.length === 2) {
      const dirName = segments[0]!;
      skills.push(parseSkillFile(dirName, absolute, repoRoot, readFileSync(absolute, 'utf8')));
    } else {
      nestedSkillPaths.push(rel);
    }
  });

  skills.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
  nestedSkillPaths.sort();
  symlinkPaths.sort();

  return { skillRoot, skills, nestedSkillPaths, symlinkPaths };
}

/** Find directories other than the canonical root that behave like skill roots. */
export function findCompetingSkillRoots(repoRoot: string, canonical = CANONICAL_SKILL_ROOT): string[] {
  const found = new Set<string>();

  for (const candidate of FORBIDDEN_SKILL_ROOTS) {
    if (candidate === canonical) continue;
    const absolute = join(repoRoot, candidate);
    if (!existsSync(absolute)) continue;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      found.add(candidate);
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (containsInstructionFile(absolute)) found.add(candidate);
  }

  // Also catch an unanticipated root: any SKILL.md outside the canonical tree.
  walk(repoRoot, (absolute, isSymlink) => {
    if (isSymlink) return;
    if (!absolute.endsWith('SKILL.md')) return;
    const rel = relative(repoRoot, absolute).split(sep).join('/');
    if (rel.startsWith(`${canonical}/`)) return;
    if (rel.includes('__fixtures__')) return; // adversarial fixtures are inert by design
    found.add(rel.slice(0, rel.lastIndexOf('/')));
  });

  return [...found].sort();
}
