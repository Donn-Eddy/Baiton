/** Pure plan-repository discovery and write-target seam. */
import * as path from 'path';
import type { GitService } from '../git';
import {
  isWithinSubtree,
  repoByRoot,
  repoTopologyFor,
  reposWithBaiton,
  type Repo,
  type RepoSet,
} from '../activation/repoDiscovery';
import type { RepoTopology } from '../model/validator';
import { resolveDocument } from '../storage/documentLocation';
import { GuardContext } from './guard';
import type { PlanRepoInfo, PlanRepoLookup, PlanRepoSeam, PlanRepoTarget } from './seams';

export interface PlanRepoSeamDeps {
  repos: () => RepoSet | undefined;
  ownerRoot: string;
  restricted: () => boolean;
  gitFor(root: string): GitService;
  exists(p: string): Promise<boolean>;
}

export type PlanRef = { repo?: string; slug: string };

/** Parse `slug` or `<repoPath>:<slug>`, splitting on the last colon. */
export function parsePlanRef(input: string): { ok: true; ref: PlanRef } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty plan reference' };
  const separator = trimmed.lastIndexOf(':');
  if (separator < 0) return { ok: true, ref: { slug: trimmed } };

  const repo = trimmed.slice(0, separator);
  const slug = trimmed.slice(separator + 1);
  if (slug.length === 0) return { ok: false, error: `plan reference "${trimmed}" has no slug` };
  if (repo.length === 0) return { ok: false, error: `plan reference "${trimmed}" has an empty repo path` };
  return { ok: true, ref: { repo: normalizeRepoPath(repo) ?? repo, slug } };
}

/** Format a qualified `<repoPath>:<slug>` reference. */
export function formatPlanRef(repoPath: string, slug: string): string {
  return `${normalizeRepoPath(repoPath) ?? repoPath}:${slug}`;
}

/** Normalize a repo address while preserving absolute roots and outside paths. */
export function normalizeRepoPath(repoPath: string): string | undefined {
  const trimmed = repoPath.trim().replace(/\\/g, '/');
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  const withoutTrailingSlash = normalized.replace(/\/+$/, '');
  return withoutTrailingSlash === '' || withoutTrailingSlash === '.' || withoutTrailingSlash === './'
    ? '.'
    : withoutTrailingSlash;
}

/**
 * Build a plan-repo seam. Plan addressing spans every discovered repo with a
 * `.baiton/` (phase worktrees are excluded by repo discovery), while `list()`
 * remains scoped to the owner's subtree for draft context. With no usable
 * discovery, this degenerates to the synthetic owner target.
 */
