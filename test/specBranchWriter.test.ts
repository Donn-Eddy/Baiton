import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import { createSpecBranchWriter, specFolderPathspec } from '../src/engine/specBranchWriter';

/** Unit tests for the per-slug serialized spec-branch writer. */

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

describe('specBranchWriter', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it('serializes same-slug callers', async () => {
    const w = createSpecBranchWriter({ specsDir: '/x', git: noGit });
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
    const w = createSpecBranchWriter({ specsDir: '/x', git: noGit });
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
    const w = createSpecBranchWriter({ specsDir: '/x', git: noGit });
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
    const w = createSpecBranchWriter({ specsDir: '/x', git: noGit });
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
    const w = createSpecBranchWriter({ specsDir: '/x', git: noGit });
    assert.strictEqual(await w.apply('s', () => 42), 42);
  });

  it('scope.commit delegates to commitPaths on the spec folder', async () => {
    const calls: unknown[][] = [];
    const w = createSpecBranchWriter({
      specsDir: '/repo/.baiton/specs',
      git: {
        commitPaths: async (...args: unknown[]) => {
          calls.push(args);
          return 'sha1';
        },
      },
    });
    const sha = await w.apply('s', (scope) => {
      assert.strictEqual(scope.dir, path.join('/repo/.baiton/specs', 's'));
      return scope.commit('msg', { K: 'v' });
    });
    assert.strictEqual(sha, 'sha1');
    assert.deepStrictEqual(calls, [[['.baiton/specs/s'], 'msg', { K: 'v' }]]);
    assert.strictEqual(specFolderPathspec('x'), '.baiton/specs/x');
  });

  it('commits only the spec folder in a real repo', async () => {
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
    const w = createSpecBranchWriter({
      specsDir: path.join(repo, '.baiton', 'specs'),
      git: createGitService(repo),
    });
    await w.apply('s', (scope) => scope.commit('spec(s): T01 planning'));
    const files = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    assert.deepStrictEqual(files, ['.baiton/specs/s/spec.md']);
    assert.ok(git(repo, 'status', '--porcelain').includes('src/'));
  });
});
