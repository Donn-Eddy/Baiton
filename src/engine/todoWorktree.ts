/**
 * Per-todo worktree lifecycle (host-free core).
 *
 * Each todo of a spec executes in its own linked worktree at
 * `.baiton/worktrees/<slug>/<todo-id>/`, checked out on the branch
 * `baiton-todo/<slug>/<todo-id>` that starts at the head of the spec branch
 * `baiton/<slug>`. This module composes the worktree and merge primitives of
 * {@link GitWorktreeService} into:
 *
 * - **create/reuse** the worktree, idempotently: a registered worktree is reused
 *   as-is and never reset;
 * - **find** a todo's registered worktree;
 * - **land** the todo branch into the spec branch in the main checkout, refusing
 *   with a named reason and preserving the branch on conflict;
 * - **remove** the worktree and optionally its branch; and
 * - list the **unlanded** todos of a spec (those whose branch still exists).
 *
 * Every expected failure is a returned {@link Result}, never a throw, mirroring
 * `runWorktree.ts`. No `vscode` import, sync `fs` like its engine neighbours, so
 * it is unit testable against temp repos.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import * as path from 'path';

import { Result, err, ok } from '../model/result';
import { createGitService } from '../git/gitService';
import type { GitError, GitWorktree, GitWorktreeService } from '../git/types';
import { RUN_WORKTREES_DIR, asGitError, safeRealpath } from './runWorktree';

/**
 * The ref namespace every todo branch lives under. NOT `baiton/`: the spec branch
 * `baiton/<slug>` is a ref file, so `baiton/<slug>/<id>` would be an impossible
 * ref ("cannot lock ref ... exists").
 */
export const TODO_BRANCH_NAMESPACE = 'baiton-todo';

/** The spec's own branch, `baiton/<slug>`. */
export function specBranchFor(slug: string): string {
  return `baiton/${slug}`;
}

/** The prefix (ending in `/`) of every todo branch of one spec. */
export function todoBranchPrefix(slug: string): string {
  return `${TODO_BRANCH_NAMESPACE}/${slug}/`;
}

/** One todo's branch, `baiton-todo/<slug>/<todo-id>`. */
export function todoBranchFor(slug: string, todoId: string): string {
  return `${todoBranchPrefix(slug)}${todoId}`;
}

/** One todo's absolute worktree directory. */
export function todoWorktreeDirFor(workspaceRoot: string, slug: string, todoId: string): string {
  return path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR, slug, todoId);
}

/** One todo's worktree directory, repository-relative and in forward-slash form. */
export function todoWorktreeRelativeDir(slug: string, todoId: string): string {
  return `.baiton/${RUN_WORKTREES_DIR}/${slug}/${todoId}`;
}

/** The default merge commit message when a todo lands. */
export function todoLandMessage(slug: string, todoId: string): string {
  return `spec(${slug}): land ${todoId}`;
}

/** A slug or todo id usable as both a path segment and a ref component. */
export function isTodoWorktreeKey(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.lock') &&
    !value.endsWith('.')
  );
}

/**
 * A git service bound to one todo's worktree directory, so that todo's
 * head/commit/diff calls go through the worktree rather than the main checkout.
 * The factory is injectable for tests.
 */
export function createTodoGitService(
  workspaceRoot: string,
  slug: string,
  todoId: string,
  factory: (dir: string) => GitWorktreeService = createGitService,
): GitWorktreeService {
  return factory(todoWorktreeDirFor(workspaceRoot, slug, todoId));
}

/** How the todo worktree operations are bound to a workspace and to git. */
export interface TodoWorktreeDeps {
  /** Absolute workspace root; `.baiton/worktrees/` resolves under it. */
  workspaceRoot: string;
  /** Service bound to the MAIN checkout (`createGitService(workspaceRoot)`). */
  git: GitWorktreeService;
  /** Factory for a service bound to another directory; injected for tests. */
  createService?: (dir: string) => GitWorktreeService;
}

