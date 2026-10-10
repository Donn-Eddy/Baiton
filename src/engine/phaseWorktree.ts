/**
 * Per-phase worktree lifecycle (host-free core).
 *
 * Each phase of a plan executes in its own linked worktree at
 * `.baiton/worktrees/<slug>/<phase-id>/`, checked out on the branch
 * `baiton-phase/<slug>/<phase-id>` that starts at the head of the plan branch
 * `baiton/<slug>`. This module composes the worktree and merge primitives of
 * {@link GitWorktreeService} into:
 *
 * - **create/reuse** the worktree, idempotently: a registered worktree is reused
 *   as-is and never reset;
 * - **find** a phase's registered worktree;
 * - **land** the phase branch into the plan branch in the main checkout, refusing
 *   with a named reason and preserving the branch on conflict;
 * - **remove** the worktree and optionally its branch; and
 * - list the **unlanded** phases of a plan (those whose branch still exists).
 *
 * Every expected failure is a returned {@link Result}, never a throw, mirroring
 * `runWorktree.ts`. No `vscode` import, sync `fs` like its engine neighbours, so
 * it is unit testable against temp repos.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import * as path from 'path';

import { Result, err, ok } from '../model/result';
import type { DocumentKind } from '../model/parser';
import { createGitService } from '../git/gitService';
import type { GitError, GitWorktree, GitWorktreeService } from '../git/types';
import { resolveDocument } from '../storage/documentLocation';
import { RUN_WORKTREES_DIR, asGitError, safeRealpath } from './runWorktree';

/**
 * The ref namespace every phase branch lives under. NOT `baiton/`: the plan branch
 * `baiton/<slug>` is a ref file, so `baiton/<slug>/<id>` would be an impossible
 * ref ("cannot lock ref ... exists").
 */
export const PHASE_BRANCH_NAMESPACE = 'baiton-phase';
// Legacy: phases of a legacy .baiton/specs/ document keep the baiton-todo/ namespace so in-flight branches still resolve.
export const LEGACY_TODO_BRANCH_NAMESPACE = 'baiton-todo';

/** Namespace selected for branches of one document kind. */
export function phaseBranchNamespace(kind: DocumentKind): string {
  return kind === 'plan' ? PHASE_BRANCH_NAMESPACE : LEGACY_TODO_BRANCH_NAMESPACE;
}

/** The plan's own branch, `baiton/<slug>`. */
export function planBranchFor(slug: string): string {
  return `baiton/${slug}`;
}

/** Resolve the existing document kind for a slug, preferring plans when both exist. */
export function documentKindFor(workspaceRoot: string, slug: string): DocumentKind {
  return resolveDocument(path.join(workspaceRoot, '.baiton'), slug).kind;
}

/** The prefix (ending in `/`) of every phase branch of one plan. */
export function phaseBranchPrefix(slug: string, kind: DocumentKind): string {
  return `${phaseBranchNamespace(kind)}/${slug}/`;
}

/** One phase's branch, `baiton-phase/<slug>/<phase-id>`. */
export function phaseBranchFor(slug: string, phaseId: string, kind: DocumentKind): string {
  return `${phaseBranchPrefix(slug, kind)}${phaseId}`;
}

/** One phase's absolute worktree directory. */
export function phaseWorktreeDirFor(workspaceRoot: string, slug: string, phaseId: string): string {
  return path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR, slug, phaseId);
}

/** One phase's worktree directory, repository-relative and in forward-slash form. */
export function phaseWorktreeRelativeDir(slug: string, phaseId: string): string {
  return `.baiton/${RUN_WORKTREES_DIR}/${slug}/${phaseId}`;
}

/** The default merge commit message when a phase lands. */
export function phaseLandMessage(slug: string, phaseId: string): string {
  return `plan(${slug}): land ${phaseId}`;
}

