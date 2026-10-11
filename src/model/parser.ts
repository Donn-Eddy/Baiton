/**
 * Pure parser for plan.md and legacy spec.md documents.
 *
 * A plan has a preamble followed by `# PHASES` and `P##` phase lines. The
 * legacy spec.md format has `# OVERVIEW`, `# TODOS` and `T##` lines. The parser
 * never throws; structural validity is the validator's job.
 */
import { PhaseState, isPhaseState } from './phaseState';

/** The supported document grammars. `legacy-spec` is the legacy spec.md format (`# OVERVIEW` + `# TODOS`, `T##`). */
export type DocumentKind = 'plan' | 'legacy-spec';

/** A plan document parsed into frontmatter, preamble, phases and raw lines. */
export interface ParsedPlan {
  kind: DocumentKind;
  frontmatter: Map<string, string>;
  /** The plan preamble, or the legacy OVERVIEW section. */
  preamble: string;
  phases: Phase[];
  rawLines: string[];
}

/** One work item under the document's PHASES or legacy TODOS section. */
export interface Phase {
  /** The kind's prefix (`P`, or `T` for legacy) followed by two or more digits. */
  id: string;
  state: PhaseState;
  title: string;
  after: string[];
  files: string[];
  lineIndex: number;
}

/** Pattern for phase ids belonging to a document kind. */
export function phaseIdPattern(kind: DocumentKind): RegExp {
  return kind === 'plan' ? /^P\d{2,}$/ : /^T\d{2,}$/;
}

/** Prefix used by phase ids belonging to a document kind. */
export function phaseIdPrefix(kind: DocumentKind): 'P' | 'T' {
  return kind === 'plan' ? 'P' : 'T';
}

// Legacy documents preserve the old TODOS section name.
function phasesSectionName(kind: DocumentKind): 'PHASES' | 'TODOS' {
  // Legacy: retain the old section name for existing documents.
  return kind === 'plan' ? 'PHASES' : 'TODOS';
}

/** Infer document kind from PHASES, or legacy TODOS and OVERVIEW headers. */
export function detectDocumentKind(raw: string): DocumentKind {
  const lines = raw.split('\n');
  const { bodyStart } = parseFrontmatter(lines);
  let phasesHeader = -1;
  let legacyTodosHeader = -1;
  for (let i = bodyStart; i < lines.length; i++) {
    if (phasesHeader === -1 && isHeader(lines[i], 'PHASES')) phasesHeader = i;
    // Legacy spec.md format is identified by its TODOS header.
    if (legacyTodosHeader === -1 && isHeader(lines[i], 'TODOS')) legacyTodosHeader = i;
    if (phasesHeader !== -1 || legacyTodosHeader !== -1) {
      if (phasesHeader !== -1 && legacyTodosHeader !== -1) {
        return phasesHeader < legacyTodosHeader ? 'plan' : 'legacy-spec';
      }
    }
  }
  if (phasesHeader !== -1) return 'plan';
  if (legacyTodosHeader !== -1) return 'legacy-spec';
  return findHeader(lines, bodyStart, 'OVERVIEW') !== -1 ? 'legacy-spec' : 'plan';
}

/** Parse document text. Never throws. */
export function parsePlan(
  raw: string,
  kind: DocumentKind = detectDocumentKind(raw),
): ParsedPlan {
  const rawLines = raw.split('\n');
  const { frontmatter, bodyStart } = parseFrontmatter(rawLines);
  const { preamble, phasesStart } = parsePreamble(rawLines, bodyStart, kind);
  const phases = parsePhases(rawLines, phasesStart, kind);
  return { kind, frontmatter, preamble, phases, rawLines };
}

/** Parse a leading flat `---`-fenced frontmatter block. */
function parseFrontmatter(lines: string[]): {
  frontmatter: Map<string, string>;
  bodyStart: number;
} {
  const frontmatter = new Map<string, string>();
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter, bodyStart: 0 };
  }
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { frontmatter, bodyStart: i + 1 };
    const line = lines[i];
    if (line.trim() === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key !== '') frontmatter.set(key, value);
  }
  return { frontmatter, bodyStart: i };
}

