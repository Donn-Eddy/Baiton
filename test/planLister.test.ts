import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listPhasePlans,
  listPlans,
  listPlansAcrossRepos,
  phasePlanPath,
  planExplorerSourceSpecs,
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
      { repo: 'packages/api', baitonDir: path.join(childBaitonDir, '.') },
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

  it('de-duplicates the same repo and slug across distinct source paths', async () => {
    const otherBaitonDir = path.join(root, 'other', '.baiton');
    const thirdBaitonDir = path.join(root, 'third', '.baiton');
    const writeAt = (directory: string, relative: string, contents: string): void => {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    writeAt(baitonDir, 'plans/alpha/plan.md', 'first source\n');
    writeAt(otherBaitonDir, 'plans/alpha/plan.md', 'second source\n');
    writeAt(thirdBaitonDir, 'plans/alpha/plan.md', 'third source\n');

    const listed = await listPlansAcrossRepos([
      { repo: 'duplicate', baitonDir },
      { repo: 'duplicate', baitonDir: otherBaitonDir },
      { repo: 'other-repo', baitonDir: thirdBaitonDir },
    ]);
    assert.deepStrictEqual(listed.map(({ repo, slug }) => [repo, slug]), [
      ['duplicate', 'alpha'],
      ['other-repo', 'alpha'],
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

  it('projects discovered repos into source specs with owner and action policy', () => {
    const rootRepo = {
      name: '.', folderName: 'workspace', relPath: '', root,
      baitonDir, hasGit: true, children: ['packages/api', 'packages/web'],
    };
    const apiRoot = path.join(root, 'packages', 'api');
    const apiBaitonDir = path.join(apiRoot, '.baiton');
    const apiRepo = {
      name: 'packages/api', folderName: 'workspace', relPath: 'packages/api',
      root: apiRoot, baitonDir: apiBaitonDir, hasGit: true, parent: '.', children: [],
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
    const deps = {
      ownerRoot: root,
      ownerBaitonDir: path.join(root, '.baiton-owner'),
      restricted: false,
      loaded: () => true,
    };

    assert.deepStrictEqual(planExplorerSourceSpecs(undefined, deps), []);
    const specs = planExplorerSourceSpecs(set, deps);
    assert.deepStrictEqual(specs.map(({ repo, root: specRoot, baitonDir: directory, isOwner, actionable, topology }) => ({
      repo, root: specRoot, baitonDir: directory, isOwner, actionable, topologyOwner: topology?.owner,
    })), [
      {
        repo: '.', root, baitonDir: deps.ownerBaitonDir,
        isOwner: true, actionable: true, topologyOwner: '.',
      },
      {
        repo: 'packages/api', root: apiRoot, baitonDir: apiBaitonDir,
        isOwner: false, actionable: true, topologyOwner: 'packages/api',
      },
    ]);
    const restricted = planExplorerSourceSpecs(set, { ...deps, restricted: true });
    assert.deepStrictEqual(restricted.map(({ actionable }) => actionable), [true, false]);
    const unloaded = planExplorerSourceSpecs(set, {
      ...deps,
      loaded: (name) => name !== 'packages/api',
    });
    assert.deepStrictEqual(unloaded.map(({ actionable }) => actionable), [true, false]);
    assert.strictEqual(planExplorerSourceSpecs({
      repos: [rootRepo], folderRoots: [rootRepo], truncated: false,
    }, deps).length, 1);
  });
});
