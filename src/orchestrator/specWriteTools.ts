/**
 * The orchestrator's spec-writing tools (Requirements 9.5–9.10, 17.1, 23.5).
 *
 * The orchestrator refines spec files through these tools and never edits
 * source (Req 8.1). All four are mutating, so the guard requires an
 * idempotency key, replays a seen key unchanged, and disables them under
 * Restricted Mode; each resolves its target through
 * {@link GuardContext.resolveMutatingPath} so the write can only land under
 * `.baiton/specs/` (Req 8.1, 8.2).
 *
 * The spec file itself is no longer written here: the `draft_spec` control tool
 * hands the requirements to the spec-writer harness, which drafts the OVERVIEW
 * and todo list, and {@link renderSpec}/{@link writeAndCommit} (exported for
 * that runner) render and commit the result. These tools refine the spec after
 * the draft lands.
 *
 * - `update_overview(slug, text)` rewrites the OVERVIEW section, leaving
 *   frontmatter and todos untouched.
 * - `add_todo` / `edit_todo` / `remove_todo` change exactly one todo line and
 *   never take a todo state as an argument (Req 9.6, 9.7). `edit_todo` and
 *   `remove_todo` refuse a todo whose state is `done`, `failed`, or a running
 *   state (`planning`/`executing`/`reviewing`) (Req 9.8).
 *
 * Every write under the spec folder is committed on the spec branch as
 * `spec(<slug>): <id> <what>` before any subsequent stage, using the git
 * service seam (Req 17.1). A todo-scoped write uses that todo's id; a
 * spec-scoped write (draft/overview) uses the slug as the `<id>` field.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseSpec } from '../model/parser';
import { TodoState } from '../model/todoState';
import { Tool, ToolContext, ToolResult } from './guard';
import { ToolServices } from './toolServices';

/** The states a todo cannot be edited or removed from (Req 9.8). */
const PROTECTED_STATES: ReadonlySet<TodoState> = new Set<TodoState>([
  'done',
  'failed',
  'planning',
  'executing',
  'reviewing',
]);

/** A todo id is `T` followed by two or more decimal digits (Req 3.3). */
const TODO_ID = /^T\d{2,}$/;

/** Build every spec-writing tool for the registry. */
export function createSpecWriteTools(services: ToolServices): Tool[] {
  return [
    updateOverviewTool(services),
    addTodoTool(services),
    editTodoTool(services),
    removeTodoTool(services),
  ];
}

/**
 * `update_overview(slug, text)` — replace the OVERVIEW section body with `text`,
 * leaving frontmatter and every todo line unchanged.
 */
function updateOverviewTool(services: ToolServices): Tool {
  return {
    name: 'update_overview',
    description: "Rewrite a spec's OVERVIEW section, leaving frontmatter and todos untouched.",
    mutating: true,
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' }, text: { type: 'string' } },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const text = readString(args, 'text');
      if (slug === undefined || text === undefined) {
        return { ok: false, error: 'update_overview requires a string "slug" and a string "text"' };
      }
      const loaded = await loadSpecForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const rewritten = replaceOverview(loaded.content, text);
      if (rewritten === undefined) {
        return { ok: false, error: `spec "${slug}" has no OVERVIEW/TODOS structure to update` };
      }
      const write = await writeAndCommit(services, loaded.absolute, rewritten, slug, slug, 'update overview');
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, commit: write.commit } };
    },
  };
}

/**
 * `add_todo(slug, id, title, after?, files?)` — append a new `pending` todo line.
 * A state is never accepted (Req 9.7); the todo is created `pending`. The id
 * must be a fresh `T##` not already present in the spec.
 */
