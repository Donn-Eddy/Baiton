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
 * modes", todo T17), driven against REAL temporary git repositories, a real
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

describe('run commands (design "dispatch modes", todo T17)', () => {
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
  function realPipeline(repo: string, store: RunStore, runId: string) {
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
});
