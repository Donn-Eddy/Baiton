import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listPhasePlans,
  listPlans,
  listPlansAcrossRepos,
  phasePlanPath,
  planListingRepos,
} from '../src/activation/planLister';
import type { RepoSet } from '../src/activation/repoDiscovery';

describe('plan lister', () => {
  let root: string;
  let baitonDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-lister-'));
    baitonDir = path.join(root, '.baiton');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(relative: string, contents: string): void {
    const target = path.join(baitonDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  it('lists resolved plan and legacy documents once each in slug order', async () => {
    write('specs/z-legacy/spec.md', '# OVERVIEW\nLegacy.\n');
    write('plans/a-plan/plan.md', '# PHASES\n');
    write('specs/shared/spec.md', 'legacy\n');
    write('plans/shared/plan.md', 'plan\n');
    write('plans/draft/other.txt', 'no document\n');

    assert.deepStrictEqual(await listPlans(baitonDir), [
      { slug: 'a-plan', kind: 'plan', raw: '# PHASES\n' },
      { slug: 'shared', kind: 'plan', raw: 'plan\n' },
      { slug: 'z-legacy', kind: 'legacy-spec', raw: '# OVERVIEW\nLegacy.\n' },
    ]);
  });

  it('reports non-ENOENT document read failures and locates phase plans by kind', async () => {
    fs.mkdirSync(path.join(baitonDir, 'plans', 'unreadable', 'plan.md'), { recursive: true });
    write('specs/legacy/spec.md', '# OVERVIEW\n');
    write('specs/legacy/todos/T01/plan.md', '# Legacy plan\n');
    write('plans/new/plan.md', '# PHASES\n');
    write('plans/new/phases/P01/plan.md', '# Plan P01\n');

    const listed = await listPlans(baitonDir);
    const readFailure = listed.find((item) => item.slug === 'unreadable');
    assert.strictEqual(readFailure?.kind, 'plan');
    assert.match(readFailure?.readError ?? '', /EISDIR/);
    assert.strictEqual(phasePlanPath(baitonDir, 'legacy', 'T01'), path.join(baitonDir, 'specs', 'legacy', 'todos', 'T01', 'plan.md'));
    assert.strictEqual(phasePlanPath(baitonDir, 'new', 'P01'), path.join(baitonDir, 'plans', 'new', 'phases', 'P01', 'plan.md'));
    assert.deepStrictEqual([...await listPhasePlans(baitonDir, 'legacy')], ['T01']);
    assert.deepStrictEqual([...await listPhasePlans(baitonDir, 'new')], ['P01']);
  });

  it('lists plans across repositories in source order and skips a missing source', async () => {
    const childBaitonDir = path.join(root, 'packages', 'api', '.baiton');
    const writeAt = (directory: string, relative: string, contents: string): void => {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    writeAt(baitonDir, 'plans/alpha/plan.md', 'root alpha\n');
    writeAt(baitonDir, 'specs/zeta/spec.md', 'root zeta\n');
    writeAt(childBaitonDir, 'plans/alpha/plan.md', 'api alpha\n');
    writeAt(childBaitonDir, 'plans/beta/plan.md', 'api beta\n');

    const listed = await listPlansAcrossRepos([
      { repo: '.', baitonDir },
      { repo: 'packages/api', baitonDir: childBaitonDir },
      { repo: 'missing', baitonDir: path.join(root, 'missing', '.baiton') },
    ]);
    assert.deepStrictEqual(
      listed.map(({ repo, slug, baitonDir: owner }) => [repo, slug, owner]),
      [
        ['.', 'alpha', baitonDir],
        ['.', 'zeta', baitonDir],
        ['packages/api', 'alpha', childBaitonDir],
        ['packages/api', 'beta', childBaitonDir],
      ],
    );
    assert.deepStrictEqual(listed.map((entry) => entry.raw), [
      'root alpha\n', 'root zeta\n', 'api alpha\n', 'api beta\n',
    ]);
  });

  it('projects only repos with baiton directories and gives each the full topology', () => {
    const rootRepo = {
      name: '.', folderName: 'workspace', relPath: '', root,
      baitonDir, hasGit: true, children: ['packages/api', 'packages/web'],
    };
    const apiRepo = {
      name: 'packages/api', folderName: 'workspace', relPath: 'packages/api',
      root: path.join(root, 'packages', 'api'), baitonDir: path.join(root, 'packages', 'api', '.baiton'),
      hasGit: true, parent: '.', children: [],
    };
    const webRepo = {
      name: 'packages/web', folderName: 'workspace', relPath: 'packages/web',
      root: path.join(root, 'packages', 'web'), hasGit: true, parent: '.', children: [],
    };
    const set: RepoSet = {
      repos: [rootRepo, apiRepo, webRepo],
      folderRoots: [rootRepo],
      truncated: false,
    };

    const sources = planListingRepos(set);
    assert.deepStrictEqual(sources.map(({ repo, baitonDir: owner, topology }) => ({
      repo,
      baitonDir: owner,
      owner: topology?.owner,
      topologyRepos: topology?.repos.map((entry) => entry.name),
    })), [
      { repo: '.', baitonDir, owner: '.', topologyRepos: ['.', 'packages/api', 'packages/web'] },
      {
        repo: 'packages/api',
        baitonDir: apiRepo.baitonDir,
        owner: 'packages/api',
        topologyRepos: ['.', 'packages/api', 'packages/web'],
      },
    ]);
  });
});
