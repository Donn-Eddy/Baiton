import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import { createRunStore, type RunStore } from '../src/engine/runStore';
import { createRunWorktree } from '../src/engine/runWorktree';
import { createRunPipeline } from '../src/engine/runPipeline';
import { createPlanRepoSeam } from '../src/orchestrator/planRepos';
import type { GitService } from '../src/git';
import type { RepoSet } from '../src/activation/repoDiscovery';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../src/engine/terminalHost';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import type { Role } from '../src/model/role';
import type { Surface } from '../src/activation/surface';
import type { RunsCommandDeps, RunsPipelineFacts } from '../src/activation/runsExplorer';

/**
 * End-to-end tests for the three `baiton.runs.*` commands (design "dispatch
 * modes"), driven against REAL temporary git repositories, a real
 * `RunStore` and a real `GitService`.
 *
 * `test/runsExplorer.test.ts` drives the same handlers through a stubbed git, so
 * nothing there shows a real branch merged, a real worktree removed, or a real
 * worktree kept after a cancel. This file is that proof:
 *
 * - `runRunsMerge` landing a real merge commit with a `Run-Id:` trailer, then
 *   removing the worktree, its registration and the run branch, and recording
 *   the manifest as `merged`
 * - each of the `wrong-branch`, `base-moved` and `dirty-tree` refusals reaching
 *   the user, logging its reason token, and leaving the run and the base branch
 *   untouched; likewise a declined confirmation
 * - `runRunsViewDiff` handing over exactly `git diff <baseHead> <branch>` under a
 *   title naming that range, and warning once the merge removed the branch
 * - `runRunsCancel` against the REAL `RunPipeline`: the stage terminal disposed,
 *   the manifest `cancelled`, and the worktree, its registration and the branch
 *   all still on disk
 *
 * The agent boundary is stubbed exactly as `test/runPipeline.test.ts` stubs it.
 */

// ---------------------------------------------------------------------------
// Agent-boundary stubs (modelled on test/runPipeline.test.ts)
// ---------------------------------------------------------------------------

/** A stub adapter that always probes ok and launches an inert shell. */
class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  public launches: LaunchRequest[] = [];
  async probe(): Promise<ProbeResult> {
    return { version: '0.0.0-stub', ok: true };
  }
  launch(req: LaunchRequest): LaunchSpec {
    this.launches.push(req);
    return { shellPath: 'true', shellArgs: [] };
  }
  attach(_req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
}

/** A stub terminal that only records disposal. */
class StubTerminal implements HostTerminal {
  public disposeCount = 0;
  readonly processId = Promise.resolve<number | undefined>(4321);
  sendText(_text: string): void {}
  dispose(): void {
    this.disposeCount += 1;
  }
  show(): void {}
}

class StubTerminalHost implements TerminalHost {
  public readonly created: StubTerminal[] = [];
  createTerminal(_options: CreateTerminalOptions): HostTerminal {
    const t = new StubTerminal();
    this.created.push(t);
    return t;
  }
}

/** A result watcher the test drives directly. */
class StubResultWatcher implements ResultWatcher {
  public disposeCount = 0;
  private resultListeners: Array<(raw: string) => void> = [];
  private closeListeners: Array<(exitCode: number | undefined) => void> = [];

  onResult(listener: (raw: string) => void): Unsubscribe {
    this.resultListeners.push(listener);
    return () => {
      this.resultListeners = this.resultListeners.filter((l) => l !== listener);
    };
  }
  onTerminalClose(listener: (exitCode: number | undefined) => void): Unsubscribe {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }
  dispose(): void {
    this.disposeCount += 1;
  }
  emitResult(raw: string): void {
    for (const l of [...this.resultListeners]) {
      l(raw);
    }
  }
  emitClose(exitCode: number | undefined): void {
    for (const l of [...this.closeListeners]) {
      l(exitCode);
    }
  }
}

class StubWatcherFactory implements ResultWatcherFactory {
  public readonly watchers: StubResultWatcher[] = [];
  create(_input: {
    slug: string;
    runId: string;
    resultPath: string;
    terminal: HostTerminal;
  }): ResultWatcher {
    const w = new StubResultWatcher();
    this.watchers.push(w);
    return w;
  }
}

// ---------------------------------------------------------------------------
// Repo, surface and deps helpers
// ---------------------------------------------------------------------------

