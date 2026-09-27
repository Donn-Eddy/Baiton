import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { GitWorktreeService } from '../src/git';
import type { RunManifest, RunStore } from '../src/engine/runStore';
import type { LiveRunStage, RunPipelineEvent } from '../src/engine/runPipeline';
import type { Surface } from '../src/activation/surface';

/**
 * Unit tests for the Runs view glue (design "dispatch modes", todo T16):
 *
 * - `RUNS_VIEW_ID` and the three `baiton.runs.*` commands match what
 *   `package.json` contributes, including the `view/item/context` `when` clauses
 *   and which of them negate `baiton.restricted`
 * - `start()` watching `.baiton/runs/*\/run.json`, subscribing to the pipeline
 *   and painting once; `dispose()` releasing both
 * - `getChildren`/`getTreeItem` mapping the model's two groups, their runs, and
 *   each run's label/description/tooltip/contextValue and icon
 * - a throwing `store.list()` degrading to two empty groups plus a logged line
 * - `runRunsCancel`, `runRunsViewDiff` and `runRunsMerge`: their Restricted Mode
 *   behaviour, their refusals, and their one success path each
 *
 * The `vscode` glue is exercised without a host by redirecting `vscode` to
 * `test/fixtures/vscodeFake.mjs` through `vscodeLoader.mjs`, as
 * `test/configPanel.view.test.ts` does.
 */

type RunsExplorerModule = typeof import('../src/activation/runsExplorer');

let mod: RunsExplorerModule;

/** A valid manifest, with the fields a case cares about overridden. */
function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  const id = overrides.id ?? 'bug-20260926-120000-a1b2';
  return {
    version: 1,
    id,
    mode: 'bug',
    composerMode: 'bug',
    explicitMode: false,
    statement: 'Fix the crash on empty input',
    files: [],
    baseBranch: 'main',
    baseHead: 'aaa',
    branch: `baiton/bug/${id}`,
    worktreeDir: `.baiton/worktrees/${id}`,
    state: 'confirmed',
    attempts: { plan: 1, execute: 1, review: 1, investigate: 0 },
    createdAt: '2026-09-26T12:00:00.000Z',
    updatedAt: '2026-09-26T12:05:00.000Z',
    ...overrides,
  };
}

/** A fake watcher recording which events the provider hooked. */
interface FakeWatcher {
  pattern: { base?: unknown; pattern?: unknown };
  create: (() => void)[];
  change: (() => void)[];
  del: (() => void)[];
  disposed: number;
}

interface WatcherHarness {
  watchers: FakeWatcher[];
}

/** Install the minimal host fake the Runs glue touches. */
function installFake(): WatcherHarness {
  const watchers: FakeWatcher[] = [];
  const fake = {
    window: {
      showTextDocument: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      registerTreeDataProvider: () => ({ dispose: () => {} }),
    },
    commands: { executeCommand: async () => undefined },
    workspace: {
      createFileSystemWatcher: (pattern: { base?: unknown; pattern?: unknown }) => {
        const watcher: FakeWatcher = {
          pattern,
          create: [],
          change: [],
          del: [],
          disposed: 0,
        };
        watchers.push(watcher);
        return {
          onDidCreate: (l: () => void) => {
            watcher.create.push(l);
            return { dispose: () => {} };
          },
          onDidChange: (l: () => void) => {
            watcher.change.push(l);
            return { dispose: () => {} };
          },
          onDidDelete: (l: () => void) => {
            watcher.del.push(l);
            return { dispose: () => {} };
          },
          dispose: () => {
            watcher.disposed++;
          },
        };
      },
    },
  };
  (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;
  return { watchers };
}

/** A recorder standing in for the shared {@link Surface}. */
interface SurfaceRecorder {
  logs: string[];
  infos: string[];
  warns: string[];
  errors: string[];
  surface: Surface;
}

function recorder(): SurfaceRecorder {
  const logs: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    infos,
    warns,
    errors,
    surface: {
      log: (m: string) => logs.push(m),
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    } as unknown as Surface,
  };
}

