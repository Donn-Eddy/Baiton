/**
 * The concrete git service, implemented by shelling out to `git` (design
 * "Git service"). Every invocation runs `git` directly via `child_process`
 * with no intervening shell and with the repository working directory injected,
 * so the seam is testable against a temporary repo and safe from shell quoting.
 *
 * Read and mutating operations reject their promise on a non-zero git exit,
 * surfacing git's own stderr. The exceptions are `resetWorkingTree` and `merge`,
 * which return a {@link Result} so the caller can halt the run before the next
 * stage, or report a conflict as a named reason, instead of faulting (Req 15.5,
 * 15.6).
 */
import { execFile } from 'child_process';
import { Result, err, ok } from '../model/result';
import {
  GitChange,
  GitError,
  GitStatus,
  GitWorktree,
  GitWorktreeService,
} from './types';

/** The relative directory that scopes a spec's own changes (Req 16.1). */
const SPEC_ROOT = '.baiton/specs';

/** Outcome of a single git invocation. */
interface GitRun {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Constructs a {@link GitWorktreeService} bound to `repoRoot`. The working
 * directory is injected so callers (and tests) can point the service at any
 * repository — including a linked worktree, which is a repository working
 * directory like any other.
 */
export function createGitService(repoRoot: string): GitWorktreeService {
  return new ShellGitService(repoRoot);
}

class ShellGitService implements GitWorktreeService {
  constructor(private readonly repoRoot: string) {}

  async status(): Promise<GitStatus> {
    // `--untracked-files=all` lists each untracked file individually. Without
    // it, git collapses a fully-untracked directory to its shallowest parent
    // (e.g. a brand-new `.baiton/specs/<slug>/` reports as `.baiton/`), which
    // would defeat the clean-except-spec-folder prefix check (Req 16.1).
    const out = await this.runOrThrow(['status', '--porcelain', '--untracked-files=all']);
    const changes = parsePorcelain(out);
    return { clean: changes.length === 0, changes };
  }

  async isCleanExceptSpecFolder(slug: string): Promise<boolean> {
    const { changes } = await this.status();
    const prefix = `${SPEC_ROOT}/${slug}/`;
    return changes.every((change) => change.path.startsWith(prefix));
  }

  async fetch(remote: string): Promise<void> {
    await this.runOrThrow(['fetch', remote]);
  }

  async resolveBaseCommit(base: string): Promise<string> {
    const out = await this.runOrThrow(['rev-parse', '--verify', `${base}^{commit}`]);
    return out.trim();
  }

  async createSpecBranch(branch: string, fromCommit: string): Promise<void> {
    await this.runOrThrow(['branch', branch, fromCommit]);
  }

  async checkout(branch: string): Promise<void> {
    await this.runOrThrow(['checkout', branch]);
  }

  async commit(message: string, trailers?: Record<string, string>): Promise<string> {
    await this.runOrThrow(['add', '-A']);
    const fullMessage = withTrailers(message, trailers);
    await this.runOrThrow(['commit', '-m', fullMessage]);
    return this.head();
  }

  async head(): Promise<string> {
    const out = await this.runOrThrow(['rev-parse', 'HEAD']);
    return out.trim();
  }

