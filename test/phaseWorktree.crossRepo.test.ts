import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import {
  createPhaseWorktree,
  landPhaseWorktree,
  phaseBranchFor,
  phaseWorktreeDirFor,
  planLandingWorktreeDirFor,
  resolvePhaseTargetRoot,
  TARGET_WORKTREE_GITIGNORE,
  unlandedPhases,
  unlandedPhasesAcross,
  type PhaseTargetRepo,
  type PhaseWorktreeDeps,
} from '../src/engine/phaseWorktree';
import { createQueueWorktreeSeam } from '../src/engine/runQueue';
import type { PhaseTargetResolver } from '../src/engine/phaseWorktree';
import type { RepoTopology } from '../src/model/validator';
import { err, ok } from '../src/model/result';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(root: string, relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitIn(root: string, relative: string, content: string, message: string): void {
  writeFile(root, relative, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function initRepo(root: string, branch: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Baiton Test');
  git(root, 'config', 'user.email', 'baiton-test@example.com');
  git(root, 'checkout', '-q', '-b', branch);
}

describe('cross-repo phase worktrees', () => {
  let owner: string;
  let child: string;
  let ownerGit: ReturnType<typeof createGitService>;
  let childGit: ReturnType<typeof createGitService>;
  let target: PhaseTargetRepo;
  let deps: PhaseWorktreeDeps;

  beforeEach(() => {
    owner = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-cross-owner-'));
    initRepo(owner, 'main');
    writeFile(owner, 'README.md', 'owner\n');
    writeFile(owner, '.gitignore', 'packages/api/\n');
    writeFile(owner, '.baiton/.gitignore', GITIGNORE_CONTENTS);
    git(owner, 'add', '-A');
    git(owner, 'commit', '-q', '-m', 'owner baseline');
    git(owner, 'checkout', '-q', '-b', 'baiton/s');

    child = path.join(owner, 'packages/api');
    initRepo(child, 'main');
    writeFile(child, 'README.md', 'child baseline\n');
    git(child, 'add', '-A');
    git(child, 'commit', '-q', '-m', 'child baseline');
    ownerGit = createGitService(owner);
    childGit = createGitService(child);
    target = { name: 'packages/api', root: child, isOwner: false, git: childGit };
    deps = { workspaceRoot: owner, git: ownerGit, target };
  });

  afterEach(() => fs.rmSync(owner, { recursive: true, force: true }));

  it('creates and reuses the target branch under the owner path, ignoring run artifacts', async () => {
    const startHead = git(child, 'rev-parse', 'HEAD');
    const mainHead = git(child, 'rev-parse', 'main');
    const result = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    const worktreeDir = phaseWorktreeDirFor(owner, 's', 'P03');
    assert.strictEqual(result.value.worktreeDir, worktreeDir);
    assert.strictEqual(git(worktreeDir, 'branch', '--show-current'), 'baiton-phase/s/P03');
    assert.strictEqual(git(worktreeDir, 'rev-parse', 'HEAD'), startHead);
    assert.strictEqual(await childGit.currentBranch(), 'main');
    assert.strictEqual(await childGit.head(), mainHead);
    assert.strictEqual(await childGit.status().then((status) => status.clean), true);
    assert.strictEqual(await childGit.branchHead('baiton/s'), startHead);
    assert.strictEqual(await ownerGit.branchHead('baiton-phase/s/P03'), undefined);
    assert.ok((await childGit.listWorktrees()).some((worktree) => path.resolve(worktree.dir) === path.resolve(worktreeDir)));
    assert.ok(!(await ownerGit.listWorktrees()).some((worktree) => path.resolve(worktree.dir) === path.resolve(worktreeDir)));
    assert.strictEqual(fs.readFileSync(path.join(worktreeDir, '.baiton/.gitignore'), 'utf8'), TARGET_WORKTREE_GITIGNORE);
    writeFile(worktreeDir, '.baiton/runs/r1/result.json', '{}\n');
    assert.strictEqual(git(worktreeDir, 'status', '--porcelain'), '');
    assert.strictEqual(fs.existsSync(path.join(child, '.baiton')), false);

    const reused = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(reused.ok && reused.value.reused);
    if (reused.ok) assert.strictEqual(reused.value.head, startHead);
  });

  it('lands through a temporary worktree while leaving the target main checkout untouched', async () => {
    const ownerPlanHead = git(owner, 'rev-parse', 'baiton/s');
    const childMainHead = git(child, 'rev-parse', 'HEAD');
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(created.ok);
    if (!created.ok) return;
    commitIn(created.value.worktreeDir, 'src/api.ts', 'export const api = true;\n', 'phase work');

    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(landed.ok, JSON.stringify(landed));
    if (!landed.ok) return;
    assert.strictEqual(landed.value.noop, false);
    assert.strictEqual(git(child, 'log', '-1', '--format=%s', 'baiton/s'), 'plan(s): land P03');
    assert.ok(git(child, 'show', 'baiton/s:src/api.ts').includes('api = true'));
    assert.strictEqual(await childGit.currentBranch(), 'main');
    assert.strictEqual(await childGit.head(), childMainHead);
    assert.strictEqual((await childGit.status()).clean, true);
    assert.strictEqual(await childGit.branchHead(phaseBranchFor('s', 'P03', 'plan')), undefined);
    assert.strictEqual(fs.existsSync(created.value.worktreeDir), false);
    assert.strictEqual(fs.existsSync(planLandingWorktreeDirFor(owner, 's', child)), false);
    assert.deepStrictEqual((await childGit.listWorktrees()).map((worktree) => worktree.branch), ['main']);
    assert.strictEqual(git(owner, 'rev-parse', 'baiton/s'), ownerPlanHead);
  });

  it('lands directly when the target main checkout already has the plan branch checked out', async () => {
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(created.ok);
    if (!created.ok) return;
    commitIn(created.value.worktreeDir, 'src/direct.ts', 'direct\n', 'direct work');
    git(child, 'checkout', '-q', 'baiton/s');

    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(landed.ok, JSON.stringify(landed));
    assert.strictEqual(await childGit.currentBranch(), 'baiton/s');
    assert.ok(fs.existsSync(path.join(child, 'src/direct.ts')));
    assert.strictEqual(fs.existsSync(planLandingWorktreeDirFor(owner, 's', child)), false);
  });

  it('removes the landing worktree after a conflict and preserves both branches and the phase worktree', async () => {
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(created.ok);
    if (!created.ok) return;
    commitIn(created.value.worktreeDir, 'README.md', 'phase side\n', 'phase conflict side');
    git(child, 'checkout', '-q', 'baiton/s');
    commitIn(child, 'README.md', 'plan side\n', 'plan conflict side');
    const planHead = git(child, 'rev-parse', 'baiton/s');
    const phaseHead = git(child, 'rev-parse', phaseBranchFor('s', 'P03', 'plan'));
    git(child, 'checkout', '-q', 'main');

    const landed = await landPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(!landed.ok && landed.error.reason === 'conflict');
    assert.strictEqual(git(child, 'rev-parse', 'baiton/s'), planHead);
    assert.strictEqual(git(child, 'rev-parse', phaseBranchFor('s', 'P03', 'plan')), phaseHead);
    assert.ok(fs.existsSync(created.value.worktreeDir));
    assert.strictEqual(fs.existsSync(planLandingWorktreeDirFor(owner, 's', child)), false);
    assert.deepStrictEqual((await childGit.listWorktrees()).map((worktree) => worktree.branch), ['main', phaseBranchFor('s', 'P03', 'plan')]);
  });

  it('unions owner and child unlanded phases and matches the owner-only result for an empty target list', async () => {
    const created = await createPhaseWorktree(deps, { slug: 's', phaseId: 'P03' });
    assert.ok(created.ok);
    git(owner, 'branch', 'baiton-phase/s/P01');
    assert.deepStrictEqual(await unlandedPhasesAcross({ workspaceRoot: owner, git: ownerGit }, 's', [target]), ['P01', 'P03']);
    assert.deepStrictEqual(await unlandedPhasesAcross({ workspaceRoot: owner, git: ownerGit }, 's', []), await unlandedPhases({ workspaceRoot: owner, git: ownerGit }, 's'));
  });

  it('keeps owner targets equivalent to the target-free lifecycle', async () => {
    const ownerTarget: PhaseTargetRepo = { name: '.', root: owner, isOwner: true, git: ownerGit };
    const withoutTarget = await createPhaseWorktree({ workspaceRoot: owner, git: ownerGit }, { slug: 's', phaseId: 'P01' });
    const withOwnerTarget = await createPhaseWorktree({ workspaceRoot: owner, git: ownerGit, target: ownerTarget }, { slug: 's', phaseId: 'P02' });
    assert.ok(withoutTarget.ok && withOwnerTarget.ok);
    if (!withoutTarget.ok || !withOwnerTarget.ok) return;
    assert.strictEqual(withoutTarget.value.reused, withOwnerTarget.value.reused);
    assert.strictEqual(withoutTarget.value.planBranch, withOwnerTarget.value.planBranch);
    assert.strictEqual(path.dirname(withoutTarget.value.worktreeDir), path.dirname(withOwnerTarget.value.worktreeDir));
    assert.ok((await landPhaseWorktree({ workspaceRoot: owner, git: ownerGit }, { slug: 's', phaseId: 'P01' })).ok);
    assert.ok((await landPhaseWorktree({ workspaceRoot: owner, git: ownerGit, target: ownerTarget }, { slug: 's', phaseId: 'P02' })).ok);
  });

  it('resolves only the owner or discovered descendants', () => {
    const topology: RepoTopology = {
      owner: '.',
      repos: [
        { name: '.', root: owner },
        { name: 'packages/api', root: child, parent: '.' },
        { name: 'packages/web', root: path.join(owner, 'packages/web'), parent: '.' },
      ],
    };
    const implicit = resolvePhaseTargetRoot({ id: 'P01' }, undefined, owner);
    assert.ok(implicit.ok && implicit.value.isOwner && implicit.value.root === owner);
    const nested = resolvePhaseTargetRoot({ id: 'P02', repo: 'packages/api' }, topology, owner);
    assert.ok(nested.ok && nested.value.root === child);
    const nestedOwnerTopology: RepoTopology = {
      owner: 'packages/api',
      repos: [
        { name: '.', root: owner },
        { name: 'packages/api', root: child, parent: '.' },
        { name: 'packages/web', root: path.join(owner, 'packages/web'), parent: '.' },
      ],
    };
    for (const hint of ['../web', '..', 'missing']) {
      const refused = resolvePhaseTargetRoot({ id: 'P03', repo: hint }, nestedOwnerTopology, child);
      assert.ok(!refused.ok);
      if (!refused.ok) assert.ok(refused.error.includes(hint));
    }
  });

  it('resolves queue creation through the target and returns target-resolution errors without creating', async () => {
    const resolver: PhaseTargetResolver = {
      forPhase: async () => ok(target),
      forPlan: async () => [target],
    };
    const seam = createQueueWorktreeSeam({ workspaceRoot: owner, git: ownerGit, targets: resolver });
    const ensured = await seam.ensure('s', 'P03');
    assert.ok(ensured.ok, JSON.stringify(ensured));
    if (ensured.ok) {
      assert.strictEqual(ensured.value.dir, phaseWorktreeDirFor(owner, 's', 'P03'));
      assert.strictEqual(await ensured.value.git.currentBranch(), phaseBranchFor('s', 'P03', 'plan'));
      const commonDir = git(ensured.value.dir, 'rev-parse', '--git-common-dir');
      assert.ok(path.resolve(ensured.value.dir, commonDir).startsWith(path.resolve(child)));
    }

    const refusal = createQueueWorktreeSeam({
      workspaceRoot: owner,
      git: ownerGit,
      targets: { forPhase: async () => err('bad target'), forPlan: async () => [] },
    });
    const refused = await refusal.ensure('s', 'P04');
    assert.ok(!refused.ok && refused.error === 'bad target');
    assert.strictEqual(fs.existsSync(phaseWorktreeDirFor(owner, 's', 'P04')), false);
  });
});
