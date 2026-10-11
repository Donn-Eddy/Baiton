import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import { createPlanBranchWriter, planFolderPathspec } from '../src/engine/planBranchWriter';
import { locationFor } from '../src/storage/documentLocation';

/** Unit tests for the per-slug serialized plan-branch writer. */

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(repo: string, relPath: string, contents: string): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

const noGit = { commitPaths: async (): Promise<string> => 'sha' };

describe('planBranchWriter', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it('serializes same-slug callers', async () => {
    const w = createPlanBranchWriter({ baitonDir: '/x/.baiton', git: noGit });
    const log: string[] = [];
    const gate = deferred();
    const a = w.apply('s', async () => {
      log.push('A-start');
      await gate.promise;
      log.push('A-end');
    });
    const b = w.apply('s', async () => {
      log.push('B-start');
      log.push('B-end');
    });
    await tick();
    assert.deepStrictEqual(log, ['A-start']);
    gate.resolve();
    await Promise.all([a, b]);
    assert.deepStrictEqual(log, ['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('runs 5 callers FIFO with no overlap', async () => {
    const w = createPlanBranchWriter({ baitonDir: '/x/.baiton', git: noGit });
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const all = [0, 1, 2, 3, 4].map((i) =>
      w.apply('s', async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(i);
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        active--;
      }),
    );
    await Promise.all(all);
    assert.deepStrictEqual(order, [0, 1, 2, 3, 4]);
    assert.strictEqual(maxActive, 1);
  });

  it('does not block different slugs', async () => {
    const w = createPlanBranchWriter({ baitonDir: '/x/.baiton', git: noGit });
    const gate = deferred();
    const a = w.apply('a', () => gate.promise);
    let aDone = false;
    void a.then(() => {
      aDone = true;
    });
    assert.strictEqual(await w.apply('b', () => 'quick'), 'quick');
    assert.strictEqual(aDone, false);
    gate.resolve();
    await a;
  });

  it('isolates rejections', async () => {
    const w = createPlanBranchWriter({ baitonDir: '/x/.baiton', git: noGit });
    const boom = new Error('boom');
    await assert.rejects(
      w.apply('s', async () => {
        throw boom;
      }),
      (e: unknown) => e === boom,
    );
    assert.strictEqual(await w.apply('s', () => 7), 7);
  });

  it('passes return values through (sync fn allowed)', async () => {
    const w = createPlanBranchWriter({ baitonDir: '/x/.baiton', git: noGit });
    assert.strictEqual(await w.apply('s', () => 42), 42);
  });

  it('scope.commit delegates to commitPaths on the resolved document folder', async () => {
    const calls: unknown[][] = [];
    const w = createPlanBranchWriter({
      baitonDir: '/repo/.baiton',
      git: {
        commitPaths: async (...args: unknown[]) => {
          calls.push(args);
          return 'sha1';
        },
      },
    });
    const sha = await w.apply('s', (scope) => {
      assert.strictEqual(scope.dir, path.join('/repo/.baiton/plans', 's'));
      return scope.commit('msg', { K: 'v' });
    });
    assert.strictEqual(sha, 'sha1');
    assert.deepStrictEqual(calls, [[['.baiton/plans/s'], 'msg', { K: 'v' }]]);
    assert.strictEqual(planFolderPathspec(locationFor('/x/.baiton', 'x', 'plan')), '.baiton/plans/x');
    assert.strictEqual(planFolderPathspec(locationFor('/x/.baiton', 'x', 'legacy-spec')), '.baiton/specs/x');
  });

  it('commits only the legacy document folder in a real repo', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-sbw-'));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Baiton Test');
    git(repo, 'config', 'user.email', 'baiton-test@example.com');
    writeFile(repo, 'README.md', 'baseline\n');
    writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial commit');
    writeFile(repo, '.baiton/specs/s/spec.md', 'spec\n');
    writeFile(repo, 'src/other.ts', 'x\n');
    const w = createPlanBranchWriter({
      baitonDir: path.join(repo, '.baiton'),
      git: createGitService(repo),
    });
    // Legacy fixture: this document retains its T## phase id.
    await w.apply('s', (scope) => scope.commit('plan(s): T01 planning'));
    const files = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    assert.deepStrictEqual(files, ['.baiton/specs/s/spec.md']);
    assert.ok(git(repo, 'status', '--porcelain').includes('src/'));
  });

  it('commits only the plan document folder in a real repo', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-pbw-plan-'));
    repos.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Baiton Test');
    git(repo, 'config', 'user.email', 'baiton-test@example.com');
    writeFile(repo, 'README.md', 'baseline\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial commit');
    writeFile(repo, '.baiton/plans/s/plan.md', '# PHASES\n- [pending] P01 Plan\n');
    writeFile(repo, 'src/other.ts', 'x\n');
    const w = createPlanBranchWriter({ baitonDir: path.join(repo, '.baiton'), git: createGitService(repo) });
    await w.apply('s', (scope) => scope.commit('plan(s): P01 planning'));
    const files = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    assert.deepStrictEqual(files, ['.baiton/plans/s/plan.md']);
    assert.ok(git(repo, 'status', '--porcelain').includes('src/'));
  });
});
