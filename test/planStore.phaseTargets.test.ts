import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPhaseTargetResolver } from '../src/activation/planStore';
import type { GitWorktreeService } from '../src/git';
import type { RepoTopology } from '../src/model/validator';

describe('phase target resolver', () => {
  let ownerRoot: string;
  const ownerGit = {} as GitWorktreeService;
  const childGit = {} as GitWorktreeService;
  let childRoot: string;
  const topologyForOwner = (root: string): RepoTopology => ({
    owner: '.',
    repos: [
      { name: '.', root },
      { name: 'packages/api', root: childRoot, parent: '.' },
    ],
  });

  beforeEach(() => {
    ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-target-owner-'));
    childRoot = path.join(ownerRoot, 'packages/api');
    fs.mkdirSync(path.join(ownerRoot, '.baiton/plans/s'), { recursive: true });
    fs.writeFileSync(path.join(ownerRoot, '.baiton/plans/s/plan.md'), [
      '# PHASES',
      '- [pending] P01 Owner work',
      '- [pending] P02 Child work (after P01; repo: packages/api)',
      '- [pending] P03 Invalid work (repo: ../elsewhere)',
    ].join('\n'));
  });

  afterEach(() => fs.rmSync(ownerRoot, { recursive: true, force: true }));

  function resolver(topologyValue: RepoTopology | undefined) {
    const gitRoots: string[] = [];
    return {
      gitRoots,
      targets: createPhaseTargetResolver({
        baitonDir: path.join(ownerRoot, '.baiton'),
        ownerRoot,
        topology: () => topologyValue,
        gitFor: (root) => {
          gitRoots.push(path.resolve(root));
          return path.resolve(root) === ownerRoot ? ownerGit : childGit;
        },
      }),
    };
  }

  it('resolves owner and child targets and falls back to owner for unknown phases or missing documents', async () => {
    const { targets, gitRoots } = resolver(topologyForOwner(ownerRoot));
    const owner = await targets.forPhase('s', 'P01');
    assert.ok(owner.ok);
    if (owner.ok) {
      assert.strictEqual(owner.value.isOwner, true);
      assert.strictEqual(owner.value.git, ownerGit);
      assert.strictEqual(owner.value.name, '.');
    }
    const child = await targets.forPhase('s', 'P02');
    assert.ok(child.ok);
    if (child.ok) {
      assert.strictEqual(child.value.root, childRoot);
      assert.strictEqual(child.value.git, childGit);
      assert.strictEqual(gitRoots.at(-1), childRoot);
    }
    const unknown = await targets.forPhase('s', 'P99');
    assert.ok(unknown.ok && unknown.value.isOwner);
    const missing = await targets.forPhase('missing', 'P02');
    assert.ok(missing.ok && missing.value.isOwner);
    const invalid = await targets.forPhase('s', 'P03');
    assert.ok(!invalid.ok);
    if (!invalid.ok) assert.match(invalid.error, /\.\.\/elsewhere/);
  });

  it('lists distinct valid targets owner first and skips invalid hints', async () => {
    const { targets } = resolver(topologyForOwner(ownerRoot));
    const planTargets = await targets.forPlan('s');
    assert.deepStrictEqual(planTargets.map((target) => target.root), [ownerRoot, childRoot]);
  });

  it('resolves hint-less phases without topology and rejects child hints without topology', async () => {
    const { targets } = resolver(undefined);
    const owner = await targets.forPhase('s', 'P01');
    assert.ok(owner.ok && owner.value.root === ownerRoot);
    const child = await targets.forPhase('s', 'P02');
    assert.ok(!child.ok);
  });
});
