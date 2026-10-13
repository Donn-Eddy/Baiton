import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { PlanStore } from '../src/engine';
import { phaseContextValue } from '../src/model/phaseActions';
import { planContextValue } from '../src/model/planActions';
import type { RepoTopology } from '../src/model/validator';
import type { Surface } from '../src/activation/surface';
import type { PrsMergedQuery } from '../src/activation/planExplorer';

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

function repoTopologies(root: string): { owner: RepoTopology; api: RepoTopology } {
  const apiRoot = path.join(root, 'packages', 'api');
  const repos = [
    { name: '.', root },
    { name: 'packages/api', root: apiRoot, parent: '.' },
  ];
  return {
    owner: { owner: '.', repos },
    api: { owner: 'packages/api', repos },
  };
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

describe('PlanExplorer', function () {
  this.timeout(8000);
  let root: string;
  let baitonDir: string;
  let explorer: InstanceType<PlanExplorerModule['PlanExplorer']> | undefined;

  function writePlan(slug: string, frontmatterLines: string[]): string {
    const target = path.join(baitonDir, 'plans', slug, 'plan.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ['---', ...frontmatterLines, '---', validPlan()].join('\n'));
    return target;
  }

  function groupSlugs(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const group of explorer?.getChildren() ?? []) {
      if (group.kind !== 'group') continue;
      out[group.node.kind] = explorer!.getChildren(group)
        .flatMap((node) => node.kind === 'plan' ? [node.node.slug] : []);
    }
    return out;
  }

  function fireChange(): void {
    const fake = (globalThis as unknown as {
      __vscodeFake: { watchers: Array<{ change?: () => void; disposed: boolean }> };
    }).__vscodeFake;
    for (const watcher of fake.watchers) {
      if (!watcher.disposed) watcher.change?.();
    }
  }

  function waitForTreeChange(): Promise<void> {
    return new Promise((resolve) => {
      const subscription = explorer!.onDidChangeTreeData(() => {
        subscription.dispose();
        resolve();
      });
    });
  }

  async function refreshAfterChange(): Promise<void> {
    const changed = waitForTreeChange();
    fireChange();
    await changed;
  }

  before(async () => {
    const repoRoot = process.cwd();
    const loaderUrl = pathToFileURL(join(repoRoot, 'test', 'fixtures', 'vscodeLoader.mjs')).href;
    register(loaderUrl, pathToFileURL(join(repoRoot, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    const vscode = await import('vscode');
    Object.assign(vscode.workspace, {
      openTextDocument: async (documentPath: string) => {
        const fake = (globalThis as unknown as {
          __vscodeFake: { workspace: { openTextDocument(path: string): Promise<unknown> } };
        }).__vscodeFake;
        return fake.workspace.openTextDocument(documentPath);
      },
    });
    Object.assign(vscode.window, {
      showTextDocument: async (document: unknown) => {
        const fake = (globalThis as unknown as {
          __vscodeFake: { window: { showTextDocument(document: unknown): Promise<unknown> } };
        }).__vscodeFake;
        return fake.window.showTextDocument(document);
      },
    });
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
    const handlers: Record<string, (slug: string, repo?: string) => unknown> = {};
    const openedDocuments: string[] = [];
    const fake = {
      handlers,
      openedDocuments,
      watchers,
      window: { showTextDocument: async () => undefined },
      commands: {
        executeCommand: async () => undefined,
        registerCommand: (command: string, handler: unknown) => {
          handlers[command] = handler as (slug: string, repo?: string) => unknown;
          return { dispose: () => { delete handlers[command]; } };
        },
      },
      workspace: {
        openTextDocument: async (documentPath: string) => {
          openedDocuments.push(documentPath);
          return documentPath;
        },
        createFileSystemWatcher: () => {
          const watcher: { create?: () => void; change?: () => void; del?: () => void; disposed: boolean } = { disposed: false };
          watchers.push(watcher);
          return {
            onDidCreate: (cb: () => void) => { watcher.create = cb; return { dispose: () => undefined }; },
            onDidChange: (cb: () => void) => { watcher.change = cb; return { dispose: () => undefined }; },
            onDidDelete: (cb: () => void) => { watcher.del = cb; return { dispose: () => undefined }; },
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
    assert.strictEqual(explorer.getTreeItem(plans[0]).description, 'no status');
    assert.deepStrictEqual(explorer.getTreeItem(plans[0]).command?.arguments, ['alpha']);
    assert.strictEqual(explorer.getTreeItem(plans[0]).id, undefined);
    assert.strictEqual(explorer.getTreeItem(children[0][0]).description, 'pending');
    assert.deepStrictEqual(mod.treeNodeTarget(plans[0]), ['alpha']);
    assert.deepStrictEqual(mod.treeNodeTarget(children[0][0]), ['alpha', 'P01']);
    assert.strictEqual(
      (globalThis as unknown as { __vscodeFake: { watchers: unknown[] } }).__vscodeFake.watchers.length,
      1,
    );
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

  it('lists and labels multiple repos while keeping non-primary rows action-free', async () => {
    const childBaitonDir = path.join(root, 'packages', 'api', '.baiton');
    const childPlan = path.join(childBaitonDir, 'plans', 'api-plan', 'plan.md');
    fs.mkdirSync(path.dirname(childPlan), { recursive: true });
    fs.writeFileSync(childPlan, validPlan());
    const topologies = repoTopologies(root);
    const activePlans: (string | undefined)[] = [];
    const sources = () => [
      {
        repo: '.', baitonDir, topology: topologies.owner,
        isApproved: async () => false, actionable: true,
      },
      {
        repo: 'packages/api', baitonDir: childBaitonDir, topology: topologies.api,
        isApproved: async () => false, actionable: false,
      },
    ];
    const surface = { error: () => undefined } as unknown as Surface;
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      surface,
      false,
      (slug) => activePlans.push(slug),
      { sources },
    ).start();
    await waitFor(() => {
      const pending = explorer?.getChildren().find((group) =>
        group.kind === 'group' && group.node.kind === 'pending');
      return pending !== undefined && explorer!.getChildren(pending).length === 3;
    }, 'the multi-repository plan refresh');

    const pending = explorer.getChildren().find((group) =>
      group.kind === 'group' && group.node.kind === 'pending')!;
    const plans = explorer.getChildren(pending);
    assert.deepStrictEqual(plans.map((node) => node.kind === 'plan' ? node.node.slug : ''), [
      'alpha', 'beta', 'api-plan',
    ]);
    const alpha = plans[0];
    const apiPlan = plans[2];
    const alphaItem = explorer.getTreeItem(alpha);
    const apiItem = explorer.getTreeItem(apiPlan);
    assert.ok(String(alphaItem.description).startsWith('. · '));
    assert.ok(String(apiItem.description).startsWith('packages/api · '));
    assert.ok(String(apiItem.tooltip).includes('Repo: packages/api'));
    assert.strictEqual(apiItem.contextValue, planContextValue([]));
    assert.deepStrictEqual(apiItem.command?.arguments, ['api-plan', 'packages/api']);
    assert.strictEqual(apiItem.id, 'packages/api:api-plan');
    const apiPhases = explorer.getChildren(apiPlan);
    assert.strictEqual(explorer.getTreeItem(apiPhases[0]).contextValue, phaseContextValue([]));
    assert.strictEqual(
      (globalThis as unknown as { __vscodeFake: { watchers: unknown[] } }).__vscodeFake.watchers.length,
      2,
    );

    const fake = (globalThis as unknown as {
      __vscodeFake: {
        handlers: Record<string, (slug: string, repo?: string) => unknown>;
        openedDocuments: string[];
      };
    }).__vscodeFake;
    await fake.handlers['baiton.planExplorer.openPlan']('api-plan', 'packages/api');
    assert.deepStrictEqual(fake.openedDocuments, [childPlan]);
    assert.deepStrictEqual(activePlans, []);
    await fake.handlers['baiton.planExplorer.openPlan']('alpha', '.');
    assert.deepStrictEqual(activePlans, ['alpha']);
  });

  it('labels valid child-repo phase targets and exposes unknown targets as errors', async () => {
    const targetPlan = path.join(baitonDir, 'plans', 'target', 'plan.md');
    const topologies = repoTopologies(root);
    const writeTarget = (hint: string): void => {
      fs.mkdirSync(path.dirname(targetPlan), { recursive: true });
      fs.writeFileSync(
        targetPlan,
        validPlan().replace('- [pending] P01 Implement the plan', `- [pending] P01 Implement the plan ${hint}`),
      );
    };
    const sources = () => [
      {
        repo: '.', baitonDir, topology: topologies.owner,
        isApproved: async () => false, actionable: true,
      },
      {
        repo: 'packages/api', baitonDir: path.join(root, 'packages', 'api', '.baiton'),
        topology: topologies.api, isApproved: async () => false, actionable: false,
      },
    ];
    const surface = { error: () => undefined } as unknown as Surface;
    const makeExplorer = () => new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      surface,
      false,
      undefined,
      { sources },
    ).start();
    const targetNode = () => {
      const pending = explorer!.getChildren().find((group) =>
        group.kind === 'group' && group.node.kind === 'pending')!;
      return explorer!.getChildren(pending).find((node) =>
        node.kind === 'plan' && node.node.slug === 'target');
    };

    writeTarget('(repo: packages/api)');
    explorer = makeExplorer();
    await waitFor(() => {
      const target = targetNode();
      return target?.kind === 'plan' && !target.node.invalid;
    }, 'the valid target plan');
    const valid = targetNode();
    assert.ok(valid);
    assert.strictEqual(valid.kind, 'plan');
    const phase = explorer.getChildren(valid)[0];
    assert.strictEqual(phase.kind, 'phase');
    assert.strictEqual(phase.kind === 'phase' ? phase.node.repo : undefined, 'packages/api');
    assert.strictEqual(explorer.getTreeItem(phase).description, 'pending · packages/api');
    assert.ok(String(explorer.getTreeItem(phase).tooltip).includes('Repo: packages/api'));

    explorer.dispose();
    explorer = undefined;
    writeTarget('(repo: ../elsewhere)');
    explorer = makeExplorer();
    await waitFor(() => {
      const target = targetNode();
      return target?.kind === 'plan' && target.node.invalid;
    }, 'the invalid target plan');
    const invalid = targetNode();
    assert.ok(invalid);
    assert.strictEqual(invalid.kind, 'plan');
    assert.ok(explorer.getChildren(invalid).some((node) => node.kind === 'error'));
  });

  it('groups a pr plan Completed when its recorded PRs all read merged, without writing the document', async () => {
    const url = 'https://github.com/o/r/pull/1';
    const planPath = writePlan('merged', ['status: pr', `pr: ${url}`]);
    writePlan('prdone', ['status: done', `pr: ${url}`]);
    writePlan('prnourl', ['status: pr']);
    const before = fs.readFileSync(planPath);
    const calls: PrsMergedQuery[] = [];
    const warnings: string[] = [];
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      { error: () => undefined, warn: (m: string) => warnings.push(m), log: (m: string) => warnings.push(m) } as unknown as Surface,
      false,
      undefined,
      { prsMerged: async (query) => { calls.push(query); return true; } },
    ).start();

    await waitFor(() => groupSlugs().completed?.includes('merged') === true, 'the merged PR plan');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].slug, 'merged');
    assert.deepStrictEqual(calls[0].urls, [url]);
    assert.strictEqual(calls[0].repo, undefined);
    assert.deepStrictEqual(groupSlugs().completed, ['merged', 'prdone']);
    const completed = explorer.getChildren().find((group) =>
      group.kind === 'group' && group.node.kind === 'completed')!;
    const plan = explorer.getChildren(completed).find((node) =>
      node.kind === 'plan' && node.node.slug === 'merged')!;
    assert.strictEqual(explorer.getTreeItem(plan).contextValue, planContextValue(['showPr']));
    assert.strictEqual(explorer.getTreeItem(plan).description, 'pr');
    assert.deepStrictEqual(fs.readFileSync(planPath), before);
    assert.deepStrictEqual(warnings, []);
  });

  it('memoises the check per URL set and re-arms when the URL set changes', async () => {
    const firstUrl = 'https://github.com/o/r/pull/1';
    const secondUrl = 'https://github.com/o/r/pull/2';
    writePlan('merged', ['status: pr', `pr: ${firstUrl}`]);
    const calls: PrsMergedQuery[] = [];
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      { error: () => undefined } as unknown as Surface,
      false,
      undefined,
      { prsMerged: async (query) => { calls.push(query); return true; } },
    ).start();
    await waitFor(() => groupSlugs().completed?.includes('merged') === true, 'the initial merged PR plan');

    await refreshAfterChange();
    await refreshAfterChange();
    assert.strictEqual(calls.length, 1);

    writePlan('merged', ['status: pr', `pr: ${secondUrl}`]);
    await refreshAfterChange();
    await waitFor(() => calls.length === 2 && groupSlugs().completed?.includes('merged') === true, 'the changed PR URL check');
    assert.deepStrictEqual(calls.map((call) => call.urls), [[firstUrl], [secondUrl]]);
  });

  it('does not block refresh on a hung check', async () => {
    const url = 'https://github.com/o/r/pull/1';
    writePlan('waiting', ['status: pr', `pr: ${url}`]);
    const calls: PrsMergedQuery[] = [];
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      { error: () => undefined } as unknown as Surface,
      false,
      undefined,
      { prsMerged: (query) => { calls.push(query); return new Promise<boolean>(() => {}); } },
    ).start();
    await waitFor(() => groupSlugs().pending?.includes('alpha') === true &&
      groupSlugs().pending?.includes('beta') === true, 'the initial plan rows with a pending PR check');
    assert.strictEqual(calls.length, 1);
    assert.ok(!groupSlugs().completed?.includes('waiting'));

    await refreshAfterChange();
    assert.strictEqual(calls.length, 1);
  });

  it('treats failed and synchronously thrown checks as not merged and logs once', async () => {
    const url = 'https://github.com/o/r/pull/1';
    writePlan('failed', ['status: pr', `pr: ${url}`]);
    writePlan('syncfailed', ['status: pr', `pr: ${url.replace('/1', '/2')}`]);
    const calls: PrsMergedQuery[] = [];
    const warnings: string[] = [];
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      { error: () => undefined, warn: (m: string) => warnings.push(m), log: (m: string) => warnings.push(m) } as unknown as Surface,
      false,
      undefined,
      { prsMerged: (query) => {
        calls.push(query);
        if (query.slug === 'syncfailed') throw new Error('sync offline');
        return Promise.reject(new Error('offline'));
      } },
    ).start();
    await waitFor(() => warnings.length === 2, 'the PR check failure logs');
    assert.deepStrictEqual(warnings.map((message) => message.includes('syncfailed') ? 'syncfailed' : 'failed').sort(), ['failed', 'syncfailed']);
    assert.strictEqual(calls.length, 2);
    assert.ok(!groupSlugs().completed?.includes('failed'));
    assert.ok(!groupSlugs().completed?.includes('syncfailed'));

    await refreshAfterChange();
    await refreshAfterChange();
    assert.strictEqual(warnings.length, 2);
    assert.strictEqual(calls.length, 2);
  });

  it('requires every recorded URL in prs to be merged', async () => {
    const firstUrl = 'https://github.com/o/r/pull/1';
    const secondUrl = 'https://github.com/o/api/pull/3';
    writePlan('multi', [
      'status: pr-partial',
      `pr: ${firstUrl}`,
      `prs: {".":"${firstUrl}","packages/api":"${secondUrl}"}`,
    ]);
    const calls: PrsMergedQuery[] = [];
    const surface = { error: () => undefined, warn: () => undefined, log: () => undefined } as unknown as Surface;
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      surface,
      false,
      undefined,
      { prsMerged: async (query) => { calls.push(query); return query.urls.every((url) => !url.endsWith('/3')); } },
    ).start();
    await waitFor(() => calls.length === 1 && groupSlugs().pending?.includes('multi') === true, 'the partial PR plan check');
    assert.deepStrictEqual(calls[0].urls, [firstUrl, secondUrl]);
    assert.strictEqual(calls[0].repoForUrl.get(secondUrl), 'packages/api');
    assert.ok(!groupSlugs().completed?.includes('multi'));

    explorer.dispose();
    explorer = new mod.PlanExplorer(
      baitonDir,
      { isApproved: async () => false } as unknown as PlanStore,
      surface,
      false,
      undefined,
      { prsMerged: async () => true },
    ).start();
    await waitFor(() => groupSlugs().completed?.includes('multi') === true, 'the completed partial PR plan');
    const completed = explorer.getChildren().find((group) =>
      group.kind === 'group' && group.node.kind === 'completed')!;
    const plan = explorer.getChildren(completed).find((node) =>
      node.kind === 'plan' && node.node.slug === 'multi')!;
    assert.strictEqual(explorer.getTreeItem(plan).contextValue, planContextValue(['showPr']));
  });
});