/** A store over an in-memory manifest list. */
function fakeStore(manifests: RunManifest[], updates: { id: string; patch: unknown }[] = []): RunStore {
  return {
    list: () => manifests,
    read: (id: string) => {
      const found = manifests.find((m) => m.id === id);
      return found === undefined
        ? { ok: false, error: { kind: 'absent', runId: id, path: id, message: `run ${id} is absent.` } }
        : { ok: true, value: found };
    },
    update: (id: string, patch: unknown) => {
      updates.push({ id, patch });
      const found = manifests.find((m) => m.id === id);
      return { ok: true, value: found ?? manifest({ id }) };
    },
  } as unknown as RunStore;
}

/** A pipeline fake over recorded calls. */
interface PipelineHarness {
  pipeline: import('../src/activation/runsExplorer').RunsPipelineFacts;
  listeners: ((event: RunPipelineEvent) => void)[];
  cancels: number;
  unsubscribes: number;
}

function fakePipeline(stage?: LiveRunStage): PipelineHarness {
  const listeners: ((event: RunPipelineEvent) => void)[] = [];
  const harness: PipelineHarness = {
    listeners,
    cancels: 0,
    unsubscribes: 0,
    pipeline: {
      onChange: (listener) => {
        listeners.push(listener);
        return () => {
          harness.unsubscribes++;
          const i = listeners.indexOf(listener);
          if (i >= 0) {
            listeners.splice(i, 1);
          }
        };
      },
      currentStage: () => stage,
      currentRunId: () => stage?.runId,
      cancel: () => {
        harness.cancels++;
        return true;
      },
    },
  };
  return harness;
}

/** A live stage fact for `runId`. */
function liveStage(runId: string): LiveRunStage {
  return {
    runId,
    launchId: `${runId}.execute.1`,
    mode: 'bug',
    stage: 'execute',
    attempt: 1,
    sessionId: 'sess-1',
    terminal: { dispose: () => {} } as unknown as LiveRunStage['terminal'],
  };
}

/** The deps for the command handlers, with every seam recorded. */
interface CommandHarness {
  deps: import('../src/activation/runsExplorer').RunsCommandDeps;
  surface: SurfaceRecorder;
  updates: { id: string; patch: unknown }[];
  diffs: { title: string; diff: string }[];
  confirms: string[];
  refreshes: number;
  pipeline: PipelineHarness;
}

function commandHarness(options: {
  manifests?: RunManifest[];
  git?: Partial<GitWorktreeService>;
  restricted?: boolean;
  confirm?: boolean;
  stage?: LiveRunStage;
  repoRoot?: string;
}): CommandHarness {
  const updates: { id: string; patch: unknown }[] = [];
  const diffs: { title: string; diff: string }[] = [];
  const confirms: string[] = [];
  const surface = recorder();
  const pipeline = fakePipeline(options.stage);
  const harness = {
    surface,
    updates,
    diffs,
    confirms,
    refreshes: 0,
    pipeline,
  } as CommandHarness;
  harness.deps = {
    repoRoot: options.repoRoot ?? path.join(os.tmpdir(), 'baiton-runs-explorer-absent'),
    store: fakeStore(options.manifests ?? [], updates),
    git: (options.git ?? {}) as GitWorktreeService,
    pipeline: pipeline.pipeline,
    surface: surface.surface,
    restricted: () => options.restricted === true,
    showDiff: async (title: string, diff: string) => {
      diffs.push({ title, diff });
    },
    confirm: async (message: string) => {
      confirms.push(message);
      return options.confirm === true;
    },
    refresh: () => {
      harness.refreshes++;
    },
  };
  return harness;
}

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

function readPkg(): {
  contributes?: {
    views?: { baiton?: { id: string }[] };
    commands?: { command: string; title?: string; category?: string }[];
    menus?: { commandPalette?: MenuEntry[]; 'view/item/context'?: MenuEntry[] };
  };
} {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
}

