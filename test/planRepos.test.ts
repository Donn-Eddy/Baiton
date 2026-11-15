import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitService } from '../src/git';
import {
  planOwnerRepoFor,
  repoByRoot,
  type Repo,
  type RepoSet,
} from '../src/activation/repoDiscovery';
import {
  createPlanRepoSeam,
  formatPlanRef,
  parsePlanRef,
} from '../src/orchestrator/planRepos';
import { locationFor } from '../src/storage/documentLocation';

function repo(input: Partial<Repo> & Pick<Repo, 'name' | 'root'>): Repo {
  return {
    folderName: 'workspace',
    relPath: input.name,
    hasGit: false,
    children: [],
    ...input,
  };
}

function writePlan(baitonDir: string, slug: string): string {
  const file = locationFor(baitonDir, slug, 'plan').documentPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# PHASES\n', 'utf8');
  return file;
}

function writeLegacySpec(baitonDir: string, slug: string): string {
  const file = locationFor(baitonDir, slug, 'legacy-spec').documentPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# SPEC\n', 'utf8');
  return file;
}

function deps(ownerRoot: string, getRepos: () => RepoSet | undefined) {
  return {
    repos: getRepos,
    ownerRoot,
    restricted: () => false,
    gitFor: (root: string) => ({ root } as unknown as GitService),
    exists: async (target: string) => fs.promises.access(target).then(() => true, () => false),
  };
}