export function createPlanRepoSeam(deps: PlanRepoSeamDeps): PlanRepoSeam {
  const ownerRoot = path.resolve(deps.ownerRoot);

  const snapshot = (): { set?: RepoSet; owner?: Repo } => {
    const set = deps.repos();
    const owner = set === undefined ? undefined : repoByRoot(set, ownerRoot);
    return { ...(set !== undefined ? { set } : {}), ...(owner !== undefined ? { owner } : {}) };
  };

  const fallbackInfo: PlanRepoInfo = { path: '.', name: '.', hasBaiton: true };
  const makeFallback = (): PlanRepoTarget => {
    const topology: RepoTopology = { owner: '.', repos: [{ name: '.', root: ownerRoot }] };
    const baitonDir = path.join(ownerRoot, '.baiton');
    return {
      info: fallbackInfo,
      root: ownerRoot,
      baitonDir,
      git: deps.gitFor(ownerRoot),
      topology,
      guard: new GuardContext({ repoRoot: ownerRoot, baitonDir, restricted: deps.restricted() }),
    };
  };

  const listedRepos = (): { set?: RepoSet; owner?: Repo; repos: readonly Repo[] } => {
    const current = snapshot();
    if (current.set === undefined || current.owner === undefined) {
      return { ...current, repos: [] };
    }
    return {
      ...current,
      repos: [
        current.owner,
        ...current.set.repos.filter(
          (repo) => repo.name !== current.owner?.name && isWithinSubtree(current.set!, current.owner!, repo),
        ),
      ],
    };
  };

  const infoFor = (repo: Repo, owner: Repo): PlanRepoInfo => {
    const relative = path.relative(owner.root, repo.root);
    const repoPath = path.isAbsolute(relative)
      ? repo.root.split(path.sep).join('/')
      : relative.split(path.sep).join('/') || '.';
    return { path: repoPath, name: repo.name, hasBaiton: repo.baitonDir !== undefined };
  };

  const makeTarget = (repo: Repo, owner: Repo, set: RepoSet): PlanRepoTarget | undefined => {
    if (repo.baitonDir === undefined) return undefined;
    return {
      info: infoFor(repo, owner),
      root: repo.root,
      baitonDir: repo.baitonDir,
      git: deps.gitFor(repo.root),
      topology: repoTopologyFor(set, repo.name),
      guard: new GuardContext({
        repoRoot: repo.root,
        baitonDir: repo.baitonDir,
        restricted: deps.restricted(),
      }),
    };
  };

  const ownerRepos = (set: RepoSet, owner: Repo): readonly Repo[] => [
    ...(owner.baitonDir === undefined ? [] : [owner]),
    ...reposWithBaiton(set).filter((repo) => repo.name !== owner.name),
  ];

  const unknownRepoError = (repoPath: string): string =>
    `repo "${repoPath}" is not a discovered repo with a .baiton/ directory`;

  const fallbackTarget = (repoPath?: string): { ok: true; target: PlanRepoTarget } | { ok: false; error: string } => {
    const normalized = repoPath === undefined ? '.' : normalizeRepoPath(repoPath);
    return normalized === '.'
      ? { ok: true, target: makeFallback() }
      : { ok: false, error: unknownRepoError(repoPath ?? '') };
  };

  return {
    list(): readonly PlanRepoInfo[] {
      const { set, owner, repos } = listedRepos();
      if (set === undefined || owner === undefined) return [fallbackInfo];
      return repos.map((repo) => infoFor(repo, owner));
    },

    owners(): readonly PlanRepoInfo[] {
      const current = snapshot();
      if (current.set === undefined || current.owner === undefined) return [fallbackInfo];
      return ownerRepos(current.set, current.owner).map((repo) => infoFor(repo, current.owner!));
    },

    target(repoPath: string): { ok: true; target: PlanRepoTarget } | { ok: false; error: string } {
      const normalized = normalizeRepoPath(repoPath);
      const { set, owner } = snapshot();
      if (set === undefined || owner === undefined) return fallbackTarget(repoPath);

      const repo = normalized === undefined
        ? undefined
        : set.repos.find((candidate) => infoFor(candidate, owner).path === normalized);
      if (repo === undefined) return { ok: false, error: unknownRepoError(repoPath) };
      if (repo.baitonDir === undefined) {
        return isWithinSubtree(set, owner, repo)
          ? { ok: false, error: `repo "${repoPath}" has no .baiton/ directory; initialize Baiton there first` }
          : { ok: false, error: unknownRepoError(repoPath) };
      }
      const target = makeTarget(repo, owner, set);
      return target === undefined
        ? { ok: false, error: `repo "${repoPath}" has no .baiton/ directory; initialize Baiton there first` }
        : { ok: true, target };
    },

    targetAt(root: string): PlanRepoTarget | undefined {
      const { set, owner } = snapshot();
      if (set === undefined || owner === undefined) {
        return path.resolve(root) === ownerRoot ? makeFallback() : undefined;
      }
      const repo = repoByRoot(set, root);
      return repo === undefined ? undefined : makeTarget(repo, owner, set);
    },

    async locate(slug: string, repoPath?: string): Promise<PlanRepoLookup> {
      const current = snapshot();
      if (current.set === undefined || current.owner === undefined) {
        if (repoPath !== undefined && normalizeRepoPath(repoPath) !== '.') {
          return { kind: 'invalid', error: unknownRepoError(repoPath) };
        }
        const target = makeFallback();
        return await deps.exists(resolveDocument(target.baitonDir, slug).documentPath)
          ? { kind: 'found', target }
          : { kind: 'missing' };
      }

      if (repoPath !== undefined) {
        const resolved = this.target(repoPath);
        if (!resolved.ok) return { kind: 'invalid', error: resolved.error };
        return await deps.exists(resolveDocument(resolved.target.baitonDir, slug).documentPath)
          ? { kind: 'found', target: resolved.target }
          : { kind: 'missing' };
      }

      const candidates = ownerRepos(current.set, current.owner);
      const found = await Promise.all(candidates.map(async (candidate) =>
        await deps.exists(resolveDocument(candidate.baitonDir!, slug).documentPath) ? candidate : undefined,
      ));
      const matches = found.filter((candidate): candidate is Repo => candidate !== undefined);
      if (matches.length === 0) return { kind: 'missing' };
      if (matches.length > 1) {
        return { kind: 'ambiguous', repos: matches.map((candidate) => infoFor(candidate, current.owner!).path) };
      }
      const target = makeTarget(matches[0], current.owner, current.set);
      return target === undefined ? { kind: 'missing' } : { kind: 'found', target };
    },
  };
}
