/**
 * Pure spec-file validator (Requirement 4).
 *
 * Runs over the parsed model plus the raw text and reports every structural
 * problem as a located {@link SpecError}: grammar failures on `- [` lines,
 * duplicate ids, unknown states, missing or self `after` targets, dependency
 * cycles (naming the ids that form them), and merge-conflict markers anywhere
 * in the file. An empty array means the spec is valid. The validator NEVER
 * mutates the spec — it only reports (Req 4.2) — and, like the parser, never
 * throws.
 */
import { ParsedSpec, Todo } from './parser';
import { TODO_STATES, isTodoState } from './todoState';

/**
 * One located validation problem. `line` is the 1-based line number of the
 * offending line in the raw spec text, `text` is that line's content, and
 * `reason` explains why it failed.
 */
export interface SpecError {
  /** 1-based line number of the offending line. */
  line: number;
  /** The raw text of the offending line. */
  text: string;
  /** Human-readable explanation of the failure. */
  reason: string;
}

/** A todo id is the character `T` followed by two or more decimal digits (Req 3.3). */
const TODO_ID = /^T\d{2,}$/;

/** Leading `- [<state>] ` prefix of a todo line (Req 3.2), same shape as the parser. */
const TODO_PREFIX = /^- \[([^\]]*)\]\s+(.*)$/;

/**
 * Merge-conflict markers, matched at the start of a line (Req 4.8). Covers the
 * three git markers `<<<<<<<`, `=======` and `>>>>>>>`.
 */
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];

/**
 * Validates a parsed spec against its raw text. Returns a list of located
 * errors; an empty list means the spec is valid (Req 4.9). The spec text is
 * never changed by this function (Req 4.2).
 */
export function validateSpec(spec: ParsedSpec, raw: string): SpecError[] {
  const rawLines = raw.split('\n');
  const errors: SpecError[] = [];

  // Merge-conflict markers on any line of the file (Req 4.8). Reported first so
  // their line numbers surface even when the rest of the file is well-formed.
  errors.push(...findConflictMarkers(rawLines));

  // Grammar failures on `- [` lines the parser could not turn into a todo
  // (Req 4.1, 4.2, 4.4).
  errors.push(...findGrammarErrors(spec, rawLines));

  // Duplicate ids across the parsed todos (Req 4.3).
  errors.push(...findDuplicateIds(spec.todos));

  // Dependency errors: missing targets and self-references (Req 4.5, 4.6).
  errors.push(...findDependencyErrors(spec.todos));

  // Dependency cycles, naming the participating ids (Req 4.7).
  errors.push(...findCycleErrors(spec.todos));

  return errors;
}

/**
 * Scans every line for a leading merge-conflict marker and reports one error
 * per marked line with its 1-based line number (Req 4.8).
 */
function findConflictMarkers(rawLines: string[]): SpecError[] {
  const errors: SpecError[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const marker = CONFLICT_MARKERS.find((m) => line.startsWith(m));
    if (marker) {
      errors.push({
        line: i + 1,
        text: line,
        reason: `merge-conflict marker "${marker}" found`,
      });
    }
  }
  return errors;
}

/**
 * Finds `- [` lines that do not parse against the todo grammar. The parser
 * silently drops such lines, so this re-examines each raw `- [` line to report
 * a specific reason: a malformed grammar, an unknown state, or a malformed id
 * (Req 4.1, 4.2, 4.4).
 */
function findGrammarErrors(spec: ParsedSpec, rawLines: string[]): SpecError[] {
  const errors: SpecError[] = [];

  // Line indices the parser already recognized as valid todos; those need no
  // grammar re-check.
  const parsedLines = new Set(spec.todos.map((t) => t.lineIndex));

  const todosStart = findTodosStart(rawLines);
  if (todosStart === -1) {
    return errors;
  }

  for (let i = todosStart; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.startsWith('- [') || parsedLines.has(i)) {
      continue;
    }
    errors.push({
      line: i + 1,
      text: line,
      reason: grammarFailureReason(line),
    });
  }
  return errors;
}

/**
 * Explains why a `- [` line failed the todo grammar. Distinguishes an unknown
 * state (Req 4.4) from a general grammar failure (Req 4.2) and a malformed id.
 */
function grammarFailureReason(line: string): string {
  const m = TODO_PREFIX.exec(line);
  if (!m) {
    return 'malformed todo line: expected "- [<state>] <id> <title>"';
  }

  const stateText = m[1].trim();
  if (!isTodoState(stateText)) {
    return `unknown state "${stateText}"; expected one of ${TODO_STATES.join(', ')}`;
  }

  const rest = m[2];
  const spaceIdx = rest.search(/\s/);
  const id = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (!TODO_ID.test(id)) {
    return `malformed id "${id}"; expected "T" followed by two or more digits`;
  }

  return 'malformed todo line: expected "- [<state>] <id> <title>"';
}

