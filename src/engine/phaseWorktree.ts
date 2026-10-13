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
 *
 * The worktree directory always stays under the OWNING repo's `.baiton/`, while
 * a cross-repo worktree is a checkout of the TARGET repo. This preserves the
 * owner's existing paths and keeps the child repo's main checkout free of an
 * untracked `.baiton/` directory.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';

import { Result, err, ok } from '../model/result';
import type { DocumentKind } from '../model/parser';
import { createGitService } from '../git/gitService';
import type { GitError, GitWorktree, GitWorktreeService } from '../git/types';
import { resolvePhaseRepo, type RepoTopology } from '../model/validator';
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
/** Resolve a document under the owning repository's `.baiton/` directory. */
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

/** One phase's absolute worktree directory beneath the owning repo root. */
export function phaseWorktreeDirFor(workspaceRoot: string, slug: string, phaseId: string): string {
  return path.join(workspaceRoot, '.baiton', RUN_WORKTREES_DIR, slug, phaseId);
}

/** One phase's worktree directory relative to the owning repo root, in forward-slash form. */
export function phaseWorktreeRelativeDir(slug: string, phaseId: string): string {
  return `.baiton/${RUN_WORKTREES_DIR}/${slug}/${phaseId}`;
}

/** The default merge commit message when a phase lands. */
export function phaseLandMessage(slug: string, phaseId: string): string {
  return `plan(${slug}): land ${phaseId}`;
}

/** Where one phase's git work happens: its target repo (the owner when the phase has no repo hint). */
export interface PhaseTargetRepo {
  /** Stable repo name ('.' for a single-folder root). */
  name: string;
  /** Canonical absolute root of the target repo's main checkout. */
  root: string;
  /** True when the target is the plan's owning repo. */
  isOwner: boolean;
  /** Git service bound to the target repo's MAIN checkout. */
  git: GitWorktreeService;
}

/** Resolves phase targets for one owning repo (implemented in activation/planStore.ts). */
export interface PhaseTargetResolver {
  /** The target of one phase; the owner for a hint-less phase, an unknown phase or an unreadable plan. Err only for a hint that does not resolve to the owner or a repo nested beneath it. */
  forPhase(slug: string, phaseId: string): Promise<Result<PhaseTargetRepo, string>>;
  /** Distinct targets of every phase of the plan, owner first, then in phase order; phases whose hint does not resolve are skipped. Never rejects. */
  forPlan(slug: string): Promise<readonly PhaseTargetRepo[]>;
}

/** Pure: resolve a phase's optional repo hint to a target name and root. */
export function resolvePhaseTargetRoot(
  phase: { id: string; repo?: string },
  topology: RepoTopology | undefined,
  ownerRoot: string,
): Result<{ name: string; root: string; isOwner: boolean }, string> {
  const binding = resolvePhaseRepo(phase.repo, topology);
  if (binding.ok) {
    if (binding.isOwner) return ok({ name: binding.target, root: ownerRoot, isOwner: true });
    const repo = topology?.repos.find((candidate) => candidate.name === binding.target);
    if (repo !== undefined) return ok({ name: binding.target, root: path.resolve(repo.root), isOwner: false });
    return err(`phase ${JSON.stringify(phase.id)} has repo hint ${JSON.stringify(phase.repo)}, which is unknown; a phase may only target the owning repo or a repo nested beneath it`);
  }
  const reason = binding.reason === 'sibling'
    ? `a sibling of the owning repo${binding.target === undefined ? '' : ` (${binding.target})`}`
    : binding.reason === 'ancestor'
      ? `an ancestor of the owning repo${binding.target === undefined ? '' : ` (${binding.target})`}`
      : binding.reason === 'invalid'
        ? 'invalid'
        : `unknown${binding.target === undefined ? '' : ` (${binding.target})`}`;
  return err(
    `phase ${JSON.stringify(phase.id)} has repo hint ${JSON.stringify(phase.repo)}, which is ${reason}; ` +
      'a phase may only target the owning repo or a repo nested beneath it',
  );
}

/** Written inside a phase worktree of a repo that tracks none, to ignore run artifacts. */
export const TARGET_WORKTREE_GITIGNORE = '# Baiton run artifacts of a phase owned by another repo. Never committed.\n*\n';