/** A slug or phase id usable as both a path segment and a ref component. */
export function isPhaseWorktreeKey(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.lock') &&
    !value.endsWith('.')
  );
}

/**
 * A git service bound to one phase's worktree directory, so that phase's
 * head/commit/diff calls go through the worktree rather than the main checkout.
 * The factory is injectable for tests.
 */
export function createPhaseGitService(
  workspaceRoot: string,
  slug: string,
  phaseId: string,
  factory: (dir: string) => GitWorktreeService = createGitService,
): GitWorktreeService {
  return factory(phaseWorktreeDirFor(workspaceRoot, slug, phaseId));
}

/** How the phase worktree operations are bound to a workspace and to git. */
export interface PhaseWorktreeDeps {
  /** Absolute workspace root; `.baiton/worktrees/` resolves under it. */
  workspaceRoot: string;
  /** Service bound to the MAIN checkout (`createGitService(workspaceRoot)`). */
  git: GitWorktreeService;
  /** Factory for a service bound to another directory; injected for tests. */
  createService?: (dir: string) => GitWorktreeService;
}

/** Everything a created (or reused) phase worktree is identified by. */
export interface PhaseWorktreeInfo {
  slug: string;
  phaseId: string;
  kind: DocumentKind;
  /** `baiton-phase/<slug>/<phase-id>`. */
  branch: string;
  /** `baiton/<slug>`. */
  planBranch: string;
  /** Absolute worktree directory. */
  worktreeDir: string;
  /** Repository-relative worktree directory. */
  relativeWorktreeDir: string;
  /** Head of the phase branch as found/created. */
  head: string;
  /** True when an existing registered worktree was reused. */
  reused: boolean;
}

/** Every expected failure of the create/remove operations, classified. */
export type PhaseWorktreeError =
  | { kind: 'invalid-id'; slug: string; phaseId: string; message: string }
  | { kind: 'no-plan-branch'; slug: string; phaseId: string; planBranch: string; message: string }
  // Non-empty unregistered directory.
  | { kind: 'exists'; slug: string; phaseId: string; path: string; message: string }
  // Registered worktree on another branch, or detached.
  | {
      kind: 'wrong-branch';
      slug: string;
      phaseId: string;
      path: string;
      expected: string;
      actual: string | undefined;
      message: string;
    }
  // Registered but prunable, or its directory is missing.
  | { kind: 'stale'; slug: string; phaseId: string; path: string; message: string }
  // The branch exists but has no worktree.
  | { kind: 'orphan-branch'; slug: string; phaseId: string; branch: string; message: string }
  | { kind: 'git'; slug: string; phaseId: string; message: string; error?: GitError }
  | { kind: 'io'; slug: string; phaseId: string; path: string; message: string };

/** What a landed phase produced. */
export interface PhaseLandOutcome {
  /** The plan branch's head after landing. */
  commit: string;
  planBranch: string;
  branch: string;
  /** True when the branch was already contained in the plan branch: no merge commit was made. */
  noop: boolean;
  /** Non-fatal cleanup problems after a successful merge (worktree/branch removal). */
  cleanup: readonly string[];
}

/** Why a land was refused, as one named reason. */
export type PhaseLandRefusal =
  | { reason: 'invalid-id'; message: string }
  | { reason: 'wrong-branch'; expected: string; actual: string; message: string }
  | { reason: 'dirty-tree'; changes: readonly string[]; message: string }
  | { reason: 'missing-branch'; branch: string; message: string }
  | { reason: 'conflict'; branch: string; error: GitError; message: string }
  | { reason: 'git'; message: string };