/** Extract the plan preamble or the legacy OVERVIEW and locate the item section. */
function parsePreamble(
  lines: string[],
  bodyStart: number,
  kind: DocumentKind,
): { preamble: string; phasesStart: number } {
  if (kind === 'plan') {
    const phasesHeader = findHeader(lines, bodyStart, phasesSectionName(kind));
    const preamble = lines
      .slice(bodyStart, phasesHeader === -1 ? lines.length : phasesHeader)
      .join('\n');
    return {
      preamble,
      phasesStart: phasesHeader === -1 ? lines.length : phasesHeader + 1,
    };
  }

  // Legacy spec.md format: preserve the original OVERVIEW slicing byte-for-byte.
  const overviewHeader = findHeader(lines, bodyStart, 'OVERVIEW');
  const todosHeader = findHeader(lines, bodyStart, phasesSectionName(kind));
  let preamble = '';
  if (overviewHeader !== -1) {
    const end = todosHeader !== -1 ? todosHeader : lines.length;
    const start = overviewHeader + 1;
    if (start < end) preamble = lines.slice(start, end).join('\n');
  }
  return {
    preamble,
    phasesStart: todosHeader !== -1 ? todosHeader + 1 : lines.length,
  };
}

function findHeader(lines: string[], from: number, name: string): number {
  for (let i = from; i < lines.length; i++) {
    if (isHeader(lines[i], name)) return i;
  }
  return -1;
}

function isHeader(line: string, name: string): boolean {
  const m = /^#+\s+(.*)$/.exec(line);
  return m !== null && m[1].trim() === name;
}

/** Parse item lines in the selected section; prose is ignored. */
function parsePhases(lines: string[], phasesStart: number, kind: DocumentKind): Phase[] {
  const phases: Phase[] = [];
  for (let i = phasesStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- [')) continue;
    const phase = parsePhaseLine(line, i, kind);
    if (phase) phases.push(phase);
  }
  return phases;
}

/** Parse one phase line, returning undefined when it fails this kind's grammar. */
function parsePhaseLine(line: string, lineIndex: number, kind: DocumentKind): Phase | undefined {
  const m = PHASE_PREFIX.exec(line);
  if (!m) return undefined;
  const stateText = m[1].trim();
  if (!isPhaseState(stateText)) return undefined;
  const rest = m[2];
  const spaceIdx = rest.search(/\s/);
  const id = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (!phaseIdPattern(kind).test(id)) return undefined;
  const afterId = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
  const { title, after, files } = parseTitleAndHints(afterId, kind);
  return { id, state: stateText, title, after, files, lineIndex };
}

/** Matches the leading `- [<state>] ` prefix of a phase line. */
const PHASE_PREFIX = /^- \[([^\]]*)\]\s+(.*)$/;

function parseTitleAndHints(
  text: string,
  kind: DocumentKind,
): { title: string; after: string[]; files: string[] } {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed.endsWith(')')) return { title: text.trim(), after: [], files: [] };
  const open = trimmed.lastIndexOf('(');
  if (open === -1) return { title: text.trim(), after: [], files: [] };
  const parsed = parseHints(trimmed.slice(open + 1, -1), phaseIdPattern(kind));
  if (!parsed) return { title: text.trim(), after: [], files: [] };
  return {
    title: trimmed.slice(0, open).trim(),
    after: parsed.after,
    files: parsed.files,
  };
}

/** Return ids in a trailing after hint that uses the other document kind's ids. */
export function trailingHintIdsOfOtherKind(
  title: string,
  kind: DocumentKind,
): string[] | undefined {
  const trimmed = title.replace(/\s+$/, '');
  if (!trimmed.endsWith(')')) return undefined;
  const open = trimmed.lastIndexOf('(');
  if (open === -1) return undefined;
  const otherKind: DocumentKind = kind === 'plan' ? 'legacy-spec' : 'plan';
  const parsed = parseHints(trimmed.slice(open + 1, -1), phaseIdPattern(otherKind));
  return parsed && parsed.after.length > 0 ? parsed.after : undefined;
}

function parseHints(
  inner: string,
  idPattern: RegExp,
): { after: string[]; files: string[] } | undefined {
  const groups = inner.split(';');
  const after: string[] = [];
  const files: string[] = [];
  let sawAny = false;
  for (const rawGroup of groups) {
    const group = rawGroup.trim();
    if (group === '') return undefined;
    const afterItems = matchGroup(group, 'after');
    if (afterItems !== undefined) {
      const ids = splitList(afterItems);
      if (ids.length === 0 || !ids.every((id) => idPattern.test(id))) return undefined;
      after.push(...ids);
      sawAny = true;
      continue;
    }
    const filesItems = matchGroup(group, 'files');
    if (filesItems !== undefined) {
      const paths = splitList(filesItems);
      if (paths.length === 0) return undefined;
      files.push(...paths);
      sawAny = true;
      continue;
    }
    return undefined;
  }
  return sawAny ? { after, files } : undefined;
}

function matchGroup(group: string, keyword: string): string | undefined {
  const re = new RegExp(`^${keyword}\\s*:?\\s+(.*)$`, 'i');
  const m = re.exec(group);
  return m ? m[1] : undefined;
}

function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}
