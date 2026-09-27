/**
 * Run worktree lifecycle (host-free core).
 *
 * This module composes the worktree and merge primitives of
 * {@link GitWorktreeService} into the three lifecycle operations a spec-less run
 * needs:
 *
 * - **create** a linked worktree at `.baiton/worktrees/<run-id>/`, checked out on
 *   a new branch `baiton/<mode>/<run-id>` starting at the head of the branch that
 *   was checked out when the run started;
 * - **merge** that branch back into the base branch, refusing with a named reason
 *   (`wrong-branch`, `base-moved`, `dirty-tree`, `missing-branch`, `conflict`)
 *   instead of faulting; and
 * - **remove** the worktree — and optionally its branch — on demand.
 *
 * Every expected failure is a returned {@link Result}, never a throw, mirroring
 * `runStore.ts`. No `vscode` import, sync `fs` like its engine neighbours
 * (`launcher.ts`, `runStore.ts`), so it is unit testable against temp repos.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'fs';
import * as path from 'path';

import { Result, err, ok } from '../model/result';
import type { RunMode } from '../model/mode';
import { createGitService } from '../git/gitService';
import type { GitError, GitWorktree, GitWorktreeService } from '../git/types';
import { isRunId, runBranchFor, runWorktreeDirFor } from './runStore';

/** The directory segment under `.baiton/` that holds every run worktree. */
export const RUN_WORKTREES_DIR = 'worktrees';

/** The directory every run worktree lives under. */
export function runWorktreesRootDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR);
}

/**
 * One run's worktree directory, repository-relative and always in forward-slash
 * form. This is the value stored in `RunManifest.worktreeDir` (documented there
 * as repository-relative), while {@link runWorktreeDirFor} yields the absolute
 * path handed to git.
 */
export function runWorktreeRelativeDir(runId: string): string {
  return `.baiton/${RUN_WORKTREES_DIR}/${runId}`;
}

/**
 * A git service bound to one run's worktree directory, so the pipeline's
 * head/branch/commit/diff calls for that run go through the worktree rather than
 * the main checkout. The factory is injectable for tests.
 */
export function createRunGitService(
  workspaceRoot: string,
  runId: string,
  factory: (dir: string) => GitWorktreeService = createGitService,
): GitWorktreeService {
  return factory(runWorktreeDirFor(workspaceRoot, runId));
}

/** How the run worktree operations are bound to a workspace and to git. */
export interface RunWorktreeDeps {
  /** Absolute workspace root; `.baiton/worktrees/` resolves under it. */
  workspaceRoot: string;
  /** Service bound to the MAIN checkout (`createGitService(workspaceRoot)`). */
  git: GitWorktreeService;
  /** Factory for a service bound to another directory; injected for tests. */
  createService?: (dir: string) => GitWorktreeService;
}

/** Everything a created run worktree is identified by. */
export interface RunWorktreeInfo {
  runId: string;
  mode: RunMode;
  /** `baiton/<mode>/<run-id>`. */
  branch: string;
  /** Absolute worktree directory. */
  worktreeDir: string;
  /** Repository-relative worktree directory, for `RunManifest.worktreeDir`. */
  relativeWorktreeDir: string;
  /** The branch that was checked out when the worktree was created. */
  baseBranch: string;
  /** That branch's head commit at that moment. */
  baseHead: string;
}

/** Every expected failure of the create/remove operations, classified. */
export type RunWorktreeError =
  | { kind: 'invalid-id'; runId: string; message: string }
  | { kind: 'exists'; runId: string; path: string; message: string }
  | { kind: 'detached-head'; runId: string; message: string }
  | { kind: 'no-base-head'; runId: string; baseBranch: string; message: string }
  | { kind: 'git'; runId: string; message: string; error?: GitError }
  | { kind: 'io'; runId: string; path: string; message: string };

/** What a landed merge produced. */
export interface RunMergeOutcome {
  /** The merge commit's sha on the base branch. */
  commit: string;
  baseBranch: string;
  branch: string;
  /** Non-fatal cleanup problems after a successful merge (worktree/branch removal). */
  cleanup: readonly string[];
}

/** Why a merge was refused, as one named reason the Runs view shows. */
export type RunMergeRefusal =
  | { reason: 'wrong-branch'; expected: string; actual: string; message: string }
  | {
      reason: 'base-moved';
      baseBranch: string;
      expected: string;
      actual: string | undefined;
      message: string;
    }
  | { reason: 'dirty-tree'; changes: readonly string[]; message: string }
  | { reason: 'missing-branch'; branch: string; message: string }
  | { reason: 'conflict'; branch: string; error: GitError; message: string }
  | { reason: 'git'; message: string };

