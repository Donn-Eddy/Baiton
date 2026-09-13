/**
 * The `fs`/serializer/git-backed {@link SpecStore} (task 15.2; design "Stage
 * engine", "Spec model").
 *
 * The run queue and crash recovery read approval / blocked / input-rev facts
 * and apply lifecycle state writes through this seam. The store keeps the queue
 * free of `fs`, the serializer, and git by owning all three here:
 *
 *   - Reads (`currentState`, `isApproved`, `isBlocked`, `inputRev`,
 *     `inputRevMatches`) re-read the spec's `spec.md` fresh each call and use
 *     the pure {@link parseSpec} / {@link approvalHash} / {@link computeInputRev}
 *     cores so no cached copy is trusted (Req 6.3).
 *   - `writeState` applies the minimal state-box edit via {@link writeTodoState}
 *     to freshly re-read content, writes it back, and commits the change on the
 *     spec branch as `spec(<slug>): <id> <what>` before the next stage
 *     (Req 6.1, 6.3, 17.1). It resolves `false` when the serializer aborts (the
 *     target could not be located) so the queue surfaces a `spec-write-failed`
 *     refusal and leaves state unchanged (Req 6.5).
 *
 * Approval is true iff the spec's `approved_rev` byte-equals the current
 * Approval_Hash and is non-empty (Req 5.3, 5.4). Input-rev match compares the
 * plan's recorded Input_Rev — journaled at the todo's most recent plan start
 * (Req 21.1) — against the current Input_Rev; with no recorded plan rev there is
 * nothing to invalidate, so it matches (Req 18.9).
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { approvalHash, computeInputRev } from '../model/hash';
import { parseSpec } from '../model/parser';
import { isBlocked as deriveBlocked } from '../model/hash';
import { writeTodoState } from '../model/writer';
import { isErr } from '../model/result';
import type { TodoState } from '../model/todoState';
import type { GitService } from '../git';
import type { SpecStore } from '../engine';
import { parseJournal } from '../journal';

/**
 * Build a {@link SpecStore} rooted at a repository's `.baiton/specs/` directory,
 * committing state writes through the injected git service.
 *
 * @param specsDir absolute `.baiton/specs/` directory.
 * @param git      the git seam used to commit each state write (Req 17.1).
 */
export function createSpecStore(
  specsDir: string,
  git: GitService,
): SpecStore {
  const specPath = (slug: string): string =>
    path.join(specsDir, slug, 'spec.md');
  const journalPath = (slug: string): string =>
    path.join(specsDir, slug, 'runs.jsonl');

  /** Re-read and parse a spec's `spec.md`, or `undefined` when unreadable. */
  const readSpec = async (
    slug: string,
  ): Promise<ReturnType<typeof parseSpec> | undefined> => {
    try {
      const raw = await fsp.readFile(specPath(slug), 'utf8');
      return parseSpec(raw);
    } catch {
      return undefined;
    }
  };

  return {
    async currentState(slug, todoId): Promise<TodoState | undefined> {
      const spec = await readSpec(slug);
      return spec?.todos.find((t) => t.id === todoId)?.state;
    },

    async isApproved(slug): Promise<boolean> {
      const spec = await readSpec(slug);
      if (spec === undefined) {
        return false;
      }
      const recorded = (spec.frontmatter.get('approved_rev') ?? '').trim();
      if (recorded === '') {
        return false;
      }
      return recorded === approvalHash(spec);
    },

    async isBlocked(slug, todoId): Promise<boolean> {
      const spec = await readSpec(slug);
      if (spec === undefined) {
        return false;
      }
      const todo = spec.todos.find((t) => t.id === todoId);
      if (todo === undefined) {
        return false;
      }
      return deriveBlocked(todo, spec.todos);
    },

    async inputRev(slug, todoId): Promise<string> {
      const spec = await readSpec(slug);
      return spec === undefined ? '' : computeInputRev(spec, todoId);
    },

    async inputRevMatches(slug, todoId): Promise<boolean> {
      const spec = await readSpec(slug);
      if (spec === undefined) {
        return false;
      }
      const current = computeInputRev(spec, todoId);
      const recorded = recordedPlanInputRev(journalPath(slug), todoId);
      // No recorded plan rev: nothing to invalidate against, so it matches.
      return recorded === undefined || recorded === current;
    },

    async writeState(slug, todoId, state, note): Promise<boolean> {
      let current: string;
      try {
        current = await fsp.readFile(specPath(slug), 'utf8');
      } catch {
        return false;
      }
      const written = writeTodoState(current, todoId, state);
      if (isErr(written)) {
        return false;
      }
      if (written.value === current) {
        // The serializer left the file unchanged (e.g. a `done`-line edit path
        // or an already-current state): nothing to commit (Req 4.11, 6.5).
        return false;
      }
      try {
        await fsp.writeFile(specPath(slug), written.value, 'utf8');
        await git.commit(`spec(${slug}): ${todoId} ${what(state, note)}`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The Input_Rev recorded at the todo's most recent plan start, or `undefined`
 * when the journal records no plan run for the todo (Req 18.9, 21.1).
 */
function recordedPlanInputRev(
  journalFile: string,
  todoId: string,
): string | undefined {
  let latest: string | undefined;
  for (const entry of parseJournal(journalFile)) {
    if (entry.stage === 'plan' && entry.todoId === todoId) {
      latest = entry.inputRev;
    }
  }
  return latest;
}

/** A short verb for the state-write commit message `spec(<slug>): <id> <what>`. */
function what(state: TodoState, note?: string): string {
  return note !== undefined && note.length > 0 ? `${state} (${note})` : state;
}
