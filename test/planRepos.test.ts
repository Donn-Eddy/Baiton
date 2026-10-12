import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitService } from '../src/git';
import type { Repo, RepoSet } from '../src/activation/repoDiscovery';
import { createPlanRepoSeam } from '../src/orchestrator/planRepos';
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

function writePlan(baitonDir: string, slug: string): void {
  const file = locationFor(baitonDir, slug, 'plan').documentPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# PHASES\n', 'utf8');
}

describe('plan repository seam', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('lists only the owner and descendants with owner-relative POSIX paths', async () => {
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
    const seam = createPlanRepoSeam({
      repos: () => set,
      ownerRoot,
      restricted: () => false,
      gitFor: () => ({} as GitService),
      exists: async (target) => fs.promises.access(target).then(() => true, () => false),
    });

    assert.deepStrictEqual(seam.list(), [
      { path: '.', name: 'owner', hasBaiton: true },
      { path: 'packages/api', name: 'api', hasBaiton: true },
      { path: 'packages/api/internal', name: 'internal', hasBaiton: true },
      { path: 'packages/uninitialized', name: 'no-baiton', hasBaiton: false },
    ]);
    const api = seam.target('packages/api/../api');
    assert.strictEqual(api.ok, true);
    if (api.ok) {
      assert.strictEqual(api.target.info.path, 'packages/api');
      assert.strictEqual(api.target.topology.owner, 'api');
      assert.strictEqual(api.target.guard.repoRoot, apiRoot);
    }
    assert.deepStrictEqual(seam.target('..'), {
      ok: false,
      error: 'repo ".." is not the owning repo or a repo nested beneath it',
    });
    assert.deepStrictEqual(seam.target('../sibling'), {
      ok: false,
      error: 'repo "../sibling" is not the owning repo or a repo nested beneath it',
    });
    assert.deepStrictEqual(seam.target('packages/uninitialized'), {
      ok: false,
      error: 'repo "packages/uninitialized" has no .baiton/ directory; initialize Baiton there first',
    });
  });

  it('prefers an owner match and refuses a slug found in multiple descendants', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-repos-locate-'));
    roots.push(workspaceRoot);
    const ownerRoot = path.join(workspaceRoot, 'owner');
    const apiRoot = path.join(ownerRoot, 'packages', 'api');
    const nestedRoot = path.join(apiRoot, 'nested');
    for (const dir of [ownerRoot, apiRoot, nestedRoot]) fs.mkdirSync(dir, { recursive: true });
    const entries = [
      repo({ name: 'workspace', root: workspaceRoot, children: ['owner'] }),
      repo({ name: 'owner', root: ownerRoot, parent: 'workspace', children: ['api'], baitonDir: path.join(ownerRoot, '.baiton') }),
      repo({ name: 'api', root: apiRoot, parent: 'owner', children: ['nested'], baitonDir: path.join(apiRoot, '.baiton') }),
      repo({ name: 'nested', root: nestedRoot, parent: 'api', baitonDir: path.join(nestedRoot, '.baiton') }),
    ];
    for (const entry of entries) {
      if (entry.baitonDir !== undefined) fs.mkdirSync(entry.baitonDir, { recursive: true });
    }
    const set: RepoSet = { repos: entries, folderRoots: [entries[0]], truncated: false };
    const seam = createPlanRepoSeam({
      repos: () => set,
      ownerRoot,
      restricted: () => false,
      gitFor: () => ({} as GitService),
      exists: async (target) => fs.promises.access(target).then(() => true, () => false),
    });
    writePlan(path.join(ownerRoot, '.baiton'), 'owner-wins');
    writePlan(path.join(apiRoot, '.baiton'), 'owner-wins');
    writePlan(path.join(apiRoot, '.baiton'), 'ambiguous');
    writePlan(path.join(nestedRoot, '.baiton'), 'ambiguous');

    const ownerMatch = await seam.locate('owner-wins');
    assert.strictEqual(ownerMatch.kind, 'found');
    if (ownerMatch.kind === 'found') assert.strictEqual(ownerMatch.target.info.path, '.');
    assert.deepStrictEqual(await seam.locate('ambiguous'), {
      kind: 'ambiguous',
      repos: ['packages/api', 'packages/api/nested'],
    });
    assert.deepStrictEqual(await seam.locate('missing'), { kind: 'missing' });
  });
});