/** What a removal actually did, so a caller can report it precisely. */
export interface RunWorktreeRemoval {
  /** True when a registered worktree was deregistered by git. */
  worktreeRemoved: boolean;
  /** True when a leftover directory was deleted directly. */
  dirRemoved: boolean;
  /** True when the run branch was deleted. */
  branchDeleted: boolean;
  /** Non-fatal problems, e.g. a directory that could not be removed. */
  warnings: readonly string[];
}

/** Describe a caught value for an error message. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Narrow a thrown value to a {@link GitError} — the shape `runOrThrow` throws —
 * so a `kind: 'git'` failure can carry git's own command and stderr.
 */
function asGitError(e: unknown): GitError | undefined {
  if (typeof e !== 'object' || e === null) {
    return undefined;
  }
  const candidate = e as { command?: unknown; stderr?: unknown; exitCode?: unknown };
  if (typeof candidate.command !== 'string' || typeof candidate.stderr !== 'string') {
    return undefined;
  }
  return {
    command: candidate.command,
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined,
    stderr: candidate.stderr,
  };
}

/**
 * Resolve a path through `realpathSync`, falling back to `path.resolve` when it
 * does not exist. Git prints realpaths in `worktree list --porcelain`, so a raw
 * string comparison against a constructed path fails wherever a parent is a
 * symlink (e.g. `/tmp` on macOS) — see {@link GitWorktree.dir}.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Create a run's worktree: `.baiton/worktrees/<run-id>/` checked out on the new
 * branch `baiton/<mode>/<run-id>` at the head of the currently checked-out
 * branch, which is recorded in the returned info as the run's merge base.
 *
 * Nothing is created before every check has passed: each failure returns
 * immediately with its own `kind`.
 */
export async function createRunWorktree(
  deps: RunWorktreeDeps,
  input: { runId: string; mode: RunMode },
): Promise<Result<RunWorktreeInfo, RunWorktreeError>> {
  const { runId, mode } = input;
  if (!isRunId(runId)) {
    return err({
      kind: 'invalid-id',
      runId,
      message:
        `${JSON.stringify(runId)} is not a valid run id: use letters, digits and ` +
        'hyphens only (a dot would collide with a launch directory name).',
    });
  }

  const worktreeDir = runWorktreeDirFor(deps.workspaceRoot, runId);
  const branch = runBranchFor(mode, runId);

  // An existing *empty* directory is tolerated, because git accepts one.
  if (existsSync(worktreeDir)) {
    let entries: string[];
    try {
      entries = readdirSync(worktreeDir);
    } catch (e) {
      return err({
        kind: 'io',
        runId,
        path: worktreeDir,
        message: `Could not inspect the existing directory at ${worktreeDir}: ${describe(e)}.`,
      });
    }
    if (entries.length > 0) {
      return err({
        kind: 'exists',
        runId,
        path: worktreeDir,
        message:
          `A non-empty directory already exists at ${worktreeDir}. Remove it, or clean up ` +
          `run ${runId}, before creating its worktree again.`,
      });
    }
  }

  let baseBranch: string;
  try {
    baseBranch = await deps.git.currentBranch();
  } catch (e) {
    return err({
      kind: 'git',
      runId,
      message: `Could not read the current branch of ${deps.workspaceRoot}: ${describe(e)}.`,
      ...(asGitError(e) !== undefined ? { error: asGitError(e)! } : {}),
    });
  }
  // `currentBranch()` is `rev-parse --abbrev-ref HEAD`, which prints the literal
  // `HEAD` on a detached checkout. A run must remember a real branch name, or it
  // could never merge back into anything.
  if (baseBranch.length === 0 || baseBranch === 'HEAD') {
    return err({
      kind: 'detached-head',
      runId,
      message:
        'Cannot start a run from a detached HEAD: check out a named branch first, because the ' +
        "run's branch is merged back into the branch it started from.",
    });
  }

  const baseHead = await deps.git.branchHead(baseBranch);
  if (baseHead === undefined) {
    return err({
      kind: 'no-base-head',
      runId,
      baseBranch,
      message:
        `The branch ${baseBranch} has no commits yet, so run ${runId} has nothing to branch ` +
        'from. Make an initial commit, then start the run again.',
    });
  }

  try {
    mkdirSync(path.dirname(worktreeDir), { recursive: true });
  } catch (e) {
    return err({
      kind: 'io',
      runId,
      path: path.dirname(worktreeDir),
      message: `Could not create ${path.dirname(worktreeDir)}: ${describe(e)}.`,
    });
  }

  try {
    // `addWorktree` uses `git worktree add -b`, so a colliding run branch fails
    // loudly here rather than silently resetting an existing branch.
    await deps.git.addWorktree(worktreeDir, branch, baseHead);
  } catch (e) {
    return err({
      kind: 'git',
      runId,
      message:
        `Could not create the worktree for run ${runId} on branch ${branch} at ${worktreeDir}: ` +
        `${describe(e)}.`,
      ...(asGitError(e) !== undefined ? { error: asGitError(e)! } : {}),
    });
  }

  return ok({
    runId,
    mode,
    branch,
    worktreeDir,
    relativeWorktreeDir: runWorktreeRelativeDir(runId),
    baseBranch,
    baseHead,
  });
}

