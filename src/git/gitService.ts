/**
 * The concrete {@link GitService}, implemented by shelling out to `git` (design
 * "Git service"). Every invocation runs `git` directly via `child_process`
 * with no intervening shell and with the repository working directory injected,
 * so the seam is testable against a temporary repo and safe from shell quoting.
 *
 * Read and mutating operations reject their promise on a non-zero git exit,
 * surfacing git's own stderr. The single exception is `resetWorkingTree`, which
 * returns a {@link Result} so the caller can halt the run before the next stage
 * when the reset fails (Req 15.5, 15.6).
 */
import { execFile } from 'child_process';
import { Result, err, ok } from '../model/result';
import { GitChange, GitError, GitService, GitStatus } from './types';

/** The relative directory that scopes a spec's own changes (Req 16.1). */
const SPEC_ROOT = '.baiton/specs';

/** Outcome of a single git invocation. */
interface GitRun {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Constructs a {@link GitService} bound to `repoRoot`. The working directory is
 * injected so callers (and tests) can point the service at any repository.
 */
export function createGitService(repoRoot: string): GitService {
  return new ShellGitService(repoRoot);
}

class ShellGitService implements GitService {
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
