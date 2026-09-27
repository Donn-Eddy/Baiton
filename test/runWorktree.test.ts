import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import {
  type RunWorktreeDeps,
  createRunGitService,
  createRunWorktree,
  findRunWorktree,
  mergeRunWorktree,
  removeRunWorktree,
  runMergeMessage,
} from '../src/engine/runWorktree';
import { runBranchFor, runWorktreeDirFor } from '../src/engine/runStore';

/**
 * Unit tests for the run worktree lifecycle (T06), driven against real temporary
 * git repositories:
 *
 * - `createRunWorktree` creating `.baiton/worktrees/<id>/` on `baiton/<mode>/<id>`
 *   at the base head, leaving the main checkout clean, and each of its refusals
 * - the worktree-bound git service from `createRunGitService`
 * - `mergeRunWorktree`'s happy path (a real merge commit with a `Run-Id:` trailer,
 *   followed by cleanup) and its `wrong-branch`, `base-moved`, `dirty-tree`,
 *   `missing-branch` and `conflict` refusals, including their precedence
 * - `removeRunWorktree`'s idempotence
 * - `runMergeMessage`'s subject and trailer
 *
 * Every worktree is created inside its repo's own `.baiton/worktrees/` — the
 * production layout these tests exist to pin — and each temp repo is removed
 * after the test.
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
 * Create an initialized temp repo on `main` with a local identity, a committed
 * `README.md` and a committed `.baiton/.gitignore` holding the canonical
 * exclusion list. That ignore file is load-bearing: without it a worktree created
 * under `.baiton/worktrees/` makes the tree dirty and the merge path's own
 * `dirty-tree` check fires everywhere.
 */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runworktree-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFile(repo, 'README.md', 'baseline\n');
  writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}

