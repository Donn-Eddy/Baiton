import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import {
  type PhaseWorktreeDeps,
  createPhaseGitService,
  createPhaseWorktree,
  documentKindFor,
  findPhaseWorktree,
  landPhaseWorktree,
  removePhaseWorktree,
  phaseBranchFor,
  phaseLandMessage,
  phaseWorktreeDirFor,
  phaseWorktreeRelativeDir,
  unlandedPhases,
} from '../src/engine/phaseWorktree';

/**
 * Unit tests for the per-phase worktree lifecycle, driven against real temporary
 * git repositories: naming, idempotent create, every create/land refusal with
 * precedence, happy-path and no-op land, conflict preservation, remove and
 * `unlandedPhases`.
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

describe('phase worktree lifecycle', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  function depsFor(repo: string): PhaseWorktreeDeps {
    return { workspaceRoot: repo, git: createGitService(repo) };
  }

  afterEach(() => {
    while (repos.length > 0) {
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  it('names branches, directories and the land message', async () => {
    const repo = newRepo();
    assert.strictEqual(phaseBranchFor('s', 'P01', 'plan'), 'baiton-phase/s/P01');
    assert.strictEqual(phaseWorktreeDirFor(repo, 's', 'P01'), path.join(repo, '.baiton', 'worktrees', 's', 'P01'));
    assert.strictEqual(phaseWorktreeRelativeDir('s', 'P01'), '.baiton/worktrees/s/P01');
    assert.strictEqual(phaseLandMessage('s', 'P01'), 'plan(s): land P01');
    // Regression: the plan branch and phase branch coexist.
    const res = await createPhaseWorktree(depsFor(repo), { slug: 's', phaseId: 'P01' });
    assert.ok(res.ok, JSON.stringify(res));
    assert.ok(git(repo, 'branch', '--list', 'baiton/s').includes('baiton/s'));
  });

  describe('createPhaseWorktree', () => {
    it('creates the worktree from the plan branch head and leaves main clean', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const res = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(res.ok);
      if (!res.ok) {
        return;
      }
      assert.strictEqual(res.value.reused, false);
      assert.ok(fs.existsSync(res.value.worktreeDir));
      assert.strictEqual(git(res.value.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'baiton-phase/s/P01');
      assert.strictEqual(
        git(res.value.worktreeDir, 'rev-parse', 'HEAD').trim(),
        git(repo, 'rev-parse', 'baiton/s').trim(),
      );
      assert.strictEqual((await deps.git.status()).clean, true);
      assert.strictEqual(await deps.git.currentBranch(), 'baiton/s');
    });

    it('bases on the plan branch even when main is checked out', async () => {
      const repo = newRepo();
      commitIn(repo, '.baiton/plans/s/plan.md', 'x\n', 'plan state');
      git(repo, 'checkout', '-q', 'main');
      const res = await createPhaseWorktree(depsFor(repo), { slug: 's', phaseId: 'P01' });
      assert.ok(res.ok);
      if (res.ok) {
        assert.strictEqual(res.value.head, git(repo, 'rev-parse', 'baiton/s').trim());
      }
    });

    it('is idempotent and never resets a reused worktree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const first = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      const second = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(first.ok && second.ok);
      if (!first.ok || !second.ok) {
        return;
      }
      assert.strictEqual(second.value.reused, true);
      assert.strictEqual(second.value.worktreeDir, first.value.worktreeDir);
      assert.strictEqual(second.value.branch, first.value.branch);

      commitIn(first.value.worktreeDir, 'src/a.txt', 'a\n', 'work');
      commitIn(repo, '.baiton/plans/s/plan.md', 'x\n', 'plan state');
      const third = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
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
        const r = await createPhaseWorktree(deps, { slug: 's', phaseId: bad });
        assert.ok(!r.ok && r.error.kind === 'invalid-id');
      }

      const noPlan = await createPhaseWorktree(deps, { slug: 'nope', phaseId: 'P01' });
      assert.ok(!noPlan.ok && noPlan.error.kind === 'no-plan-branch');

      writeFile(repo, '.baiton/worktrees/s/P02/file.txt', 'x\n');
      const exists = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P02' });
      assert.ok(!exists.ok && exists.error.kind === 'exists');

      git(repo, 'branch', 'baiton-phase/s/P09');
      const orphan = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P09' });
      assert.ok(!orphan.ok && orphan.error.kind === 'orphan-branch');

      assert.strictEqual((await deps.git.listWorktrees()).length, 1);
    });
  });

  it('finds a phase worktree only once it exists', async () => {
    const repo = newRepo();
    const deps = depsFor(repo);
    assert.strictEqual(await findPhaseWorktree(deps, 's', 'P01'), undefined);
    await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
    const found = await findPhaseWorktree(deps, 's', 'P01');
    assert.strictEqual(found?.branch, 'baiton-phase/s/P01');
  });

  describe('landPhaseWorktree', () => {
    it('merges into the plan branch and cleans up', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      commitIn(created.value.worktreeDir, 'src/a.txt', 'a\n', 'work');
      commitIn(repo, '.baiton/plans/s/plan.md', 'x\n', 'plan state');

      const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(landed.ok, JSON.stringify(landed));
      if (!landed.ok) {
        return;
      }
      assert.strictEqual(landed.value.noop, false);
      assert.strictEqual(git(repo, 'log', '-1', '--format=%s').trim(), 'plan(s): land P01');
      assert.strictEqual(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
      assert.ok(fs.existsSync(path.join(repo, 'src/a.txt')));
      assert.ok(!fs.existsSync(created.value.worktreeDir));
      assert.strictEqual(await deps.git.branchHead('baiton-phase/s/P01'), undefined);
      assert.deepStrictEqual(await unlandedPhases(deps, 's'), []);
      assert.deepStrictEqual(landed.value.cleanup, []);
    });

    it('lands an untouched branch as a no-op and still cleans up', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      const before = git(repo, 'rev-parse', 'HEAD').trim();
      const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(landed.ok);
      if (landed.ok) {
        assert.strictEqual(landed.value.noop, true);
      }
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), before);
      assert.ok(!fs.existsSync(created.value.worktreeDir));
      assert.strictEqual(await deps.git.branchHead('baiton-phase/s/P01'), undefined);
    });

    it('refuses in the pinned order', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);

      const invalid = await landPhaseWorktree(deps, { slug: 's', phaseId: '../x' });
      assert.ok(!invalid.ok && invalid.error.reason === 'invalid-id');

      // dirty-tree beats missing-branch (no phase branch exists yet).
      writeFile(repo, 'README2.md', 'x\n');
      const dirty = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(!dirty.ok && dirty.error.reason === 'dirty-tree');
      if (!dirty.ok && dirty.error.reason === 'dirty-tree') {
        assert.deepStrictEqual(dirty.error.changes, ['README2.md']);
      }

      // wrong-branch beats dirty-tree.
      git(repo, 'checkout', '-q', 'main');
      const wrong = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(!wrong.ok && wrong.error.reason === 'wrong-branch');
      git(repo, 'checkout', '-q', 'baiton/s');

      // A dirty plan folder alone does not refuse; the missing branch does.
      fs.rmSync(path.join(repo, 'README2.md'));
      writeFile(repo, '.baiton/plans/s/plan.md', 'x\n');
      const missing = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(!missing.ok && missing.error.reason === 'missing-branch');
    });

    it('aborts a conflicting merge and preserves branch and worktree', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(created.ok);
      if (!created.ok) {
        return;
      }
      commitIn(created.value.worktreeDir, 'README.md', 'from phase\n', 'phase edit');
      commitIn(repo, 'README.md', 'from plan\n', 'plan edit');
      const planHead = git(repo, 'rev-parse', 'HEAD').trim();
      const phaseHead = git(repo, 'rev-parse', 'baiton-phase/s/P01').trim();

      const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(!landed.ok && landed.error.reason === 'conflict');
      assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), planHead);
      assert.strictEqual((await deps.git.status()).clean, true);
      assert.strictEqual(git(repo, 'rev-parse', 'baiton-phase/s/P01').trim(), phaseHead);
      assert.ok(fs.existsSync(created.value.worktreeDir));
      assert.ok((await findPhaseWorktree(deps, 's', 'P01')) !== undefined);
    });
  });

  describe('removePhaseWorktree', () => {
    it('keeps the branch unless asked, is idempotent and drops the empty parent', async () => {
      const repo = newRepo();
      const deps = depsFor(repo);
      await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });

      const kept = await removePhaseWorktree(deps, { slug: 's', phaseId: 'P01', deleteBranch: false });
      assert.ok(kept.ok);
      if (kept.ok) {
        assert.strictEqual(kept.value.worktreeRemoved, true);
        assert.strictEqual(kept.value.branchDeleted, false);
      }
      assert.deepStrictEqual(await unlandedPhases(deps, 's'), ['P01']);
      assert.ok(!fs.existsSync(path.join(repo, '.baiton', 'worktrees', 's')));

      const gone = await removePhaseWorktree(deps, { slug: 's', phaseId: 'P01', deleteBranch: true });
      assert.ok(gone.ok);
      if (gone.ok) {
        assert.strictEqual(gone.value.branchDeleted, true);
      }
      assert.deepStrictEqual(await unlandedPhases(deps, 's'), []);

      const again = await removePhaseWorktree(deps, { slug: 's', phaseId: 'P01', deleteBranch: true });
      assert.deepStrictEqual(again.ok && again.value, {
        worktreeRemoved: false,
        dirRemoved: false,
        branchDeleted: false,
        warnings: [],
      });
    });
  });

  it('lists unlanded phases of exactly one slug', async () => {
    const repo = newRepo();
    const deps = depsFor(repo);
    await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
    await createPhaseWorktree(deps, { slug: 's', phaseId: 'P02' });
    git(repo, 'branch', 'baiton-phase/s-other/P01');
    assert.deepStrictEqual(await unlandedPhases(deps, 's'), ['P01', 'P02']);
    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
    assert.ok(landed.ok);
    assert.deepStrictEqual(await unlandedPhases(deps, 's'), ['P02']);
  });

  it('binds a git service to the phase worktree', async () => {
    const repo = newRepo();
    await createPhaseWorktree(depsFor(repo), { slug: 's', phaseId: 'P01' });
    assert.strictEqual(await createPhaseGitService(repo, 's', 'P01').currentBranch(), 'baiton-phase/s/P01');
  });
});

describe('legacy spec documents', () => {
  const repos: string[] = [];

  function legacyRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    commitIn(repo, '.baiton/specs/s/spec.md', '# OVERVIEW\n\nLegacy plan.\n', 'legacy document');
    return repo;
  }

  function depsFor(repo: string): PhaseWorktreeDeps {
    return { workspaceRoot: repo, git: createGitService(repo) };
  }

  afterEach(() => {
    while (repos.length > 0) fs.rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('keeps the legacy branch namespace and resolves the document kind', async () => {
    const repo = legacyRepo();
    const deps = depsFor(repo);
    assert.strictEqual(phaseBranchFor('s', 'T01', 'legacy-spec'), 'baiton-todo/s/T01');
    assert.strictEqual(documentKindFor(repo, 's'), 'legacy-spec');

    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'T01' });
    assert.ok(created.ok);
    if (created.ok) {
      assert.strictEqual(created.value.branch, 'baiton-todo/s/T01');
      assert.strictEqual(git(created.value.worktreeDir, 'branch', '--show-current').trim(), 'baiton-todo/s/T01');
    }
  });

  it('lands legacy phases with the plan message and deletes the legacy branch', async () => {
    const repo = legacyRepo();
    const deps = depsFor(repo);
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'T01' });
    assert.ok(created.ok);
    if (!created.ok) return;
    commitIn(created.value.worktreeDir, 'src/legacy.txt', 'legacy work\n', 'legacy work');

    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'T01' });
    assert.ok(landed.ok);
    assert.strictEqual(git(repo, 'log', '-1', '--format=%s').trim(), 'plan(s): land T01');
    assert.strictEqual(await deps.git.branchHead('baiton-todo/s/T01'), undefined);
  });

  it('lists legacy branches only and ignores plan namespace branches', async () => {
    const repo = legacyRepo();
    const deps = depsFor(repo);
    git(repo, 'branch', 'baiton-todo/s/T02');
    git(repo, 'branch', 'baiton-phase/s/P01');
    assert.deepStrictEqual(await unlandedPhases(deps, 's'), ['T02']);
  });

  it('ignores dirty changes in the legacy document folder when landing', async () => {
    const repo = legacyRepo();
    const deps = depsFor(repo);
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'T01' });
    assert.ok(created.ok);
    writeFile(repo, '.baiton/specs/s/spec.md', '# OVERVIEW\n\nDirty legacy document.\n');

    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'T01' });
    assert.ok(landed.ok, JSON.stringify(landed));
  });
});

describe('document kind preference', () => {
  it('prefers plans when both document roots contain the slug', async () => {
    const repo = makeRepo();
    try {
      commitIn(repo, '.baiton/plans/s/plan.md', '# Plan\n\nPlan document.\n', 'plan document');
      commitIn(repo, '.baiton/specs/s/spec.md', '# OVERVIEW\n\nLegacy document.\n', 'legacy document');
      const deps: PhaseWorktreeDeps = { workspaceRoot: repo, git: createGitService(repo) };

      assert.strictEqual(documentKindFor(repo, 's'), 'plan');
      const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P01' });
      assert.ok(created.ok);
      if (created.ok) assert.strictEqual(created.value.branch, 'baiton-phase/s/P01');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
