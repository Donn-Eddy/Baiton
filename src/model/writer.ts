/**
 * Pure minimal-edit serializer (Requirement 6).
 *
 * This module is the single seam for edit-ownership. The Extension owns exactly
 * two kinds of bytes in a Spec_File: the lifecycle `[state]` box of each todo
 * line and the extension-managed frontmatter keys. Everything else — OVERVIEW
 * prose, todo titles, hints, ids and non-managed frontmatter keys — belongs to
 * the user or the Orchestrator and must never move (Req 6.1, 6.2).
 *
 * Both writers are pure `string -> Result<string, WriteError>` transforms.
 * `current` is the freshly re-read on-disk content; re-reading (and the
 * re-read-then-re-apply loop of Req 6.3, 6.4) is the caller's job. Each writer
 * locates the exact target, edits only that target, and leaves every other byte
 * identical. When the target cannot be located or parsed the writer aborts and
 * returns the original-preserving error so the caller can leave the file
 * unchanged and surface it (Req 6.5).
 *
 * `writeTodoState` additionally refuses to change a todo whose current state is
 * `done`: it leaves the state unchanged and reports a `done-protected` error so
 * the caller can display the warning that identifies that todo (Req 4.11).
 */
import { ManagedKey } from './managedKey';
import { parseSpec } from './parser';
import { Result, err, isOk, ok } from './result';
import { TodoState } from './todoState';

/**
 * Why a minimal edit could not be applied. Every variant means the write was
 * aborted and the file content must be left unchanged (Req 6.5). `kind`
 * discriminates the reason so callers can surface the right message:
 *
 * - `todo-not-found`   — no todo with the requested id parses in `current`.
 * - `key-not-found`    — the managed frontmatter key is not present in `current`.
 * - `done-protected`   — the target todo's current state is `done`; its state
 *                        is left unchanged and the caller warns (Req 4.11).
 */
export type WriteError =
  | { kind: 'todo-not-found'; todoId: string; message: string }
  | { kind: 'key-not-found'; key: ManagedKey; message: string }
  | { kind: 'done-protected'; todoId: string; message: string };

/** Matches the leading `- [<state>] ` box of a todo line, capturing the box. */
const STATE_BOX = /^(- )\[[^\]]*\]/;

/**
 * Applies the lifecycle state of the todo identified by `todoId` to the freshly
 * re-read content `current`, touching only that todo's `[state]` box and
 * leaving every other byte identical (Req 6.1).
 *
 * Aborts, returning the original-preserving {@link WriteError}, when:
 * - no todo with `todoId` can be located and parsed in `current`
 *   (`todo-not-found`, Req 6.5); or
 * - that todo's current state is `done` (`done-protected`, Req 4.11) — the
 *   state is left unchanged so the caller can warn and identify the todo.
 */
export function writeTodoState(
  current: string,
  todoId: string,
  state: TodoState,
): Result<string, WriteError> {
  const spec = parseSpec(current);
  const todo = spec.todos.find((t) => t.id === todoId);
  if (todo === undefined) {
    return err({
      kind: 'todo-not-found',
      todoId,
      message: `cannot write state: todo "${todoId}" was not found or did not parse`,
    });
  }

  // A `done` todo's state is frozen: leave it unchanged and let the caller warn
  // (Req 4.11). This applies even when the requested state equals `done`, so
  // the write is a strict no-op signalled as an abort.
  if (todo.state === 'done') {
    return err({
      kind: 'done-protected',
      todoId,
      message: `todo "${todoId}" is done; its state was left unchanged`,
    });
  }

  const lines = splitPreservingLineCount(current);
  const line = lines[todo.lineIndex];
  // Guard the raw line still carries the box we parsed. `parseSpec` only yields
  // a todo when its line began with `- [<state>]`, so this should always match;
  // if it somehow does not, abort rather than corrupt the line (Req 6.5).
  if (line === undefined || !STATE_BOX.test(line)) {
    return err({
      kind: 'todo-not-found',
      todoId,
      message: `cannot write state: todo "${todoId}" line could not be located`,
    });
  }

  // Replace only the state box; the id, title and hints after it are untouched.
  lines[todo.lineIndex] = line.replace(STATE_BOX, `$1[${state}]`);
  return ok(joinPreservingLineCount(current, lines));
}