/**
 * The registered worktree of one run, or `undefined` when git does not know it.
 *
 * Both sides of the comparison go through {@link safeRealpath} because git prints
 * realpaths, so raw string comparison against the constructed path is wrong.
 */
export async function findRunWorktree(
  deps: RunWorktreeDeps,
  runId: string,
): Promise<GitWorktree | undefined> {
  const target = safeRealpath(runWorktreeDirFor(deps.workspaceRoot, runId));
  const worktrees = await deps.git.listWorktrees();
  return worktrees.find((w) => safeRealpath(w.dir) === target);
}

/**
 * The default merge commit message: `Merge <branch>` (with the run's statement
 * folded into the subject when there is one), a blank line, then a
 * `Run-Id: <run-id>` trailer — the same trailer the execute commit carries, so
 * `findCommitByRunId` also finds the merge.
 */
export function runMergeMessage(input: {
  runId: string;
  branch: string;
  statement?: string;
}): string {
  const first = (input.statement ?? '').split('\n')[0]?.trim() ?? '';
  const summary = first.length > 60 ? `${first.slice(0, 60)}…` : first;
  const subject = summary.length > 0 ? `Merge ${input.branch}: ${summary}` : `Merge ${input.branch}`;
  return `${subject}\n\nRun-Id: ${input.runId}\n`;
}

/**
 * Merge a run's branch back into its base branch, then remove the worktree and
 * the branch.
 *
 * The merge always runs in the MAIN checkout (`deps.git`), never in the run's
 * worktree. The check order is pinned — **wrong-branch → base-moved →
 * dirty-tree → missing-branch → merge** — and tests assert it, because only one
 * reason reaches the user: the later checks only mean anything while the base
 * branch is the one checked out; a base that has moved makes the run stale
 * regardless of local edits; and a dirty tree would be swept into the merge
 * commit, so it must be reported before git is touched at all.
 */