describe('plan repository seam', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('lists the owner subtree and addresses every .baiton repo', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-repos-'));
    roots.push(workspaceRoot);
    const ownerRoot = path.join(workspaceRoot, 'owner');
    const apiRoot = path.join(ownerRoot, 'packages', 'api');
    const internalRoot = path.join(apiRoot, 'internal');
    const noBaitonRoot = path.join(ownerRoot, 'packages', 'uninitialized');
    const siblingRoot = path.join(workspaceRoot, 'sibling');
    for (const dir of [ownerRoot, apiRoot, internalRoot, noBaitonRoot, siblingRoot]) fs.mkdirSync(dir, { recursive: true });
    const entries = [
      repo({ name: 'workspace', root: workspaceRoot, children: ['owner', 'sibling'] }),
      repo({ name: 'owner', root: ownerRoot, parent: 'workspace', children: ['api', 'no-baiton'], baitonDir: path.join(ownerRoot, '.baiton') }),
      repo({ name: 'api', root: apiRoot, parent: 'owner', children: ['internal'], baitonDir: path.join(apiRoot, '.baiton') }),
      repo({ name: 'internal', root: internalRoot, parent: 'api', baitonDir: path.join(internalRoot, '.baiton') }),
      repo({ name: 'no-baiton', root: noBaitonRoot, parent: 'owner' }),
      repo({ name: 'sibling', root: siblingRoot, parent: 'workspace', baitonDir: path.join(siblingRoot, '.baiton') }),
    ];
    for (const entry of entries) if (entry.baitonDir !== undefined) fs.mkdirSync(entry.baitonDir, { recursive: true });
    const set: RepoSet = { repos: entries, folderRoots: [entries[0]], truncated: false };
    const seam = createPlanRepoSeam(deps(ownerRoot, () => set));

    assert.deepStrictEqual(seam.list(), [
      { path: '.', name: 'owner', hasBaiton: true },
      { path: 'packages/api', name: 'api', hasBaiton: true },
      { path: 'packages/api/internal', name: 'internal', hasBaiton: true },
      { path: 'packages/uninitialized', name: 'no-baiton', hasBaiton: false },
    ]);
    assert.deepStrictEqual(seam.owners(), [
      { path: '.', name: 'owner', hasBaiton: true },
      { path: 'packages/api', name: 'api', hasBaiton: true },
      { path: 'packages/api/internal', name: 'internal', hasBaiton: true },
      { path: '../sibling', name: 'sibling', hasBaiton: true },
    ]);

    const api = seam.target('packages/api/../api');
    assert.strictEqual(api.ok, true);
    if (api.ok) {
      assert.strictEqual(api.target.info.path, 'packages/api');
      assert.strictEqual(api.target.topology.owner, 'api');
      assert.strictEqual(api.target.guard.repoRoot, apiRoot);
    }
    const sibling = seam.target('../sibling');
    assert.strictEqual(sibling.ok, true);
    if (sibling.ok) {
      assert.strictEqual(sibling.target.info.path, '../sibling');
      assert.strictEqual(sibling.target.topology.owner, 'sibling');
      assert.strictEqual(sibling.target.guard.repoRoot, siblingRoot);
      assert.strictEqual(sibling.target.baitonDir, path.join(siblingRoot, '.baiton'));
      assert.strictEqual((sibling.target.git as unknown as { root: string }).root, siblingRoot);
      const ownerDocument = writePlan(path.join(ownerRoot, '.baiton'), 'owner-plan');
      assert.strictEqual((await sibling.target.guard.resolveMutatingPath(ownerDocument)).ok, false);
    }
    assert.strictEqual(seam.targetAt(siblingRoot)?.info.path, '../sibling');
    assert.strictEqual(seam.targetAt(noBaitonRoot), undefined);
    assert.deepStrictEqual(seam.target('..'), {
      ok: false,
      error: 'repo ".." is not a discovered repo with a .baiton/ directory',
    });
    assert.deepStrictEqual(seam.target('packages/uninitialized'), {
      ok: false,
      error: 'repo "packages/uninitialized" has no .baiton/ directory; initialize Baiton there first',
    });
    assert.deepStrictEqual(seam.target('nope'), {
      ok: false,
      error: 'repo "nope" is not a discovered repo with a .baiton/ directory',
    });
  });

  it('locates without precedence and supports explicit repo lookup', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-repos-locate-'));
    roots.push(workspaceRoot);
    const ownerRoot = path.join(workspaceRoot, 'owner');
    const apiRoot = path.join(ownerRoot, 'packages', 'api');
    const nestedRoot = path.join(apiRoot, 'nested');
    const siblingRoot = path.join(workspaceRoot, 'sibling');
    for (const dir of [ownerRoot, apiRoot, nestedRoot, siblingRoot]) fs.mkdirSync(dir, { recursive: true });
    const entries = [
      repo({ name: 'workspace', root: workspaceRoot, children: ['owner', 'sibling'] }),
      repo({ name: 'owner', root: ownerRoot, parent: 'workspace', children: ['api'], baitonDir: path.join(ownerRoot, '.baiton') }),
      repo({ name: 'api', root: apiRoot, parent: 'owner', children: ['nested'], baitonDir: path.join(apiRoot, '.baiton') }),
      repo({ name: 'nested', root: nestedRoot, parent: 'api', baitonDir: path.join(nestedRoot, '.baiton') }),
      repo({ name: 'sibling', root: siblingRoot, parent: 'workspace', baitonDir: path.join(siblingRoot, '.baiton') }),
    ];
    for (const entry of entries) {
      if (entry.baitonDir !== undefined) fs.mkdirSync(entry.baitonDir, { recursive: true });
    }
    const set: RepoSet = { repos: entries, folderRoots: [entries[0]], truncated: false };
    const seam = createPlanRepoSeam(deps(ownerRoot, () => set));
    writePlan(path.join(ownerRoot, '.baiton'), 'shared');
    writePlan(path.join(apiRoot, '.baiton'), 'shared');
    writePlan(path.join(apiRoot, '.baiton'), 'ambiguous');
    writePlan(path.join(nestedRoot, '.baiton'), 'ambiguous');
    writePlan(path.join(siblingRoot, '.baiton'), 'sibling-only');
    writePlan(path.join(ownerRoot, '.baiton'), 'owner-only');
    writeLegacySpec(path.join(nestedRoot, '.baiton'), 'legacy-child');

    assert.deepStrictEqual(await seam.locate('shared'), { kind: 'ambiguous', repos: ['.', 'packages/api'] });
    assert.deepStrictEqual(await seam.locate('ambiguous'), {
      kind: 'ambiguous',
      repos: ['packages/api', 'packages/api/nested'],
    });
    const siblingOnly = await seam.locate('sibling-only');
    assert.strictEqual(siblingOnly.kind, 'found');
    if (siblingOnly.kind === 'found') assert.strictEqual(siblingOnly.target.info.path, '../sibling');
    const ownerOnly = await seam.locate('owner-only');
    assert.strictEqual(ownerOnly.kind, 'found');
    if (ownerOnly.kind === 'found') assert.strictEqual(ownerOnly.target.info.path, '.');
    const legacy = await seam.locate('legacy-child');
    assert.strictEqual(legacy.kind, 'found');
    if (legacy.kind === 'found') assert.strictEqual(legacy.target.info.path, 'packages/api/nested');
    assert.deepStrictEqual(await seam.locate('missing'), { kind: 'missing' });

    const ownerMatch = await seam.locate('shared', '.');
    assert.strictEqual(ownerMatch.kind, 'found');
    if (ownerMatch.kind === 'found') assert.strictEqual(ownerMatch.target.info.path, '.');
    const apiMatch = await seam.locate('shared', 'packages/api');
    assert.strictEqual(apiMatch.kind, 'found');
    if (apiMatch.kind === 'found') assert.strictEqual(apiMatch.target.info.path, 'packages/api');
    assert.deepStrictEqual(await seam.locate('shared', 'packages/api/nested'), { kind: 'missing' });
    const invalid = await seam.locate('x', 'bogus');
    assert.strictEqual(invalid.kind, 'invalid');
  });

  it('degenerates to the synthetic owner when discovery cannot locate the owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-repos-fallback-'));
    roots.push(root);
    const ownerRoot = path.join(root, 'owner');
    fs.mkdirSync(path.join(ownerRoot, '.baiton'), { recursive: true });
    const expectedInfo = [{ path: '.', name: '.', hasBaiton: true }];

    const withoutSet = createPlanRepoSeam(deps(ownerRoot, () => undefined));
    assert.deepStrictEqual(withoutSet.list(), expectedInfo);
    assert.deepStrictEqual(withoutSet.owners(), expectedInfo);
    const fallback = withoutSet.target('.');
    assert.strictEqual(fallback.ok, true);
    if (fallback.ok) assert.strictEqual(fallback.target.baitonDir, path.join(ownerRoot, '.baiton'));
    assert.deepStrictEqual(withoutSet.target('../x'), {
      ok: false,
      error: 'repo "../x" is not a discovered repo with a .baiton/ directory',
    });
    writePlan(path.join(ownerRoot, '.baiton'), 'fallback');
    assert.strictEqual((await withoutSet.locate('fallback')).kind, 'found');
    assert.deepStrictEqual(await withoutSet.locate('missing'), { kind: 'missing' });
    assert.strictEqual((await withoutSet.locate('fallback', 'packages/api')).kind, 'invalid');

    const otherRoot = path.join(root, 'other');
    fs.mkdirSync(otherRoot, { recursive: true });
    const otherSet: RepoSet = {
      repos: [repo({ name: 'other', root: otherRoot, baitonDir: path.join(otherRoot, '.baiton') })],
      folderRoots: [],
      truncated: false,
    };
    const missingOwner = createPlanRepoSeam(deps(ownerRoot, () => otherSet));
    assert.deepStrictEqual(missingOwner.list(), expectedInfo);
    assert.deepStrictEqual(missingOwner.owners(), expectedInfo);
    assert.strictEqual(missingOwner.targetAt(ownerRoot)?.info.path, '.');

    const singleSet: RepoSet = {
      repos: [repo({ name: '.', root: ownerRoot, baitonDir: path.join(ownerRoot, '.baiton') })],
      folderRoots: [],
      truncated: false,
    };
    const single = createPlanRepoSeam(deps(ownerRoot, () => singleSet));
    assert.deepStrictEqual(single.list(), expectedInfo);
    assert.deepStrictEqual(single.owners(), expectedInfo);
    const singleTarget = single.target('.');
    assert.strictEqual(singleTarget.ok, true);
    if (singleTarget.ok) {
      assert.deepStrictEqual(singleTarget.target.topology, {
        owner: '.',
        repos: [{ name: '.', root: ownerRoot }],
      });
    }
  });

  it('parses and formats qualified plan references', () => {
    assert.deepStrictEqual(parsePlanRef('my-plan'), { ok: true, ref: { slug: 'my-plan' } });
    assert.deepStrictEqual(parsePlanRef('packages/api:my-plan'), {
      ok: true,
      ref: { repo: 'packages/api', slug: 'my-plan' },
    });
    assert.deepStrictEqual(parsePlanRef('packages\\api/:my-plan'), {
      ok: true,
      ref: { repo: 'packages/api', slug: 'my-plan' },
    });
    assert.deepStrictEqual(parsePlanRef('.:x'), { ok: true, ref: { repo: '.', slug: 'x' } });
    assert.deepStrictEqual(parsePlanRef('./:x'), { ok: true, ref: { repo: '.', slug: 'x' } });
    assert.deepStrictEqual(parsePlanRef('../sibling:x'), { ok: true, ref: { repo: '../sibling', slug: 'x' } });
    assert.deepStrictEqual(parsePlanRef('C:/w/repo:x'), { ok: true, ref: { repo: 'C:/w/repo', slug: 'x' } });
    for (const input of [':x', 'a:', '', '   ']) assert.strictEqual(parsePlanRef(input).ok, false, input);
    assert.deepStrictEqual(parsePlanRef('   '), { ok: false, error: 'empty plan reference' });
    assert.deepStrictEqual(parsePlanRef(':x'), { ok: false, error: 'plan reference ":x" has an empty repo path' });
    assert.deepStrictEqual(parsePlanRef('a:'), { ok: false, error: 'plan reference "a:" has no slug' });
    assert.strictEqual(formatPlanRef('.', 'x'), '.:x');
    assert.strictEqual(formatPlanRef('packages/api/', 'x'), 'packages/api:x');

    for (const repoPath of ['.', 'packages/api', '../sibling', '/workspace/repo', 'C:/w/repo']) {
      const formatted = formatPlanRef(repoPath, 'some-plan');
      assert.deepStrictEqual(parsePlanRef(formatted), {
        ok: true,
        ref: { repo: repoPath, slug: 'some-plan' },
      });
    }
  });

  it('provides pure repo root and plan owner lookups', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-owner-'));
    roots.push(root);
    const ownerRoot = path.join(root, 'owner');
    const apiRoot = path.join(ownerRoot, 'packages', 'api');
    const plainRoot = path.join(ownerRoot, 'plain');
    const owner = repo({ name: 'owner', root: ownerRoot, baitonDir: path.join(ownerRoot, '.baiton') });
    const api = repo({ name: 'api', root: apiRoot, baitonDir: path.join(apiRoot, '.baiton'), parent: 'owner' });
    const plain = repo({ name: 'plain', root: plainRoot, parent: 'owner' });
    const set: RepoSet = { repos: [owner, api, plain], folderRoots: [owner], truncated: false };

    assert.strictEqual(repoByRoot(set, path.join(apiRoot, '..', 'api')), api);
    assert.strictEqual(planOwnerRepoFor(set, path.join(apiRoot, '.baiton', 'plans', 's', 'plan.md')), api);
    assert.strictEqual(planOwnerRepoFor(set, path.join(ownerRoot, '.baiton', 'plans', 's', 'plan.md')), owner);
    assert.strictEqual(planOwnerRepoFor(set, path.join(apiRoot, 'src', 'x.ts')), undefined);
    assert.strictEqual(planOwnerRepoFor(set, path.join(plainRoot, 'src', 'x.ts')), undefined);
  });
});