/**
 * Writes `value` to the extension-managed frontmatter key `key` in the freshly
 * re-read content `current`, touching only that key's value and leaving every
 * other byte identical (Req 6.1).
 *
 * The key must already exist inside a `---`-fenced frontmatter block; this
 * writer updates a managed key in place and does not create new keys or a
 * frontmatter block. It aborts with a `key-not-found` {@link WriteError} when
 * the key line cannot be located, so the caller leaves the file unchanged and
 * surfaces the error (Req 6.5).
 */
export function writeFrontmatterKey(
  current: string,
  key: ManagedKey,
  value: string,
): Result<string, WriteError> {
  const lines = splitPreservingLineCount(current);
  const keyLine = findFrontmatterKeyLine(lines, key);
  if (keyLine === -1) {
    return err({
      kind: 'key-not-found',
      key,
      message: `cannot write frontmatter: managed key "${key}" was not found`,
    });
  }

  // Rewrite only the value, preserving the original key text and the exact
  // spacing between the key, its colon and the value start. When the key had no
  // value yet (nothing but the colon, e.g. `branch:`), insert a single space so
  // the result reads `key: value` rather than gluing the value to the colon.
  const line = lines[keyLine];
  const sep = line.indexOf(':');
  const prefix = line.slice(0, sep + 1);
  const afterColon = line.slice(sep + 1);
  const existingWs = /^\s*/.exec(afterColon)?.[0] ?? '';
  const leadingWs = existingWs === '' ? ' ' : existingWs;
  lines[keyLine] = `${prefix}${leadingWs}${value}`;
  return ok(joinPreservingLineCount(current, lines));
}

/**
 * Finds the raw line index of a managed frontmatter key inside the leading
 * `---`-fenced block, or -1 when there is no such block or the key is absent.
 * Scans only within the fence so a `key:` appearing later in prose is never
 * mistaken for frontmatter, matching the parser's frontmatter shape (Req 3.1).
 */
function findFrontmatterKeyLine(lines: string[], key: ManagedKey): number {
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return -1;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      // Reached the closing fence without finding the key.
      return -1;
    }
    const sep = lines[i].indexOf(':');
    if (sep === -1) {
      continue;
    }
    if (lines[i].slice(0, sep).trim() === key) {
      return i;
    }
  }
  return -1;
}

/**
 * Splits content into lines the same way the parser does (on `\n`), so line
 * indices line up with {@link parseSpec}'s `rawLines` and {@link Todo.lineIndex}.
 */
function splitPreservingLineCount(content: string): string[] {
  return content.split('\n');
}

/**
 * Rejoins edited lines with `\n`. Because the split/join pair is the exact
 * inverse used by the parser, every unedited line — including trailing newlines
 * and blank lines — is reproduced byte-for-byte (Req 6.1). `original` is
 * accepted for symmetry and future line-ending handling; the current model
 * treats `\n` as the sole separator.
 */
function joinPreservingLineCount(_original: string, lines: string[]): string {
  return lines.join('\n');
}

/**
 * Upsert an extension-managed frontmatter key: rewrite the value in place when
 * the key line exists (via {@link writeFrontmatterKey}), otherwise insert a
 * `key: value` line just before the closing fence, creating a frontmatter
 * block at the top when there is none. Used by approval and the PR stage,
 * which set keys a hand-written spec may not carry.
 */
export function setFrontmatterKey(
  content: string,
  key: ManagedKey,
  value: string,
): string {
  const written = writeFrontmatterKey(content, key, value);
  if (isOk(written)) {
    return written.value;
  }
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return ['---', `${key}: ${value}`, '---', '', ...lines].join('\n');
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      lines.splice(i, 0, `${key}: ${value}`);
      return lines.join('\n');
    }
  }
  lines.splice(1, 0, `${key}: ${value}`);
  return lines.join('\n');
}