describe('Runs view (design "dispatch modes", todo T16)', () => {
  before(async () => {
    const root = process.cwd();
    register(
      pathToFileURL(join(root, 'test/fixtures/vscodeLoader.mjs')).href,
      pathToFileURL(join(root, '/')).href,
    );
    await import('./fixtures/vscodeLoader.mjs');
    mod = await import('../src/activation/runsExplorer');
  });

  let harness: WatcherHarness;

  beforeEach(() => {
    harness = installFake();
  });

  it('RUNS_VIEW_ID matches the view package.json contributes', () => {
    assert.strictEqual(mod.RUNS_VIEW_ID, 'baiton.runsView');
    const views = readPkg().contributes?.views?.baiton;
    assert.ok(views, 'contributes.views.baiton must exist');
    assert.ok(
      views.some((v) => v.id === mod.RUNS_VIEW_ID),
      `contributed view ${mod.RUNS_VIEW_ID} must exist in package.json`,
    );
  });

  it('package.json contributes the three run commands with tree-only menus gated on Restricted Mode where they act', () => {
    const contributes = readPkg().contributes;
    const ids = ['baiton.runs.cancel', 'baiton.runs.viewDiff', 'baiton.runs.merge'];
    for (const id of ids) {
      const command = contributes?.commands?.find((c) => c.command === id);
      assert.ok(command, `${id} must be a contributed command`);
      assert.strictEqual(command.category, 'Baiton');
      const palette = contributes?.menus?.commandPalette?.find((m) => m.command === id);
      assert.ok(palette, `${id} must have a commandPalette entry`);
      assert.strictEqual(palette.when, 'false', `${id} is tree-only`);
    }

    const context = contributes?.menus?.['view/item/context'] ?? [];
    const tokens: Record<string, string> = {
      'baiton.runs.cancel': 'cancel',
      'baiton.runs.viewDiff': 'viewDiff',
      'baiton.runs.merge': 'merge',
    };
    for (const id of ids) {
      const entry = context.find((m) => m.command === id);
      assert.ok(entry, `${id} must have a view/item/context entry`);
      const when = entry.when ?? '';
      assert.ok(when.includes('view == baiton.runsView'), `${id} must be scoped to the Runs view`);
      assert.ok(
        when.includes(`viewItem =~ /\\b${tokens[id]}\\b/`),
        `${id} must match the model's \\b${tokens[id]}\\b token, got: ${when}`,
      );
      const negatesRestricted = when.includes('!baiton.restricted');
      assert.strictEqual(
        negatesRestricted,
        id !== 'baiton.runs.viewDiff',
        `${id} restricted gating is wrong: ${when}`,
      );
    }
  });

  it('start() watches the runs dir, subscribes to the pipeline, and dispose() releases both', () => {
    const pipeline = fakePipeline();
    const surface = recorder();
    const explorer = new mod.RunsExplorer(
      fakeStore([manifest()]),
      '/repo/.baiton/runs',
      pipeline.pipeline,
      surface.surface,
    );
    let paints = 0;
    explorer.onDidChangeTreeData(() => {
      paints++;
    });
    explorer.start();

    assert.strictEqual(harness.watchers.length, 1);
    const watcher = harness.watchers[0];
    assert.strictEqual(watcher.pattern.base, '/repo/.baiton/runs');
    assert.strictEqual(watcher.pattern.pattern, '*/run.json');
    assert.strictEqual(watcher.create.length, 1);
    assert.strictEqual(watcher.change.length, 1);
    assert.strictEqual(watcher.del.length, 1);
    assert.strictEqual(pipeline.listeners.length, 1);
    assert.strictEqual(paints, 1, 'the first refresh paints once');

    pipeline.listeners[0]({ kind: 'started' } as unknown as RunPipelineEvent);
    assert.strictEqual(paints, 2, 'a pipeline event repaints immediately');

    const subscribed = pipeline.listeners[0];
    explorer.dispose();
    assert.strictEqual(watcher.disposed, 1);
    assert.strictEqual(pipeline.unsubscribes, 1);
    assert.strictEqual(pipeline.listeners.length, 0);
    subscribed({ kind: 'started' } as unknown as RunPipelineEvent);
    assert.strictEqual(paints, 2, 'a later event repaints nothing after dispose');
  });

  it('getChildren returns the two model groups and their runs in input order', () => {
    const active = manifest({ id: 'bug-1', state: 'planned' });
    const doneA = manifest({ id: 'bug-2', state: 'done' });
    const doneB = manifest({ id: 'bug-3', state: 'merged' });
    const explorer = new mod.RunsExplorer(
      fakeStore([active, doneA, doneB]),
      '/repo/.baiton/runs',
      fakePipeline().pipeline,
      recorder().surface,
    ).start();

    const groups = explorer.getChildren();
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(
      groups.map((g) => (g.kind === 'group' ? g.node.contextValue : g.kind)),
      ['baiton.runGroup.active', 'baiton.runGroup.complete'],
    );
    assert.deepStrictEqual(
      groups.map((g) => (g.kind === 'group' ? g.node.label : '')),
      ['Active', 'Complete'],
    );

    const activeRuns = explorer.getChildren(groups[0]);
    assert.deepStrictEqual(
      activeRuns.map((r) => (r.kind === 'run' ? r.node.runId : '')),
      ['bug-1'],
    );
    const completeRuns = explorer.getChildren(groups[1]);
    assert.deepStrictEqual(
      completeRuns.map((r) => (r.kind === 'run' ? r.node.runId : '')),
      ['bug-2', 'bug-3'],
    );
    assert.deepStrictEqual(explorer.getChildren(completeRuns[0]), []);

    const groupItem = explorer.getTreeItem(groups[1]);
    assert.strictEqual(groupItem.description, '2');
    assert.strictEqual((groupItem.iconPath as { id: string }).id, 'history');
    explorer.dispose();
  });

  it('getTreeItem copies the model node verbatim and picks the icon from the live stage or the state', () => {
    const manifests = [
      manifest({ id: 'bug-live', state: 'executing' }),
      manifest({ id: 'bug-done', state: 'done' }),
      manifest({ id: 'bug-merged', state: 'merged' }),
      manifest({ id: 'bug-failed', state: 'failed' }),
    ];
    const explorer = new mod.RunsExplorer(
      fakeStore(manifests),
      '/repo/.baiton/runs',
      fakePipeline(liveStage('bug-live')).pipeline,
      recorder().surface,
    ).start();

    const byId = new Map<string, import('../src/activation/runsExplorer').RunTreeNode>();
    for (const group of explorer.getChildren()) {
      for (const run of explorer.getChildren(group)) {
        if (run.kind === 'run') {
          byId.set(run.node.runId, run);
        }
      }
    }

    const live = byId.get('bug-live');
    assert.ok(live && live.kind === 'run');
    const liveItem = explorer.getTreeItem(live);
    assert.strictEqual(liveItem.label, live.node.label);
    assert.strictEqual(liveItem.description, live.node.description);
    assert.strictEqual(liveItem.tooltip, live.node.tooltip);
    assert.strictEqual(liveItem.contextValue, live.node.contextValue);
    assert.strictEqual(liveItem.id, 'bug-live');
    assert.strictEqual((liveItem.iconPath as { id: string }).id, 'sync~spin');
    assert.strictEqual(liveItem.command, undefined, 'no click-to-open in this view');

    const icons: Record<string, string> = {
      'bug-done': 'check',
      'bug-merged': 'git-merge',
      'bug-failed': 'error',
    };
    for (const [id, icon] of Object.entries(icons)) {
      const node = byId.get(id);
      assert.ok(node && node.kind === 'run');
      assert.strictEqual((explorer.getTreeItem(node).iconPath as { id: string }).id, icon, id);
    }
    explorer.dispose();
  });

  it('a throwing store.list() yields two empty groups and one logged line', () => {
    const surface = recorder();
    const store = {
      list: () => {
        throw new Error('EACCES: permission denied');
      },
    } as unknown as RunStore;
    const explorer = new mod.RunsExplorer(
      store,
      '/repo/.baiton/runs',
      fakePipeline().pipeline,
      surface.surface,
    ).start();

    const groups = explorer.getChildren();
    assert.strictEqual(groups.length, 2);
    for (const group of groups) {
      assert.deepStrictEqual(explorer.getChildren(group), []);
    }
    assert.strictEqual(surface.logs.length, 1);
    assert.ok(surface.logs[0].includes('could not list runs'), surface.logs[0]);
    assert.deepStrictEqual(surface.errors, []);
    explorer.dispose();
  });

  it('runRunsCancel refuses in Restricted Mode, refuses a run with no stage in flight, and cancels the run in flight', async () => {
    const restricted = commandHarness({ restricted: true, stage: liveStage('bug-1') });
    await mod.runRunsCancel(restricted.deps, 'bug-1');
    assert.strictEqual(restricted.pipeline.cancels, 0);
    assert.strictEqual(restricted.surface.warns.length, 1);
    assert.ok(restricted.surface.warns[0].includes('Restricted Mode'));

    const idle = commandHarness({});
    await mod.runRunsCancel(idle.deps, undefined);
    assert.deepStrictEqual(idle.surface.warns, ['Baiton: no run is in flight.']);
    assert.strictEqual(idle.pipeline.cancels, 0);

    const other = commandHarness({ stage: liveStage('bug-other') });
    await mod.runRunsCancel(other.deps, 'bug-1');
    assert.deepStrictEqual(other.surface.warns, [
      'Baiton: run bug-1 has no stage in flight to cancel.',
    ]);
    assert.strictEqual(other.pipeline.cancels, 0);

    const live = commandHarness({ stage: liveStage('bug-1') });
    await mod.runRunsCancel(live.deps, 'bug-1');
    assert.strictEqual(live.pipeline.cancels, 1);
    assert.strictEqual(live.refreshes, 1);
    assert.deepStrictEqual(live.surface.warns, []);

    const fallback = commandHarness({ stage: liveStage('bug-1') });
    await mod.runRunsCancel(fallback.deps, undefined);
    assert.strictEqual(fallback.pipeline.cancels, 1, 'falls back to the run in flight');
  });

  it('runRunsViewDiff shows the branch diff, reports the empty cases, and is not blocked by Restricted Mode', async () => {
    const noWorktree = commandHarness({
      manifests: [manifest({ id: 'inv-1', mode: 'investigate', worktreeDir: undefined })],
    });
    await mod.runRunsViewDiff(noWorktree.deps, 'inv-1');
    assert.deepStrictEqual(noWorktree.surface.warns, [
      'Baiton: run inv-1 has no worktree, so there is no diff to show.',
    ]);
    assert.deepStrictEqual(noWorktree.diffs, []);

    const goneBranch = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'merged' })],
      git: { branchHead: async () => undefined },
    });
    await mod.runRunsViewDiff(goneBranch.deps, 'bug-1');
    assert.deepStrictEqual(goneBranch.surface.warns, [
      'Baiton: the branch baiton/bug/bug-1 for run bug-1 no longer exists.',
    ]);

    const diffArgs: [string, string][] = [];
    const shown = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done' })],
      restricted: true, // A read-only action stays available in Restricted Mode.
      git: {
        branchHead: async () => 'bbb',
        diff: async (from: string, to: string) => {
          diffArgs.push([from, to]);
          return 'diff --git a/x b/x\n';
        },
      },
    });
    await mod.runRunsViewDiff(shown.deps, 'bug-1');
    assert.deepStrictEqual(diffArgs, [['aaa', 'baiton/bug/bug-1']]);
    assert.deepStrictEqual(shown.diffs, [
      { title: 'bug run bug-1', diff: 'diff --git a/x b/x\n' },
    ]);
    assert.deepStrictEqual(shown.surface.warns, []);

    const empty = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done' })],
      git: { branchHead: async () => 'bbb', diff: async () => '   \n' },
    });
    await mod.runRunsViewDiff(empty.deps, 'bug-1');
    assert.deepStrictEqual(empty.diffs, []);
    assert.deepStrictEqual(empty.surface.infos, [
      'Baiton: run bug-1 changed nothing on baiton/bug/bug-1.',
    ]);

    const none = commandHarness({});
    await mod.runRunsViewDiff(none.deps, undefined);
    assert.deepStrictEqual(none.surface.warns, ['Baiton: no run selected.']);
  });

  it('runRunsMerge lands a done run, records it as merged, and refuses everything else', async () => {
    // 1. Restricted Mode.
    const restricted = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done' })],
      restricted: true,
    });
    await mod.runRunsMerge(restricted.deps, 'bug-1');
    assert.ok(restricted.surface.warns[0].includes('Restricted Mode'));
    assert.deepStrictEqual(restricted.updates, []);
    assert.deepStrictEqual(restricted.confirms, []);

    // 2. A state that is not `done`, and a run with no worktree.
    const notDone = commandHarness({ manifests: [manifest({ id: 'bug-1', state: 'failed' })] });
    await mod.runRunsMerge(notDone.deps, 'bug-1');
    assert.deepStrictEqual(notDone.surface.warns, [
      'Baiton: run bug-1 is failed; only a run whose review passed can be merged.',
    ]);
    const noWorktree = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done', worktreeDir: undefined })],
    });
    await mod.runRunsMerge(noWorktree.deps, 'bug-1');
    assert.strictEqual(noWorktree.surface.warns.length, 1);
    assert.deepStrictEqual(noWorktree.confirms, []);

    // 3. A declined confirm merges nothing.
    const declined = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done' })],
      confirm: false,
      git: {
        currentBranch: async () => {
          throw new Error('mergeRunWorktree must not run after a declined confirm');
        },
      },
    });
    await mod.runRunsMerge(declined.deps, 'bug-1');
    assert.strictEqual(declined.confirms.length, 1);
    assert.ok(declined.confirms[0].includes('baiton/bug/bug-1'));
    assert.ok(declined.confirms[0].includes('main'));
    assert.ok(declined.confirms[0].includes('worktree and branch are removed'));
    assert.deepStrictEqual(declined.updates, []);

    // 4. A refusal reaches the user verbatim and leaves the manifest untouched.
    const refused = commandHarness({
      manifests: [manifest({ id: 'bug-1', state: 'done' })],
      confirm: true,
      git: { currentBranch: async () => 'feature/x' },
    });
    await mod.runRunsMerge(refused.deps, 'bug-1');
    assert.strictEqual(refused.updates.length, 0);
    assert.strictEqual(refused.surface.warns.length, 1);
    assert.ok(refused.surface.warns[0].includes('but feature/x is checked out'), refused.surface.warns[0]);
    assert.strictEqual(refused.refreshes, 1);

    // 5. The success path, against a temp dir so the worktree cleanup has a real
    // path to probe.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runs-merge-'));
    try {
      const deleted: string[] = [];
      const success = commandHarness({
        manifests: [manifest({ id: 'bug-1', state: 'done' })],
        confirm: true,
        repoRoot,
        git: {
          currentBranch: async () => 'main',
          branchHead: async () => 'aaa',
          status: async () => ({ clean: true, changes: [] }),
          merge: async () => ({ ok: true, value: 'deadbeef' }),
          listWorktrees: async () => [],
          removeWorktree: async () => undefined,
          deleteBranch: async (branch: string) => {
            deleted.push(branch);
          },
        } as Partial<GitWorktreeService>,
      });
      await mod.runRunsMerge(success.deps, 'bug-1');

      assert.deepStrictEqual(success.updates, [{ id: 'bug-1', patch: { state: 'merged' } }]);
      assert.deepStrictEqual(success.surface.infos, [
        'Baiton: merged baiton/bug/bug-1 into main as deadbeef.',
      ]);
      assert.deepStrictEqual(success.surface.warns, []);
      assert.deepStrictEqual(deleted, ['baiton/bug/bug-1']);
      assert.strictEqual(success.refreshes, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
