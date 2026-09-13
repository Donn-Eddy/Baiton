/**
 * Derived blocked status and the content hashes (Requirements 4.10, 5.1, 18.5).
 *
 * These are pure functions over a {@link ParsedSpec}. `isBlocked` derives a
 * todo's blocked status from its `after` targets and is NEVER written back into
 * the spec file (Req 4.10). `approvalHash` and `computeInputRev` produce stable
 * SHA-256 digests over spec content: the approval hash ties approval to the
 * OVERVIEW plus every todo line with its state box blanked (Req 5.1), and the
 * input rev ties a plan to the OVERVIEW plus a single todo's line (Req 18.5,
 * the Input_Rev definition).
 */
import { createHash } from 'crypto';
import { ParsedSpec, Todo } from './parser';

/**
 * Whether a todo is blocked: true if and only if at least one of its `after`
 * targets is in a state other than `done` (Req 4.10). An `after` id with no
 * matching todo in `all` is treated as not-done and therefore blocking, since
 * an unmet/unknown dependency cannot be considered complete.
 *
 * This status is derived on demand and is never persisted into the spec file.
 */
export function isBlocked(todo: Todo, all: Todo[]): boolean {
  if (todo.after.length === 0) {
    return false;
  }
  const byId = new Map<string, Todo>();
  for (const t of all) {
    byId.set(t.id, t);
  }
  return todo.after.some((depId) => {
    const dep = byId.get(depId);
    return dep === undefined || dep.state !== 'done';
  });
}

/**
 * The Approval_Hash: a SHA-256 over the OVERVIEW section combined with every
 * todo line whose state box has been blanked to `[]`, excluding all other
 * frontmatter and prose (Req 5.1). Blanking the state box makes the hash
 * invariant under lifecycle state changes while remaining sensitive to the
 * OVERVIEW text and to any todo title, id or hints (design Property 7).
 */
export function approvalHash(spec: ParsedSpec): string {
  const blankedTodoLines = spec.todos.map((todo) =>
    blankStateBox(spec.rawLines[todo.lineIndex]),
  );
  return sha256(hashPayload(spec.overview, blankedTodoLines));
}

/**
 * The Input_Rev for a single todo: a SHA-256 over the OVERVIEW section combined
 * with that todo's line (Req 18.5 / the Input_Rev definition). The state box is
 * blanked so the rev is stable across the state transitions that occur between
 * recording a plan and requesting Execute, while still tracking changes to the
 * OVERVIEW or to the todo's own title, id or hints.
 *
 * Returns the empty string when no todo with `todoId` exists in the spec.
 */
export function computeInputRev(spec: ParsedSpec, todoId: string): string {
  const todo = spec.todos.find((t) => t.id === todoId);
  if (todo === undefined) {
    return '';
  }
  const blankedLine = blankStateBox(spec.rawLines[todo.lineIndex]);
  return sha256(hashPayload(spec.overview, [blankedLine]));
}

/**
 * Replaces the first `[<state>]` box on a todo line with an empty `[]` box,
 * leaving the rest of the line untouched. Applied to the raw on-disk line so
 * the hash reflects the exact user-owned content minus the lifecycle state.
 */
function blankStateBox(line: string): string {
  return line.replace(/^(- )\[[^\]]*\]/, '$1[]');
}

/**
 * Builds the canonical byte payload for a content hash. The OVERVIEW and each
 * todo line are joined with a newline separator so that reordering or moving
 * content between the two sections cannot collide.
 */
function hashPayload(overview: string, todoLines: string[]): string {
  return [overview, ...todoLines].join('\n');
}

/** Hex-encoded SHA-256 digest of a UTF-8 string. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
