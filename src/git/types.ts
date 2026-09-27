/**
 * Types for the git service seam (design "Git service").
 *
 * The git service is the single seam through which every git operation runs so
 * the journal and recovery see one place for reads, writes and resets (design
 * "Git service"). These types describe the working-tree status the service
 * reports and the structured error it surfaces from a non-zero git invocation.
 */
import { Result } from '../model/result';

/**
 * A single changed path reported by `git status --porcelain`, carrying the
 * two-character XY status code and the path relative to the repository root.
 * Renames are represented by their destination path (the post-arrow side of a
 * porcelain rename entry).
 */
export interface GitChange {
  /** The two-character porcelain status code, e.g. ` M`, `??`, `A `, `R `. */
  readonly code: string;
  /** The changed path, relative to the repository root, forward-slash form. */
  readonly path: string;
}

/**
 * The result of `status()`: whether the working tree has no changes at all and
 * the full list of changed paths. `clean` is true if and only if `changes` is
 * empty; callers that need the narrower "clean except one spec folder" check
 * use {@link GitService.isCleanExceptSpecFolder} instead (Req 16.1).
 */
export interface GitStatus {
  /** True when the working tree reports no changes of any kind. */
  readonly clean: boolean;
  /** Every changed path the porcelain status reported. */
  readonly changes: readonly GitChange[];
}

/**
 * A structured failure from a git invocation. Surfaced by operations that
 * return a {@link Result} (currently `resetWorkingTree`) so a non-zero reset can
 * halt the run before the next stage with a message identifying what failed
 * (Req 15.6).
 */
export interface GitError {
  /** The git argv that was run, joined for display (no shell involved). */
  readonly command: string;
  /** The process exit code, or undefined when the process did not exit normally. */
  readonly exitCode: number | undefined;
  /** Captured standard error output from the failed invocation. */
  readonly stderr: string;
}

/**
 * The git service seam. Every method shells out to `git` in an injectable repo
 * working directory; none of them touch a shell (arguments are passed as an
 * argv array). Read operations reject on a non-zero exit; `resetWorkingTree`
 * instead returns a {@link Result} so callers can halt the run deliberately
 * (Req 15.5, 15.6).
 */
export interface GitService {
  /** Report the working-tree status via porcelain output. */
  status(): Promise<GitStatus>;
  /**
   * Treat the tree as clean if and only if every change is confined to
   * `.baiton/specs/<slug>/` (Req 16.1).
   */
  isCleanExceptSpecFolder(slug: string): Promise<boolean>;
  /** Fetch the configured remote (Req 16.3). */
  fetch(remote: string): Promise<void>;
  /** Resolve a base ref to a single commit sha (Req 16.3). */
  resolveBaseCommit(base: string): Promise<string>;
  /** Create a new branch pointing at `fromCommit` (Req 16.5). */
  createSpecBranch(branch: string, fromCommit: string): Promise<void>;
  /** Check out an existing branch (Req 16.5, 16.6). */
  checkout(branch: string): Promise<void>;
  /**
   * Stage all working-tree changes and create one commit, appending each
   * trailer as a `Key: value` line (e.g. `Run-Id: <id>`). Returns the new
   * commit sha (Req 17.1, 17.4).
   */
  commit(message: string, trailers?: Record<string, string>): Promise<string>;
  /** The current HEAD commit sha (Req 17.2). */
  head(): Promise<string>;
  /** The current branch name (Req 17.6). */
  currentBranch(): Promise<string>;
  /** The diff between a commit and a ref. */
  diff(fromCommit: string, toRef: string): Promise<string>;
  /**
   * The diff of the working tree against a ref (default `HEAD`), i.e. what the
   * orchestrator's `git_diff(ref?)` read tool surfaces. With no ref this shows
   * unstaged+staged working-tree changes against `HEAD`.
   */
  diffAgainstWorkingTree(ref?: string): Promise<string>;
  /**
   * The most recent `n` commits as `<sha> <subject>` lines (newest first), i.e.
   * what the orchestrator's `git_log(n)` read tool surfaces.
   */
  log(n: number): Promise<string>;
  /**
   * Restore the working tree with `git checkout -- .` then `git clean -fd`,
   * returning a failure Result on the first non-zero exit rather than throwing
   * so the caller can halt the run (Req 15.5, 15.6).
   */
  resetWorkingTree(): Promise<Result<void, GitError>>;
  /**
   * Find the sha of a commit whose message carries a `Run-Id: <runId>` trailer,
   * or undefined when no such commit exists (Req 21.5).
   */
  findCommitByRunId(runId: string): Promise<string | undefined>;
  /**
   * Push `branch` to `remote`, setting its upstream (Req 8 "PR"). Rejects with
   * a {@link GitError} carrying the remote's stderr on a rejected push.
   */
  push(remote: string, branch: string): Promise<void>;
  /** The fetch URL of `remote` (`git remote get-url`), for PR provider detection. */
  remoteUrl(remote: string): Promise<string>;
}

