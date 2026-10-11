import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { PlanStore } from '../src/engine';
import type { Surface } from '../src/activation/surface';

type PlanExplorerModule = typeof import('../src/activation/planExplorer');
let mod: PlanExplorerModule;

function validPlan(): string {
  return [
    '# Endstate', 'The plan is complete.', '',
    '# What needs changing', 'Change the activation path.', '',
    '# Limitations & constraints', 'None.', '',
    '# PHASES', '- [pending] P01 Implement the plan', '',
  ].join('\n');
}

function validLegacyPlan(): string {
  return [
    '---', 'status: draft', 'branch:', 'approved_rev: ', '---', '',
    '# OVERVIEW', 'Legacy plan.', '',
    '# TODOS', '- [pending] T01 Legacy phase', '',
  ].join('\n');
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('PlanExplorer', () => {
  let root: string;
  let baitonDir: string;
  let explorer: InstanceType<PlanExplorerModule['PlanExplorer']> | undefined;

  before(async () => {
    const repoRoot = process.cwd();
    const loaderUrl = pathToFileURL(join(repoRoot, 'test', 'fixtures', 'vscodeLoader.mjs')).href;
    register(loaderUrl, pathToFileURL(join(repoRoot, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    mod = await import('../src/activation/planExplorer');
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-explorer-'));
    baitonDir = path.join(root, '.baiton');
    const write = (relative: string, contents: string) => {
      const target = path.join(baitonDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    write('plans/alpha/plan.md', validPlan());
    write('specs/beta/spec.md', validLegacyPlan());

    const watchers: Array<{ create?: () => void; change?: () => void; del?: () => void; disposed: boolean }> = [];
    const fake = {
      commands: {
        executeCommand: async () => undefined,
        registerCommand: () => ({ dispose: () => undefined }),
      },
      workspace: {
        createFileSystemWatcher: () => {
          const watcher = { disposed: false };
          watchers.push(watcher);
          const on = () => ({ dispose: () => undefined });
          return {
            onDidCreate: on,
            onDidChange: on,
            onDidDelete: on,
            dispose: () => { watcher.disposed = true; },
          };
        },
      },
      RelativePattern: class {
        constructor(public readonly base: string, public readonly pattern: string) {}
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;
  });

  afterEach(() => {
    explorer?.dispose();
    explorer = undefined;
    delete (globalThis as unknown as { __vscodeFake?: unknown }).__vscodeFake;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists plan and legacy roots with plan and phase nodes', async () => {
    const surface = { error: () => undefined } as unknown as Surface;
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      surface,
      false,
    ).start();
    await waitFor(() => explorer !== undefined && explorer.getChildren()
      .some((group) => explorer!.getChildren(group).length > 0), 'the initial plan refresh');

    const roots = explorer.getChildren();
    assert.deepStrictEqual(roots.map((node) => node.kind), ['group', 'group', 'group']);
    assert.deepStrictEqual(roots.map((node) => node.kind === 'group' ? node.node.kind : ''), ['active', 'pending', 'completed']);
    const labels = ['Active', 'Pending', 'Completed'];
    const kinds = ['active', 'pending', 'completed'];
    const counts = ['0', '2', '0'];
    roots.forEach((group, index) => {
      const item = explorer!.getTreeItem(group);
      assert.strictEqual(item.label, labels[index]);
      assert.strictEqual(item.id, `baiton.planGroup.${kinds[index]}`);
      assert.strictEqual(item.contextValue, `baiton.planGroup.${kinds[index]}`);
      assert.strictEqual(item.collapsibleState, index === 2 ? 1 : 2);
      assert.strictEqual(item.description, counts[index]);
      assert.strictEqual(item.command, undefined);
      assert.strictEqual(mod.treeNodeTarget(group), undefined);
    });

    const activePlans = explorer.getChildren(roots[0]);
    const plans = explorer.getChildren(roots[1]);
    const completedPlans = explorer.getChildren(roots[2]);
    assert.deepStrictEqual(activePlans, []);
    assert.deepStrictEqual(completedPlans, []);
    assert.deepStrictEqual(plans.map((node) => node.kind === 'plan' ? node.node.slug : ''), ['alpha', 'beta']);
    const children = plans.map((plan) => explorer!.getChildren(plan));
    assert.deepStrictEqual(children.map((nodes) => nodes.map((node) => node.kind === 'phase' ? node.node.id : node.kind)), [['P01'], ['T01']]);

    assert.ok(explorer.getTreeItem(plans[0]).contextValue?.startsWith('baiton.planRoot'));
    assert.ok(explorer.getTreeItem(children[0][0]).contextValue?.startsWith('baiton.phase'));
    assert.deepStrictEqual(mod.treeNodeTarget(plans[0]), ['alpha']);
    assert.deepStrictEqual(mod.treeNodeTarget(children[0][0]), ['alpha', 'P01']);
  });

  it('places plans into Active, Pending, and Completed groups from their facts', async () => {
    const write = (relative: string, contents: string) => {
      const target = path.join(baitonDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    write('plans/gamma/plan.md', ['---', 'status: done', '---', validPlan()].join('\n'));
    write(
      'plans/delta/plan.md',
      validPlan().replace('- [pending] P01 Implement the plan', '- [executing] P01 Implement the plan'),
    );
    write(
      'plans/eps/plan.md',
      [
        '---', 'status: done', '---',
        validPlan().replace(
          '- [pending] P01 Implement the plan',
          '- [pending] P01 Implement the plan\n- [pending] P01 Duplicate phase',
        ),
      ].join('\n'),
    );

    const surface = { error: () => undefined } as unknown as Surface;
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async (slug: string) => slug === 'beta' } as unknown as PlanStore,
      surface,
      false,
    ).start();
    await waitFor(() => explorer !== undefined && explorer.getChildren()
      .some((group) => explorer!.getChildren(group).length === 2), 'the grouped plan refresh');

    const groups = explorer.getChildren();
    const slugsByGroup = groups.map((group) => explorer!.getChildren(group)
      .map((node) => node.kind === 'plan' ? node.node.slug : ''));
    assert.deepStrictEqual(slugsByGroup, [['beta', 'delta'], ['alpha'], ['eps', 'gamma']]);
  });
});
