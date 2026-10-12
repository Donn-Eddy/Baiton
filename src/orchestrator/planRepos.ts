/** Pure plan-repository discovery and write-target seam. */
import * as path from 'path';
import type { GitService } from '../git';
import {
  isWithinSubtree,
  repoTopologyFor,
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

/**
 * Build a plan-repo seam scoped to the conversation's owning repo subtree.
 * If discovery is absent or omits the owner root, this exposes a synthetic
 * owner-only target at `ownerRoot` with `.baiton/` derived from that root.
 */
export function createPlanRepoSeam(deps: PlanRepoSeamDeps): PlanRepoSeam {
  const ownerRoot = path.resolve(deps.ownerRoot);

  const snapshot = (): { set?: RepoSet; owner?: Repo } => {
    const set = deps.repos();
    const owner = set?.repos.find((repo) => path.resolve(repo.root) === ownerRoot);
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

  const infoFor = (repo: Repo, owner: Repo): PlanRepoInfo => ({
    path: path.relative(owner.root, repo.root).split(path.sep).join('/') || '.',
    name: repo.name,
    hasBaiton: repo.baitonDir !== undefined,
  });

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

  const normalizedPath = (repoPath: string): string | undefined => {
    const trimmed = repoPath.trim().replace(/\\/g, '/');
    if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return undefined;
    const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
    if (normalized === '..' || normalized.startsWith('../')) return undefined;
    return normalized === '' || normalized === './' ? '.' : normalized;
  };

  return {
    list(): readonly PlanRepoInfo[] {
      const { set, owner, repos } = listedRepos();
      if (set === undefined || owner === undefined) return [fallbackInfo];
      return repos.map((repo) => infoFor(repo, owner));
    },

    target(repoPath: string): { ok: true; target: PlanRepoTarget } | { ok: false; error: string } {
      const normalized = normalizedPath(repoPath);
      const { set, owner, repos } = listedRepos();
      if (set === undefined || owner === undefined) {
        return normalized === '.'
          ? { ok: true, target: makeFallback() }
          : { ok: false, error: `repo "${repoPath}" is not the owning repo or a repo nested beneath it` };
      }
      const repo = normalized === undefined
        ? undefined
        : repos.find((candidate) => infoFor(candidate, owner).path === normalized);
      if (repo === undefined) {
        return { ok: false, error: `repo "${repoPath}" is not the owning repo or a repo nested beneath it` };
      }
      if (repo.baitonDir === undefined) {
        return { ok: false, error: `repo "${repoPath}" has no .baiton/ directory; initialize Baiton there first` };
      }
      const target = makeTarget(repo, owner, set);
      return target === undefined
        ? { ok: false, error: `repo "${repoPath}" has no .baiton/ directory; initialize Baiton there first` }
        : { ok: true, target };
    },

    async locate(slug: string): Promise<PlanRepoLookup> {
      const { set, owner, repos } = listedRepos();
      if (set === undefined || owner === undefined) {
        const target = makeFallback();
        return await deps.exists(resolveDocument(target.baitonDir, slug).documentPath)
          ? { kind: 'found', target }
          : { kind: 'missing' };
      }
      const ownerRepo = repos[0];
      if (ownerRepo?.baitonDir !== undefined && await deps.exists(resolveDocument(ownerRepo.baitonDir, slug).documentPath)) {
        const target = makeTarget(ownerRepo, owner, set);
        if (target !== undefined) return { kind: 'found', target };
      }
      const descendants = repos.slice(1).filter((repo) => repo.baitonDir !== undefined);
      const found = await Promise.all(descendants.map(async (repo) =>
        await deps.exists(resolveDocument(repo.baitonDir!, slug).documentPath) ? repo : undefined,
      ));
      const matches = found.filter((repo): repo is Repo => repo !== undefined);
      if (matches.length === 0) return { kind: 'missing' };
      if (matches.length > 1) {
        return { kind: 'ambiguous', repos: matches.map((repo) => infoFor(repo, owner).path) };
      }
      const target = makeTarget(matches[0], owner, set);
      return target === undefined ? { kind: 'missing' } : { kind: 'found', target };
    },
  };
}
