/**
 * Minimal, dependency-free front-matter reader.
 *
 * Deliberately supports only the subset this repository's SKILL.md files are
 * allowed to use: `key: scalar` and `key: [a, b, c]`. Anything else is reported
 * as invalid rather than silently tolerated, so the skill format cannot drift
 * into arbitrary YAML.
 */

export type Frontmatter = {
  readonly values: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
};

export type FrontmatterResult =
  { readonly ok: true; readonly data: Frontmatter } | { readonly ok: false; readonly reason: string };

const DELIMITER = '---';

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseFrontmatter(source: string): FrontmatterResult {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== DELIMITER) {
    return { ok: false, reason: 'file does not start with a `---` front-matter delimiter' };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === DELIMITER) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, reason: 'front-matter block is never closed with `---`' };
  }

  const values: Record<string, string | readonly string[]> = {};

  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (/^\s/.test(line)) {
      return { ok: false, reason: `line ${i + 1}: indented/nested YAML is not allowed in SKILL.md front-matter` };
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      return { ok: false, reason: `line ${i + 1}: expected \`key: value\`, got ${JSON.stringify(line)}` };
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();

    if (key === '') {
      return { ok: false, reason: `line ${i + 1}: empty key` };
    }
    if (Object.hasOwn(values, key)) {
      return { ok: false, reason: `duplicate front-matter key \`${key}\`` };
    }

    if (rawValue.startsWith('[')) {
      if (!rawValue.endsWith(']')) {
        return { ok: false, reason: `line ${i + 1}: unterminated inline array for \`${key}\`` };
      }
      const inner = rawValue.slice(1, -1).trim();
      values[key] =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((entry) => stripQuotes(entry))
              .filter((entry) => entry !== '');
    } else {
      values[key] = stripQuotes(rawValue);
    }
  }

  return {
    ok: true,
    data: { values, body: lines.slice(end + 1).join('\n') },
  };
}

export function readString(fm: Frontmatter, key: string): string | undefined {
  const value = fm.values[key];
  return typeof value === 'string' ? value : undefined;
}

export function readList(fm: Frontmatter, key: string): readonly string[] | undefined {
  const value = fm.values[key];
  return Array.isArray(value) ? value : undefined;
}
