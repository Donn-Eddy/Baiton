/**
 * Workspace resolution (Requirements 22.3–22.8; design "Activation and
 * workspace resolution"). Repo discovery is supplied as an input, then this
 * pure selector chooses the primary repo while preserving the current
 * single-primary context for existing consumers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Result, ok, err } from '../model/result';
import type { Repo, RepoSet } from './repoDiscovery';

/**
 * The resolved workspace the extension operates on. `baitonDir` is the
 * `.baiton/` directory under the primary repo root; `restricted` mirrors VS
 * Code Restricted Mode.
 */
export interface WorkspaceContext<TUri> {
  /** The primary repo root the extension currently operates on. */
  readonly root: TUri;
  /** `<root>/.baiton`, derived by the shell. */
  readonly baitonDir: TUri;
  /** VS Code Restricted Mode: true disables writes and dispatch. */
  readonly restricted: boolean;
}

export interface PrimaryRepo<TUri> extends WorkspaceContext<TUri> {
  readonly repo: Repo;
}

export interface WorkspaceRepos<TUri> {
  readonly restricted: boolean;
  readonly repos: RepoSet;
  readonly primary: PrimaryRepo<TUri>;
}

/** Why workspace resolution failed. */
export type WorkspaceError =
  | { kind: 'no-folder'; message: string }
  | { kind: 'no-baiton-root'; message: string };

/**
 * Resolve the primary repo. A single opened folder remains primary even if it
 * is uninitialized; a multi-root workspace selects the first Baiton repo.
 */
export function resolveWorkspace<TUri>(
  repos: RepoSet,
  trusted: boolean,
  toUri: (fsPath: string) => TUri,
): Result<WorkspaceRepos<TUri>, WorkspaceError> {
  if (repos.folderRoots.length === 0) {
    return err({
      kind: 'no-folder',
      message: 'No workspace folder is open. Baiton needs a folder containing a .baiton/ directory.',
    });
  }

  let repo: Repo | undefined;
  if (repos.folderRoots.length === 1) {
    repo = repos.folderRoots[0];
  } else {
    repo = repos.folderRoots.find((folderRoot) => folderRoot.baitonDir !== undefined)
      ?? repos.repos.find((candidate) => candidate.baitonDir !== undefined);
  }

  if (!repo) {
    return err({
      kind: 'no-baiton-root',
      message: 'No workspace repo contains a .baiton/ directory. Run Baiton: Initialize to set one up.',
    });
  }

  const restricted = !trusted;
  const primary: PrimaryRepo<TUri> = {
    root: toUri(repo.root),
    baitonDir: toUri(repo.baitonDir ?? path.join(repo.root, '.baiton')),
    restricted,
    repo,
  };
  return ok({ restricted, repos, primary });
}

/** Seam over `fs.realpathSync.native` so tests can inject a fake realpath. */
export type RealpathFn = (p: string) => string;

/**
 * Canonicalize a workspace root by resolving symlinks in it, so Baiton spells
 * every derived path (terminal cwd, brief, result, journal, guard, PR diff) the
 * way a CLI launched with that cwd will spell its own.
 *
 * Motivating failure: on ostree-style hosts `/home` is a symlink to `/var/home`,
 * so VS Code reports the folder as `/home/<user>/<repo>` while opencode resolves
 * its project directory to `/var/home/<user>/<repo>`. opencode's
 * external-directory check is `path.relative(projectDir, file)` starting with
 * `..`, so the brief path Baiton puts in the initial prompt looks external and
 * triggers the `external_directory` permission ask; `opencode run` is
 * non-interactive, so the ask is auto-rejected and the stage fails before the
 * brief is ever read.
 *
 * Canonicalizing once at ingress (the shell's workspace-folder read) keeps
 * `WorkspaceContext.root`, `baitonDir`, and every consumer on a single
 * spelling. Falls back to the input when realpath throws (path missing,
 * permission error).
 */
export function canonicalizeRoot(
  fsPath: string,
  realpath: RealpathFn = fs.realpathSync.native,
): string {
  try {
    return realpath(fsPath);
  } catch {
    return fsPath;
  }
}