describe('run worktree lifecycle (T06)', () => {
  const repos: string[] = [];

  /** Register a fresh repo for automatic cleanup. */
  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  /** Deps bound to the main checkout of `repo`. */
  function depsFor(repo: string): RunWorktreeDeps {
    return { workspaceRoot: repo, git: createGitService(repo) };
  }

  afterEach(() => {
    while (repos.length > 0) {
      const repo = repos.pop()!;
      // Deregister any worktree first so git's administrative files do not keep
      // the directory alive; a forced rm is enough either way.
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('createRunWorktree', () => {
    it('creates the worktree on the run branch at the base head', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-20260926-120000-abcd';
      const baseHead = (await deps.git.branchHead('main'))!;

      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok, 'expected the worktree to be created');
      const info = created.value;

      assert.strictEqual(info.branch, `baiton/quick/${runId}`);
      assert.strictEqual(info.baseBranch, 'main');
      assert.strictEqual(info.baseHead, baseHead);
      assert.strictEqual(info.relativeWorktreeDir, `.baiton/worktrees/${runId}`);
      assert.strictEqual(info.worktreeDir, runWorktreeDirFor(repo, runId));
      assert.ok(fs.existsSync(path.join(info.worktreeDir, 'README.md')));

      const registered = await findRunWorktree(deps, runId);
      assert.ok(registered, 'expected git to list the run worktree');
      assert.strictEqual(fs.realpathSync(registered.dir), fs.realpathSync(info.worktreeDir));
      assert.strictEqual(registered.branch, info.branch);
      assert.strictEqual(await deps.git.branchHead(info.branch), baseHead);
    });

    it('leaves the main checkout clean (the /worktrees/ ignore line)', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);

      const created = await createRunWorktree(deps, { runId: 'quick-clean-1', mode: 'quick' });
      assert.ok(created.ok);
      assert.strictEqual(await deps.git.isClean(), true);
    });

    it('refuses an invalid run id without touching the disk', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);

      const created = await createRunWorktree(deps, { runId: 'a.b', mode: 'quick' });
      assert.ok(!created.ok);
      assert.strictEqual(created.error.kind, 'invalid-id');
      assert.ok(!fs.existsSync(path.join(repo, '.baiton', 'worktrees')));
    });

    it('refuses a pre-existing non-empty directory', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-exists-1';
      writeFile(repo, `.baiton/worktrees/${runId}/stray.txt`, 'in the way\n');

      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(!created.ok);
      assert.strictEqual(created.error.kind, 'exists');
      assert.ok(created.error.kind === 'exists' && created.error.path.includes(runId));
    });

    it('tolerates a pre-existing empty directory', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-empty-1';
      fs.mkdirSync(runWorktreeDirFor(repo, runId), { recursive: true });

      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok, 'an empty directory is acceptable to git');
    });

    it('refuses a detached HEAD', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      git(repo, 'checkout', '-q', '--detach');

      const created = await createRunWorktree(deps, { runId: 'quick-detached-1', mode: 'quick' });
      assert.ok(!created.ok);
      assert.strictEqual(created.error.kind, 'detached-head');
    });

    it('refuses a second create for the same run id, leaving the first intact', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-collide-1';

      const first = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(first.ok);
      // A second create sees the populated directory; remove it so the `-b`
      // branch collision is what fails.
      fs.rmSync(first.value.worktreeDir, { recursive: true, force: true });

      const second = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(!second.ok);
      assert.strictEqual(second.error.kind, 'git');
      assert.notStrictEqual(await deps.git.branchHead(first.value.branch), undefined);
    });
  });

  describe('createRunGitService', () => {
    it('binds a service to the run worktree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-bound-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);

      const worktreeGit = createRunGitService(repo, runId);
      assert.strictEqual(await worktreeGit.currentBranch(), created.value.branch);
      assert.strictEqual(await worktreeGit.head(), created.value.baseHead);
    });
  });

  describe('mergeRunWorktree', () => {
    it('merges the run branch, records the Run-Id trailer and cleans up', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-merge-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      const info = created.value;

      writeFile(info.worktreeDir, 'feature.txt', 'from the run\n');
      await createRunGitService(repo, runId).commit('Add feature.txt');

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: info.baseBranch,
        baseHead: info.baseHead,
      });
      assert.ok(merged.ok, 'expected the merge to land');
      assert.deepStrictEqual(merged.value.cleanup, []);
      assert.strictEqual(merged.value.commit, await deps.git.branchHead('main'));

      // A real merge commit: `rev-list --parents -n 1` prints the commit plus its
      // two parents, i.e. three shas.
      const parents = git(repo, 'rev-list', '--parents', '-n', '1', merged.value.commit)
        .trim()
        .split(/\s+/);
      assert.strictEqual(parents.length, 3);

      assert.ok(fs.existsSync(path.join(repo, 'feature.txt')));
      const message = git(repo, 'log', '-1', '--format=%B', merged.value.commit);
      assert.ok(message.includes(`Run-Id: ${runId}`), message);

      assert.strictEqual(await findRunWorktree(deps, runId), undefined);
      assert.ok(!fs.existsSync(info.worktreeDir));
      assert.strictEqual(await deps.git.branchHead(info.branch), undefined);
    });

    it('refuses wrong-branch and leaves the run untouched', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-wrongbranch-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      git(repo, 'checkout', '-q', '-b', 'other');

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead: created.value.baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'wrong-branch');
      if (merged.error.reason === 'wrong-branch') {
        assert.strictEqual(merged.error.expected, 'main');
        assert.strictEqual(merged.error.actual, 'other');
      }
      assert.ok(fs.existsSync(created.value.worktreeDir));
      assert.notStrictEqual(await deps.git.branchHead(created.value.branch), undefined);
    });

    it('refuses base-moved when the base branch advanced', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-basemoved-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);

      writeFile(repo, 'other.txt', 'moved on\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'move the base');
      const newHead = (await deps.git.branchHead('main'))!;

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead: created.value.baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'base-moved');
      if (merged.error.reason === 'base-moved') {
        assert.strictEqual(merged.error.actual, newHead);
        assert.strictEqual(merged.error.expected, created.value.baseHead);
      }
    });

    it('refuses base-moved with actual undefined when the base ref is gone', async () => {
      // `branchHead` reports a missing ref as undefined rather than rejecting, so
      // a base branch that was deleted or renamed away must route deliberately
      // into `base-moved`. A real repo cannot have the base branch both checked
      // out (past the wrong-branch check) and absent, so the seam is stubbed.
      const repo = newRepo();
      const real = createGitService(repo);
      const stub = {
        currentBranch: async () => 'main',
        branchHead: async () => undefined,
        status: real.status.bind(real),
      } as unknown as RunWorktreeDeps['git'];

      const merged = await mergeRunWorktree(
        { workspaceRoot: repo, git: stub },
        {
          runId: 'quick-basegone-1',
          mode: 'quick',
          baseBranch: 'main',
          baseHead: 'a'.repeat(40),
        },
      );
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'base-moved');
      if (merged.error.reason === 'base-moved') {
        assert.strictEqual(merged.error.actual, undefined);
        assert.ok(merged.error.message.includes('no longer exists'), merged.error.message);
      }
    });

    it('refuses dirty-tree naming the changed path', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-dirty-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      writeFile(repo, 'README.md', 'edited in the main checkout\n');

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead: created.value.baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'dirty-tree');
      if (merged.error.reason === 'dirty-tree') {
        assert.deepStrictEqual([...merged.error.changes], ['README.md']);
      }
      assert.ok(fs.existsSync(created.value.worktreeDir));
      assert.notStrictEqual(await deps.git.branchHead(created.value.branch), undefined);
    });

    it('pins the refusal order: base-moved before dirty-tree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-order-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      writeFile(repo, 'other.txt', 'moved on\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'move the base');
      writeFile(repo, 'README.md', 'and dirty too\n');

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead: created.value.baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'base-moved');
    });

    it('pins the refusal order: wrong-branch before dirty-tree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-order-2';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      git(repo, 'checkout', '-q', '-b', 'other');
      writeFile(repo, 'README.md', 'dirty as well\n');

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead: created.value.baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'wrong-branch');
    });

    it('refuses missing-branch for a run that was never created', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const baseHead = (await deps.git.branchHead('main'))!;

      const merged = await mergeRunWorktree(deps, {
        runId: 'quick-nobranch-1',
        mode: 'quick',
        baseBranch: 'main',
        baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'missing-branch');
      if (merged.error.reason === 'missing-branch') {
        assert.strictEqual(merged.error.branch, runBranchFor('quick', 'quick-nobranch-1'));
      }
    });

    it('reports a conflicting merge as conflict, leaving the run retryable', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-conflict-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      const info = created.value;

      writeFile(info.worktreeDir, 'README.md', 'the run says this\n');
      await createRunGitService(repo, runId).commit('Run edit');
      writeFile(repo, 'README.md', 'but main says this\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'Base edit');
      const baseHead = (await deps.git.branchHead('main'))!;

      const merged = await mergeRunWorktree(deps, {
        runId,
        mode: 'quick',
        baseBranch: 'main',
        baseHead,
      });
      assert.ok(!merged.ok);
      assert.strictEqual(merged.error.reason, 'conflict');
      if (merged.error.reason === 'conflict') {
        assert.ok(typeof merged.error.error.command === 'string');
      }
      assert.ok(!fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
      assert.strictEqual(await deps.git.isClean(), true);
      assert.ok(fs.existsSync(info.worktreeDir));
      assert.notStrictEqual(await deps.git.branchHead(info.branch), undefined);
    });
  });

  describe('removeRunWorktree', () => {
    it('deregisters, deletes the directory and force-deletes the branch', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-remove-1';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);
      writeFile(created.value.worktreeDir, 'unmerged.txt', 'never landed\n');
      await createRunGitService(repo, runId).commit('Unmerged work');

      const removed = await removeRunWorktree(deps, { runId, mode: 'quick', deleteBranch: true });
      assert.ok(removed.ok);
      assert.strictEqual(removed.value.worktreeRemoved, true);
      assert.strictEqual(removed.value.branchDeleted, true);
      assert.deepStrictEqual([...removed.value.warnings], []);
      assert.ok(!fs.existsSync(created.value.worktreeDir));
      assert.strictEqual(await deps.git.branchHead(created.value.branch), undefined);
    });

    it('keeps the branch when deleteBranch is omitted', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-remove-2';
      const created = await createRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(created.ok);

      const removed = await removeRunWorktree(deps, { runId, mode: 'quick' });
      assert.ok(removed.ok);
      assert.strictEqual(removed.value.worktreeRemoved, true);
      assert.strictEqual(removed.value.branchDeleted, false);
      assert.notStrictEqual(await deps.git.branchHead(created.value.branch), undefined);
    });

    it('is idempotent', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const runId = 'quick-remove-3';
      assert.ok((await createRunWorktree(deps, { runId, mode: 'quick' })).ok);

      assert.ok((await removeRunWorktree(deps, { runId, mode: 'quick', deleteBranch: true })).ok);
      const again = await removeRunWorktree(deps, { runId, mode: 'quick', deleteBranch: true });
      assert.ok(again.ok);
      assert.deepStrictEqual(again.value, {
        worktreeRemoved: false,
        dirRemoved: false,
        branchDeleted: false,
        warnings: [],
      });
    });

    it('is a no-op for a valid run id with nothing on disk', async () => {
      const repo = newRepo();
      const removed = await removeRunWorktree(depsFor(repo), {
        runId: 'quick-unknown-1',
        mode: 'quick',
        deleteBranch: true,
      });
      assert.ok(removed.ok);
      assert.deepStrictEqual(removed.value, {
        worktreeRemoved: false,
        dirRemoved: false,
        branchDeleted: false,
        warnings: [],
      });
    });

    it('refuses an invalid run id', async () => {
      const repo = newRepo();
      const removed = await removeRunWorktree(depsFor(repo), { runId: 'a.b', mode: 'quick' });
      assert.ok(!removed.ok);
      assert.strictEqual(removed.error.kind, 'invalid-id');
    });
  });

  describe('runMergeMessage', () => {
    it('uses a bare subject without a statement', () => {
      const message = runMergeMessage({ runId: 'quick-1', branch: 'baiton/quick/quick-1' });
      assert.strictEqual(message.split('\n')[0], 'Merge baiton/quick/quick-1');
    });

    it('folds a statement first line into the subject, truncated', () => {
      const statement = `${'x'.repeat(80)}\nsecond line`;
      const message = runMergeMessage({
        runId: 'quick-1',
        branch: 'baiton/quick/quick-1',
        statement,
      });
      const subject = message.split('\n')[0];
      assert.ok(subject.startsWith('Merge baiton/quick/quick-1: '));
      assert.ok(subject.endsWith('…'));
      assert.ok(!subject.includes('second line'));
      assert.ok(subject.includes('x'.repeat(60)));
      assert.ok(!subject.includes('x'.repeat(61)));
    });

    it('puts the Run-Id trailer on its own line after a blank line', () => {
      const lines = runMergeMessage({
        runId: 'quick-trailer-1',
        branch: 'baiton/quick/quick-trailer-1',
        statement: 'Do the thing',
      }).split('\n');
      assert.strictEqual(lines[1], '');
      assert.strictEqual(lines[2], 'Run-Id: quick-trailer-1');
      assert.strictEqual(lines[3], '');
      assert.strictEqual(lines.length, 4);
    });
  });
});
