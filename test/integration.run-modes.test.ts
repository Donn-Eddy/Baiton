import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import type { GitWorktreeService } from '../src/git/types';
import { parseJournal } from '../src/journal';
import type { Role } from '../src/model/role';
import { createRunStore, type RunStore } from '../src/engine/runStore';
import {
  createRunPipeline,
  type RunFinding,
  type RunPipeline,
  type RunPipelineEvent,
  type RunPipelineOutcome,
  type RunPipelineRequest,
} from '../src/engine/runPipeline';
import {
  findRunWorktree,
  mergeRunWorktree,
  type RunWorktreeDeps,
} from '../src/engine/runWorktree';
import { createRunPipelineSeam, createStageLock } from '../src/activation/engineFacade';
import { createToolRegistry } from '../src/orchestrator/registry';
import { GuardContext } from '../src/orchestrator/guard';
import type { ToolServices } from '../src/orchestrator/toolServices';
import type { InterventionAnswer, InterventionRequest } from '../src/orchestrator/interventions';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../src/engine/terminalHost';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';

/**
 * The single offline, deterministic end-to-end test of the spec-less run
 * pipeline (dispatch modes, T18).
 *
 * Everything below the agent boundary is real: a real temporary git repository
 * per case, the real `RunStore`, the real `createRunWorktree`/`mergeRunWorktree`
 * lifecycle, the real `createRunPipeline` (with its real worktree-bound git
 * service — no `createService` injection), and, for the confirm case, the real
 * control-tool registry over the real `createRunPipelineSeam`. Only the agent
 * boundary is stubbed: the adapter's probe/launch, the terminal host and the
 * result watcher, which the test drives itself.
 *
 * What it pins: a confirmed Bug run creates its branch and worktree, plans,
 * executes with a `Run-Id:` commit and reviews, and touches nothing under
 * `.baiton/specs/`; a declined confirm creates nothing; a merge removes the
 * worktree and branch and refuses on a moved base or a dirty tree, while a
 * cancel keeps them; an Investigate run commits nothing and yields a finding;
 * and only the spec draft (never a per-todo queue) blocks a spec-less run.
 */

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

/** Run git synchronously in `cwd`, throwing on non-zero exit (test helper). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Write a file at `root/relPath`, creating parent directories as needed. */
function writeFile(root: string, relPath: string, contents: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

/**
 * An initialized temp repo on `main` with a local identity, a committed
 * `README.md`, a committed `src/a.ts` and a committed `.baiton/.gitignore`
 * holding the canonical exclusion list. That ignore file is load-bearing: it
 * carries `/runs/` and `/worktrees/`, without which the run directory and the
 * worktree make the main checkout dirty and every merge refuses `dirty-tree`.
 */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runmodes-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeFile(repo, 'README.md', 'baseline\n');
  writeFile(repo, 'src/a.ts', 'export const bound = 0;\n');
  writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}

// ---------------------------------------------------------------------------
// Agent-boundary stubs
// ---------------------------------------------------------------------------

/** An inert adapter: it probes ok and launches `true`. */
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
  public readonly options: CreateTerminalOptions[] = [];
  createTerminal(options: CreateTerminalOptions): HostTerminal {
    this.options.push(options);
    const t = new StubTerminal();
    this.created.push(t);
    return t;
  }
}

/** A result watcher the test drives: it delivers results and terminal closes. */
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
  public readonly created: Array<{ slug: string; runId: string; resultPath: string }> = [];
  create(input: {
    slug: string;
    runId: string;
    resultPath: string;
    terminal: HostTerminal;
  }): ResultWatcher {
    this.created.push({ slug: input.slug, runId: input.runId, resultPath: input.resultPath });
    const w = new StubResultWatcher();
    this.watchers.push(w);
    return w;
  }
}

// ---------------------------------------------------------------------------
// Schema-conformant result fixtures
// ---------------------------------------------------------------------------

const PLAN_RESULT = JSON.stringify({
  steps: [{ title: 'Fix the off-by-one', detail: 'Adjust the loop bound.', files: ['src/a.ts'] }],
  risks: ['none known'],
  acceptance: ['the test suite passes'],
});

