import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import {
  type TodoWorktreeDeps,
  createTodoGitService,
  createTodoWorktree,
  findTodoWorktree,
  landTodoWorktree,
  removeTodoWorktree,
  todoBranchFor,
  todoLandMessage,
  todoWorktreeDirFor,
  todoWorktreeRelativeDir,
  unlandedTodos,
} from '../src/engine/todoWorktree';

/**
 * Unit tests for the per-todo worktree lifecycle, driven against real temporary
 * git repositories: naming, idempotent create, every create/land refusal with
 * precedence, happy-path and no-op land, conflict preservation, remove and
 * `unlandedTodos`.
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

/** Temp repo on `main` with a committed README and `.baiton/.gitignore`, then `baiton/s` checked out. */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-todowt-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFile(repo, 'README.md', 'baseline\n');
  writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  git(repo, 'checkout', '-q', '-b', 'baiton/s');
  return repo;
}

/** Commit `file` with `contents` inside a checkout at `dir`. */
function commitIn(dir: string, file: string, contents: string, msg: string): void {
  writeFile(dir, file, contents);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

describe('todo worktree lifecycle', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  function depsFor(repo: string): TodoWorktreeDeps {
    return { workspaceRoot: repo, git: createGitService(repo) };
  }

  afterEach(() => {
    while (repos.length > 0) {
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  it('names branches, directories and the land message', async () => {
    const repo = newRepo();
    assert.strictEqual(todoBranchFor('s', 'T01'), 'baiton-todo/s/T01');
    assert.strictEqual(todoWorktreeDirFor(repo, 's', 'T01'), path.join(repo, '.baiton', 'worktrees', 's', 'T01'));
    assert.strictEqual(todoWorktreeRelativeDir('s', 'T01'), '.baiton/worktrees/s/T01');
    assert.strictEqual(todoLandMessage('s', 'T01'), 'spec(s): land T01');
    // Regression: the spec branch and the todo branch coexist.
    const res = await createTodoWorktree(depsFor(repo), { slug: 's', todoId: 'T01' });
    assert.ok(res.ok, JSON.stringify(res));
    assert.ok(git(repo, 'branch', '--list', 'baiton/s').includes('baiton/s'));
  });

  describe('createTodoWorktree', () => {
    it('creates the worktree from the spec branch head and leaves main clean', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const res = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(res.ok);
      if (!res.ok) {
        return;
      }
      assert.strictEqual(res.value.reused, false);
      assert.ok(fs.existsSync(res.value.worktreeDir));
      assert.strictEqual(git(res.value.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'baiton-todo/s/T01');
      assert.strictEqual(
        git(res.value.worktreeDir, 'rev-parse', 'HEAD').trim(),
        git(repo, 'rev-parse', 'baiton/s').trim(),
      );
      assert.strictEqual((await deps.git.status()).clean, true);
      assert.strictEqual(await deps.git.currentBranch(), 'baiton/s');
    });

    it('bases on the spec branch even when main is checked out', async () => {
      const repo = newRepo();
      commitIn(repo, '.baiton/specs/s/spec.md', 'x\n', 'spec state');
      git(repo, 'checkout', '-q', 'main');
      const res = await createTodoWorktree(depsFor(repo), { slug: 's', todoId: 'T01' });
      assert.ok(res.ok);
      if (res.ok) {
        assert.strictEqual(res.value.head, git(repo, 'rev-parse', 'baiton/s').trim());
      }
    });

    it('is idempotent and never resets a reused worktree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const first = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      const second = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(first.ok && second.ok);
      if (!first.ok || !second.ok) {
        return;
      }
      assert.strictEqual(second.value.reused, true);
      assert.strictEqual(second.value.worktreeDir, first.value.worktreeDir);
      assert.strictEqual(second.value.branch, first.value.branch);

      commitIn(first.value.worktreeDir, 'src/a.txt', 'a\n', 'work');
      commitIn(repo, '.baiton/specs/s/spec.md', 'x\n', 'spec state');
      const third = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(third.ok);
      if (third.ok) {
        assert.strictEqual(third.value.reused, true);
        assert.strictEqual(third.value.head, git(first.value.worktreeDir, 'rev-parse', 'HEAD').trim());
      }
    });

    it('refuses with named kinds and creates nothing', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);

      for (const bad of ['../x', 'a b']) {
        const r = await createTodoWorktree(deps, { slug: 's', todoId: bad });
        assert.ok(!r.ok && r.error.kind === 'invalid-id');
      }

      const noSpec = await createTodoWorktree(deps, { slug: 'nope', todoId: 'T01' });
      assert.ok(!noSpec.ok && noSpec.error.kind === 'no-spec-branch');

      writeFile(repo, '.baiton/worktrees/s/T02/file.txt', 'x\n');
      const exists = await createTodoWorktree(deps, { slug: 's', todoId: 'T02' });
      assert.ok(!exists.ok && exists.error.kind === 'exists');

      git(repo, 'branch', 'baiton-todo/s/T09');
      const orphan = await createTodoWorktree(deps, { slug: 's', todoId: 'T09' });
      assert.ok(!orphan.ok && orphan.error.kind === 'orphan-branch');

      assert.strictEqual((await deps.git.listWorktrees()).length, 1);
    });
  });

  it('finds a todo worktree only once it exists', async () => {
    const repo = newRepo();
    const deps = depsFor(repo);
    assert.strictEqual(await findTodoWorktree(deps, 's', 'T01'), undefined);
    await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
    const found = await findTodoWorktree(deps, 's', 'T01');
    assert.strictEqual(found?.branch, 'baiton-todo/s/T01');
  });

  describe('landTodoWorktree', () => {
    it('merges into the spec branch and cleans up', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      commitIn(created.value.worktreeDir, 'src/a.txt', 'a\n', 'work');
      commitIn(repo, '.baiton/specs/s/spec.md', 'x\n', 'spec state');

      const landed = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(landed.ok, JSON.stringify(landed));
      if (!landed.ok) {
        return;
      }
      assert.strictEqual(landed.value.noop, false);
      assert.strictEqual(git(repo, 'log', '-1', '--format=%s').trim(), 'spec(s): land T01');
      assert.strictEqual(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
      assert.ok(fs.existsSync(path.join(repo, 'src/a.txt')));
      assert.ok(!fs.existsSync(created.value.worktreeDir));
      assert.strictEqual(await deps.git.branchHead('baiton-todo/s/T01'), undefined);
      assert.deepStrictEqual(await unlandedTodos(deps, 's'), []);
      assert.deepStrictEqual(landed.value.cleanup, []);
    });

    it('lands an untouched branch as a no-op and still cleans up', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      const before = git(repo, 'rev-parse', 'HEAD').trim();
      const landed = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(landed.ok);
      if (landed.ok) {
        assert.strictEqual(landed.value.noop, true);
      }
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
      assert.ok(!fs.existsSync(created.value.worktreeDir));
      assert.strictEqual(await deps.git.branchHead('baiton-todo/s/T01'), undefined);
    });

    it('refuses in the pinned order', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);

      const invalid = await landTodoWorktree(deps, { slug: 's', todoId: '../x' });
      assert.ok(!invalid.ok && invalid.error.reason === 'invalid-id');

      // dirty-tree beats missing-branch (no todo branch exists yet).
      writeFile(repo, 'README2.md', 'x\n');
      const dirty = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(!dirty.ok && dirty.error.reason === 'dirty-tree');
      if (!dirty.ok && dirty.error.reason === 'dirty-tree') {
        assert.deepStrictEqual(dirty.error.changes, ['README2.md']);
      }

      // wrong-branch beats dirty-tree.
      git(repo, 'checkout', '-q', 'main');
      const wrong = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(!wrong.ok && wrong.error.reason === 'wrong-branch');
      git(repo, 'checkout', '-q', 'baiton/s');

      // A dirty spec folder alone does not refuse; the missing branch does.
      fs.rmSync(path.join(repo, 'README2.md'));
      writeFile(repo, '.baiton/specs/s/spec.md', 'x\n');
      const missing = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(!missing.ok && missing.error.reason === 'missing-branch');
    });

    it('aborts a conflicting merge and preserves branch and worktree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      commitIn(created.value.worktreeDir, 'README.md', 'from todo\n', 'todo edit');
      commitIn(repo, 'README.md', 'from spec\n', 'spec edit');
      const specHead = git(repo, 'rev-parse', 'HEAD').trim();
      const todoHead = git(repo, 'rev-parse', 'baiton-todo/s/T01').trim();

      const landed = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
      assert.ok(!landed.ok && landed.error.reason === 'conflict');
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), specHead);
      assert.strictEqual((await deps.git.status()).clean, true);
      assert.strictEqual(git(repo, 'rev-parse', 'baiton-todo/s/T01').trim(), todoHead);
      assert.ok(fs.existsSync(created.value.worktreeDir));
      assert.ok((await findTodoWorktree(deps, 's', 'T01')) !== undefined);
    });
  });

  describe('removeTodoWorktree', () => {
    it('keeps the branch unless asked, is idempotent and drops the empty parent', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });

      const kept = await removeTodoWorktree(deps, { slug: 's', todoId: 'T01', deleteBranch: false });
      assert.ok(kept.ok);
      if (kept.ok) {
        assert.strictEqual(kept.value.worktreeRemoved, true);
        assert.strictEqual(kept.value.branchDeleted, false);
      }
      assert.deepStrictEqual(await unlandedTodos(deps, 's'), ['T01']);
      assert.ok(!fs.existsSync(path.join(repo, '.baiton', 'worktrees', 's')));

      const gone = await removeTodoWorktree(deps, { slug: 's', todoId: 'T01', deleteBranch: true });
      assert.ok(gone.ok);
      if (gone.ok) {
        assert.strictEqual(gone.value.branchDeleted, true);
      }
      assert.deepStrictEqual(await unlandedTodos(deps, 's'), []);

      const again = await removeTodoWorktree(deps, { slug: 's', todoId: 'T01', deleteBranch: true });
      assert.deepStrictEqual(again.ok && again.value, {
        worktreeRemoved: false,
        dirRemoved: false,
        branchDeleted: false,
        warnings: [],
      });
    });
  });

  it('lists unlanded todos of exactly one slug', async () => {
    const repo = newRepo();
    const deps = depsFor(repo);
    await createTodoWorktree(deps, { slug: 's', todoId: 'T01' });
    await createTodoWorktree(deps, { slug: 's', todoId: 'T02' });
    git(repo, 'branch', 'baiton-todo/s-other/T01');
    assert.deepStrictEqual(await unlandedTodos(deps, 's'), ['T01', 'T02']);
    const landed = await landTodoWorktree(deps, { slug: 's', todoId: 'T01' });
    assert.ok(landed.ok);
    assert.deepStrictEqual(await unlandedTodos(deps, 's'), ['T02']);
  });

  it('binds a git service to the todo worktree', async () => {
    const repo = newRepo();
    await createTodoWorktree(depsFor(repo), { slug: 's', todoId: 'T01' });
    assert.strictEqual(await createTodoGitService(repo, 's', 'T01').currentBranch(), 'baiton-todo/s/T01');
  });
});