/** Run git synchronously in `cwd`, throwing on non-zero exit (test helper). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Write a file, creating parent directories as needed. */
function writeFile(base: string, relPath: string, contents: string): void {
  const full = path.join(base, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

/** Yield to the event loop on a real timer, so real `git` children keep up. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ready(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(ready(), `${what} never happened`);
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

/** A pipeline that is driving nothing; the merge and diff paths never touch it. */
const IDLE_PIPELINE: RunsPipelineFacts = {
  onChange: () => () => {},
  currentStage: () => undefined,
  currentRunId: () => undefined,
  cancel: () => false,
};

interface Harness {
  deps: RunsCommandDeps;
  surface: SurfaceRecorder;
  store: RunStore;
  diffs: { title: string; diff: string }[];
  confirms: string[];
  refreshes: number;
}

/** Command deps over the real store and git service of `repo`. */
function makeDeps(
  repo: string,
  options: {
    confirm?: boolean;
    restricted?: boolean;
    pipeline?: RunsPipelineFacts;
    store?: RunStore;
  } = {},
): Harness {
  const store = options.store ?? createRunStore({ workspaceRoot: repo });
  const surface = recorder();
  const diffs: { title: string; diff: string }[] = [];
  const confirms: string[] = [];
  const harness = { surface, store, diffs, confirms, refreshes: 0 } as Harness;
  harness.deps = {
    repoRoot: repo,
    store,
    git: createGitService(repo),
    pipeline: options.pipeline ?? IDLE_PIPELINE,
    surface: surface.surface,
    restricted: () => options.restricted === true,
    showDiff: async (title, diff) => {
      diffs.push({ title, diff });
    },
    confirm: async (message) => {
      confirms.push(message);
      return options.confirm === true;
    },
    refresh: () => {
      harness.refreshes++;
    },
  };
  return harness;
}

describe('run commands (design "dispatch modes")', () => {
  type RunsExplorerModule = typeof import('../src/activation/runsExplorer');
  let mod: RunsExplorerModule;

  before(async () => {
    const root = process.cwd();
    register(
      pathToFileURL(join(root, 'test/fixtures/vscodeLoader.mjs')).href,
      pathToFileURL(join(root, '/')).href,
    );
    await import('./fixtures/vscodeLoader.mjs');
    mod = await import('../src/activation/runsExplorer');
  });

  const repos: string[] = [];

  beforeEach(() => {
    // Importing the module needs no installed fake — only `RunsExplorer`'s
    // construction touches `vscode` — but a stray host call must fail loudly.
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = {
      window: {},
      commands: {},
      workspace: {},
    };
  });

  afterEach(() => {
    while (repos.length > 0) {
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  /**
   * A fresh repo on `main` with a committed `README.md` and a committed
   * `.baiton/.gitignore`. That ignore file is load-bearing: without it the
   * worktree directory makes the main tree dirty and every merge refuses
   * `dirty-tree`.
   */
  function newRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runcmd-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Baiton Test');
    git(repo, 'config', 'user.email', 'baiton-test@example.com');
    git(repo, 'checkout', '-q', '-b', 'main');
    writeFile(repo, 'README.md', 'baseline\n');
    writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial commit');
    repos.push(repo);
    return repo;
  }

  /**
   * Create a real worktree for `runId`, commit one file inside it, and record the
   * run as `done` in `store` — the state `runRunsMerge` requires.
   */
  async function seedDoneRun(
    repo: string,
    store: RunStore,
    runId: string,
  ): Promise<{ branch: string; worktreeDir: string; baseHead: string; file: string }> {
    const created = await createRunWorktree(
      { workspaceRoot: repo, git: createGitService(repo) },
      { runId, mode: 'bug' },
    );
    assert.ok(created.ok, 'the run worktree should be created');
    const info = created.value;

    const file = `run-${runId}.txt`;
    writeFile(info.worktreeDir, file, 'from the run\n');
    execFileSync('git', ['add', '-A'], { cwd: info.worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'Run work'], { cwd: info.worktreeDir });

    const made = store.create({
      id: runId,
      mode: 'bug',
      composerMode: 'bug',
      explicitMode: false,
      statement: 'Fix the crash on empty input',
      files: [],
      baseBranch: info.baseBranch,
      baseHead: info.baseHead,
      worktreeDir: info.relativeWorktreeDir,
    });
    assert.ok(made.ok, 'the manifest should be created');
    assert.ok(store.update(runId, { state: 'done' }).ok);

    return { branch: info.branch, worktreeDir: info.worktreeDir, baseHead: info.baseHead, file };
  }

  /** Whether git still lists a worktree at `dir`. */
  function worktreeRegistered(repo: string, dir: string): boolean {
    const list = git(repo, 'worktree', 'list', '--porcelain');
    const candidates = [dir];
    // `git worktree list` reports realpaths, which differ from the created path
    // under a symlinked temp dir (macOS `/var` -> `/private/var`).
    try {
      candidates.push(path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir)));
    } catch {
      // The parent is gone too, so the created path is the only candidate left.
    }
    return candidates.some((c) => list.includes(c));
  }

  /** The branches matching `name`, as `git branch --list` prints them. */
  function branchExists(repo: string, name: string): boolean {
    return git(repo, 'branch', '--list', name).trim() !== '';
  }

  // --- merge ---------------------------------------------------------------

  it('runRunsMerge lands a real merge commit, removes the worktree and branch, and records the run merged', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: true });
    const runId = 'bug-20260101-000000-mrg1';
    const seeded = await seedDoneRun(repo, h.store, runId);

    await mod.runRunsMerge(h.deps, runId);

    // A real merge commit: `rev-list --parents -n 1` prints the commit plus its
    // two parents.
    const head = git(repo, 'rev-parse', 'main').trim();
    const parents = git(repo, 'rev-list', '--parents', '-n', '1', head).trim().split(/\s+/);
    assert.strictEqual(parents.length, 3, 'main should be a merge commit');
    const message = git(repo, 'log', '-1', '--format=%B', head);
    assert.ok(message.includes(`Run-Id: ${runId}`), message);

    // The run's work is in the main checkout; the worktree and branch are gone.
    assert.ok(fs.existsSync(path.join(repo, seeded.file)), 'the run file is in the main checkout');
    assert.ok(!fs.existsSync(seeded.worktreeDir), 'the worktree directory is removed');
    assert.ok(!worktreeRegistered(repo, seeded.worktreeDir), 'the worktree is deregistered');
    assert.ok(!branchExists(repo, seeded.branch), 'the run branch is deleted');
    assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'the main checkout stays clean');

    const read = h.store.read(runId);
    assert.ok(read.ok);
    assert.strictEqual(read.value.state, 'merged');
    assert.ok(read.value.completedAt !== undefined, 'completedAt is stamped');

    assert.strictEqual(h.surface.infos.length, 1);
    assert.ok(h.surface.infos[0].includes(head), h.surface.infos[0]);
    assert.deepStrictEqual(h.surface.warns, []);
    assert.strictEqual(h.refreshes, 1);
  });

  it('runRunsMerge surfaces a wrong-branch refusal and leaves the run and the base alone', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: true });
    const runId = 'bug-20260101-000000-wrb1';
    const seeded = await seedDoneRun(repo, h.store, runId);
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', '-b', 'side');

    await mod.runRunsMerge(h.deps, runId);

    assert.strictEqual(h.surface.warns.length, 1);
    assert.ok(h.surface.warns[0].includes('side'), h.surface.warns[0]);
    assert.ok(
      h.surface.logs.some((l) => l === `Baiton: merge refused for run ${runId} (wrong-branch).`),
      JSON.stringify(h.surface.logs),
    );
    assert.deepStrictEqual(h.surface.infos, []);
    const read = h.store.read(runId);
    assert.ok(read.ok && read.value.state === 'done');
    assert.ok(fs.existsSync(seeded.worktreeDir));
    assert.ok(branchExists(repo, seeded.branch));
    assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), headBefore);
  });

  it('runRunsMerge surfaces a base-moved refusal and leaves the run and the base alone', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: true });
    const runId = 'bug-20260101-000000-bmv1';
    const seeded = await seedDoneRun(repo, h.store, runId);
    writeFile(repo, 'other.txt', 'moved on\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'move the base');
    const headBefore = git(repo, 'rev-parse', 'main').trim();

    await mod.runRunsMerge(h.deps, runId);

    assert.strictEqual(h.surface.warns.length, 1);
    assert.ok(
      h.surface.logs.some((l) => l === `Baiton: merge refused for run ${runId} (base-moved).`),
      JSON.stringify(h.surface.logs),
    );
    assert.deepStrictEqual(h.surface.infos, []);
    const read = h.store.read(runId);
    assert.ok(read.ok && read.value.state === 'done');
    assert.ok(fs.existsSync(seeded.worktreeDir));
    assert.ok(branchExists(repo, seeded.branch));
    assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), headBefore);
  });

  it('runRunsMerge surfaces a dirty-tree refusal and leaves the run and the base alone', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: true });
    const runId = 'bug-20260101-000000-drt1';
    const seeded = await seedDoneRun(repo, h.store, runId);
    fs.appendFileSync(path.join(repo, 'README.md'), 'edited in the main checkout\n');
    const headBefore = git(repo, 'rev-parse', 'main').trim();

    await mod.runRunsMerge(h.deps, runId);

    assert.strictEqual(h.surface.warns.length, 1);
    assert.ok(h.surface.warns[0].includes('uncommitted change'), h.surface.warns[0]);
    assert.ok(
      h.surface.logs.some((l) => l === `Baiton: merge refused for run ${runId} (dirty-tree).`),
      JSON.stringify(h.surface.logs),
    );
    assert.deepStrictEqual(h.surface.infos, []);
    const read = h.store.read(runId);
    assert.ok(read.ok && read.value.state === 'done');
    assert.ok(fs.existsSync(seeded.worktreeDir));
    assert.ok(branchExists(repo, seeded.branch));
    assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), headBefore);
  });

  it('a declined confirmation merges nothing', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: false });
    const runId = 'bug-20260101-000000-dec1';
    const seeded = await seedDoneRun(repo, h.store, runId);
    const headBefore = git(repo, 'rev-parse', 'main').trim();

    await mod.runRunsMerge(h.deps, runId);

    assert.strictEqual(h.confirms.length, 1);
    assert.ok(h.confirms[0].includes(seeded.branch));
    assert.ok(h.confirms[0].includes('main'));
    assert.deepStrictEqual(h.surface.infos, []);
    assert.deepStrictEqual(h.surface.warns, []);
    const read = h.store.read(runId);
    assert.ok(read.ok && read.value.state === 'done');
    assert.ok(fs.existsSync(seeded.worktreeDir));
    assert.ok(branchExists(repo, seeded.branch));
    assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), headBefore);
  });

  // --- view diff -----------------------------------------------------------

  it('runRunsViewDiff shows the real <base commit>..<branch> diff, and warns once the merge removed the branch', async () => {
    const repo = newRepo();
    const h = makeDeps(repo, { confirm: true });
    const runId = 'bug-20260101-000000-dif1';
    const seeded = await seedDoneRun(repo, h.store, runId);

    await mod.runRunsViewDiff(h.deps, runId);

    const expected = git(repo, 'diff', seeded.baseHead, seeded.branch);
    assert.strictEqual(h.diffs.length, 1);
    assert.strictEqual(h.diffs[0].diff, expected);
    assert.ok(h.diffs[0].diff.includes(seeded.file), h.diffs[0].diff);
    assert.strictEqual(
      h.diffs[0].title,
      `bug run ${runId}: ${mod.shortSha(seeded.baseHead)}..${seeded.branch}`,
    );
    assert.ok(
      h.surface.logs.some((l) =>
        l === `Baiton: diff for run ${runId}: ${mod.shortSha(seeded.baseHead)}..${seeded.branch}.`,
      ),
      JSON.stringify(h.surface.logs),
    );
    assert.strictEqual(h.surface.warns.length, 0, JSON.stringify(h.surface.warns));

    // After the merge the branch is gone, so a second View diff warns.
    await mod.runRunsMerge(h.deps, runId);
    h.diffs.length = 0;
    await mod.runRunsViewDiff(h.deps, runId);
    assert.deepStrictEqual(h.diffs, []);
    assert.ok(
      h.surface.warns.some((w) => w.includes(`${seeded.branch} for run ${runId} no longer exists`)),
      JSON.stringify(h.surface.warns),
    );
  });

  // --- cancel against the real pipeline ------------------------------------

  /** A real pipeline over `repo`, with only the agent boundary stubbed. */
  function realPipeline(repo: string, store: RunStore, runId: string, isPlanBusy?: () => boolean) {
    const terminalHost = new StubTerminalHost();
    const watcherFactory = new StubWatcherFactory();
    const pipeline = createRunPipeline({
      workspaceRoot: repo,
      git: createGitService(repo),
      store,
      terminalHost,
      watcherFactory,
      modelForRole: () => ({ model: 'stub-model' }),
      adapterForRole: () => new StubAdapter(),
      execAttempts: () => 2,
      newRunId: () => runId,
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
      report: () => {},
      ...(isPlanBusy !== undefined ? { isPlanBusy } : {}),
    });
    return { pipeline, terminalHost, watcherFactory };
  }

  /** Start a `bug` run and wait until its plan stage's watcher exists. */
  async function startBugRun(real: ReturnType<typeof realPipeline>) {
    const started = await real.pipeline.start({
      mode: 'bug',
      composerMode: 'bug',
      explicitMode: false,
      statement: 'the counter is off by one',
      files: ['README.md'],
      reproduction: 'Call count() with an empty list.',
    });
    assert.ok(started.ok, 'the run should start against a real repo');
    if (!started.ok) {
      throw new Error('unreachable');
    }
    await waitUntil(() => real.watcherFactory.watchers.length > 0, 'the plan watcher appearing');
    return started;
  }

  it('runRunsCancel disposes the live stage and keeps the worktree and branch on disk', async () => {
    const repo = newRepo();
    const runId = 'bug-20260101-000000-cnc1';
    const store = createRunStore({ workspaceRoot: repo });
    const real = realPipeline(repo, store, runId);
    const headBefore = git(repo, 'rev-parse', 'main').trim();
    const started = await startBugRun(real);
    const h = makeDeps(repo, { store, pipeline: real.pipeline });

    await mod.runRunsCancel(h.deps, runId);

    assert.strictEqual(real.terminalHost.created[0].disposeCount, 1, 'the stage terminal is disposed');
    assert.ok(
      h.surface.logs.some(
        (l) => l === `Baiton: cancel run ${runId}; its worktree and branch are kept.`,
      ),
      JSON.stringify(h.surface.logs),
    );
    assert.deepStrictEqual(h.surface.warns, []);
    assert.strictEqual(h.refreshes, 1);

    // The manifest reaches `cancelled` only once the closed terminal makes the
    // stage resolve, so await the run's own completion.
    real.watcherFactory.watchers[0].emitClose(undefined);
    const outcome = await started.completed;
    assert.strictEqual(outcome.state, 'cancelled');

    const read = store.read(runId);
    assert.ok(read.ok);
    assert.strictEqual(read.value.state, 'cancelled');
    assert.strictEqual(read.value.outcome?.kind, 'cancelled');

    const worktreeDir = path.join(repo, '.baiton', 'worktrees', runId);
    assert.ok(fs.existsSync(worktreeDir), 'the worktree directory is kept');
    assert.ok(worktreeRegistered(repo, worktreeDir), 'the worktree stays registered');
    assert.ok(branchExists(repo, `baiton/bug/${runId}`), 'the run branch is kept');
    assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), headBefore);
    assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'the main checkout stays clean');
  });

  it('runRunsCancel refuses in Restricted Mode and for a run the pipeline is not driving', async () => {
    const repo = newRepo();
    const runId = 'bug-20260101-000000-cnc2';
    const store = createRunStore({ workspaceRoot: repo });
    const real = realPipeline(repo, store, runId);
    const started = await startBugRun(real);
    const worktreeDir = path.join(repo, '.baiton', 'worktrees', runId);

    const restricted = makeDeps(repo, { store, pipeline: real.pipeline, restricted: true });
    await mod.runRunsCancel(restricted.deps, runId);
    assert.strictEqual(restricted.surface.warns.length, 1);
    assert.ok(restricted.surface.warns[0].includes('Restricted Mode'));
    assert.strictEqual(real.terminalHost.created[0].disposeCount, 0, 'nothing was disposed');

    const other = makeDeps(repo, { store, pipeline: real.pipeline });
    await mod.runRunsCancel(other.deps, 'bug-20260101-000000-zzzz');
    assert.deepStrictEqual(other.surface.warns, [
      'Baiton: run bug-20260101-000000-zzzz has no stage in flight to cancel.',
    ]);
    assert.strictEqual(real.terminalHost.created[0].disposeCount, 0, 'still nothing disposed');

    // Neither refusal touched the run.
    const read = store.read(runId);
    assert.ok(read.ok);
    assert.notStrictEqual(read.value.state, 'cancelled');
    assert.ok(fs.existsSync(worktreeDir));
    assert.ok(branchExists(repo, `baiton/bug/${runId}`));

    // Leave no stage in flight behind: cancel for real and let the run settle.
    assert.strictEqual(real.pipeline.cancel(), true);
    real.watcherFactory.watchers[0].emitClose(undefined);
    await started.completed;
  });

  describe('repository lock after per-phase queues', () => {
    const startBug = (real: ReturnType<typeof realPipeline>) =>
      real.pipeline.start({
        mode: 'bug',
        composerMode: 'bug',
        explicitMode: false,
        statement: 'the counter is off by one',
        files: ['README.md'],
        reproduction: 'Call count() with an empty list.',
      });

    it('refuses a plan-less run only while the plan draft runs', async () => {
      const { createStageLock } = await import('../src/activation/engineFacade');
      const repo = newRepo();
      const runId = 'bug-20260101-000000-lck1';
      const store = createRunStore({ workspaceRoot: repo });
      let draftRunning = true;
      // eslint-disable-next-line prefer-const
      let real: ReturnType<typeof realPipeline>;
      const lock = createStageLock({
        planDraftRunning: () => draftRunning,
        runRunning: () => real.pipeline.isRunning(),
      });
      real = realPipeline(repo, store, runId, () => lock.runPipelineBusy());

      const refused = await startBug(real);
      assert.ok(!refused.ok);
      if (!refused.ok) {
        assert.strictEqual(refused.error.kind, 'busy');
      }
      assert.ok(!fs.existsSync(path.join(repo, '.baiton', 'worktrees', runId)), 'no worktree was created');

      draftRunning = false;
      const started = await startBug(real);
      assert.ok(started.ok, 'the run starts once the draft is idle');
      if (!started.ok) {
        return;
      }
      await waitUntil(() => real.watcherFactory.watchers.length > 0, 'the plan watcher appearing');
      assert.strictEqual(real.pipeline.cancel(), true);
      real.watcherFactory.watchers[0].emitClose(undefined);
      await started.completed;
    });

    it('makes the plan draft busy while a plan-less run runs, and free once it settles', async () => {
      const { createStageLock } = await import('../src/activation/engineFacade');
      const repo = newRepo();
      const store = createRunStore({ workspaceRoot: repo });
      // eslint-disable-next-line prefer-const
      let real: ReturnType<typeof realPipeline>;
      const lock = createStageLock({
        planDraftRunning: () => false,
        runRunning: () => real.pipeline.isRunning(),
      });
      real = realPipeline(repo, store, 'bug-20260101-000000-lck2', () => lock.runPipelineBusy());
      assert.strictEqual(lock.planDraftBusy(), false);

      const started = await startBugRun(real);
      assert.strictEqual(lock.planDraftBusy(), true);

      assert.strictEqual(real.pipeline.cancel(), true);
      real.watcherFactory.watchers[0].emitClose(undefined);
      await started.completed;
      assert.strictEqual(lock.planDraftBusy(), false);
    });

    it('an idle plan draft never blocks a run', async () => {
      const { createStageLock } = await import('../src/activation/engineFacade');
      const lock = createStageLock({ planDraftRunning: () => false, runRunning: () => false });
      assert.strictEqual(lock.runPipelineBusy(), false);
      assert.strictEqual(lock.planDraftBusy(), false);
    });
  });
});

