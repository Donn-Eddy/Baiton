/**
 * Pure repository discovery, replacing the activation shell's single-root
 * selection. The shell supplies the filesystem seam so this module stays
 * independent of VS Code and direct filesystem access.
 */
import * as path from 'path';
import type { RepoTopology } from '../model/validator';

export type DirEntryKind = 'dir' | 'file' | 'other';

export interface DiscoveryDirEntry {
  readonly name: string;
  readonly kind: DirEntryKind;
}

export interface DiscoveryFs {
  readdir(dir: string): Promise<readonly DiscoveryDirEntry[]>;
}

export interface DiscoveryFolder {
  readonly name: string;
  /** Already canonicalized by the shell. */
  readonly root: string;
}

export interface Repo {
  readonly name: string;
  readonly folderName: string;
  readonly relPath: string;
  readonly root: string;
  readonly baitonDir?: string;
  readonly hasGit: boolean;
  readonly parent?: string;
  readonly children: readonly string[];
}

export interface RepoSet {
  /** Pre-order, folder by folder; each parent precedes children. */
  readonly repos: readonly Repo[];
  /** One entry per input folder, in input order. */
  readonly folderRoots: readonly Repo[];
  readonly truncated: boolean;
}

/** Project discovered repositories into the pure topology used by plan validation and phase targeting. */
export function repoTopologyFor(set: RepoSet, ownerName: string): RepoTopology {
  return {
    owner: ownerName,
    repos: set.repos.map((repo) => ({
      name: repo.name,
      root: repo.root,
      ...(repo.parent ? { parent: repo.parent } : {}),
    })),
  };
}

export interface DiscoveryOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export const DISCOVERY_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.baiton',
]);
export const DEFAULT_DISCOVERY_MAX_DEPTH = 12;
export const DEFAULT_DISCOVERY_MAX_ENTRIES = 50000;
export const SINGLE_ROOT_REPO_NAME = '.';

interface MutableRepo {
  name: string;
  folderName: string;
  relPath: string;
  root: string;
  baitonDir?: string;
  hasGit: boolean;
  parent?: string;
  children: string[];
}

/**
 * Walk workspace folders without following symlinks or entering Baiton's own
 * state directories. Repositories can be Git roots, Baiton roots, or the
 * workspace folder root itself.
 */