  async currentBranch(): Promise<string> {
    const out = await this.runOrThrow(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  }

  async diff(fromCommit: string, toRef: string): Promise<string> {
    return this.runOrThrow(['diff', fromCommit, toRef]);
  }

  async diffAgainstWorkingTree(ref?: string): Promise<string> {
    // `git diff <ref>` compares the working tree to <ref>; with no ref, HEAD.
    const args = ref ? ['diff', ref] : ['diff', 'HEAD'];
    return this.runOrThrow(args);
  }

  async log(n: number): Promise<string> {
    const count = Number.isInteger(n) && n >= 1 ? n : 1;
    const out = await this.runOrThrow([
      'log',
      `--max-count=${count}`,
      '--format=%H %s',
    ]);
    return out.trimEnd();
  }

  async resetWorkingTree(): Promise<Result<void, GitError>> {
    const checkout = await this.run(['checkout', '--', '.']);
    if (checkout.exitCode !== 0) {
      return err(toGitError(['checkout', '--', '.'], checkout));
    }
    const clean = await this.run(['clean', '-fd']);
    if (clean.exitCode !== 0) {
      return err(toGitError(['clean', '-fd'], clean));
    }
    return ok(undefined);
  }

  async findCommitByRunId(runId: string): Promise<string | undefined> {
    // Match the exact trailer line `Run-Id: <runId>` anywhere in a commit
    // message body, scanning the full history reachable from HEAD (Req 21.5).
    const grep = `^Run-Id: ${escapeBasicRegex(runId)}$`;
    const out = await this.runOrThrow([
      'log',
      '--all',
      '--format=%H',
      '--extended-regexp',
      `--grep=${grep}`,
      '--max-count=1',
    ]);
    const sha = out.trim().split('\n')[0]?.trim();
    return sha ? sha : undefined;
  }

  /** Run git and reject with a {@link GitError} on any non-zero exit. */
  async push(remote: string, branch: string): Promise<void> {
    await this.runOrThrow(['push', '--set-upstream', remote, branch]);
  }

  async remoteUrl(remote: string): Promise<string> {
    const out = await this.runOrThrow(['remote', 'get-url', remote]);
    return out.trim();
  }

  async addWorktree(dir: string, branch: string, fromCommit: string): Promise<void> {
    // `-b` (not `-B`) is deliberate: an id collision must fail loudly rather
    // than silently reset an existing branch to `fromCommit`.
    await this.runOrThrow(['worktree', 'add', '-b', branch, dir, fromCommit]);
  }

  async listWorktrees(): Promise<readonly GitWorktree[]> {
    const out = await this.runOrThrow(['worktree', 'list', '--porcelain']);
    return parseWorktreeList(out);
  }

  async removeWorktree(dir: string, force = false): Promise<void> {
    await this.runOrThrow(['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.runOrThrow(['branch', force ? '-D' : '-d', branch]);
  }

  async branchHead(ref: string): Promise<string | undefined> {
    // The non-throwing `run`, so a missing ref is `undefined` rather than a
    // rejection (a caller comparing against a remembered sha must tolerate a
    // branch that has since been deleted).
    const result = await this.run(['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const sha = result.stdout.trim();
    return sha ? sha : undefined;
  }

  async merge(branch: string, message: string): Promise<Result<string, GitError>> {
    // `--no-ff` guarantees a merge commit, so `message` is always recorded even
    // when the base could fast-forward.
    const args = ['merge', '--no-ff', '--no-edit', '-m', message, branch];
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      // Leave the tree as it was: without this a conflicted merge would keep the
      // repository in merge state and misfire every later dirty-tree check. The
      // abort's own exit code is ignored because it is non-zero when the merge
      // failed before any merge state existed (e.g. an unknown branch).
      await this.run(['merge', '--abort']);
      return err(toGitError(args, result));
    }
    return ok(await this.head());
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).clean;
  }

  private async runOrThrow(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw toGitError(args, result);
    }
    return result.stdout;
  }

  /** Run git in the repo root, capturing exit code and streams (never rejects). */
  private run(args: string[]): Promise<GitRun> {
    return new Promise<GitRun>((resolve) => {
      execFile(
        'git',
        args,
        { cwd: this.repoRoot, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? undefined
                : 0;
          resolve({ exitCode, stdout, stderr });
        },
      );
    });
  }
}

/** Parse `git status --porcelain` output into structured changes. */
function parsePorcelain(output: string): GitChange[] {
  const changes: GitChange[] = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    changes.push({ code, path: destinationPath(rest) });
  }
  return changes;
}

/**
 * Parse `git worktree list --porcelain` output into structured worktrees,
 * preserving git's order (the main worktree first). Records are separated by
 * blank lines and carry one key per line: `worktree <path>` opens a record,
 * `HEAD <sha>` and `branch refs/heads/<name>` fill it in, `bare` and `detached`
 * simply leave `head`/`branch` unset, and `locked`/`prunable` (each optionally
 * followed by a reason) raise their flag.
 *
 * The reported `dir` is whatever absolute path git prints, which is the realpath
 * — it can differ from a symlinked input such as `/tmp` on macOS — so callers
 * compare with `fs.realpathSync` rather than raw equality.
 */
function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  for (const record of output.split(/\n\s*\n/)) {
    let dir: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let locked = false;
    let prunable = false;
    for (const line of record.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const space = trimmed.indexOf(' ');
      const key = space >= 0 ? trimmed.slice(0, space) : trimmed;
      const value = space >= 0 ? trimmed.slice(space + 1) : '';
      if (key === 'worktree') {
        dir = value;
      } else if (key === 'HEAD') {
        head = value;
      } else if (key === 'branch') {
        branch = value.startsWith(HEADS_PREFIX) ? value.slice(HEADS_PREFIX.length) : value;
      } else if (key === 'locked') {
        locked = true;
      } else if (key === 'prunable') {
        prunable = true;
      }
    }
    // A record with no `worktree` line is not a worktree (e.g. trailing output).
    if (dir !== undefined) {
      worktrees.push({ dir, head, branch, locked, prunable });
    }
  }
  return worktrees;
}

/** The ref namespace git prints in a porcelain worktree `branch` line. */
const HEADS_PREFIX = 'refs/heads/';

/**
 * The path a porcelain entry refers to. Rename/copy entries are `old -> new`;
 * the destination is what now exists in the tree, so it is the path that must
 * be inside the spec folder for the tree to count as clean-except-spec (Req
 * 16.1).
 */
function destinationPath(rest: string): string {
  const arrow = rest.indexOf(' -> ');
  const raw = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  return unquote(raw);
}

/**
 * Undo git's C-style quoting of paths with unusual characters. When
 * `core.quotepath` renders a path it wraps it in double quotes; strip them so
 * the prefix check compares plain paths.
 */
function unquote(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    return path.slice(1, -1);
  }
  return path;
}

/**
 * Append trailers to a commit message as `Key: value` lines separated from the
 * body by a blank line, e.g. `Run-Id: <id>` (Req 17.4). Returns the message
 * unchanged when there are no trailers.
 */
function withTrailers(message: string, trailers?: Record<string, string>): string {
  const entries = trailers ? Object.entries(trailers) : [];
  if (entries.length === 0) {
    return message;
  }
  const trailerBlock = entries.map(([key, value]) => `${key}: ${value}`).join('\n');
  return `${message}\n\n${trailerBlock}`;
}

/** Escape the characters that carry meaning in git's ERE `--grep` pattern. */
function escapeBasicRegex(input: string): string {
  return input.replace(/[.*+?()|{}\\^$[\]]/g, '\\$&');
}

/** Build a {@link GitError} from a failed invocation. */
function toGitError(args: string[], run: GitRun): GitError {
  return {
    command: ['git', ...args].join(' '),
    exitCode: run.exitCode,
    stderr: run.stderr,
  };
}