describe('plan command targets (repo, slug)', () => {
  type CommandsModule = typeof import('../src/activation/commands');
  let mod: CommandsModule;
  const tempRoots: string[] = [];

  before(async () => {
    const root = process.cwd();
    register(
      pathToFileURL(join(root, 'test/fixtures/vscodeLoader.mjs')).href,
      pathToFileURL(join(root, '/')).href,
    );
    await import('./fixtures/vscodeLoader.mjs');
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = {
      window: { showQuickPick: async () => undefined, showInputBox: async () => undefined },
      commands: {},
      workspace: {},
      languages: {},
      env: {},
      Uri: {},
      Disposable: class {},
    };
    mod = await import('../src/activation/commands');
  });

  afterEach(() => {
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  function makeLayout(): {
    ws: string;
    child: string;
    ownerBaiton: string;
    childBaiton: string;
    set: RepoSet;
    ownerGit: GitService;
    childGit: GitService;
  } {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-target-'));
    tempRoots.push(ws);
    const child = path.join(ws, 'child');
    const ownerBaiton = path.join(ws, '.baiton');
    const childBaiton = path.join(child, '.baiton');
    for (const [baiton, slug] of [
      [ownerBaiton, 'alpha'],
      [ownerBaiton, 'shared'],
      [childBaiton, 'beta'],
      [childBaiton, 'shared'],
    ] as const) {
      writeFile(ws, path.relative(ws, path.join(baiton, 'plans', slug, 'plan.md')), `# ${slug}\n`);
    }
    const owner = {
      name: '.',
      folderName: path.basename(ws),
      relPath: '',
      root: ws,
      baitonDir: ownerBaiton,
      hasGit: false,
      children: ['child'],
    };
    const childRepo = {
      name: 'child',
      folderName: path.basename(ws),
      relPath: 'child',
      root: child,
      baitonDir: childBaiton,
      hasGit: false,
      parent: '.',
      children: [],
    };
    const set: RepoSet = { repos: [owner, childRepo], folderRoots: [owner], truncated: false };
    return {
      ws,
      child,
      ownerBaiton,
      childBaiton,
      set,
      ownerGit: {} as GitService,
      childGit: {} as GitService,
    };
  }

  function makeDeps(
    layout: ReturnType<typeof makeLayout>,
    options: {
      discovered?: boolean;
      choose?: (items: string[], placeHolder: string) => Promise<string | undefined>;
    } = {},
  ) {
    const repos = options.discovered === false ? undefined : layout.set;
    const planRepos = createPlanRepoSeam({
      repos: () => repos,
      ownerRoot: layout.ws,
      restricted: () => false,
      gitFor: (root) => path.resolve(root) === path.resolve(layout.ws) ? layout.ownerGit : layout.childGit,
      exists: async (p) => {
        try {
          await fs.promises.access(p);
          return true;
        } catch {
          return false;
        }
      },
    });
    return {
      planRepos,
      repos: () => repos,
      ownerRoot: layout.ws,
      ownerBaitonDir: layout.ownerBaiton,
      ownerGit: layout.ownerGit,
      choose: options.choose ?? (async () => undefined),
    };
  }

  it('parses only plan and legacy spec documents, using the last .baiton segment', () => {
    const layout = makeLayout();
    const worktree = path.join(layout.ws, '.baiton', 'worktrees', 's', 'P01');
    const worktreePlan = path.join(worktree, '.baiton', 'plans', 'x', 'plan.md');
    writeFile(layout.ws, path.relative(layout.ws, worktreePlan), '# x\n');

    assert.deepStrictEqual(
      mod.planDocumentFromPath(path.join(layout.ws, '.baiton', 'plans', 'alpha', 'plan.md')),
      { slug: 'alpha', root: layout.ws, baitonDir: layout.ownerBaiton },
    );
    assert.deepStrictEqual(
      mod.planDocumentFromPath(path.join(layout.child, '.baiton', 'specs', 'old', 'spec.md')),
      { slug: 'old', root: layout.child, baitonDir: layout.childBaiton },
    );
    assert.deepStrictEqual(mod.planDocumentFromPath(worktreePlan), {
      slug: 'x', root: worktree, baitonDir: path.join(worktree, '.baiton'),
    });
    assert.strictEqual(
      mod.planDocumentFromPath(path.join(layout.ws, '.baiton', 'plans', 'alpha', 'phases', 'P01', 'plan.md')),
      undefined,
    );
    assert.strictEqual(
      mod.planDocumentFromPath(path.join(layout.ws, '.baiton', 'plans', 'alpha', 'notes.md')),
      undefined,
    );
  });

  it('resolves CodeLens targets to the owning repo and preserves owner worktree plans', async () => {
    const layout = makeLayout();
    const single = mod.resolveLensTarget(
      makeDeps(layout, { discovered: false }),
      path.join(layout.ws, '.baiton', 'plans', 'alpha', 'plan.md'),
    );
    assert.deepStrictEqual(single, { slug: 'alpha', baitonDir: layout.ownerBaiton });

    const deps = makeDeps(layout);
    const child = mod.resolveLensTarget(
      deps,
      path.join(layout.child, '.baiton', 'plans', 'shared', 'plan.md'),
    );
    assert.deepStrictEqual(child, {
      slug: 'shared', baitonDir: layout.childBaiton, repoPath: 'child',
    });

    const owner = mod.resolveLensTarget(
      deps,
      path.join(layout.ws, '.baiton', 'plans', 'shared', 'plan.md'),
    );
    assert.deepStrictEqual(owner, {
      slug: 'shared', baitonDir: layout.ownerBaiton, repoPath: '.',
    });

    const worktree = path.join(layout.ws, '.baiton', 'worktrees', 's', 'P01');
    const worktreePlan = path.join(worktree, '.baiton', 'plans', 'x', 'plan.md');
    writeFile(layout.ws, path.relative(layout.ws, worktreePlan), '# x\n');
    assert.deepStrictEqual(mod.resolveLensTarget(deps, worktreePlan), {
      slug: 'x', baitonDir: layout.ownerBaiton, repoPath: '.',
    });

    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-unrelated-'));
    tempRoots.push(unrelated);
    assert.strictEqual(
      mod.resolveLensTarget(deps, path.join(unrelated, '.baiton', 'plans', 'x', 'plan.md')),
      undefined,
    );
  });

  it('round-trips lens repo paths through plan target resolution without choosing', async () => {
    const layout = makeLayout();
    let chooseCalls = 0;
    const deps = makeDeps(layout, { choose: async () => { chooseCalls++; return undefined; } });

    const childArgs = mod.phaseArgs('shared', 'P01', 'child');
    const ownerArgs = mod.phaseArgs('shared', 'P01', '.');
    const child = await mod.resolvePlanTarget(deps, { ...childArgs, slug: childArgs.slug! });
    const owner = await mod.resolvePlanTarget(deps, { ...ownerArgs, slug: ownerArgs.slug! });
    assert.ok(child.ok && owner.ok);
    if (child.ok && owner.ok) {
      assert.strictEqual(child.target.root, layout.child);
      assert.strictEqual(owner.target.root, layout.ws);
    }
    assert.strictEqual(chooseCalls, 0);
  });

  it('keeps the single-repo picker bare and returns the owner instances', async () => {
    const layout = makeLayout();
    const deps = makeDeps(layout, { discovered: false });
    let offered: string[] = [];
    const target = await mod.pickPlanTarget({
      ...deps,
      quickPick: async (items) => { offered = items; return 'alpha'; },
      input: async () => undefined,
    });
    assert.deepStrictEqual(offered, ['alpha', 'shared']);
    assert.ok(target);
    assert.strictEqual(target.slug, 'alpha');
    assert.strictEqual(target.root, layout.ws);
    assert.strictEqual(target.baitonDir, layout.ownerBaiton);
    assert.strictEqual(target.isOwner, true);
    assert.strictEqual(target.label, 'alpha');
    assert.strictEqual(target.git, layout.ownerGit);
  });

  it('qualifies every picker item when multiple repos own plans', async () => {
    const layout = makeLayout();
    const deps = makeDeps(layout);
    let offered: string[] = [];
    const target = await mod.pickPlanTarget({
      ...deps,
      quickPick: async (items) => { offered = items; return 'child:beta'; },
      input: async () => undefined,
    });
    assert.deepStrictEqual(offered, [
      '.:alpha', '.:shared', 'child:beta', 'child:shared',
    ]);
    assert.ok(target);
    assert.strictEqual(target.slug, 'beta');
    assert.strictEqual(target.root, layout.child);
    assert.strictEqual(target.baitonDir, layout.childBaiton);
    assert.strictEqual(target.isOwner, false);
    assert.strictEqual(target.label, 'child:beta');
    assert.strictEqual(target.git, layout.childGit);
  });

  it('locates unique and qualified refs and asks before resolving an ambiguous bare slug', async () => {
    const layout = makeLayout();
    let chosen: string[] = [];
    const choice: { selected?: string } = {};
    const deps = makeDeps(layout, {
      choose: async (items) => { chosen = items; return choice.selected; },
    });

    const unique = await mod.resolvePlanTarget(deps, { slug: 'beta' });
    assert.ok(unique.ok);
    if (unique.ok) assert.strictEqual(unique.target.root, layout.child);

    const qualified = await mod.resolvePlanTarget(deps, { slug: 'child:shared' });
    assert.ok(qualified.ok);
    if (qualified.ok) assert.strictEqual(qualified.target.root, layout.child);

    const dismissed = await mod.resolvePlanTarget(deps, { slug: 'shared' });
    assert.deepStrictEqual(chosen, ['.:shared', 'child:shared']);
    assert.ok(!dismissed.ok && 'error' in dismissed);
    if (!dismissed.ok && 'error' in dismissed) {
      assert.ok(dismissed.error.includes('.:shared, child:shared'));
    }

    choice.selected = 'child:shared';
    const selected = await mod.resolvePlanTarget(deps, { slug: 'shared' });
    assert.ok(selected.ok);
    if (selected.ok) assert.strictEqual(selected.target.root, layout.child);
  });

  it('resolves tree repo names and explicit paths without choosing and reports unknown names', async () => {
    const layout = makeLayout();
    let chooseCalls = 0;
    const deps = makeDeps(layout, { choose: async () => { chooseCalls++; return undefined; } });
    const byName = await mod.resolvePlanTarget(deps, { slug: 'shared', repoName: 'child' });
    const byPath = await mod.resolvePlanTarget(deps, { slug: 'shared', repoPath: 'child' });
    assert.ok(byName.ok && byPath.ok);
    if (byName.ok) assert.strictEqual(byName.target.root, layout.child);
    if (byPath.ok) assert.strictEqual(byPath.target.root, layout.child);
    assert.strictEqual(chooseCalls, 0);

    const unknown = await mod.resolvePlanTarget(deps, { slug: 'shared', repoName: 'missing' });
    assert.ok(!unknown.ok && 'error' in unknown);
    if (!unknown.ok && 'error' in unknown) {
      assert.strictEqual(unknown.error, 'repo "missing" is not a discovered repo with a .baiton/ directory');
    }
  });

  it('falls back to the owner when a bare slug does not exist in any repo', async () => {
    const layout = makeLayout();
    const result = await mod.resolvePlanTarget(makeDeps(layout), { slug: 'nope' });
    assert.ok(result.ok);
    if (result.ok) {
      assert.strictEqual(result.target.root, layout.ws);
      assert.strictEqual(result.target.baitonDir, layout.ownerBaiton);
      assert.strictEqual(result.target.isOwner, true);
    }
  });

  it('normalizes TreeNode and CodeLens arguments with the plan owner repo', () => {
    const phaseNode = {
      kind: 'phase' as const,
      node: {
        slug: 's',
        id: 'P01',
        ownerRepo: 'child',
        repo: 'other',
        title: 'Phase',
        state: 'pending' as const,
        blocked: false,
        hasSession: false,
        hasPlan: false,
        actions: [],
      },
    };
    assert.deepStrictEqual(mod.planArg(phaseNode), { slug: 's', repoName: 'child' });
    assert.deepStrictEqual(mod.phaseArgs(phaseNode), { slug: 's', phaseId: 'P01', repoName: 'child' });

    const ownerless = {
      ...phaseNode,
      node: { ...phaseNode.node, ownerRepo: undefined, repo: 'other' },
    };
    assert.deepStrictEqual(mod.planArg(ownerless), { slug: 's' });
    assert.deepStrictEqual(mod.phaseArgs('s', 'P01', 'child'), {
      slug: 's', phaseId: 'P01', repoPath: 'child',
    });
  });
});
