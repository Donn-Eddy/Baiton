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
    await waitFor(() => explorer?.getChildren().length === 2, 'the initial root refresh');

    const roots = explorer.getChildren();
    assert.deepStrictEqual(roots.map((node) => node.kind), ['plan', 'plan']);
    assert.deepStrictEqual(roots.map((node) => node.kind === 'plan' ? node.node.slug : ''), ['alpha', 'beta']);
    const children = roots.map((rootNode) => explorer!.getChildren(rootNode));
    assert.deepStrictEqual(children.map((nodes) => nodes.map((node) => node.kind === 'phase' ? node.node.id : node.kind)), [['P01'], ['T01']]);

    assert.ok(explorer.getTreeItem(roots[0]).contextValue?.startsWith('baiton.planRoot'));
    assert.ok(explorer.getTreeItem(children[0][0]).contextValue?.startsWith('baiton.phase'));
    assert.deepStrictEqual(mod.treeNodeTarget(roots[0]), ['alpha']);
    assert.deepStrictEqual(mod.treeNodeTarget(children[0][0]), ['alpha', 'P01']);
  });
});
