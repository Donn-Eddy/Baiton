import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGitService } from '../src/git/gitService';
import { isErr, isOk } from '../src/model/result';

/**
 * Unit tests for the git service against a real temporary repository (Task 8.2).
 *
 * Each test creates a throwaway git repo under `os.tmpdir()`, initializes it
 * with a committed baseline and a local `user.name`/`user.email` so commits
 * succeed without touching global config, then drives the {@link createGitService}
 * seam through the behaviors the design pins down:
 *
 * - clean-except-spec-folder detection (Req 16.1)
 * - base-commit resolution of a branch to a sha (Req 16.3)
 * - branch creation + checkout (Req 16.5)
 * - commit with a `Run-Id:` trailer + find-by-Run-Id (Req 17.4, 21.5)
 * - `resetWorkingTree` restoring the tree and its non-zero failure path (Req 15.6)
 * - run worktrees: add on a new branch, porcelain list parsing, remove (plain and
 *   forced over local modifications)
 * - branch delete, merged and unmerged, with and without force
 * - `branchHead` resolving a ref or reporting undefined for a missing one
 * - `merge` as a real merge commit, and its aborted conflict/unknown-branch paths
 * - whole-tree `isClean`, distinct from the spec-scoped clean check
 *
 * Temp repos are removed after each test.
 */

/** Run git synchronously in `cwd`, throwing on non-zero exit (test helper). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Write a file at `repo/relPath`, creating parent directories as needed. */
function writeFile(repo: string, relPath: string, contents: string): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