/** Everything a created (or reused) todo worktree is identified by. */
export interface TodoWorktreeInfo {
  slug: string;
  todoId: string;
  /** `baiton-todo/<slug>/<todo-id>`. */
  branch: string;
  /** `baiton/<slug>`. */
  specBranch: string;
  /** Absolute worktree directory. */
  worktreeDir: string;
  /** Repository-relative worktree directory. */
  relativeWorktreeDir: string;
  /** Head of the todo branch as found/created. */
  head: string;
  /** True when an existing registered worktree was reused. */
  reused: boolean;
}

/** Every expected failure of the create/remove operations, classified. */
export type TodoWorktreeError =
  | { kind: 'invalid-id'; slug: string; todoId: string; message: string }
  | { kind: 'no-spec-branch'; slug: string; todoId: string; specBranch: string; message: string }
  // Non-empty unregistered directory.
  | { kind: 'exists'; slug: string; todoId: string; path: string; message: string }
  // Registered worktree on another branch, or detached.
  | {
      kind: 'wrong-branch';
      slug: string;
      todoId: string;
      path: string;
      expected: string;
      actual: string | undefined;
      message: string;
    }
  // Registered but prunable, or its directory is missing.
  | { kind: 'stale'; slug: string; todoId: string; path: string; message: string }
  // The branch exists but has no worktree.
  | { kind: 'orphan-branch'; slug: string; todoId: string; branch: string; message: string }
  | { kind: 'git'; slug: string; todoId: string; message: string; error?: GitError }
  | { kind: 'io'; slug: string; todoId: string; path: string; message: string };

/** What a landed todo produced. */
export interface TodoLandOutcome {
  /** The spec branch's head after landing. */
  commit: string;
  specBranch: string;
  branch: string;
  /** True when the branch was already contained in the spec branch: no merge commit was made. */
  noop: boolean;
  /** Non-fatal cleanup problems after a successful merge (worktree/branch removal). */
  cleanup: readonly string[];
}

/** Why a land was refused, as one named reason. */
export type TodoLandRefusal =
  | { reason: 'invalid-id'; message: string }
  | { reason: 'wrong-branch'; expected: string; actual: string; message: string }
  | { reason: 'dirty-tree'; changes: readonly string[]; message: string }
  | { reason: 'missing-branch'; branch: string; message: string }
  | { reason: 'conflict'; branch: string; error: GitError; message: string }
  | { reason: 'git'; message: string };

/** What a removal actually did, so a caller can report it precisely. */
export interface TodoWorktreeRemoval {
  /** True when a registered worktree was deregistered by git. */
  worktreeRemoved: boolean;
  /** True when a leftover directory was deleted directly. */
  dirRemoved: boolean;
  /** True when the todo branch was deleted. */
  branchDeleted: boolean;
  /** Non-fatal problems, e.g. a directory that could not be removed. */
  warnings: readonly string[];
}

/** Describe a caught value for an error message. */
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The `error` property for a `kind: 'git'` failure, when the thrown value is a GitError. */
function gitErrorPart(e: unknown): { error?: GitError } {
  const g = asGitError(e);
  return g !== undefined ? { error: g } : {};
}

/**
 * The registered worktree of one todo, or `undefined` when git does not know it.
 * Both sides of the comparison go through `safeRealpath`, as in `findRunWorktree`.
 */
export async function findTodoWorktree(
  deps: TodoWorktreeDeps,
  slug: string,
  todoId: string,
): Promise<GitWorktree | undefined> {
  const target = safeRealpath(todoWorktreeDirFor(deps.workspaceRoot, slug, todoId));
  const worktrees = await deps.git.listWorktrees();
  return worktrees.find((w) => safeRealpath(w.dir) === target);
}

/**
 * Create a todo's worktree, idempotently: `.baiton/worktrees/<slug>/<todo-id>/`
 * on the new branch `baiton-todo/<slug>/<todo-id>` at the head of the spec branch
 * `baiton/<slug>` (the BRANCH's head, not whatever the main checkout has out).
 *
 * An already-registered worktree on the right branch is reused untouched: the
 * worktree takes the spec head the first time only and then keeps its own history.
 *
 * Nothing is created before every check has passed: each failure returns
 * immediately with its own `kind`.
 */