/**
 * Reports every todo id that appears on more than one todo line. Each
 * duplicated occurrence after the first is located so the user sees the id and
 * its line (Req 4.3).
 */
function findDuplicateIds(todos: Todo[]): SpecError[] {
  const errors: SpecError[] = [];
  const seen = new Map<string, Todo>();

  for (const todo of todos) {
    if (seen.has(todo.id)) {
      errors.push({
        line: todo.lineIndex + 1,
        text: renderTodoRef(todo),
        reason: `duplicate id "${todo.id}"`,
      });
    } else {
      seen.set(todo.id, todo);
    }
  }
  return errors;
}

/**
 * Reports `after` references to ids that no todo declares (Req 4.5) and todos
 * that list their own id in `after` (Req 4.6). Both are located on the
 * referencing todo's line.
 */
function findDependencyErrors(todos: Todo[]): SpecError[] {
  const errors: SpecError[] = [];
  const knownIds = new Set(todos.map((t) => t.id));

  for (const todo of todos) {
    for (const dep of todo.after) {
      if (dep === todo.id) {
        errors.push({
          line: todo.lineIndex + 1,
          text: renderTodoRef(todo),
          reason: `todo "${todo.id}" lists itself in its "after" dependencies`,
        });
        continue;
      }
      if (!knownIds.has(dep)) {
        errors.push({
          line: todo.lineIndex + 1,
          text: renderTodoRef(todo),
          reason: `todo "${todo.id}" depends on unknown id "${dep}"`,
        });
      }
    }
  }
  return errors;
}

/**
 * Detects cycles in the dependency graph formed by `after` references and
 * reports the ids forming each cycle (Req 4.7). Self-references are handled by
 * {@link findDependencyErrors} and are excluded here so a self-loop is not also
 * reported as a cycle. Edges to unknown ids are ignored (they are already
 * reported as missing dependencies).
 */
function findCycleErrors(todos: Todo[]): SpecError[] {
  const byId = new Map<string, Todo>();
  for (const todo of todos) {
    // On a duplicate id, keep the first declaration for graph purposes; the
    // duplicate is reported separately.
    if (!byId.has(todo.id)) {
      byId.set(todo.id, todo);
    }
  }

  // Adjacency limited to real, non-self edges between known todos.
  const adjacency = new Map<string, string[]>();
  for (const todo of byId.values()) {
    const edges = todo.after.filter(
      (dep) => dep !== todo.id && byId.has(dep),
    );
    adjacency.set(todo.id, edges);
  }

  const cycles = findCycles(adjacency);
  return cycles.map((cycle) => {
    const start = byId.get(cycle[0]);
    return {
      line: start ? start.lineIndex + 1 : 1,
      text: start ? renderTodoRef(start) : cycle.join(' -> '),
      reason: `dependency cycle: ${cycle.join(' -> ')}`,
    };
  });
}

/**
 * Finds distinct cycles in a directed graph via depth-first search, returning
 * for each the list of node ids that form it in traversal order. Each cycle is
 * reported once, keyed by its normalized set of members.
 */
function findCycles(adjacency: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const reported = new Set<string>();

  const WHITE = 0; // unvisited
  const GRAY = 1; // on the current DFS stack
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) {
    color.set(id, WHITE);
  }

  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Back edge: the cycle is the stack slice from `next` to the top.
        const idx = stack.indexOf(next);
        if (idx !== -1) {
          const cycle = stack.slice(idx);
          const key = cycleKey(cycle);
          if (!reported.has(key)) {
            reported.add(key);
            cycles.push(cycle);
          }
        }
      } else if (c === WHITE) {
        visit(next);
      }
    }

    stack.pop();
    color.set(node, BLACK);
  };

  for (const id of adjacency.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      visit(id);
    }
  }

  return cycles;
}

/**
 * A stable key identifying a cycle by its members regardless of the rotation at
 * which it was discovered, so the same cycle reached from two entry points is
 * reported once.
 */
function cycleKey(cycle: string[]): string {
  return [...cycle].sort().join('\u0000');
}

/** Finds the index of the `# TODOS` header line, or -1 when absent. */
function findTodosStart(rawLines: string[]): number {
  for (let i = 0; i < rawLines.length; i++) {
    const m = /^#+\s+(.*)$/.exec(rawLines[i]);
    if (m && m[1].trim() === 'TODOS') {
      return i + 1;
    }
  }
  return -1;
}

/** Renders a short reference to a todo for an error's `text` field. */
function renderTodoRef(todo: Todo): string {
  return `- [${todo.state}] ${todo.id} ${todo.title}`.trimEnd();
}
