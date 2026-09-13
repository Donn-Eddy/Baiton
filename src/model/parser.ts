/**
 * Pure spec-file parser (Requirement 3).
 *
 * Splits a spec file into its flat `---`-fenced frontmatter, its `# OVERVIEW`
 * section and its `# TODOS` section, and parses each `- [<state>] <id> <title>`
 * todo line into a structured {@link Todo}. The parser NEVER throws: any input,
 * including malformed frontmatter, missing sections or malformed todo lines,
 * produces a {@link ParsedSpec}. Structural validity is the validator's job
 * (Requirement 4), not the parser's.
 */
import { TodoState, isTodoState } from './todoState';

/**
 * A spec file parsed into its frontmatter, overview prose, structured todos and
 * the raw lines that back conflict-marker scanning and minimal-edit writes.
 */
export interface ParsedSpec {
  /** Flat, order-preserving `key: value` frontmatter. */
  frontmatter: Map<string, string>;
  /** Raw text of the OVERVIEW section (between `# OVERVIEW` and `# TODOS`). */
  overview: string;
  /** The parsed todos, in file order. */
  todos: Todo[];
  /** The file split into lines, for conflict-marker scanning and edits. */
  rawLines: string[];
}

/** One work item under the TODOS section. */
export interface Todo {
  /** `T` followed by two or more decimal digits. */
  id: string;
  /** Lifecycle state from the `[state]` box. */
  state: TodoState;
  /** Everything after the id up to (but excluding) a parsed trailing hint group. */
  title: string;
  /** Dependency ids from an `after` hint group. */
  after: string[];
  /** Starting file paths from a `files:` hint group. */
  files: string[];
  /** Index of this todo's line in {@link ParsedSpec.rawLines}. */
  lineIndex: number;
}

/** A todo id is the character `T` followed by two or more decimal digits (Req 3.3). */
const TODO_ID = /^T\d{2,}$/;

/** Matches the leading `- [<state>] ` prefix of a todo line (Req 3.2). */
const TODO_PREFIX = /^- \[([^\]]*)\]\s+(.*)$/;

/**
 * Splits raw spec text into a parsed model. Never throws.
 */
export function parseSpec(raw: string): ParsedSpec {
  const rawLines = raw.split('\n');

  const { frontmatter, bodyStart } = parseFrontmatter(rawLines);
  const { overview, todosStart } = parseOverview(rawLines, bodyStart);
  const todos = parseTodos(rawLines, todosStart);

  return { frontmatter, overview, todos, rawLines };
}

/**
 * Parses a leading `---`-fenced block of flat `key: value` lines. Returns the
 * frontmatter map and the index of the first body line after the closing fence.
 * If the first non-empty line is not a `---` fence there is no frontmatter and
 * the body starts at line 0.
 */
function parseFrontmatter(lines: string[]): {
  frontmatter: Map<string, string>;
  bodyStart: number;
} {
  const frontmatter = new Map<string, string>();

  // The opening fence must be the first line of the file (allowing that a file
  // may legitimately start with frontmatter). A line that is exactly `---`.
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter, bodyStart: 0 };
  }

  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      // Closing fence consumed; body starts on the next line.
      return { frontmatter, bodyStart: i + 1 };
    }
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    // Flat `key: value`, exactly one key per line, no nested keys (Req 3.1).
    const sep = line.indexOf(':');
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key !== '') {
      frontmatter.set(key, value);
    }
  }

  // No closing fence found; treat the whole remainder as consumed frontmatter.
  return { frontmatter, bodyStart: i };
}

/**
 * Extracts the OVERVIEW section: the raw text between a `# OVERVIEW` header and
 * the following `# TODOS` header. Returns the overview text and the index of
 * the line immediately after `# TODOS` (or the end of file if absent).
 */
function parseOverview(
  lines: string[],
  bodyStart: number,
): { overview: string; todosStart: number } {
  const overviewHeader = findHeader(lines, bodyStart, 'OVERVIEW');
  const todosHeader = findHeader(lines, bodyStart, 'TODOS');

  // Overview text runs from just after the OVERVIEW header up to the TODOS
  // header (or end of file). When there is no OVERVIEW header the overview is
  // empty.
  let overview = '';
  if (overviewHeader !== -1) {
    const end = todosHeader !== -1 ? todosHeader : lines.length;
    const start = overviewHeader + 1;
    if (start < end) {
      overview = lines.slice(start, end).join('\n');
    }
  }

  const todosStart = todosHeader !== -1 ? todosHeader + 1 : lines.length;
  return { overview, todosStart };
}

/** Finds the index of a `# <NAME>` header line at or after `from`, else -1. */
function findHeader(lines: string[], from: number, name: string): number {
  for (let i = from; i < lines.length; i++) {
    if (isHeader(lines[i], name)) {
      return i;
    }
  }
  return -1;
}