export async function createTodoWorktree(
  deps: TodoWorktreeDeps,
  input: { slug: string; todoId: string },
): Promise<Result<TodoWorktreeInfo, TodoWorktreeError>> {
  const { slug, todoId } = input;
  if (!isTodoWorktreeKey(slug) || !isTodoWorktreeKey(todoId)) {
    return err({
      kind: 'invalid-id',
      slug,
      todoId,
      message:
        `${JSON.stringify(slug)} / ${JSON.stringify(todoId)} is not a valid slug and todo id: ` +
        'use letters, digits, dots, underscores and hyphens, starting with a letter or digit.',
    });
  }

  const worktreeDir = todoWorktreeDirFor(deps.workspaceRoot, slug, todoId);
  const branch = todoBranchFor(slug, todoId);
  const specBranch = specBranchFor(slug);
  const relativeWorktreeDir = todoWorktreeRelativeDir(slug, todoId);

  let registered: GitWorktree | undefined;
  try {
    registered = await findTodoWorktree(deps, slug, todoId);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      todoId,
      message: `Could not list this repository's worktrees: ${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }
  if (registered !== undefined) {
    if (registered.prunable || !existsSync(worktreeDir)) {
      return err({
        kind: 'stale',
        slug,
        todoId,
        path: worktreeDir,
        message:
          `The worktree for ${todoId} at ${worktreeDir} is registered but its directory is ` +
          'missing. Remove it with removeTodoWorktree, then dispatch again.',
      });
    }
    if (registered.branch !== branch) {
      return err({
        kind: 'wrong-branch',
        slug,
        todoId,
        path: worktreeDir,
        expected: branch,
        actual: registered.branch,
        message:
          `The worktree at ${worktreeDir} is on ${registered.branch ?? 'a detached HEAD'}, ` +
          `not ${branch}.`,
      });
    }
    try {
      const head = registered.head ?? (await deps.git.branchHead(branch));
      if (head === undefined) {
        return err({
          kind: 'git',
          slug,
          todoId,
          message: `Could not resolve the head of ${branch}.`,
        });
      }
      return ok({
        slug,
        todoId,
        branch,
        specBranch,
        worktreeDir,
        relativeWorktreeDir,
        head,
        reused: true,
      });
    } catch (e) {
      return err({
        kind: 'git',
        slug,
        todoId,
        message: `Could not resolve the head of ${branch}: ${describeError(e)}.`,
        ...gitErrorPart(e),
      });
    }
  }

  let specHead: string | undefined;
  try {
    if ((await deps.git.branchHead(branch)) !== undefined) {
      return err({
        kind: 'orphan-branch',
        slug,
        todoId,
        branch,
        message:
          `The branch ${branch} exists but has no worktree (its directory may have been ` +
          'removed by hand). Land it, or remove it with removeTodoWorktree and deleteBranch.',
      });
    }
    specHead = await deps.git.branchHead(specBranch);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      todoId,
      message: `Could not inspect the branches of ${slug}: ${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }
  if (specHead === undefined) {
    return err({
      kind: 'no-spec-branch',
      slug,
      todoId,
      specBranch,
      message: `The spec branch ${specBranch} does not exist, so ${todoId} has nothing to branch from.`,
    });
  }

  // An existing *empty* directory is tolerated, because git accepts one.
  if (existsSync(worktreeDir)) {
    let entries: string[];
    try {
      entries = readdirSync(worktreeDir);
    } catch (e) {
      return err({
        kind: 'io',
        slug,
        todoId,
        path: worktreeDir,
        message: `Could not inspect the existing directory at ${worktreeDir}: ${describeError(e)}.`,
      });
    }
    if (entries.length > 0) {
      return err({
        kind: 'exists',
        slug,
        todoId,
        path: worktreeDir,
        message:
          `A non-empty directory already exists at ${worktreeDir}. Remove it before creating ` +
          `the worktree for ${todoId} again.`,
      });
    }
  }

  try {
    mkdirSync(path.dirname(worktreeDir), { recursive: true });
  } catch (e) {
    return err({
      kind: 'io',
      slug,
      todoId,
      path: path.dirname(worktreeDir),
      message: `Could not create ${path.dirname(worktreeDir)}: ${describeError(e)}.`,
    });
  }

  try {
    await deps.git.addWorktree(worktreeDir, branch, specHead);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      todoId,
      message:
        `Could not create the worktree for ${todoId} on branch ${branch} at ${worktreeDir}: ` +
        `${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }

  return ok({
    slug,
    todoId,
    branch,
    specBranch,
    worktreeDir,
    relativeWorktreeDir,
    head: specHead,
    reused: false,
  });
}

/**
 * Remove a todo's worktree, and optionally its branch.
 *
 * Tolerant of every partial state, so it can be retried: nothing on disk is an
 * all-false `ok`. This is never called for a failed or stopped stage — those keep
 * worktree and branch for inspection; it is the post-land step of
 * {@link landTodoWorktree} and an explicit cleanup path.
 */
export async function removeTodoWorktree(
  deps: TodoWorktreeDeps,
  input: { slug: string; todoId: string; deleteBranch?: boolean; force?: boolean },
): Promise<Result<TodoWorktreeRemoval, TodoWorktreeError>> {
  const { slug, todoId } = input;
  if (!isTodoWorktreeKey(slug) || !isTodoWorktreeKey(todoId)) {
    return err({
      kind: 'invalid-id',
      slug,
      todoId,
      message: `${JSON.stringify(slug)} / ${JSON.stringify(todoId)} is not a valid slug and todo id.`,
    });
  }

  const worktreeDir = todoWorktreeDirFor(deps.workspaceRoot, slug, todoId);
  const branch = todoBranchFor(slug, todoId);
  const warnings: string[] = [];
  let worktreeRemoved = false;
  let dirRemoved = false;
  let branchDeleted = false;

  let registered: GitWorktree | undefined;
  try {
    registered = await findTodoWorktree(deps, slug, todoId);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      todoId,
      message: `Could not list this repository's worktrees: ${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }
  if (registered !== undefined) {
    try {
      await deps.git.removeWorktree(worktreeDir, input.force ?? true);
      worktreeRemoved = true;
    } catch (e) {
      // Nothing has been destroyed yet, so this is a clean failure to report.
      return err({
        kind: 'git',
        slug,
        todoId,
        message: `Could not remove the worktree at ${worktreeDir}: ${describeError(e)}.`,
        ...gitErrorPart(e),
      });
    }
  }

  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
      dirRemoved = true;
    } catch (e) {
      warnings.push(`Could not delete the leftover directory ${worktreeDir}: ${describeError(e)}.`);
    }
  }

  // Drop the now-empty `.baiton/worktrees/<slug>/` folder so a fully landed spec
  // leaves nothing behind.
  const parent = path.dirname(worktreeDir);
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  } catch {
    // Best effort only.
  }

  if (input.deleteBranch === true) {
    try {
      if ((await deps.git.branchHead(branch)) !== undefined) {
        // Force: an abandoned todo's branch is legitimately unmerged.
        await deps.git.deleteBranch(branch, true);
        branchDeleted = true;
      }
    } catch (e) {
      warnings.push(`Could not delete the branch ${branch}: ${describeError(e)}.`);
    }
  }

  return ok({ worktreeRemoved, dirRemoved, branchDeleted, warnings });
}