function addTodoTool(services: ToolServices): Tool {
  return {
    name: 'add_todo',
    description: 'Append a new pending todo line to a spec with an id, title and optional hints.',
    mutating: true,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        after: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['slug', 'id', 'title'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      const title = readString(args, 'title');
      const after = readStringArray(args, 'after') ?? [];
      const files = readStringArray(args, 'files') ?? [];
      if (slug === undefined || id === undefined || title === undefined) {
        return { ok: false, error: 'add_todo requires a string "slug", "id", and "title"' };
      }
      if (!TODO_ID.test(id)) {
        return { ok: false, error: `add_todo "id" must be "T" followed by two or more digits: ${id}` };
      }
      const loaded = await loadSpecForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const spec = parseSpec(loaded.content);
      if (spec.todos.some((t) => t.id === id)) {
        return { ok: false, error: `add_todo: todo "${id}" already exists in spec "${slug}"` };
      }
      const line = renderTodoLine('pending', id, title, after, files);
      const updated = appendTodoLine(loaded.content, line);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `add ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * `edit_todo(slug, id, title?, after?, files?)` — rewrite a todo's title and/or
 * hints, preserving its existing state (a state is never an argument, Req 9.7).
 * Refuses when the todo is in a protected state (Req 9.8).
 */
function editTodoTool(services: ToolServices): Tool {
  return {
    name: 'edit_todo',
    description: "Rewrite a todo's title and hints, preserving its state; refuses protected states.",
    mutating: true,
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        after: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['slug', 'id'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      if (slug === undefined || id === undefined) {
        return { ok: false, error: 'edit_todo requires a string "slug" and "id"' };
      }
      const loaded = await loadSpecForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const spec = parseSpec(loaded.content);
      const todo = spec.todos.find((t) => t.id === id);
      if (todo === undefined) {
        return { ok: false, error: `edit_todo: todo "${id}" was not found in spec "${slug}"` };
      }
      if (PROTECTED_STATES.has(todo.state)) {
        return {
          ok: false,
          error: `edit_todo refused: todo "${id}" is in a protected state (${todo.state})`,
        };
      }

      const title = readString(args, 'title') ?? todo.title;
      const after = readStringArray(args, 'after') ?? todo.after;
      const files = readStringArray(args, 'files') ?? todo.files;
      // Preserve the existing state; only the title and hints may change.
      const newLine = renderTodoLine(todo.state, id, title, after, files);
      const updated = replaceLine(loaded.content, todo.lineIndex, newLine);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `edit ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * `remove_todo(slug, id)` — delete a todo line. Refuses when the todo is in a
 * protected state (Req 9.8).
 */
function removeTodoTool(services: ToolServices): Tool {
  return {
    name: 'remove_todo',
    description: 'Delete a todo line from a spec; refuses when the todo is in a protected state.',
    mutating: true,
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' }, id: { type: 'string' } },
      required: ['slug', 'id'],
      additionalProperties: false,
    },
    async run(args: unknown, tc: ToolContext): Promise<ToolResult> {
      const slug = readString(args, 'slug');
      const id = readString(args, 'id');
      if (slug === undefined || id === undefined) {
        return { ok: false, error: 'remove_todo requires a string "slug" and "id"' };
      }
      const loaded = await loadSpecForWrite(services, slug, tc);
      if (!loaded.ok) {
        return loaded.error;
      }
      const spec = parseSpec(loaded.content);
      const todo = spec.todos.find((t) => t.id === id);
      if (todo === undefined) {
        return { ok: false, error: `remove_todo: todo "${id}" was not found in spec "${slug}"` };
      }
      if (PROTECTED_STATES.has(todo.state)) {
        return {
          ok: false,
          error: `remove_todo refused: todo "${id}" is in a protected state (${todo.state})`,
        };
      }
      const updated = deleteLine(loaded.content, todo.lineIndex);
      const write = await writeAndCommit(services, loaded.absolute, updated, slug, id, `remove ${id}`);
      if (!write.ok) {
        return write;
      }
      return { ok: true, data: { slug, id, commit: write.commit } };
    },
  };
}

/**
 * Load a spec's on-disk content for a mutating write, resolving containment
 * through the guard first (Req 8.1, 8.2) and re-reading the current bytes so
 * the edit applies to the latest content (Req 6.3). Returns a discriminated
 * result carrying the absolute path and content on success, or a
 * {@link ToolResult} error to return directly.
 */
async function loadSpecForWrite(
  services: ToolServices,
  slug: string,
  tc: ToolContext,
): Promise<
  | { ok: true; absolute: string; content: string }
  | { ok: false; error: ToolResult }
> {
  if (!isSlug(slug)) {
    return { ok: false, error: { ok: false, error: `invalid slug: ${slug}` } };
  }
  const specFile = specPath(services, slug);
  const resolved = await tc.ctx.resolveMutatingPath(specFile);
  if (!resolved.ok) {
    return { ok: false, error: { ok: false, error: resolved.error.message } };
  }
  let content: string;
  try {
    content = await fs.readFile(resolved.resolved, 'utf8');
  } catch {
    return { ok: false, error: { ok: false, error: `spec "${slug}" was not found` } };
  }
  return { ok: true, absolute: resolved.resolved, content };
}

/**
 * Write `content` to the spec file and commit it on the spec branch as
 * `spec(<slug>): <id> <what>` before any subsequent stage (Req 17.1). Returns
 * the new commit sha on success, or a {@link ToolResult} error preserving the
 * failure. The parent directory is created for a fresh spec.
 *
 * Exported so the spec-draft runner commits the spec it renders through the
 * same path, with the same message shape, as every other spec-folder write.
 */
export async function writeAndCommit(
  services: ToolServices,
  absolute: string,
  content: string,
  slug: string,
  id: string,
  what: string,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  } catch (e) {
    return { ok: false, error: `failed to write spec file: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const commit = await services.git.commit(`spec(${slug}): ${id} ${what}`);
    return { ok: true, commit };
  } catch (e) {
    return { ok: false, error: gitCommitErrorMessage(e) };
  }
}

/**
 * One todo {@link renderSpec} can lay down: either a bare title, or a title
 * with the dependency positions and starting files the spec writer proposed.
 * `after` entries are 1-based positions in this same list — the writer does not
 * assign ids, so {@link renderSpec} maps each position to the `T##` id it
 * assigned to that position.
 */
export interface RenderSpecTodo {
  title: string;
  after?: string[];
  files?: string[];
}

/**
 * Render the full text of a new `spec.md` (Req 9.5, 23.5).
 *
 * Ids are assigned sequentially `T01`, `T02`, ... in list order and every todo
 * starts `pending` (a state is never supplied, Req 9.7). A todo's `after`
 * positions are translated into the ids assigned to those positions; a position
 * that is not an integer in range, or that does not name an *earlier* todo, is
 * dropped rather than emitted as a dangling dependency.
 */
export function renderSpec(
  slug: string,
  overview: string,
  todos: readonly (string | RenderSpecTodo)[],
): string {
  const entries: RenderSpecTodo[] = todos.map((t) =>
    typeof t === 'string' ? { title: t } : t,
  );
  const idFor = (index: number): string => `T${String(index + 1).padStart(2, '0')}`;

  const lines: string[] = [];
  lines.push('---');
  lines.push('version: 1');
  lines.push(`name: ${slug}`);
  lines.push('status: draft');
  lines.push('mode: manual');
  lines.push('base:');
  lines.push('base_commit:');
  lines.push('branch:');
  lines.push('approved_rev:');
  lines.push('---');
  lines.push('');
  lines.push('# OVERVIEW');
  lines.push('');
  lines.push(overview.replace(/\s+$/, ''));
  lines.push('');
  lines.push('# TODOS');
  lines.push('');
  entries.forEach((todo, i) => {
    const after = resolveAfter(todo.after ?? [], i, idFor);
    const files = (todo.files ?? []).filter((f) => f.trim().length > 0);
    lines.push(renderTodoLine('pending', idFor(i), todo.title, after, files));
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * Translate 1-based dependency positions into the ids assigned to them,
 * dropping anything that is not an integer position strictly earlier in the
 * list (a self- or forward-reference would make the spec invalid).
 */
function resolveAfter(
  positions: readonly string[],
  index: number,
  idFor: (i: number) => string,
): string[] {
  const out: string[] = [];
  for (const raw of positions) {
    const position = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(position) || position < 1 || position > index) {
      continue;
    }
    const id = idFor(position - 1);
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** Render a single `- [<state>] <id> <title>` line with optional hints. */
function renderTodoLine(
  state: TodoState,
  id: string,
  title: string,
  after: string[],
  files: string[],
): string {
  const groups: string[] = [];
  if (after.length > 0) {
    groups.push(`after ${after.join(', ')}`);
  }
  if (files.length > 0) {
    groups.push(`files: ${files.join(', ')}`);
  }
  const hint = groups.length > 0 ? ` (${groups.join('; ')})` : '';
  return `- [${state}] ${id} ${title.trim()}${hint}`;
}

/**
 * Replace the OVERVIEW section body (between `# OVERVIEW` and the next header)
 * with `text`, leaving frontmatter, the header lines and the TODOS section
 * untouched. Returns undefined when there is no OVERVIEW header to update.
 */
function replaceOverview(content: string, text: string): string | undefined {
  const lines = content.split('\n');
  const overviewIdx = lines.findIndex((l) => isHeader(l, 'OVERVIEW'));
  if (overviewIdx === -1) {
    return undefined;
  }
  // The section body runs until the next `#` header (typically `# TODOS`).
  let end = lines.length;
  for (let i = overviewIdx + 1; i < lines.length; i++) {
    if (/^#+\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = text.replace(/\s+$/, '');
  const rebuilt = [
    ...lines.slice(0, overviewIdx + 1),
    '',
    body,
    '',
    ...lines.slice(end),
  ];
  return rebuilt.join('\n');
}

/** Append a todo line at the end of the TODOS section. */
function appendTodoLine(content: string, todoLine: string): string {
  const lines = content.split('\n');
  const todosIdx = lines.findIndex((l) => isHeader(l, 'TODOS'));
  if (todosIdx === -1) {
    // No TODOS section: append a header and the line at the end.
    return `${content.replace(/\s+$/, '')}\n\n# TODOS\n\n${todoLine}\n`;
  }
  // Insert after the last existing todo/content line within the section, before
  // any trailing blank lines at end of file.
  let insertAt = lines.length;
  while (insertAt > todosIdx + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, todoLine);
  return lines.join('\n');
}

/** Replace a single line by index. */
function replaceLine(content: string, lineIndex: number, newLine: string): string {
  const lines = content.split('\n');
  lines[lineIndex] = newLine;
  return lines.join('\n');
}

/** Delete a single line by index. */
function deleteLine(content: string, lineIndex: number): string {
  const lines = content.split('\n');
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

/** Whether a line is a `# <NAME>` header. */
function isHeader(line: string, name: string): boolean {
  const m = /^#+\s+(.*)$/.exec(line);
  return m !== null && m[1].trim() === name;
}

/** The absolute path of a spec's `spec.md`. */
function specPath(services: ToolServices, slug: string): string {
  return path.join(services.baitonDir, 'specs', slug, 'spec.md');
}

/** A slug is a simple directory-safe name (no separators or traversal). */
function isSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

/** Read a required string field from an args object, or undefined. */
function readString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a string-array field, or undefined when absent/invalid. */
function readStringArray(args: unknown, key: string): string[] | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}

/** Render a caught git commit error into a user-facing message. */
function gitCommitErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const ge = e as { command: string; stderr?: string };
    return `commit failed: ${ge.command}${ge.stderr ? `\n${ge.stderr}` : ''}`;
  }
  return `commit failed: ${e instanceof Error ? e.message : String(e)}`;
}