const EXECUTE_RESULT = JSON.stringify({
  summary: 'Adjusted the loop bound.',
  files_changed: ['src/a.ts'],
  commands_run: ['npm test'],
  notes: ['nothing surprising'],
});

const REVIEW_PASS = JSON.stringify({
  verdict: 'pass',
  findings: [],
  tests: { ran: true, passed: true, output_tail: '1 passing' },
});

const FINDING_TEXT = 'The bound is computed twice, in src/a.ts and src/b.ts.';

const INVESTIGATE_RESULT = JSON.stringify({
  finding: FINDING_TEXT,
  files: ['src/a.ts', 'src/b.ts'],
  next_steps: ['unify the two computations'],
});

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const RUN_ID = 'bug-20260101-000000-aaaa';

/** Yield to the event loop so the pipeline's pending awaits can run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Wait until `ready()` holds, yielding on a real timer between checks: the
 * stages here await real `git` child processes, so a setImmediate-only spin
 * would outrun the pipeline.
 */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ready(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(ready(), `${what} never happened`);
}

interface Harness {
  repo: string;
  service: GitWorktreeService;
  store: RunStore;
  pipeline: RunPipeline;
  adapter: StubAdapter;
  terminalHost: StubTerminalHost;
  watcherFactory: StubWatcherFactory;
  events: RunPipelineEvent[];
  outcomes: RunPipelineOutcome[];
  findings: RunFinding[];
  reports: string[];
  /** Wait until the n-th stage watcher exists. */
  waitFor(index: number): Promise<void>;
  /** Wait for the n-th stage watcher, then deliver its result. */
  settle(index: number, json: string): Promise<void>;
  /** Wait for the n-th stage watcher, then close its terminal. */
  close(index: number, exitCode: number | undefined): Promise<void>;
  runDir(runId?: string): string;
  worktreeDir(runId?: string): string;
}

/**
 * A pipeline wired to the REAL git service, store and worktree lifecycle of
 * `repo`; only the agent boundary is stubbed. `createService` is deliberately
 * NOT injected, so the pipeline's per-run git service is the real
 * `createRunGitService`/`createGitService` bound to the run's worktree.
 */
function makeHarness(
  repo: string,
  options: { runId?: string; execAttempts?: number; isSpecBusy?: () => boolean } = {},
): Harness {
  const service = createGitService(repo);
  const store = createRunStore({ workspaceRoot: repo });
  const adapter = new StubAdapter();
  const terminalHost = new StubTerminalHost();
  const watcherFactory = new StubWatcherFactory();
  const events: RunPipelineEvent[] = [];
  const outcomes: RunPipelineOutcome[] = [];
  const findings: RunFinding[] = [];
  const reports: string[] = [];

  const pipeline = createRunPipeline({
    workspaceRoot: repo,
    git: service,
    store,
    terminalHost,
    watcherFactory,
    modelForRole: () => ({ model: 'stub-model' }),
    adapterForRole: () => adapter,
    execAttempts: () => options.execAttempts ?? 2,
    verify: () => 'npm test',
    ...(options.isSpecBusy !== undefined ? { isSpecBusy: options.isSpecBusy } : {}),
    newRunId: () => options.runId ?? RUN_ID,
    newSessionId: () => '11111111-1111-4111-8111-111111111111',
    onComplete: (o) => outcomes.push(o),
    onFinding: (f) => findings.push(f),
    report: (m) => reports.push(m),
  });
  pipeline.onChange((e) => events.push(e));

  const waitFor = (index: number): Promise<void> =>
    waitUntil(
      () => watcherFactory.watchers.length > index,
      `watcher ${index} appearing (reports: ${JSON.stringify(reports)})`,
    );

  return {
    repo,
    service,
    store,
    pipeline,
    adapter,
    terminalHost,
    watcherFactory,
    events,
    outcomes,
    findings,
    reports,
    waitFor,
    settle: async (index, json) => {
      await waitFor(index);
      watcherFactory.watchers[index].emitResult(json);
      await flush();
    },
    close: async (index, exitCode) => {
      await waitFor(index);
      watcherFactory.watchers[index].emitClose(exitCode);
      await flush();
    },
    runDir: (runId = options.runId ?? RUN_ID) => path.join(repo, '.baiton', 'runs', runId),
    worktreeDir: (runId = options.runId ?? RUN_ID) =>
      path.join(repo, '.baiton', 'worktrees', runId),
  };
}