/**
 * Create an initialized temp repo with a single committed file on `main`, a
 * local identity, and `main` as the default branch name regardless of the
 * host's git defaults. Returns the absolute repo path.
 */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-git-'));
  git(repo, 'init', '-q');
  // Local identity so commits do not depend on global git config.
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  // Normalize the branch name so branch-based assertions are deterministic.
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFile(repo, 'README.md', 'baseline\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}

describe('git service against a temp repo (Task 8.2)', () => {
  const repos: string[] = [];

  /** Register a fresh repo for automatic cleanup. */
  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  afterEach(() => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('isCleanExceptSpecFolder (Req 16.1)', () => {
    it('is true when the only change is inside .baiton/specs/<slug>/', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');

      assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), true);
    });

    it('is true for multiple changes all confined to the spec folder', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');
      writeFile(repo, '.baiton/specs/my-slug/runs.jsonl', '{}\n');

      assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), true);
    });

    it('is false when a change lies outside the spec folder', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');
      writeFile(repo, 'src/other.ts', 'export const x = 1;\n');

      assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), false);
    });

    it('is false when the change is in a different spec slug', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      writeFile(repo, '.baiton/specs/other-slug/spec.md', '# OVERVIEW\n');

      assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), false);
    });

    it('is true (vacuously) when the tree has no changes at all', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), true);
      const status = await git$.status();
      assert.strictEqual(status.clean, true);
      assert.deepStrictEqual(status.changes, []);
    });
  });

  describe('resolveBaseCommit (Req 16.3)', () => {
    it('resolves a branch name to its HEAD commit sha', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      const expected = git(repo, 'rev-parse', 'main').trim();
      const resolved = await git$.resolveBaseCommit('main');

      assert.match(resolved, /^[0-9a-f]{40}$/, 'should be a full 40-char sha');
      assert.strictEqual(resolved, expected);
    });

    it('rejects when the base ref does not exist', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      await assert.rejects(() => git$.resolveBaseCommit('no-such-branch'));
    });
  });

  describe('createSpecBranch + checkout (Req 16.5)', () => {
    it('creates a branch at the base commit and checks it out', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');

      await git$.createSpecBranch('baiton/my-slug', base);
      await git$.checkout('baiton/my-slug');

      assert.strictEqual(await git$.currentBranch(), 'baiton/my-slug');
      // The new branch points at exactly the base commit.
      assert.strictEqual(await git$.head(), base);
    });
  });

  describe('commit with Run-Id trailer + findCommitByRunId (Req 17.4, 21.5)', () => {
    it('commits with a Run-Id trailer and finds it by run id', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const runId = 'run-2024-abcdef';

      writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');
      const sha = await git$.commit('spec(my-slug): T01 execute attempt 1', {
        'Run-Id': runId,
      });

      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.strictEqual(sha, await git$.head());

      // The trailer is present as its own line in the commit body.
      const body = git(repo, 'log', '-1', '--format=%B').trim();
      assert.ok(
        body.split('\n').some((line) => line === `Run-Id: ${runId}`),
        `commit body should carry a "Run-Id: ${runId}" trailer line; got:\n${body}`,
      );

      const found = await git$.findCommitByRunId(runId);
      assert.strictEqual(found, sha, 'should find the commit by its run id');
    });

    it('returns undefined when no commit carries the run id', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      assert.strictEqual(await git$.findCommitByRunId('run-missing'), undefined);
    });

    it('does not match a run id that is only a prefix of another trailer', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');
      await git$.commit('spec(my-slug): T01 execute attempt 1', {
        'Run-Id': 'run-longer-id',
      });

      // A shorter id that is a prefix must not spuriously match the anchored trailer.
      assert.strictEqual(await git$.findCommitByRunId('run-longer'), undefined);
    });

    it('finds the right commit among several trailered commits', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      writeFile(repo, '.baiton/specs/my-slug/a.md', 'a\n');
      await git$.commit('spec(my-slug): T01 execute attempt 1', {
        'Run-Id': 'run-aaa',
      });
      writeFile(repo, '.baiton/specs/my-slug/b.md', 'b\n');
      const shaB = await git$.commit('spec(my-slug): T02 execute attempt 1', {
        'Run-Id': 'run-bbb',
      });

      assert.strictEqual(await git$.findCommitByRunId('run-bbb'), shaB);
    });
  });

  describe('resetWorkingTree (Req 15.6)', () => {
    it('restores tracked edits and removes untracked files, returning ok', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      // Dirty the tree: modify a tracked file and add an untracked one.
      writeFile(repo, 'README.md', 'baseline\nlocal edit\n');
      writeFile(repo, 'scratch.txt', 'untracked\n');
      assert.strictEqual((await git$.status()).clean, false);

      const result = await git$.resetWorkingTree();
      assert.ok(isOk(result), 'reset should succeed on a healthy repo');

      // Tracked file reverted, untracked file removed => clean tree.
      assert.strictEqual((await git$.status()).clean, true);
      assert.strictEqual(
        fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
        'baseline\n',
        'tracked edit should be reverted',
      );
      assert.strictEqual(
        fs.existsSync(path.join(repo, 'scratch.txt')),
        false,
        'untracked file should be removed',
      );
    });

    it('returns a GitError result when git fails (non-repo directory)', async () => {
      // Point the service at a plain temp directory that is NOT a git repo, so
      // `git checkout -- .` exits non-zero and the reset returns an error rather
      // than throwing (Req 15.6).
      const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-nongit-'));
      try {
        const git$ = createGitService(nonRepo);
        const result = await git$.resetWorkingTree();

        assert.ok(isErr(result), 'reset should fail outside a git repo');
        assert.notStrictEqual(
          result.error.exitCode,
          0,
          'error should carry the non-zero exit code',
        );
        assert.ok(
          result.error.command.startsWith('git '),
          'error should name the git command that failed',
        );
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('run worktrees, branch delete, branchHead, merge and isClean', () => {
    const scratch: string[] = [];

    /**
     * A fresh temp directory OUTSIDE any repository, registered for cleanup.
     * Worktrees live in sibling scratch dirs rather than inside the repo, so a
     * worktree's own files can never perturb the repo's status (and hence
     * `isClean`).
     */
    function newScratch(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-wt-'));
      scratch.push(dir);
      return dir;
    }

    /** A not-yet-existing worktree path; git creates the leaf directory itself. */
    function newWorktreePath(name = 'run-1'): string {
      return path.join(newScratch(), name);
    }

    afterEach(() => {
      while (scratch.length > 0) {
        const dir = scratch.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('adds a worktree on a new branch and lists both worktrees', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();

      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      assert.strictEqual(fs.existsSync(wt), true, 'worktree directory should exist');
      const inWorktree = createGitService(wt);
      assert.strictEqual(await inWorktree.currentBranch(), 'baiton/bug/run-1');
      assert.strictEqual(await inWorktree.head(), base);

      const worktrees = await git$.listWorktrees();
      assert.strictEqual(worktrees.length, 2, 'main worktree plus the added one');
      // Git prints realpaths, so compare against the realpath of each input.
      assert.strictEqual(worktrees[0].dir, fs.realpathSync(repo));
      assert.strictEqual(worktrees[0].branch, 'main');
      const added = worktrees.find((entry) => entry.branch === 'baiton/bug/run-1');
      assert.ok(added, 'the added worktree should be listed');
      assert.strictEqual(added.dir, fs.realpathSync(wt));
      assert.strictEqual(added.head, base);
      assert.strictEqual(added.locked, false);
      assert.strictEqual(added.prunable, false);
    });

    it('rejects addWorktree when the branch already exists', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      await git$.createSpecBranch('taken', base);

      // `-b`, not `-B`: a collision must fail loudly rather than reset the branch.
      await assert.rejects(() => git$.addWorktree(newWorktreePath(), 'taken', base));
    });

    it('reports a locked worktree as locked', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      git(repo, 'worktree', 'lock', wt);
      try {
        const added = (await git$.listWorktrees()).find(
          (entry) => entry.branch === 'baiton/bug/run-1',
        );
        assert.ok(added, 'the added worktree should be listed');
        assert.strictEqual(added.locked, true);
      } finally {
        // Unlock so directory cleanup is unaffected by the lock.
        git(repo, 'worktree', 'unlock', wt);
      }
    });

    it('removes a worktree and its directory', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      await git$.removeWorktree(wt);

      assert.strictEqual((await git$.listWorktrees()).length, 1, 'only the main worktree left');
      assert.strictEqual(fs.existsSync(wt), false, 'worktree directory should be gone');
    });

    it('refuses to remove a dirty worktree without force and removes it with force', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      // Local modifications inside the worktree: a modified tracked file and an
      // untracked leftover, as a stage that failed mid-edit would leave behind.
      writeFile(wt, 'README.md', 'baseline\nrun edit\n');
      writeFile(wt, 'scratch.txt', 'leftover\n');

      await assert.rejects(() => git$.removeWorktree(wt));
      assert.strictEqual(fs.existsSync(wt), true, 'refused removal should leave it in place');

      await git$.removeWorktree(wt, true);
      assert.strictEqual(fs.existsSync(wt), false, 'forced removal should delete it');
      assert.strictEqual((await git$.listWorktrees()).length, 1);
    });

    it('resolves branchHead for existing refs and returns undefined for a missing one', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const expected = git(repo, 'rev-parse', 'main').trim();

      assert.strictEqual(await git$.branchHead('main'), expected);
      assert.strictEqual(await git$.branchHead('HEAD'), expected);
      // Deliberately undefined rather than a rejection.
      assert.strictEqual(await git$.branchHead('no-such-branch'), undefined);
    });

    it('merges a run branch back as a two-parent merge commit', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      writeFile(wt, 'src/run.ts', 'export const run = 1;\n');
      await createGitService(wt).commit('run work', { 'Run-Id': 'run-1' });

      const merged = await git$.merge('baiton/bug/run-1', 'baiton: merge run-1');

      assert.ok(isOk(merged), 'a clean merge should succeed');
      assert.match(merged.value, /^[0-9a-f]{40}$/);
      assert.strictEqual(merged.value, await git$.head(), 'the value is the new HEAD');
      // `--no-ff` guarantees a merge commit: `<merge> <parent1> <parent2>`.
      const parents = git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/);
      assert.strictEqual(parents.length, 3, `merge commit should have two parents: ${parents}`);
      assert.ok(git(repo, 'log', '-1', '--format=%s').includes('baiton: merge run-1'));
      assert.strictEqual(
        fs.existsSync(path.join(repo, 'src/run.ts')),
        true,
        "the run branch's file should now be in the base working tree",
      );
      assert.strictEqual(await git$.isClean(), true, 'a completed merge leaves a clean tree');
    });

    it('composes merge, worktree removal and branch delete as run cleanup', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);
      writeFile(wt, 'src/run.ts', 'export const run = 1;\n');
      await createGitService(wt).commit('run work', { 'Run-Id': 'run-1' });
      assert.ok(isOk(await git$.merge('baiton/bug/run-1', 'baiton: merge run-1')));

      await git$.removeWorktree(wt);
      // Plain `-d` suffices: the branch is merged.
      await git$.deleteBranch('baiton/bug/run-1');

      assert.strictEqual(await git$.branchHead('baiton/bug/run-1'), undefined);
      assert.strictEqual((await git$.listWorktrees()).length, 1);
    });

    it('refuses to delete an unmerged branch without force and deletes it with force', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);
      writeFile(wt, 'src/run.ts', 'export const run = 1;\n');
      await createGitService(wt).commit('run work', { 'Run-Id': 'run-1' });
      // The branch must not be checked out anywhere for a delete to be attempted.
      await git$.removeWorktree(wt);

      await assert.rejects(() => git$.deleteBranch('baiton/bug/run-1'));
      assert.notStrictEqual(await git$.branchHead('baiton/bug/run-1'), undefined);

      await git$.deleteBranch('baiton/bug/run-1', true);
      assert.strictEqual(await git$.branchHead('baiton/bug/run-1'), undefined);
    });

    it('returns an error and aborts the merge on a conflict', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);
      const base = await git$.resolveBaseCommit('main');
      const wt = newWorktreePath();
      await git$.addWorktree(wt, 'baiton/bug/run-1', base);

      // Conflicting edits to the same file on both sides.
      writeFile(wt, 'README.md', 'baseline\nfrom the run\n');
      await createGitService(wt).commit('run work', { 'Run-Id': 'run-1' });
      writeFile(repo, 'README.md', 'baseline\nfrom main\n');
      await git$.commit('main work');

      const merged = await git$.merge('baiton/bug/run-1', 'baiton: merge run-1');

      assert.ok(isErr(merged), 'a conflicting merge should fail');
      assert.ok(
        merged.error.command.startsWith('git '),
        'the error should name the git command that failed',
      );
      assert.notStrictEqual(merged.error.exitCode, 0);
      // The failed merge is aborted, so the repo is not left mid-merge.
      assert.strictEqual(
        fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')),
        false,
        'the merge should have been aborted',
      );
      assert.strictEqual(
        fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
        'baseline\nfrom main\n',
        "the base branch's content should be intact",
      );
      assert.strictEqual(await git$.isClean(), true, 'the tree is left as it was');
    });

    it('returns an error rather than throwing when the merged branch does not exist', async () => {
      const repo = newRepo();
      const git$ = createGitService(repo);

      const merged = await git$.merge('no-such-branch', 'baiton: merge nothing');

      assert.ok(isErr(merged), 'merging a missing branch should be an error Result');
      assert.notStrictEqual(merged.error.exitCode, 0);
      assert.strictEqual(await git$.isClean(), true);
    });

    describe('isClean (whole tree)', () => {
      it('is true on a freshly committed repo', async () => {
        const git$ = createGitService(newRepo());

        assert.strictEqual(await git$.isClean(), true);
      });

      it('is false with an untracked file', async () => {
        const repo = newRepo();
        const git$ = createGitService(repo);
        writeFile(repo, 'scratch.txt', 'untracked\n');

        assert.strictEqual(await git$.isClean(), false);
      });

      it('is false with a modified tracked file', async () => {
        const repo = newRepo();
        const git$ = createGitService(repo);
        writeFile(repo, 'README.md', 'baseline\nlocal edit\n');

        assert.strictEqual(await git$.isClean(), false);
      });

      it('is false where isCleanExceptSpecFolder is true (they are different checks)', async () => {
        const repo = newRepo();
        const git$ = createGitService(repo);
        writeFile(repo, '.baiton/specs/my-slug/spec.md', '# OVERVIEW\n');

        assert.strictEqual(await git$.isCleanExceptSpecFolder('my-slug'), true);
        assert.strictEqual(await git$.isClean(), false);
      });
    });
  });
});