/** What a removal actually did, so a caller can report it precisely. */
export interface PhaseWorktreeRemoval {
  /** True when a registered worktree was deregistered by git. */
  worktreeRemoved: boolean;
  /** True when a leftover directory was deleted directly. */
  dirRemoved: boolean;
  /** True when the phase branch was deleted. */
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
 * The registered worktree of one phase, or `undefined` when git does not know it.
 * Both sides of the comparison go through `safeRealpath`, as in `findRunWorktree`.
 */
export async function findPhaseWorktree(
  deps: PhaseWorktreeDeps,
  slug: string,
  phaseId: string,
): Promise<GitWorktree | undefined> {
  const target = safeRealpath(phaseWorktreeDirFor(deps.workspaceRoot, slug, phaseId));
  const worktrees = await deps.git.listWorktrees();
  return worktrees.find((w) => safeRealpath(w.dir) === target);
}

/**
 * Create a phase's worktree, idempotently: `.baiton/worktrees/<slug>/<phase-id>/`
 * on the new branch `baiton-phase/<slug>/<phase-id>` at the head of the plan branch
 * `baiton/<slug>` (the BRANCH's head, not whatever the main checkout has out).
 *
 * An already-registered worktree on the right branch is reused untouched: the
 * worktree takes the plan head the first time only and then keeps its own history.
 *
 * Nothing is created before every check has passed: each failure returns
 * immediately with its own `kind`.
 */
export async function createPhaseWorktree(
  deps: PhaseWorktreeDeps,
  input: { slug: string; phaseId: string; kind?: DocumentKind },
): Promise<Result<PhaseWorktreeInfo, PhaseWorktreeError>> {
  const { slug, phaseId } = input;
  if (!isPhaseWorktreeKey(slug) || !isPhaseWorktreeKey(phaseId)) {
    return err({
      kind: 'invalid-id',
      slug,
      phaseId,
      message:
        `${JSON.stringify(slug)} / ${JSON.stringify(phaseId)} is not a valid slug and phase id: ` +
        'use letters, digits, dots, underscores and hyphens, starting with a letter or digit.',
    });
  }

  const kind = input.kind ?? documentKindFor(deps.workspaceRoot, slug);
  const worktreeDir = phaseWorktreeDirFor(deps.workspaceRoot, slug, phaseId);
  const branch = phaseBranchFor(slug, phaseId, kind);
  const planBranch = planBranchFor(slug);
  const relativeWorktreeDir = phaseWorktreeRelativeDir(slug, phaseId);

  let registered: GitWorktree | undefined;
  try {
    registered = await findPhaseWorktree(deps, slug, phaseId);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      phaseId,
      message: `Could not list this repository's worktrees: ${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }
  if (registered !== undefined) {
    if (registered.prunable || !existsSync(worktreeDir)) {
      return err({
        kind: 'stale',
        slug,
        phaseId,
        path: worktreeDir,
        message:
          `The worktree for ${phaseId} at ${worktreeDir} is registered but its directory is ` +
          'missing. Remove it with removePhaseWorktree, then dispatch again.',
      });
    }
    if (registered.branch !== branch) {
      return err({
        kind: 'wrong-branch',
        slug,
        phaseId,
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
          phaseId,
          message: `Could not resolve the head of ${branch}.`,
        });
      }
      return ok({
        slug,
        phaseId,
        kind,
        branch,
        planBranch,
        worktreeDir,
        relativeWorktreeDir,
        head,
        reused: true,
      });
    } catch (e) {
      return err({
        kind: 'git',
        slug,
        phaseId,
        message: `Could not resolve the head of ${branch}: ${describeError(e)}.`,
        ...gitErrorPart(e),
      });
    }
  }

  let planHead: string | undefined;
  try {
    if ((await deps.git.branchHead(branch)) !== undefined) {
      return err({
        kind: 'orphan-branch',
        slug,
        phaseId,
        branch,
        message:
          `The branch ${branch} exists but has no worktree (its directory may have been ` +
          'removed by hand). Land it, or remove it with removePhaseWorktree and deleteBranch.',
      });
    }
    planHead = await deps.git.branchHead(planBranch);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      phaseId,
      message: `Could not inspect the branches of ${slug}: ${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }
  if (planHead === undefined) {
    return err({
      kind: 'no-plan-branch',
      slug,
      phaseId,
      planBranch,
      message: `The plan branch ${planBranch} does not exist, so ${phaseId} has nothing to branch from.`,
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
        phaseId,
        path: worktreeDir,
        message: `Could not inspect the existing directory at ${worktreeDir}: ${describeError(e)}.`,
      });
    }
    if (entries.length > 0) {
      return err({
        kind: 'exists',
        slug,
        phaseId,
        path: worktreeDir,
        message:
          `A non-empty directory already exists at ${worktreeDir}. Remove it before creating ` +
          `the worktree for ${phaseId} again.`,
      });
    }
  }

  try {
    mkdirSync(path.dirname(worktreeDir), { recursive: true });
  } catch (e) {
    return err({
      kind: 'io',
      slug,
      phaseId,
      path: path.dirname(worktreeDir),
      message: `Could not create ${path.dirname(worktreeDir)}: ${describeError(e)}.`,
    });
  }

  try {
    await deps.git.addWorktree(worktreeDir, branch, planHead);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      phaseId,
      message:
        `Could not create the worktree for ${phaseId} on branch ${branch} at ${worktreeDir}: ` +
        `${describeError(e)}.`,
      ...gitErrorPart(e),
    });
  }