/** A `bug` dispatch with reproduction steps. */
function bugRequest(overrides: Partial<RunPipelineRequest> = {}): RunPipelineRequest {
  return {
    mode: 'bug',
    composerMode: 'bug',
    explicitMode: false,
    statement: 'the counter is off by one',
    files: ['src/a.ts'],
    reproduction: 'Call count() with an empty list.',
    ...overrides,
  };
}

/** An `investigate` dispatch. */
function investigateRequest(): RunPipelineRequest {
  return {
    mode: 'investigate',
    composerMode: 'investigate',
    explicitMode: false,
    statement: 'Where is the bound computed?',
    files: ['src/a.ts'],
  };
}

describe('Integration: spec-less run modes over a temp git repo (T18)', () => {
  const repos: string[] = [];

  /** A fresh temp repo, registered for automatic cleanup. */
  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  afterEach(() => {
    while (repos.length > 0) {
      // A forced rm is enough even with a registered worktree.
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 1: a confirmed bug run
  // -------------------------------------------------------------------------

  describe('a confirmed bug run', () => {
    it('creates the branch and worktree, plans, executes with a Run-Id commit and reviews', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const mainHeadBefore = (await h.service.branchHead('main'))!;

      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok, 'the run should start against a real repo');
      if (!started.ok) {
        return;
      }

      // The manifest names the run branch, its worktree and its merge base.
      assert.strictEqual(started.manifest.branch, `baiton/bug/${RUN_ID}`);
      assert.strictEqual(started.manifest.worktreeDir, `.baiton/worktrees/${RUN_ID}`);
      assert.strictEqual(started.manifest.mode, 'bug');
      assert.strictEqual(started.manifest.baseBranch, 'main');
      assert.strictEqual(started.manifest.baseHead, mainHeadBefore);
      assert.strictEqual(started.manifest.reproduction, 'Call count() with an empty list.');

      // The worktree is really checked out on the run branch, at the base head.
      assert.ok(fs.existsSync(path.join(h.worktreeDir(), 'README.md')));
      assert.strictEqual(
        git(h.worktreeDir(), 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
        `baiton/bug/${RUN_ID}`,
      );
      const runBranchHead = await h.service.branchHead(`baiton/bug/${RUN_ID}`);
      assert.ok(runBranchHead !== undefined, 'the run branch exists');
      assert.strictEqual(runBranchHead, mainHeadBefore);
      const registered = await findRunWorktree({ workspaceRoot: repo, git: h.service }, RUN_ID);
      assert.ok(registered !== undefined, 'git knows the run worktree');
      assert.strictEqual(fs.realpathSync(registered.dir), fs.realpathSync(h.worktreeDir()));

      // Drive plan -> execute -> review. The stub executor does real work in the
      // WORKTREE, so the execute commit is not empty.
      await h.settle(0, PLAN_RESULT);
      await h.waitFor(1);
      writeFile(h.worktreeDir(), 'src/a.ts', 'export const bound = 1;\n');
      h.watcherFactory.watchers[1].emitResult(EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'done');
      assert.deepStrictEqual(outcome.outcome, { kind: 'verdict', verdict: 'pass' });
      assert.strictEqual(outcome.commits.length, 1);

      const read = h.store.read(RUN_ID);
      assert.ok(read.ok, 'the manifest is readable');
      if (!read.ok) {
        return;
      }
      assert.strictEqual(read.value.state, 'done');
      assert.deepStrictEqual(read.value.attempts, {
        plan: 1,
        execute: 1,
        review: 1,
        investigate: 0,
      });
      assert.ok(read.value.completedAt !== undefined, 'completedAt is stamped');

      // Each stage launched under its own launch id, with its brief inside the
      // WORKTREE's run directory rather than the main checkout's.
      assert.deepStrictEqual(
        h.watcherFactory.created.map((c) => c.runId),
        [`${RUN_ID}.plan.1`, `${RUN_ID}.execute.1`, `${RUN_ID}.review.1`],
      );
      for (const created of h.watcherFactory.created) {
        assert.strictEqual(created.slug, RUN_ID, 'the run id stands in for the slug');
      }
      for (const stage of ['plan', 'execute', 'review']) {
        const brief = path.join(
          h.worktreeDir(),
          '.baiton',
          'runs',
          `${RUN_ID}.${stage}.1`,
          'brief.md',
        );
        assert.ok(fs.existsSync(brief), `the ${stage} brief lives in the worktree`);
      }
      const planBrief = fs.readFileSync(
        path.join(h.worktreeDir(), '.baiton', 'runs', `${RUN_ID}.plan.1`, 'brief.md'),
        'utf8',
      );
      assert.ok(planBrief.includes('the counter is off by one'), planBrief);
      assert.ok(planBrief.includes('# Defect'), planBrief);
      assert.ok(planBrief.includes('# Reproduction'), planBrief);
      assert.ok(planBrief.includes(`baiton/bug/${RUN_ID}`), planBrief);
      assert.ok(
        !fs.existsSync(path.join(repo, '.baiton', 'runs', `${RUN_ID}.plan.1`)),
        'no launch directory is created in the main checkout',
      );

      // The run-owned artifacts land in the MAIN checkout's run directory.
      for (const file of ['plan.md', 'execute-1.md', 'review-1.md', 'run.json', 'runs.jsonl']) {
        assert.ok(fs.existsSync(path.join(h.runDir(), file)), `${file} should be persisted`);
      }
      const entries = parseJournal(path.join(h.runDir(), 'runs.jsonl'));
      assert.deepStrictEqual(
        entries.map((e) => [e.runId, e.todoId, e.stage, e.attempt, e.result]),
        [
          [`${RUN_ID}.plan.1`, RUN_ID, 'plan', 1, 'completed'],
          [`${RUN_ID}.execute.1`, RUN_ID, 'execute', 1, 'completed'],
          [`${RUN_ID}.review.1`, RUN_ID, 'review', 1, 'completed'],
        ],
      );
      assert.strictEqual(entries[1].commit, outcome.commits[0]);

      // The commit is on the run branch, carries the trailer, and is findable.
      const log = git(repo, 'log', '-1', '--format=%B', `baiton/bug/${RUN_ID}`);
      assert.ok(log.includes(`bug(${RUN_ID}): execute attempt 1`), log);
      assert.ok(log.includes(`Run-Id: ${RUN_ID}`), log);
      assert.strictEqual(await h.service.findCommitByRunId(RUN_ID), outcome.commits[0]);

      // Isolation: `main`, the main working tree and `.baiton/specs/` are untouched.
      assert.strictEqual(await h.service.branchHead('main'), mainHeadBefore);
      assert.strictEqual((await h.service.status()).clean, true, 'the main checkout stays clean');
      assert.strictEqual(
        fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'),
        'export const bound = 0;\n',
        "the executor's change stays in the worktree until the merge",
      );
      assert.strictEqual(
        fs.existsSync(path.join(repo, '.baiton', 'specs')),
        false,
        'a run must never create anything under .baiton/specs/',
      );

      const kinds = h.events.map((e) => e.kind);
      assert.strictEqual(kinds[0], 'started');
      assert.strictEqual(kinds[kinds.length - 1], 'completed');
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: a declined confirm, through the real tool registry and seam
  // -------------------------------------------------------------------------

  describe('a declined confirm', () => {
    /**
     * Tool services wired to the REAL pipeline seam, so a decline is proven
     * against the filesystem rather than against a spy. The `confirm` seam
     * answers false and must never be consulted while the intervention seam is
     * wired.
     */
    function servicesFor(
      repo: string,
      h: Harness,
      answer: InterventionAnswer,
      calls: InterventionRequest[],
    ): ToolServices {
      return {
        repoRoot: repo,
        baitonDir: path.join(repo, '.baiton'),
        git: h.service,
        confirm: { confirm: async () => false },
        intervention: {
          ask: async (req: InterventionRequest) => {
            calls.push(req);
            return answer;
          },
        },
        runQueue: { dispatch: async () => ({ kind: 'busy' as const }) },
        runPipeline: createRunPipelineSeam(h.pipeline, () => 'bug'),
        clock: { now: () => '2026-01-01T00:00:00.000Z' },
        ids: { next: () => 'id-1' },
        gitSettings: { remote: 'origin', base: 'main' },
      };
    }

    function guardFor(repo: string): GuardContext {
      return new GuardContext({
        repoRoot: repo,
        specsDir: path.join(repo, '.baiton', 'specs'),
        restricted: false,
      });
    }

    it('writes nothing and starts nothing when the run card is declined', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const mainHeadBefore = (await h.service.branchHead('main'))!;
      const calls: InterventionRequest[] = [];
      const registry = createToolRegistry(servicesFor(repo, h, { kind: 'declined' }, calls));
      const guard = guardFor(repo);

      const startRun = await registry.call(
        'start_run',
        {
          mode: 'bug',
          statement: 'the counter is off by one',
          files: ['src/a.ts'],
          reproduction: 'Call count() with an empty list.',
        },
        'call-1',
        guard,
        'run',
      );
      assert.strictEqual(startRun.ok, false);
      if (!startRun.ok) {
        assert.match(startRun.error, /declined/i);
      }

      const investigate = await registry.call(
        'investigate',
        { question: 'Where is the bound computed?', files: ['src/a.ts'] },
        'call-2',
        guard,
        'run',
      );
      assert.strictEqual(investigate.ok, false);
      if (!investigate.ok) {
        assert.match(investigate.error, /declined/i);
      }

      assert.strictEqual(calls.length, 2, 'each tool raised exactly one card');
      for (const call of calls) {
        assert.strictEqual(call.kind, 'confirm');
      }

      // Nothing was created, dispatched or observed.
      assert.strictEqual(fs.existsSync(path.join(repo, '.baiton', 'runs')), false);
      assert.strictEqual(fs.existsSync(path.join(repo, '.baiton', 'worktrees')), false);
      assert.strictEqual(h.pipeline.isRunning(), false);
      assert.strictEqual(h.pipeline.currentRunId(), undefined);
      assert.strictEqual(h.watcherFactory.watchers.length, 0);
      assert.strictEqual(h.terminalHost.created.length, 0);
      assert.strictEqual(h.events.length, 0);
      assert.strictEqual(git(repo, 'branch', '--list', `baiton/bug/${RUN_ID}`).trim(), '');
      assert.strictEqual(await h.service.branchHead('main'), mainHeadBefore);
      assert.strictEqual((await h.service.status()).clean, true);
    });

    it('starts the real run when the card is approved', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const calls: InterventionRequest[] = [];
      const registry = createToolRegistry(servicesFor(repo, h, { kind: 'approved' }, calls));

      const result = await registry.call(
        'start_run',
        {
          mode: 'bug',
          statement: 'the counter is off by one',
          files: ['src/a.ts'],
          reproduction: 'Call count() with an empty list.',
        },
        'call-1',
        guardFor(repo),
        'run',
      );
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.data, {
          runId: RUN_ID,
          mode: 'bug',
          branch: `baiton/bug/${RUN_ID}`,
        });
      }
      assert.strictEqual(h.store.exists(RUN_ID), true, 'the manifest was written');

      // Tear the run down so no pending stage leaks into the next test.
      await h.waitFor(0);
      assert.strictEqual(h.pipeline.cancel(), true);
      h.watcherFactory.watchers[0].emitClose(undefined);
      await waitUntil(() => !h.pipeline.isRunning(), 'the run settling after cancel');
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: merging a finished run
  // -------------------------------------------------------------------------

  describe('merging a finished run', () => {
    /** The whole three-stage happy path, exactly as case 1 drives it. */
    async function finishedBugRun(h: Harness): Promise<{
      outcome: RunPipelineOutcome;
      manifest: { baseBranch: string; baseHead: string; statement: string };
    }> {
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok, 'the run should start');
      if (!started.ok) {
        throw new Error('the run did not start');
      }
      await h.settle(0, PLAN_RESULT);
      await h.waitFor(1);
      writeFile(h.worktreeDir(), 'src/a.ts', 'export const bound = 1;\n');
      h.watcherFactory.watchers[1].emitResult(EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      const outcome = await started.completed;
      assert.strictEqual(outcome.state, 'done');

      const read = h.store.read(RUN_ID);
      assert.ok(read.ok, 'the manifest is readable');
      if (!read.ok) {
        throw new Error('the manifest is unreadable');
      }
      return {
        outcome,
        manifest: {
          baseBranch: read.value.baseBranch,
          baseHead: read.value.baseHead,
          statement: read.value.statement,
        },
      };
    }

    it('merges the run branch into the base, then removes the worktree and branch', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const deps: RunWorktreeDeps = { workspaceRoot: repo, git: h.service };
      const { manifest } = await finishedBugRun(h);

      const merged = await mergeRunWorktree(deps, {
        runId: RUN_ID,
        mode: 'bug',
        baseBranch: manifest.baseBranch,
        baseHead: manifest.baseHead,
        statement: manifest.statement,
      });
      assert.ok(merged.ok, 'the merge should land');
      if (!merged.ok) {
        return;
      }
      assert.deepStrictEqual([...merged.value.cleanup], [], 'cleanup reported no problems');
      assert.strictEqual(merged.value.commit, await h.service.branchHead('main'));

      // A real merge commit: two parents, and the run's trailer.
      const parents = git(repo, 'rev-list', '--parents', '-n', '1', merged.value.commit)
        .trim()
        .split(/\s+/);
      assert.strictEqual(parents.length, 3, `expected a merge commit, got ${parents.join(' ')}`);
      const message = git(repo, 'log', '-1', '--format=%B', merged.value.commit);
      assert.ok(message.includes(`Run-Id: ${RUN_ID}`), message);

      // The executor's change reached the main checkout.
      assert.strictEqual(
        fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8'),
        'export const bound = 1;\n',
      );

      // The worktree and the branch are gone; the run directory survives.
      assert.strictEqual(fs.existsSync(h.worktreeDir()), false);
      assert.strictEqual(await findRunWorktree(deps, RUN_ID), undefined);
      assert.strictEqual(await h.service.branchHead(`baiton/bug/${RUN_ID}`), undefined);
      assert.ok(fs.existsSync(path.join(h.runDir(), 'run.json')));
    });

    it('refuses with base-moved when the base branch advanced, leaving the worktree and branch in place', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const deps: RunWorktreeDeps = { workspaceRoot: repo, git: h.service };
      const { manifest } = await finishedBugRun(h);

      writeFile(repo, 'other.txt', 'moved on\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'move the base');
      const newHead = (await h.service.branchHead('main'))!;

      const merged = await mergeRunWorktree(deps, {
        runId: RUN_ID,
        mode: 'bug',
        baseBranch: manifest.baseBranch,
        baseHead: manifest.baseHead,
        statement: manifest.statement,
      });
      assert.strictEqual(merged.ok, false);
      if (!merged.ok) {
        assert.strictEqual(merged.error.reason, 'base-moved');
        if (merged.error.reason === 'base-moved') {
          assert.strictEqual(merged.error.expected, manifest.baseHead);
          assert.strictEqual(merged.error.actual, newHead);
        }
      }

      assert.strictEqual(fs.existsSync(h.worktreeDir()), true);
      assert.notStrictEqual(await h.service.branchHead(`baiton/bug/${RUN_ID}`), undefined);
      assert.strictEqual(await h.service.branchHead('main'), newHead, 'the merge changed nothing');
    });

    it('refuses with dirty-tree when the main checkout has uncommitted changes', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);
      const deps: RunWorktreeDeps = { workspaceRoot: repo, git: h.service };
      const { manifest } = await finishedBugRun(h);
      const headBefore = (await h.service.branchHead('main'))!;

      // Dirty the main checkout WITHOUT moving the base: the base-moved check
      // runs first, so the base must stay put for this refusal to be reached.
      writeFile(repo, 'README.md', 'edited in the main checkout\n');

      const merged = await mergeRunWorktree(deps, {
        runId: RUN_ID,
        mode: 'bug',
        baseBranch: manifest.baseBranch,
        baseHead: manifest.baseHead,
        statement: manifest.statement,
      });
      assert.strictEqual(merged.ok, false);
      if (!merged.ok) {
        assert.strictEqual(merged.error.reason, 'dirty-tree');
        if (merged.error.reason === 'dirty-tree') {
          assert.ok(
            [...merged.error.changes].includes('README.md'),
            JSON.stringify(merged.error.changes),
          );
        }
      }

      assert.strictEqual(fs.existsSync(h.worktreeDir()), true);
      assert.notStrictEqual(await h.service.branchHead(`baiton/bug/${RUN_ID}`), undefined);
      assert.strictEqual(await h.service.branchHead('main'), headBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: cancel keeps the worktree and the branch
  // -------------------------------------------------------------------------

  describe('cancelling a run', () => {
    it('records cancelled and leaves the worktree and branch in place', async () => {
      const repo = newRepo();
      const h = makeHarness(repo);

      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await h.waitFor(0);
      assert.strictEqual(h.pipeline.currentStage()?.stage, 'plan');

      assert.strictEqual(h.pipeline.cancel(), true);
      // The cancel disposes the stage terminal; the stub watcher does not wire
      // dispose -> close, so the close path is driven here.
      await h.close(0, undefined);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'cancelled');
      assert.deepStrictEqual(outcome.outcome, { kind: 'cancelled' });
      assert.deepStrictEqual(outcome.commits, []);
      assert.ok(h.terminalHost.created[0].disposeCount >= 1, 'the stage terminal was disposed');

      const read = h.store.read(RUN_ID);
      assert.ok(read.ok);
      if (read.ok) {
        assert.strictEqual(read.value.state, 'cancelled');
      }

      // The worktree and branch survive for inspection — the point of the case.
      assert.strictEqual(fs.existsSync(h.worktreeDir()), true);
      assert.strictEqual(fs.existsSync(path.join(h.worktreeDir(), 'README.md')), true);
      assert.notStrictEqual(
        await findRunWorktree({ workspaceRoot: repo, git: h.service }, RUN_ID),
        undefined,
      );
      assert.notStrictEqual(await h.service.branchHead(`baiton/bug/${RUN_ID}`), undefined);
      assert.strictEqual(h.pipeline.isRunning(), false);
      assert.strictEqual((await h.service.status()).clean, true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: the repository lock
  // -------------------------------------------------------------------------

  describe('the repository lock', () => {
    it('is held against a spec-less run only by the spec draft, and the run holds it against the draft', async () => {
      const repo = newRepo();
      let drafting = true;
      // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
      let h!: Harness;
      const lock = createStageLock({
        specDraftRunning: () => drafting,
        runRunning: () => h.pipeline.isRunning(),
      });
      h = makeHarness(repo, { isSpecBusy: () => lock.runPipelineBusy() });

      // While the spec draft runs, a spec-less run is refused and creates nothing.
      const refused = await h.pipeline.start(bugRequest());
      assert.strictEqual(refused.ok, false);
      if (!refused.ok) {
        assert.strictEqual(refused.error.kind, 'busy');
      }
      assert.strictEqual(fs.existsSync(h.worktreeDir()), false, 'no worktree was created');
      assert.strictEqual(await h.service.branchHead(`baiton/bug/${RUN_ID}`), undefined, 'no branch was created');

      // With the draft finished the run starts, and while it runs the draft is locked out.
      drafting = false;
      assert.strictEqual(lock.specDraftBusy(), false);
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok, 'the run starts once the draft is done');
      if (!started.ok) {
        return;
      }
      assert.strictEqual(lock.specDraftBusy(), true, 'a running spec-less run blocks the spec draft');

      await h.waitFor(0);
      assert.strictEqual(h.pipeline.cancel(), true);
      await h.close(0, undefined);
      await started.completed;
      await waitUntil(() => !h.pipeline.isRunning(), 'the run settling after cancel');
      assert.strictEqual(lock.specDraftBusy(), false, 'the lock is released when the run ends');
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: an investigate run
  // -------------------------------------------------------------------------

  describe('an investigate run', () => {
    const RUN = 'investigate-20260101-000000-aaaa';

    it('answers with a finding, creating no branch, worktree or commit', async () => {
      const repo = newRepo();
      const h = makeHarness(repo, { runId: RUN });
      const mainHeadBefore = (await h.service.branchHead('main'))!;

      const started = await h.pipeline.start(investigateRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      assert.strictEqual(started.manifest.mode, 'investigate');
      assert.strictEqual(started.manifest.worktreeDir, undefined);
      assert.strictEqual(fs.existsSync(path.join(repo, '.baiton', 'worktrees')), false);

      await h.settle(0, INVESTIGATE_RESULT);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'answered');
      assert.deepStrictEqual(outcome.outcome, { kind: 'finding', finding: FINDING_TEXT });
      assert.deepStrictEqual(outcome.commits, []);

      const finding = outcome.finding;
      assert.ok(finding !== undefined, 'the outcome carries the finding');
      if (finding === undefined) {
        return;
      }
      assert.strictEqual(finding.runId, RUN);
      assert.strictEqual(finding.mode, 'investigate');
      assert.strictEqual(finding.question, 'Where is the bound computed?');
      assert.deepStrictEqual(finding.questionFiles, ['src/a.ts']);
      assert.strictEqual(finding.finding, FINDING_TEXT);
      assert.deepStrictEqual(finding.files, ['src/a.ts', 'src/b.ts']);
      assert.deepStrictEqual(finding.nextSteps, ['unify the two computations']);
      assert.strictEqual(finding.findingPath, `.baiton/runs/${RUN}/finding.md`);
      assert.strictEqual(h.findings.length, 1, 'the sink fired exactly once');
      assert.strictEqual(h.findings[0].runId, RUN);

      // The finding artifact, and no plan/execute/review artifact.
      const rendered = fs.readFileSync(path.join(h.runDir(RUN), 'finding.md'), 'utf8');
      assert.ok(rendered.includes(FINDING_TEXT), rendered);
      for (const file of ['plan.md', 'execute-1.md', 'review-1.md']) {
        assert.strictEqual(
          fs.existsSync(path.join(h.runDir(RUN), file)),
          false,
          `an investigate run writes no ${file}`,
        );
      }

      // One stage, launched from the MAIN checkout.
      assert.deepStrictEqual(
        h.watcherFactory.created.map((c) => c.runId),
        [`${RUN}.investigate.1`],
      );
      const briefPath = path.join(repo, '.baiton', 'runs', `${RUN}.investigate.1`, 'brief.md');
      assert.ok(fs.existsSync(briefPath), 'the brief lives under the main checkout');
      const brief = fs.readFileSync(briefPath, 'utf8');
      assert.ok(brief.includes('Where is the bound computed?'), brief);
      assert.ok(brief.includes('src/a.ts'), brief);
      assert.ok(!brief.includes(`baiton/investigate/${RUN}`), brief);

      // Git is untouched.
      assert.strictEqual(await h.service.branchHead('main'), mainHeadBefore);
      assert.strictEqual(git(repo, 'branch', '--list', `baiton/investigate/${RUN}`).trim(), '');
      assert.strictEqual((await h.service.status()).clean, true);
      assert.strictEqual(await h.service.findCommitByRunId(RUN), undefined);
      assert.strictEqual(fs.existsSync(path.join(repo, '.baiton', 'specs')), false);

      const read = h.store.read(RUN);
      assert.ok(read.ok);
      if (read.ok) {
        assert.strictEqual(read.value.state, 'answered');
        assert.deepStrictEqual(read.value.attempts, {
          plan: 0,
          execute: 0,
          review: 0,
          investigate: 1,
        });
      }
    });
  });
});
