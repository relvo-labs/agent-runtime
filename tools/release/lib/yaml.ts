/**
 * A deliberately narrow YAML-subset parser, used only to read this
 * repository's own workflow files structurally.
 *
 * No YAML parser is a declared dependency of this workspace, and the release
 * policy check must not become the reason one is added: a parser is a large
 * new supply-chain surface for a file this repository writes itself. The
 * alternative — regular expressions over workflow text — is what
 * `tools/repo/check-engines.ts` already documents as a permissive
 * pseudo-parser failure mode.
 *
 * So this parser accepts exactly the constructs the reviewed workflows use and
 * *fails closed* on everything else. In particular it rejects, rather than
 * interprets:
 *
 *   - block scalars (`|`, `>`) — a release step must be one reviewable
 *     command, never an inline shell program;
 *   - flow mappings (`{ ... }`), anchors, aliases and tags — aliasing lets one
 *     reviewed value reappear somewhere unreviewed;
 *   - tabs, multiple documents, duplicate keys, backslash escapes.
 *
 * Keys are kept verbatim as strings. YAML 1.1's "`on` means boolean true"
 * rule is deliberately not implemented: the trigger block is addressed as the
 * literal key `on`, which is what GitHub Actions itself means.
 */

export interface YamlMapping {
  readonly [key: string]: YamlValue;
}
export type YamlValue = string | number | boolean | null | readonly YamlValue[] | YamlMapping;

export type YamlParseResult =
  { readonly ok: true; readonly value: YamlValue } | { readonly ok: false; readonly error: string };

type PhysicalLine = { readonly indent: number; readonly content: string; readonly number: number };
type ParserState = { lines: PhysicalLine[]; index: number };

const KEY_RE = /^(?<key>[A-Za-z_][A-Za-z0-9_.-]*)\s*:(?<rest>.*)$/u;
const INTEGER_RE = /^-?\d+$/u;

class YamlError extends Error {}

function fail(line: number, message: string): never {
  throw new YamlError(`line ${line}: ${message}`);
}

/** Remove a trailing `# comment`, honouring quoted scalars. */
function stripComment(raw: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/u.test(raw[i - 1] ?? ''))) return raw.slice(0, i);
  }
  return raw;
}

function parseFlowSequence(text: string, line: number): YamlValue[] {
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  if (inner.includes('[') || inner.includes(']')) fail(line, 'nested flow sequences are not supported');
  return inner.split(',').map((entry) => parseScalar(entry.trim(), line));
}

function parseScalar(text: string, line: number): YamlValue {
  if (text === '') return null;
  const first = text[0]!;
  if (first === '|' || first === '>')
    fail(line, 'block scalars are not supported; every command must be a single line');
  if (first === '{') fail(line, 'flow mappings are not supported');
  if (first === '&' || first === '*' || first === '!') fail(line, 'anchors, aliases and tags are not supported');
  if (first === '[') {
    if (!text.endsWith(']')) fail(line, 'unterminated flow sequence');
    return parseFlowSequence(text, line);
  }
  if (first === '"' || first === "'") {
    if (text.length < 2 || !text.endsWith(first)) fail(line, 'unterminated quoted scalar');
    const inner = text.slice(1, -1);
    if (inner.includes(first)) fail(line, 'quoted scalar contains an unsupported inner quote');
    if (first === '"' && inner.includes('\\')) fail(line, 'backslash escapes are not supported');
    return inner;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (INTEGER_RE.test(text)) return Number(text);
  return text;
}

function peek(state: ParserState): PhysicalLine | undefined {
  return state.lines[state.index];
}

function parseMapping(state: ParserState, indent: number): YamlMapping {
  const mapping: Record<string, YamlValue> = Object.create(null) as Record<string, YamlValue>;
  for (;;) {
    const current = peek(state);
    if (current?.indent !== indent || current.content.startsWith('- ') || current.content === '-') break;
    const matched = KEY_RE.exec(current.content);
    if (matched?.groups === undefined) fail(current.number, `expected \`key: value\`, got: ${current.content}`);
    const key = matched.groups.key!;
    if (Object.prototype.hasOwnProperty.call(mapping, key)) fail(current.number, `duplicate key \`${key}\``);
    const rest = stripComment(matched.groups.rest ?? '').trim();
    state.index += 1;

    if (rest === '') {
      const next = peek(state);
      mapping[key] = next !== undefined && next.indent > indent ? parseBlock(state, next.indent) : null;
      continue;
    }
    mapping[key] = parseScalar(rest, current.number);
  }
  return mapping;
}

function parseSequence(state: ParserState, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  for (;;) {
    const current = peek(state);
    if (current?.indent !== indent) break;
    if (!current.content.startsWith('- ') && current.content !== '-') break;

    const rest = stripComment(current.content === '-' ? '' : current.content.slice(2)).trim();
    if (rest === '') {
      state.index += 1;
      const next = peek(state);
      items.push(next !== undefined && next.indent > indent ? parseBlock(state, next.indent) : null);
      continue;
    }
    if (KEY_RE.test(rest)) {
      // `- key: value` opens a mapping whose keys align two columns in, which
      // is where the item's remaining keys must also sit.
      const inlineIndent = indent + 2;
      state.lines[state.index] = { indent: inlineIndent, content: rest, number: current.number };
      items.push(parseMapping(state, inlineIndent));
      continue;
    }
    state.index += 1;
    items.push(parseScalar(rest, current.number));
  }
  return items;
}

function parseBlock(state: ParserState, indent: number): YamlValue {
  const current = peek(state);
  if (current === undefined) return null;
  if (current.indent !== indent) fail(current.number, 'unexpected indentation');
  return current.content.startsWith('- ') || current.content === '-'
    ? parseSequence(state, indent)
    : parseMapping(state, indent);
}

export function parseYamlSubset(source: string): YamlParseResult {
  try {
    if (source.includes('\t')) return { ok: false, error: 'tabs are not permitted in YAML indentation' };
    const lines: PhysicalLine[] = [];
    for (const [offset, raw] of source.split('\n').entries()) {
      const number = offset + 1;
      if (raw.trim() === '') continue;
      if (raw.trimStart().startsWith('#')) continue;
      if (raw === '---' || raw === '...')
        return { ok: false, error: `line ${number}: multi-document YAML is not supported` };
      const indent = raw.length - raw.trimStart().length;
      if (indent % 2 !== 0) return { ok: false, error: `line ${number}: indentation must be a multiple of two spaces` };
      lines.push({ indent, content: raw.trimEnd().slice(indent), number });
    }
    if (lines.length === 0) return { ok: true, value: null };
    if (lines[0]!.indent !== 0) return { ok: false, error: 'line 1: document must start at column 0' };

    const state: ParserState = { lines, index: 0 };
    const value = parseBlock(state, 0);
    const trailing = peek(state);
    if (trailing !== undefined) {
      return { ok: false, error: `line ${trailing.number}: unexpected content \`${trailing.content}\`` };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Narrowing helpers, so policy code never index-accesses an unknown shape. */
export function asMapping(value: YamlValue | undefined): YamlMapping | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as YamlMapping) : undefined;
}

export function asSequence(value: YamlValue | undefined): readonly YamlValue[] | undefined {
  return Array.isArray(value) ? (value as readonly YamlValue[]) : undefined;
}

export function asString(value: YamlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function mappingKeys(value: YamlValue | undefined): readonly string[] {
  const mapping = asMapping(value);
  return mapping === undefined ? [] : Object.keys(mapping).sort();
}
