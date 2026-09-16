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
import { parseSpec, type ParsedSpec } from '../model/parser';
import { isBlocked as deriveBlocked } from '../model/hash';
import { writeTodoState } from '../model/writer';
import { isErr } from '../model/result';
import type { TodoState } from '../model/todoState';
import type { Stage } from '../model/stage';
import type { GitService } from '../git';
import type { SpecStore } from '../engine';
import { persistencePathForStage, stageArtifactIsNumbered } from '../schema';
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
  const todoDir = (slug: string, todoId: string): string =>
    path.join(specsDir, slug, 'todos', todoId);

  /** Re-read and parse a spec's `spec.md`, or `undefined` when unreadable. */
  const readSpec = async (slug: string): Promise<ParsedSpec | undefined> => {
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

    readSpec,

    async readArtifact(slug, todoId, stage): Promise<string | undefined> {
      const dir = todoDir(slug, todoId);
      const fileName = stageArtifactIsNumbered(stage)
        ? await latestNumbered(dir, stage)
        : baseName(persistencePathForStage(stage, todoId));
      if (fileName === undefined) {
        return undefined;
      }
      try {
        return await fsp.readFile(path.join(dir, fileName), 'utf8');
      } catch {
        return undefined;
      }
    },

    async latestExecuteCommit(slug, todoId): Promise<string | undefined> {
      let commit: string | undefined;
      for (const entry of parseJournal(journalPath(slug))) {
        if (
          entry.stage === 'execute' &&
          entry.todoId === todoId &&
          entry.result === 'completed' &&
          entry.commit !== undefined
        ) {
          commit = entry.commit;
        }
      }
      return commit;
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
 * The file name of the highest-numbered artifact a numbered stage wrote into a
 * todo's artifact folder, or `undefined` when the folder holds none. The
 * directory — not the journal — is the source of truth: an artifact is on file
 * exactly when the file exists, whatever the journal recorded (Req 24.3).
 */
async function latestNumbered(
  dir: string,
  stage: Stage,
): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`^${stage}-(\\d+)\\.md$`);
  let best: { name: string; n: number } | undefined;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) {
      continue;
    }
    const n = Number(match[1]);
    if (best === undefined || n > best.n) {
      best = { name, n };
    }
  }
  return best?.name;
}

/** The final `/`-separated segment of a spec-relative artifact path. */
function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1];
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