/**
 * Land a todo: merge its branch into the spec branch, then remove the worktree
 * and the branch.
 *
 * The merge always runs in the MAIN checkout (`deps.git`). The check order is
 * pinned — **invalid-id → wrong-branch → dirty-tree → missing-branch → merge** —
 * and tests assert it. `dirty-tree` ignores changes inside
 * `.baiton/specs/<slug>/`. There is deliberately NO base-moved check: the spec
 * branch advances with state commits while a todo is in flight.
 *
 * A conflicting merge is aborted by git; the spec branch, the todo branch and
 * the worktree are then left untouched (no cleanup). A branch already contained
 * in the spec branch lands as `noop: true` and is cleaned up like any other,
 * because {@link unlandedTodos} is defined by branch existence.
 *
 * No locking here: serializing land with state commits is the spec-branch
 * writer's job.
 */
export async function landTodoWorktree(
  deps: TodoWorktreeDeps,
  input: { slug: string; todoId: string; message?: string },
): Promise<Result<TodoLandOutcome, TodoLandRefusal>> {
  const { slug, todoId } = input;
  if (!isTodoWorktreeKey(slug) || !isTodoWorktreeKey(todoId)) {
    return err({
      reason: 'invalid-id',
      message: `Cannot land: ${JSON.stringify(slug)} / ${JSON.stringify(todoId)} is not a valid slug and todo id.`,
    });
  }

  const specBranch = specBranchFor(slug);
  let actual: string;
  try {
    actual = await deps.git.currentBranch();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the current branch: ${describeError(e)}.`,
    });
  }
  if (actual !== specBranch) {
    return err({
      reason: 'wrong-branch',
      expected: specBranch,
      actual,
      message:
        `Cannot land ${todoId}: ${actual} is checked out, not ${specBranch}. ` +
        `Check out ${specBranch}, then land again.`,
    });
  }

  let outside: string[];
  try {
    const status = await deps.git.status();
    const specFolder = `.baiton/specs/${slug}/`;
    outside = status.changes.map((c) => c.path).filter((p) => !p.startsWith(specFolder));
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the working-tree status: ${describeError(e)}.`,
    });
  }
  if (outside.length > 0) {
    return err({
      reason: 'dirty-tree',
      changes: outside,
      message:
        `Cannot land ${todoId}: the working tree has ${outside.length} uncommitted change(s) ` +
        'outside the spec folder. Commit or stash them, then land again.',
    });
  }

  const branch = todoBranchFor(slug, todoId);
  let before: string;
  try {
    if ((await deps.git.branchHead(branch)) === undefined) {
      return err({
        reason: 'missing-branch',
        branch,
        message: `Cannot land ${todoId}: the branch ${branch} does not exist. It may already have been landed.`,
      });
    }
    before = await deps.git.head();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the branch heads: ${describeError(e)}.`,
    });
  }

  const merged = await deps.git.merge(branch, input.message ?? todoLandMessage(slug, todoId));
  if (!merged.ok) {
    return err({
      reason: 'conflict',
      branch,
      error: merged.error,
      message:
        `Cannot land ${branch} into ${specBranch}: the merge conflicts and was aborted, so ` +
        `${specBranch} is unchanged and the todo branch and worktree are untouched.`,
    });
  }

  // git exits 0 with "Already up to date" and makes no commit when the branch is
  // already contained, even with --no-ff.
  const noop = merged.value === before;

  // Cleanup never turns a landed merge into a failure.
  const cleanup: string[] = [];
  const removed = await removeTodoWorktree(deps, { slug, todoId, deleteBranch: true });
  if (removed.ok) {
    cleanup.push(...removed.value.warnings);
  } else {
    cleanup.push(removed.error.message);
  }

  return ok({ commit: merged.value, specBranch, branch, noop, cleanup });
}

/**
 * The todo ids of `slug` whose branch `baiton-todo/<slug>/<id>` still exists,
 * i.e. that have not been landed. The prefix ends in `/`, so slug `foo` never
 * matches the branches of slug `foo-bar`. Rejects on a git failure.
 */
export async function unlandedTodos(
  deps: Pick<TodoWorktreeDeps, 'git'>,
  slug: string,
): Promise<readonly string[]> {
  const prefix = todoBranchPrefix(slug);
  return (await deps.git.listBranches(prefix))
    .map((b) => b.slice(prefix.length))
    .filter((id) => id.length > 0 && !id.includes('/'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