/**
 * One entry of `git worktree list --porcelain`: a working tree attached to this
 * repository, either the main one or a linked run worktree (design "Git
 * service", the run worktree design).
 */
export interface GitWorktree {
  /**
   * The worktree's directory, as the absolute path git reports. Git prints the
   * realpath, which can differ from the path the worktree was created with when
   * a parent is a symlink (e.g. `/tmp` on macOS), so callers compare with
   * `fs.realpathSync` rather than raw string equality.
   */
  readonly dir: string;
  /** The commit sha the worktree's HEAD points at; undefined for a bare entry. */
  readonly head: string | undefined;
  /**
   * The checked-out branch's short name, with `refs/heads/` stripped; undefined
   * when the worktree is detached or bare.
   */
  readonly branch: string | undefined;
  /** True when git reports the worktree as locked. */
  readonly locked: boolean;
  /** True when git reports the worktree as prunable. */
  readonly prunable: boolean;
}

/**
 * The git service seam widened with the worktree and merge primitives a run
 * needs: a run works in its own linked worktree on its own branch, and the
 * result is merged back into the base branch and cleaned up (design "Git
 * service", the run worktree design).
 *
 * The same convention as {@link GitService} holds: reads reject on an unexpected
 * non-zero exit, the mutators `addWorktree`, `removeWorktree` and
 * `deleteBranch` reject with a {@link GitError} like `createSpecBranch`,
 * `checkout` and `commit`, and only `merge` returns a {@link Result}, because a
 * conflict is an ordinary outcome the caller reports as a named reason rather
 * than a fault (same rationale as `resetWorkingTree`, Req 15.6).
 */
export interface GitWorktreeService extends GitService {
  /**
   * Create a new worktree at `dir`, checked out on a NEW branch `branch`
   * starting at `fromCommit`.
   */
  addWorktree(dir: string, branch: string, fromCommit: string): Promise<void>;
  /**
   * Every worktree of this repository, the main worktree first (git's own
   * order).
   */
  listWorktrees(): Promise<readonly GitWorktree[]>;
  /**
   * Remove a worktree's registration and its directory. Without `force` git
   * refuses a worktree carrying local modifications; `force` removes it anyway.
   */
  removeWorktree(dir: string, force?: boolean): Promise<void>;
  /**
   * Delete a local branch. Without `force` git refuses a branch that has not
   * been merged.
   */
  deleteBranch(branch: string, force?: boolean): Promise<void>;
  /**
   * The commit sha `ref` resolves to, or undefined when the ref does not exist.
   * Deliberately not a rejection: callers compare a base branch's head to a
   * remembered sha and must tolerate a branch that has since been deleted.
   */
  branchHead(ref: string): Promise<string | undefined>;
  /**
   * Merge `branch` into the currently checked-out branch as a real merge commit,
   * returning the new merge commit's sha. A failed merge is aborted, so the tree
   * is left as it was.
   */
  merge(branch: string, message: string): Promise<Result<string, GitError>>;
  /**
   * True when the WHOLE working tree has no changes of any kind — the run
   * pipeline's `dirty-tree` check, as opposed to the spec-scoped
   * {@link GitService.isCleanExceptSpecFolder}.
   */
  isClean(): Promise<boolean>;
}
