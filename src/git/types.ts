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