export async function mergeRunWorktree(
  deps: RunWorktreeDeps,
  input: {
    runId: string;
    mode: RunMode;
    baseBranch: string;
    baseHead: string;
    /** Defaults to `runBranchFor(mode, runId)`. */
    branch?: string;
    /** Defaults to {@link runMergeMessage}. */
    message?: string;
    /** The run's one-line statement, folded into the default message. */
    statement?: string;
  },
): Promise<Result<RunMergeOutcome, RunMergeRefusal>> {
  const { runId, mode, baseBranch, baseHead } = input;

  // 1. wrong-branch.
  let actual: string;
  try {
    actual = await deps.git.currentBranch();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot merge: could not read the current branch: ${describe(e)}.`,
    });
  }
  if (actual !== baseBranch) {
    return err({
      reason: 'wrong-branch',
      expected: baseBranch,
      actual,
      message:
        `Cannot merge: run ${runId} started from ${baseBranch}, but ${actual} is checked out. ` +
        `Check out ${baseBranch}, then merge again.`,
    });
  }

  // 2. base-moved — including the case where the base branch is gone entirely,
  // which `branchHead` reports as `undefined` rather than rejecting.
  const head = await deps.git.branchHead(baseBranch);
  if (head !== baseHead) {
    return err({
      reason: 'base-moved',
      baseBranch,
      expected: baseHead,
      actual: head,
      message:
        head === undefined
          ? `Cannot merge: the base branch ${baseBranch} no longer exists. Run ${runId} was ` +
            `based on ${baseHead}; start the work again from a branch that still exists.`
          : `Cannot merge: the base branch ${baseBranch} has moved to ${head} since run ` +
            `${runId} started from ${baseHead}. Re-run the work on the current base.`,
    });
  }

  // 3. dirty-tree. `status()` rather than `isClean()` (the same predicate) so the
  // refusal can name the paths involved.
  let clean: boolean;
  let changes: readonly string[];
  try {
    const status = await deps.git.status();
    clean = status.clean;
    changes = status.changes.map((c) => c.path);
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot merge: could not read the working-tree status: ${describe(e)}.`,
    });
  }
  if (!clean) {
    return err({
      reason: 'dirty-tree',
      changes,
      message:
        `Cannot merge: the working tree has ${changes.length} uncommitted change(s). ` +
        'Commit or stash them, then merge again.',
    });
  }

  // 4. missing-branch.
  const branch = input.branch ?? runBranchFor(mode, runId);
  if ((await deps.git.branchHead(branch)) === undefined) {
    return err({
      reason: 'missing-branch',
      branch,
      message:
        `Cannot merge: the branch ${branch} for run ${runId} does not exist. It may already ` +
        'have been merged and cleaned up.',
    });
  }

  // 5. merge.
  const merged = await deps.git.merge(
    branch,
    input.message ?? runMergeMessage({ runId, branch, statement: input.statement }),
  );
  if (!merged.ok) {
    return err({
      reason: 'conflict',
      branch,
      error: merged.error,
      message:
        `Cannot merge ${branch} into ${baseBranch}: the merge conflicts and was aborted, so ` +
        `${baseBranch} is unchanged and the run's branch and worktree are untouched. Resolve ` +
        'the conflict on the run branch, then merge again.',
    });
  }

  // 6. Clean up, but never let cleanup turn a landed merge into a failure: the
  // commit is already on the base branch, and re-running the merge would then
  // refuse with `base-moved`. `removeRunWorktree` deregisters the worktree before
  // deleting the branch, which git requires (it refuses to delete a branch that
  // is checked out in any worktree).
  const cleanup: string[] = [];
  const removed = await removeRunWorktree(deps, { runId, mode, branch, deleteBranch: true });
  if (removed.ok) {
    cleanup.push(...removed.value.warnings);
  } else {
    cleanup.push(removed.error.message);
  }

  return ok({ commit: merged.value, baseBranch, branch, cleanup });
}

/**
 * Remove a run's worktree, and optionally its branch.
 *
 * Tolerant of every partial state, so cancel and cleanup can be retried: a run
 * with nothing on disk is an all-false `ok`. This is deliberately NOT what the
 * pipeline's `cancel()` calls — a cancelled run keeps its worktree and branch for
 * inspection. It is the Runs view's explicit cleanup path, plus the post-merge
 * step of {@link mergeRunWorktree}.
 */
export async function removeRunWorktree(
  deps: RunWorktreeDeps,
  input: {
    runId: string;
    mode: RunMode;
    branch?: string;
    /** Delete the run branch too; default false. */
    deleteBranch?: boolean;
    /** Force removal over local modifications in the worktree; default true. */
    force?: boolean;
  },
): Promise<Result<RunWorktreeRemoval, RunWorktreeError>> {
  const { runId, mode } = input;
  if (!isRunId(runId)) {
    return err({
      kind: 'invalid-id',
      runId,
      message: `${JSON.stringify(runId)} is not a valid run id.`,
    });
  }

  const worktreeDir = runWorktreeDirFor(deps.workspaceRoot, runId);
  const branch = input.branch ?? runBranchFor(mode, runId);
  const warnings: string[] = [];
  let worktreeRemoved = false;
  let dirRemoved = false;
  let branchDeleted = false;

  let registered: GitWorktree | undefined;
  try {
    registered = await findRunWorktree(deps, runId);
  } catch (e) {
    return err({
      kind: 'git',
      runId,
      message: `Could not list this repository's worktrees: ${describe(e)}.`,
      ...(asGitError(e) !== undefined ? { error: asGitError(e)! } : {}),
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
        runId,
        message: `Could not remove the worktree at ${worktreeDir}: ${describe(e)}.`,
        ...(asGitError(e) !== undefined ? { error: asGitError(e)! } : {}),
      });
    }
  }

  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
      dirRemoved = true;
    } catch (e) {
      // The registration is already gone, which is what matters; a leftover
      // directory is a warning, not a failure.
      warnings.push(`Could not delete the leftover directory ${worktreeDir}: ${describe(e)}.`);
    }
  }

  if (input.deleteBranch === true && (await deps.git.branchHead(branch)) !== undefined) {
    try {
      // Force: a cancelled run's branch is legitimately unmerged.
      await deps.git.deleteBranch(branch, true);
      branchDeleted = true;
    } catch (e) {
      warnings.push(`Could not delete the branch ${branch}: ${describe(e)}.`);
    }
  }

  return ok({ worktreeRemoved, dirRemoved, branchDeleted, warnings });
}