  return ok({
    slug,
    phaseId,
    kind,
    branch,
    planBranch,
    worktreeDir,
    relativeWorktreeDir,
    head: planHead,
    reused: false,
  });
}

/**
 * Remove a phase's worktree, and optionally its branch.
 *
 * Tolerant of every partial state, so it can be retried: nothing on disk is an
 * all-false `ok`. This is never called for a failed or stopped stage — those keep
 * worktree and branch for inspection; it is the post-land step of
 * {@link landPhaseWorktree} and an explicit cleanup path.
 */
export async function removePhaseWorktree(
  deps: PhaseWorktreeDeps,
  input: { slug: string; phaseId: string; kind?: DocumentKind; deleteBranch?: boolean; force?: boolean },
): Promise<Result<PhaseWorktreeRemoval, PhaseWorktreeError>> {
  const { slug, phaseId } = input;
  if (!isPhaseWorktreeKey(slug) || !isPhaseWorktreeKey(phaseId)) {
    return err({
      kind: 'invalid-id',
      slug,
      phaseId,
      message: `${JSON.stringify(slug)} / ${JSON.stringify(phaseId)} is not a valid slug and phase id.`,
    });
  }

  const kind = input.kind ?? documentKindFor(deps.workspaceRoot, slug);
  const worktreeDir = phaseWorktreeDirFor(deps.workspaceRoot, slug, phaseId);
  const branch = phaseBranchFor(slug, phaseId, kind);
  const warnings: string[] = [];
  let worktreeRemoved = false;
  let dirRemoved = false;
  let branchDeleted = false;

  let registered: GitWorktree | undefined;
  try {
    registered = await findPhaseWorktree(deps, slug, phaseId);
  } catch (e) {
    return err({
      kind: 'git',
      slug,
      phaseId,
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
        phaseId,
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

  // Drop the now-empty `.baiton/worktrees/<slug>/` folder so a fully landed plan
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
        // Force: an abandoned phase's branch is legitimately unmerged.
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
 * Land a phase: merge its branch into the plan branch, then remove the worktree
 * and the branch.
 *
 * The merge always runs in the MAIN checkout (`deps.git`). The check order is
 * pinned — **invalid-id → wrong-branch → dirty-tree → missing-branch → merge** —
 * and tests assert it. `dirty-tree` ignores changes inside
 * the resolved document folder. There is deliberately NO base-moved check: the plan
 * branch advances with state commits while a phase is in flight.
 *
 * A conflicting merge is aborted by git; the plan branch, the phase branch and
 * the worktree are then left untouched (no cleanup). A branch already contained
 * in the plan branch lands as `noop: true` and is cleaned up like any other,
 * because {@link unlandedPhases} is defined by branch existence.
 *
 * No locking here: serializing land with state commits is the plan-branch
 * writer's job.
 */
export async function landPhaseWorktree(
  deps: PhaseWorktreeDeps,
  input: { slug: string; phaseId: string; kind?: DocumentKind; message?: string },
): Promise<Result<PhaseLandOutcome, PhaseLandRefusal>> {
  const { slug, phaseId } = input;
  if (!isPhaseWorktreeKey(slug) || !isPhaseWorktreeKey(phaseId)) {
    return err({
      reason: 'invalid-id',
      message: `Cannot land: ${JSON.stringify(slug)} / ${JSON.stringify(phaseId)} is not a valid slug and phase id.`,
    });
  }

  const kind = input.kind ?? documentKindFor(deps.workspaceRoot, slug);
  const planBranch = planBranchFor(slug);
  let actual: string;
  try {
    actual = await deps.git.currentBranch();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the current branch: ${describeError(e)}.`,
    });
  }
  if (actual !== planBranch) {
    return err({
      reason: 'wrong-branch',
      expected: planBranch,
      actual,
      message:
        `Cannot land ${phaseId}: ${actual} is checked out, not ${planBranch}. ` +
        `Check out ${planBranch}, then land again.`,
    });
  }

  let outside: string[];
  try {
    const status = await deps.git.status();
    const documentFolder = `${resolveDocument(path.join(deps.workspaceRoot, '.baiton'), slug).pathspec}/`;
    outside = status.changes.map((c) => c.path).filter((p) => !p.startsWith(documentFolder));
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
        `Cannot land ${phaseId}: the working tree has ${outside.length} uncommitted change(s) ` +
        'outside the plan folder. Commit or stash them, then land again.',
    });
  }

  const branch = phaseBranchFor(slug, phaseId, kind);
  let before: string;
  try {
    if ((await deps.git.branchHead(branch)) === undefined) {
      return err({
        reason: 'missing-branch',
        branch,
        message: `Cannot land ${phaseId}: the branch ${branch} does not exist. It may already have been landed.`,
      });
    }
    before = await deps.git.head();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the branch heads: ${describeError(e)}.`,
    });
  }

  const merged = await deps.git.merge(branch, input.message ?? phaseLandMessage(slug, phaseId));
  if (!merged.ok) {
    return err({
      reason: 'conflict',
      branch,
      error: merged.error,
      message:
        `Cannot land ${branch} into ${planBranch}: the merge conflicts and was aborted, so ` +
        `${planBranch} is unchanged and the phase branch and worktree are untouched.`,
    });
  }

  // git exits 0 with "Already up to date" and makes no commit when the branch is
  // already contained, even with --no-ff.
  const noop = merged.value === before;

  // Cleanup never turns a landed merge into a failure.
  const cleanup: string[] = [];
  const removed = await removePhaseWorktree(deps, { slug, phaseId, kind, deleteBranch: true });
  if (removed.ok) {
    cleanup.push(...removed.value.warnings);
  } else {
    cleanup.push(removed.error.message);
  }

  return ok({ commit: merged.value, planBranch, branch, noop, cleanup });
}

/**
 * The phase ids of `slug` whose kind-specific phase branch still exists,
 * i.e. that have not been landed. The prefix ends in `/`, so slug `foo` never
 * matches the branches of slug `foo-bar`. Rejects on a git failure.
 */
export async function unlandedPhases(
  deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot'>,
  slug: string,
  kind?: DocumentKind,
): Promise<readonly string[]> {
  const prefix = phaseBranchPrefix(slug, kind ?? documentKindFor(deps.workspaceRoot, slug));
  return (await deps.git.listBranches(prefix))
    .map((b) => b.slice(prefix.length))
    .filter((id) => id.length > 0 && !id.includes('/'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