/** A temporary landing worktree, keyed by the canonical target root. */
export function planLandingWorktreeDirFor(ownerRoot: string, slug: string, targetRoot: string): string {
  const hash = createHash('sha256').update(path.resolve(targetRoot)).digest('hex').slice(0, 12);
  return path.join(ownerRoot, '.baiton', RUN_WORKTREES_DIR, slug, `_land-${hash}`);
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
  /** Absolute OWNING repo root: the document and `.baiton/worktrees/` resolve under it. */
  workspaceRoot: string;
  /** Service bound to the OWNING repo's main checkout. */
  git: GitWorktreeService;
  /** The phase's target repo; absent (or isOwner) keeps the owner-only behaviour byte-identical. */
  target?: PhaseTargetRepo;
  /** Factory for a service bound to another directory; injected for tests. */
  createService?: (dir: string) => GitWorktreeService;
}

function mainGit(deps: Pick<PhaseWorktreeDeps, 'git' | 'target'>): GitWorktreeService {
  return deps.target?.git ?? deps.git;
}

function isCrossRepo(deps: Pick<PhaseWorktreeDeps, 'target'>): boolean {
  return deps.target !== undefined && !deps.target.isOwner;
}

function ensureTargetWorktreeGitignore(worktreeDir: string): void {
  const baitonDir = path.join(worktreeDir, '.baiton');
  const gitignore = path.join(baitonDir, '.gitignore');
  if (existsSync(gitignore)) return;
  mkdirSync(baitonDir, { recursive: true });
  writeFileSync(gitignore, TARGET_WORKTREE_GITIGNORE, 'utf8');
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
  const worktrees = await mainGit(deps).listWorktrees();
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
      const head = registered.head ?? (await mainGit(deps).branchHead(branch));
      if (head === undefined) {
        return err({
          kind: 'git',
          slug,
          phaseId,
          message: `Could not resolve the head of ${branch}.`,
        });
      }
      if (isCrossRepo(deps)) {
        try {
          ensureTargetWorktreeGitignore(worktreeDir);
        } catch (e) {
          return err({
            kind: 'io', slug, phaseId, path: path.join(worktreeDir, '.baiton', '.gitignore'),
            message: `Could not write the target worktree .baiton/.gitignore: ${describeError(e)}.`,
          });
        }
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
    const git = mainGit(deps);
    if ((await git.branchHead(branch)) !== undefined) {
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
    planHead = await git.branchHead(planBranch);
    if (planHead === undefined && isCrossRepo(deps)) {
      planHead = await git.head();
      await git.createPlanBranch(planBranch, planHead);
    }
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
    await mainGit(deps).addWorktree(worktreeDir, branch, planHead);
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

  if (isCrossRepo(deps)) {
    try {
      ensureTargetWorktreeGitignore(worktreeDir);
    } catch (e) {
      return err({
        kind: 'io', slug, phaseId, path: path.join(worktreeDir, '.baiton', '.gitignore'),
        message: `Could not write the target worktree .baiton/.gitignore: ${describeError(e)}.`,
      });
    }
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
      await mainGit(deps).removeWorktree(worktreeDir, input.force ?? true);
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
      if ((await mainGit(deps).branchHead(branch)) !== undefined) {
        // Force: an abandoned phase's branch is legitimately unmerged.
        await mainGit(deps).deleteBranch(branch, true);
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
 * The owner merge runs in the MAIN checkout (`deps.git`). The check order is
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
 * For a cross-repo target the target's main checkout is never switched: landing
 * uses a temporary linked worktree unless `baiton/<slug>` is already checked
 * out in the target main checkout. No locking here: serializing land with state
 * commits is the plan-branch writer's job.
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
  if (isCrossRepo(deps)) {
    return landCrossRepoPhaseWorktree(deps, { ...input, kind });
  }
  const git = mainGit(deps);
  const planBranch = planBranchFor(slug);
  let actual: string;
  try {
    actual = await git.currentBranch();
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
    const status = await git.status();
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
    if ((await git.branchHead(branch)) === undefined) {
      return err({
        reason: 'missing-branch',
        branch,
        message: `Cannot land ${phaseId}: the branch ${branch} does not exist. It may already have been landed.`,
      });
    }
    before = await git.head();
  } catch (e) {
    return err({
      reason: 'git',
      message: `Cannot land: could not read the branch heads: ${describeError(e)}.`,
    });
  }

  const merged = await git.merge(branch, input.message ?? phaseLandMessage(slug, phaseId));
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

/** Land a target-repo phase without switching its main checkout. */
async function landCrossRepoPhaseWorktree(
  deps: PhaseWorktreeDeps,
  input: { slug: string; phaseId: string; kind: DocumentKind; message?: string },
): Promise<Result<PhaseLandOutcome, PhaseLandRefusal>> {
  const git = mainGit(deps);
  const { slug, phaseId, kind } = input;
  const planBranch = planBranchFor(slug);
  const branch = phaseBranchFor(slug, phaseId, kind);
  let actual: string;
  try {
    actual = await git.currentBranch();
  } catch (e) {
    return err({ reason: 'git', message: `Cannot land: could not read the current branch: ${describeError(e)}.` });
  }

  // If the target's main checkout already has the landing branch checked out,
  // use it directly. Every target change counts as dirty because the plan
  // document belongs to the owner repo.
  if (actual === planBranch) {
    let changes: string[];
    try {
      changes = (await git.status()).changes.map((change) => change.path);
    } catch (e) {
      return err({ reason: 'git', message: `Cannot land: could not read the working-tree status: ${describeError(e)}.` });
    }
    if (changes.length > 0) {
      return err({
        reason: 'dirty-tree', changes,
        message: `Cannot land ${phaseId}: the target working tree has ${changes.length} uncommitted change(s). Commit or stash them, then land again.`,
      });
    }
    let before: string;
    try {
      if ((await git.branchHead(branch)) === undefined) {
        return err({ reason: 'missing-branch', branch, message: `Cannot land ${phaseId}: the branch ${branch} does not exist. It may already have been landed.` });
      }
      before = await git.head();
    } catch (e) {
      return err({ reason: 'git', message: `Cannot land: could not read the branch heads: ${describeError(e)}.` });
    }
    const merged = await git.merge(branch, input.message ?? phaseLandMessage(slug, phaseId));
    if (!merged.ok) {
      return err({
        reason: 'conflict', branch, error: merged.error,
        message: `Cannot land ${branch} into ${planBranch}: the merge conflicts and was aborted, so ${planBranch} is unchanged and the phase branch and worktree are untouched.`,
      });
    }
    const cleanup: string[] = [];
    const removed = await removePhaseWorktree(deps, { slug, phaseId, kind, deleteBranch: true });
    if (removed.ok) cleanup.push(...removed.value.warnings);
    else cleanup.push(removed.error.message);
    return ok({ commit: merged.value, planBranch, branch, noop: merged.value === before, cleanup });
  }

  // Refuse early when either branch is absent, before touching a landing dir.
  try {
    if ((await git.branchHead(branch)) === undefined) {
      return err({ reason: 'missing-branch', branch, message: `Cannot land ${phaseId}: the branch ${branch} does not exist. It may already have been landed.` });
    }
    if ((await git.branchHead(planBranch)) === undefined) {
      return err({ reason: 'git', message: `Cannot land ${phaseId}: the plan branch ${planBranch} does not exist in the target repository.` });
    }
  } catch (e) {
    return err({ reason: 'git', message: `Cannot land: could not read the branch heads: ${describeError(e)}.` });
  }

  const landingDir = planLandingWorktreeDirFor(deps.workspaceRoot, slug, deps.target!.root);
  try {
    const existing = (await git.listWorktrees()).find((worktree) => safeRealpath(worktree.dir) === safeRealpath(landingDir));
    if (existing !== undefined) await git.removeWorktree(landingDir, true);
    if (existsSync(landingDir)) rmSync(landingDir, { recursive: true, force: true });
    mkdirSync(path.dirname(landingDir), { recursive: true });
    await git.addWorktreeOnBranch(landingDir, planBranch);
  } catch (e) {
    return err({ reason: 'git', message: `Cannot prepare a landing worktree for ${planBranch}: ${describeError(e)}.` });
  }

  let landingGit: GitWorktreeService | undefined;
  let landingError: string | undefined;
  try {
    landingGit = (deps.createService ?? createGitService)(landingDir);
  } catch (e) {
    landingError = describeError(e);
  }
  let before: string | undefined;
  let merged: Awaited<ReturnType<GitWorktreeService['merge']>> | undefined;
  let changes: string[] | undefined;
  if (landingGit !== undefined && landingError === undefined) {
    try {
      changes = (await landingGit.status()).changes.map((change) => change.path);
      if (changes.length === 0) {
        before = await landingGit.head();
        merged = await landingGit.merge(branch, input.message ?? phaseLandMessage(slug, phaseId));
      }
    } catch (e) {
      landingError = describeError(e);
    }
  }

  const landingCleanup: string[] = [];
  try {
    await git.removeWorktree(landingDir, true);
  } catch (e) {
    landingCleanup.push(`Could not remove the landing worktree at ${landingDir}: ${describeError(e)}.`);
  }
  try {
    if (existsSync(landingDir)) rmSync(landingDir, { recursive: true, force: true });
  } catch (e) {
    landingCleanup.push(`Could not delete the landing directory ${landingDir}: ${describeError(e)}.`);
  }

  if (landingError !== undefined) {
    return err({ reason: 'git', message: `Cannot land: could not merge in the landing worktree: ${landingError}.` });
  }
  if (changes !== undefined && changes.length > 0) {
    return err({
      reason: 'dirty-tree', changes,
      message: `Cannot land ${phaseId}: the landing worktree has ${changes.length} uncommitted change(s).`,
    });
  }
  if (merged === undefined || before === undefined) {
    return err({ reason: 'git', message: 'Cannot land: the landing worktree did not produce a merge result.' });
  }
  if (!merged.ok) {
    return err({
      reason: 'conflict', branch, error: merged.error,
      message: `Cannot land ${branch} into ${planBranch}: the merge conflicts and was aborted, so ${planBranch} is unchanged and the phase branch and worktree are untouched.`,
    });
  }

  const cleanup = [...landingCleanup];
  const removed = await removePhaseWorktree(deps, { slug, phaseId, kind, deleteBranch: true });
  if (removed.ok) cleanup.push(...removed.value.warnings);
  else cleanup.push(removed.error.message);
  return ok({ commit: merged.value, planBranch, branch, noop: merged.value === before, cleanup });
}

/**
 * The phase ids of `slug` whose kind-specific phase branch still exists,
 * i.e. that have not been landed. The prefix ends in `/`, so slug `foo` never
 * matches the branches of slug `foo-bar`. Rejects on a git failure.
 */
export async function unlandedPhases(
  deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot' | 'target'>,
  slug: string,
  kind?: DocumentKind,
): Promise<readonly string[]> {
  const prefix = phaseBranchPrefix(slug, kind ?? documentKindFor(deps.workspaceRoot, slug));
  return (await mainGit(deps).listBranches(prefix))
    .map((b) => b.slice(prefix.length))
    .filter((id) => id.length > 0 && !id.includes('/'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Union unlanded phase ids across the owner and every distinct target repo. */
export async function unlandedPhasesAcross(
  deps: Pick<PhaseWorktreeDeps, 'git' | 'workspaceRoot'>,
  slug: string,
  targets: readonly PhaseTargetRepo[],
  kind?: DocumentKind,
): Promise<readonly string[]> {
  const resolvedKind = kind ?? documentKindFor(deps.workspaceRoot, slug);
  const prefix = phaseBranchPrefix(slug, resolvedKind);
  const seenRoots = new Set([path.resolve(deps.workspaceRoot)]);
  const services: GitWorktreeService[] = [deps.git];
  for (const target of targets) {
    const root = path.resolve(target.root);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    services.push(target.git);
  }
  const branches = await Promise.all(services.map((git) => git.listBranches(prefix)));
  return [...new Set(branches.flatMap((names) => names
    .map((name) => name.slice(prefix.length))
    .filter((id) => id.length > 0 && !id.includes('/'))))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