export async function discoverRepos(
  folders: readonly DiscoveryFolder[],
  fs: DiscoveryFs,
  opts: DiscoveryOptions = {},
): Promise<RepoSet> {
  const maxDepth = validBound(opts.maxDepth, DEFAULT_DISCOVERY_MAX_DEPTH);
  const maxEntries = validBound(opts.maxEntries, DEFAULT_DISCOVERY_MAX_ENTRIES);
  const duplicateCounts = new Map<string, number>();
  for (const folder of folders) {
    duplicateCounts.set(folder.name, (duplicateCounts.get(folder.name) ?? 0) + 1);
  }

  const recordedByRoot = new Map<string, MutableRepo>();
  const recordedByName = new Map<string, MutableRepo>();
  const folderRoots: MutableRepo[] = [];
  let entriesVisited = 0;
  let truncated = false;

  const folderNameAt = (folder: DiscoveryFolder, index: number): string =>
    (duplicateCounts.get(folder.name) ?? 0) > 1 &&
    folders.findIndex((candidate) => candidate.name === folder.name) !== index
      ? `${folder.name}~${index}`
      : folder.name;

  const list = async (dir: string): Promise<readonly DiscoveryDirEntry[]> => {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  };

  for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
    const folder = folders[folderIndex];
    const namedFolder = folderNameAt(folder, folderIndex);
    const folderRoot = path.resolve(folder.root);
    const existingFolderRoot = recordedByRoot.get(folderRoot);
    if (existingFolderRoot) {
      // Preserve the one-per-input-folder mapping while the first folder keeps
      // ownership and identity for an overlapping canonical root.
      folderRoots.push(existingFolderRoot);
      continue;
    }

    const localRepos: MutableRepo[] = [];

    const walk = async (
      absDir: string,
      relPath: string,
      depth: number,
      parentName: string | undefined,
      isFolderRoot: boolean,
    ): Promise<MutableRepo | undefined> => {
      const canonicalRoot = path.resolve(absDir);
      const alreadyRecorded = recordedByRoot.get(canonicalRoot);
      if (alreadyRecorded) {
        return alreadyRecorded;
      }

      if (entriesVisited >= maxEntries) {
        truncated = true;
        return undefined;
      }
      const entries = [...(await list(absDir))].sort((a, b) => compareNames(a.name, b.name));
      const room = Math.max(0, maxEntries - entriesVisited);
      if (entries.length > room) {
        truncated = true;
      }
      const visitedEntries = entries.slice(0, room);
      entriesVisited += visitedEntries.length;

      const gitEntry = visitedEntries.find(
        (entry) => entry.name === '.git' && (entry.kind === 'dir' || entry.kind === 'file'),
      );
      const baitonEntry = visitedEntries.find(
        (entry) => entry.name === '.baiton' && entry.kind === 'dir',
      );
      const isRepo = isFolderRoot || gitEntry !== undefined || baitonEntry !== undefined;
      const effectiveRelPath = relPath.split(path.sep).join('/');
      const name = folders.length === 1
        ? effectiveRelPath.length === 0 ? SINGLE_ROOT_REPO_NAME : effectiveRelPath
        : effectiveRelPath.length === 0
          ? namedFolder
          : `${namedFolder}/${effectiveRelPath}`;

      let currentParent = parentName;
      let currentRepo: MutableRepo | undefined;
      if (isRepo) {
        currentRepo = {
          name,
          folderName: folder.name,
          relPath: effectiveRelPath,
          root: canonicalRoot,
          ...(baitonEntry ? { baitonDir: path.join(canonicalRoot, '.baiton') } : {}),
          hasGit: gitEntry !== undefined,
          ...(isFolderRoot ? {} : parentName ? { parent: parentName } : {}),
          children: [],
        };
        recordedByRoot.set(canonicalRoot, currentRepo);
        recordedByName.set(name, currentRepo);
        localRepos.push(currentRepo);
        currentParent = name;
      }

      const childDirs = visitedEntries.filter(
        (entry) => entry.kind === 'dir' && !DISCOVERY_SKIP_DIRS.has(entry.name),
      );
      // A partially visited listing has unexamined entries. Do not descend
      // into any child after the entry bound was reached.
      const reachedEntryBound = entriesVisited >= maxEntries;
      for (let childIndex = 0; childIndex < childDirs.length; childIndex++) {
        const child = childDirs[childIndex];
        if (depth >= maxDepth || reachedEntryBound) {
          truncated = true;
          continue;
        }
        const childRelPath = relPath.length === 0
          ? child.name
          : path.join(relPath, child.name);
        await walk(path.join(canonicalRoot, child.name), childRelPath, depth + 1, currentParent, false);
      }

      return currentRepo;
    };

    const rootRepo = await walk(folderRoot, '', 0, undefined, true);
    if (rootRepo) {
      folderRoots.push(rootRepo);
    } else {
      // The root is unconditional even when the entry cap prevents listing it.
      // In this branch, no entry information was available, so its flags are
      // conservatively empty and later folders still retain the correct order.
      const rootRepoFallback: MutableRepo = {
        name: folders.length === 1 ? SINGLE_ROOT_REPO_NAME : namedFolder,
        folderName: folder.name,
        relPath: '',
        root: folderRoot,
        hasGit: false,
        children: [],
      };
      recordedByRoot.set(folderRoot, rootRepoFallback);
      recordedByName.set(rootRepoFallback.name, rootRepoFallback);
      localRepos.push(rootRepoFallback);
      folderRoots.push(rootRepoFallback);
    }

    // Rebuild this folder's output in repo-tree pre-order. A repo can be nested
    // below ordinary directories, so parent links rather than filesystem depth
    // determine the order.
    for (const repo of localRepos) {
      if (repo.parent) {
        const parent = recordedByName.get(repo.parent);
        if (parent && !parent.children.includes(repo.name)) {
          parent.children.push(repo.name);
        }
      }
    }
    for (const repo of localRepos) {
      repo.children.sort(compareNames);
    }
    // `localRepos` is only needed for parent/children stitching. The final
    // globally sorted tree is constructed below from the recorded parent map.
  }

  const ordered: MutableRepo[] = [];
  const append = (repo: MutableRepo, seen = new Set<string>()): void => {
    if (seen.has(repo.name)) {
      return;
    }
    seen.add(repo.name);
    ordered.push(repo);
    for (const childName of [...repo.children].sort(compareNames)) {
      const child = recordedByName.get(childName);
      if (child) {
        append(child, seen);
      }
    }
  };
  const emitted = new Set<string>();
  for (const folderRoot of folderRoots) {
    if (!emitted.has(folderRoot.name)) {
      append(folderRoot, emitted);
    }
  }
  const repos = ordered.map((repo) => Object.freeze({
    ...repo,
    children: Object.freeze([...repo.children].sort(compareNames)),
  }));
  const repoCopies = new Map(repos.map((repo) => [repo.name, repo] as const));
  const frozenFolderRoots = folderRoots.map((repo) => repoCopies.get(repo.name) ?? Object.freeze({
    ...repo,
    children: Object.freeze([...repo.children].sort(compareNames)),
  }));

  return {
    repos: Object.freeze(repos),
    folderRoots: Object.freeze(frozenFolderRoots),
    truncated,
  };
}

function validBound(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? fallback
    : Math.floor(value);
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Find a repo by its stable identity name. */
export function repoByName(set: RepoSet, name: string): Repo | undefined {
  return set.repos.find((repo) => repo.name === name);
}

/** Find the deepest discovered repo containing an absolute path. */
export function repoFor(set: RepoSet, absPath: string): Repo | undefined {
  let best: Repo | undefined;
  for (const repo of set.repos) {
    const relative = path.relative(repo.root, absPath);
    if (
      (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) &&
      (!best || repo.root.length > best.root.length)
    ) {
      best = repo;
    }
  }
  return best;
}

/** Whether `target` is `owner` or descends from it in the repo tree. */
export function isWithinSubtree(
  set: RepoSet,
  owner: Repo | string,
  target: Repo | string,
): boolean {
  const ownerName = typeof owner === 'string' ? owner : owner.name;
  let current = repoByName(set, typeof target === 'string' ? target : target.name);
  if (!repoByName(set, ownerName) || !current) {
    return false;
  }
  const seen = new Set<string>();
  while (current && !seen.has(current.name)) {
    if (current.name === ownerName) {
      return true;
    }
    seen.add(current.name);
    current = current.parent ? repoByName(set, current.parent) : undefined;
  }
  return false;
}

/** Repositories with a real `.baiton/` directory, in discovery order. */
export function reposWithBaiton(set: RepoSet): readonly Repo[] {
  return set.repos.filter((repo) => repo.baitonDir !== undefined);
}