/** Whether a line is a `# <NAME>` header (leading `#` marks, then the name). */
function isHeader(line: string, name: string): boolean {
  const m = /^#+\s+(.*)$/.exec(line);
  if (!m) {
    return false;
  }
  return m[1].trim() === name;
}

/**
 * Parses every `- [` line at or after `todosStart` into a {@link Todo}. Lines
 * that do not begin with `- [` are prose and are ignored here (Req 3.8); the
 * validator inspects malformed `- [` lines against the grammar.
 */
function parseTodos(lines: string[], todosStart: number): Todo[] {
  const todos: Todo[] = [];
  for (let i = todosStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- [')) {
      // Prose under the TODOS section is left unchanged (Req 3.8).
      continue;
    }
    const todo = parseTodoLine(line, i);
    if (todo) {
      todos.push(todo);
    }
  }
  return todos;
}

/**
 * Parses a single `- [<state>] <id> <title>` line. Returns undefined when the
 * line does not match the todo grammar (unknown state, missing/malformed id);
 * the validator reports those as located errors.
 */
function parseTodoLine(line: string, lineIndex: number): Todo | undefined {
  const m = TODO_PREFIX.exec(line);
  if (!m) {
    return undefined;
  }
  const stateText = m[1].trim();
  if (!isTodoState(stateText)) {
    return undefined;
  }
  const state = stateText;

  // Remainder after the state box: `<id> <title>`.
  const rest = m[2];
  const spaceIdx = rest.search(/\s/);
  const id = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (!TODO_ID.test(id)) {
    return undefined;
  }
  const afterId = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);

  const { title, after, files } = parseTitleAndHints(afterId);

  return { id, state, title, after, files, lineIndex };
}

/**
 * Splits the text after the id into a title and, when the line ends with a
 * parseable ` (<hints>)` group, the parsed `after`/`files` hints. When the
 * trailing group does not parse as hints it is retained as part of the title
 * (Req 3.7).
 */
function parseTitleAndHints(text: string): {
  title: string;
  after: string[];
  files: string[];
} {
  const trimmed = text.replace(/\s+$/, '');

  // A trailing hint group must be the last content on the line: `... (<hints>)`.
  if (!trimmed.endsWith(')')) {
    return { title: text.trim(), after: [], files: [] };
  }
  const open = trimmed.lastIndexOf('(');
  if (open === -1) {
    return { title: text.trim(), after: [], files: [] };
  }

  const inner = trimmed.slice(open + 1, trimmed.length - 1);
  const parsed = parseHints(inner);
  if (!parsed) {
    // Unparseable trailing parens stay in the title (Req 3.7).
    return { title: text.trim(), after: [], files: [] };
  }

  const title = trimmed.slice(0, open).trim();
  return { title, after: parsed.after, files: parsed.files };
}

/**
 * Parses the inside of a trailing paren group as `;`-separated hint groups
 * (Req 3.6). Recognizes an `after` group of comma-separated ids (Req 3.4) and a
 * `files:` group of comma-separated paths (Req 3.5). Returns undefined when any
 * group is unrecognized or empty, so the caller keeps the parens in the title.
 */
function parseHints(
  inner: string,
): { after: string[]; files: string[] } | undefined {
  const groups = inner.split(';');
  const after: string[] = [];
  const files: string[] = [];
  let sawAny = false;

  for (const rawGroup of groups) {
    const group = rawGroup.trim();
    if (group === '') {
      // An empty group (e.g. a trailing `;`) makes the whole thing non-hint.
      return undefined;
    }

    const afterItems = matchGroup(group, 'after');
    if (afterItems !== undefined) {
      const ids = splitList(afterItems);
      if (ids.length === 0 || !ids.every((id) => TODO_ID.test(id))) {
        return undefined;
      }
      after.push(...ids);
      sawAny = true;
      continue;
    }

    const filesItems = matchGroup(group, 'files');
    if (filesItems !== undefined) {
      const paths = splitList(filesItems);
      if (paths.length === 0) {
        return undefined;
      }
      files.push(...paths);
      sawAny = true;
      continue;
    }

    // Unrecognized hint group: the trailing parens are not hints.
    return undefined;
  }

  if (!sawAny) {
    return undefined;
  }
  return { after, files };
}

/**
 * If `group` is of the form `<keyword> <items>` or `<keyword>: <items>`,
 * returns the items text; otherwise undefined. The keyword match is
 * case-insensitive and must be a whole word.
 */
function matchGroup(group: string, keyword: string): string | undefined {
  const re = new RegExp(`^${keyword}\\s*:?\\s+(.*)$`, 'i');
  const m = re.exec(group);
  if (!m) {
    return undefined;
  }
  return m[1];
}

/** Splits a comma-separated list, trimming each item and dropping empties. */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
