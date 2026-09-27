import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import type { GitStatus, GitWorktree, GitWorktreeService } from '../src/git/types';
import { Result, ok } from '../src/model/result';
import type { RunMode } from '../src/model/mode';
import type { Role } from '../src/model/role';
import { parseJournal } from '../src/journal';
import { createRunStore, type RunStore } from '../src/engine/runStore';
import {
  createRunPipeline,
  type LiveRunStage,
  type RunPipeline,
  type RunPipelineEvent,
  type RunPipelineOutcome,
  type RunPipelineRequest,
} from '../src/engine/runPipeline';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../src/engine/terminalHost';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';

/**
 * Unit tests for the spec-less run pipeline (T07).
 *
 * The agent boundary is stubbed exactly as `test/engine.specDraft.test.ts` and
 * the plan/execute/review integration test stub it — an inert adapter, a
 * terminal that only records disposal, and a result watcher the test drives
 * directly — so the pipeline's real behaviour is exercised without a CLI, a
 * terminal or a VS Code host: the manifest, journal and artifacts land in the
 * MAIN checkout's `.baiton/runs/<run-id>/`, each stage launches under
 * `<run-id>.<stage>.<n>` with its brief inside the run's worktree, the findings
 * loop re-launches execute, the execute commit carries a `Run-Id:` trailer, and
 * nothing is ever written under `.baiton/specs/`.
 *
 * The final describe repeats the happy path against a REAL temporary git repo
 * and the real `createRunWorktree`/`createGitService` path, stubbing only the
 * agent boundary.
 */

// ---------------------------------------------------------------------------
// Agent-boundary stubs
// ---------------------------------------------------------------------------

/** A stub adapter whose probe verdict the test controls. */
class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  public launches: LaunchRequest[] = [];
  public probeCount = 0;
  private readonly probeOk: boolean;
  constructor(probeOk = true) {
    this.probeOk = probeOk;
  }
  async probe(): Promise<ProbeResult> {
    this.probeCount += 1;
    return this.probeOk
      ? { version: '0.0.0-stub', ok: true }
      : { version: '', ok: false, reason: 'the CLI was not found' };
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
// A scriptable GitWorktreeService
// ---------------------------------------------------------------------------

/** Throws for every git call a pipeline path must never make. */
function boom(name: string) {
  return (): never => {
    throw new Error(`git.${name} must not be called on this path`);
  };
}

/** Every commit one fake git service recorded. */
interface RecordedCommit {
  message: string;
  trailers: Record<string, string> | undefined;
}

/**
 * A scriptable {@link GitWorktreeService}. Only the members the pipeline is
 * allowed to touch are implemented; everything else throws, so an unintended
 * git call fails the test loudly.
 */
class FakeGit implements GitWorktreeService {
  public commits: RecordedCommit[] = [];
  public addWorktreeCalls: Array<{ dir: string; branch: string; fromCommit: string }> = [];
  public removeWorktreeCalls: string[] = [];
  public deleteBranchCalls: string[] = [];
  public branch = 'main';
  public headSha = 'a'.repeat(40);
  public branchHeads = new Map<string, string>([['main', 'a'.repeat(40)]]);
  public currentBranchThrows = false;
  public addWorktreeThrows = false;
  public commitThrows = false;

  async status(): Promise<GitStatus> {
    return { clean: true, changes: [] };
  }
  async isClean(): Promise<boolean> {
    return true;
  }
  async isCleanExceptSpecFolder(): Promise<boolean> {
    return true;
  }
  async head(): Promise<string> {
    return this.headSha;
  }
  async currentBranch(): Promise<string> {
    if (this.currentBranchThrows) {
      throw new Error('not a git repository');
    }
    return this.branch;
  }
  async branchHead(ref: string): Promise<string | undefined> {
    return this.branchHeads.get(ref);
  }
  async commit(message: string, trailers?: Record<string, string>): Promise<string> {
    if (this.commitThrows) {
      throw new Error('nothing to commit');
    }
    this.commits.push({ message, trailers });
    return 'c'.repeat(40);
  }
  async addWorktree(dir: string, branch: string, fromCommit: string): Promise<void> {
    if (this.addWorktreeThrows) {
      throw new Error('fatal: could not create the worktree');
    }
    this.addWorktreeCalls.push({ dir, branch, fromCommit });
    // The launcher writes the stage's brief inside the worktree, so the
    // directory has to exist exactly as a real `git worktree add` leaves it.
    fs.mkdirSync(dir, { recursive: true });
    this.branchHeads.set(branch, fromCommit);
  }
  async listWorktrees(): Promise<readonly GitWorktree[]> {
    return [];
  }
  async removeWorktree(dir: string): Promise<void> {
    this.removeWorktreeCalls.push(dir);
  }
  async deleteBranch(branch: string): Promise<void> {
    this.deleteBranchCalls.push(branch);
  }
  async merge(): Promise<Result<string, never>> {
    return ok('m'.repeat(40));
  }
  async resetWorkingTree(): Promise<Result<void, never>> {
    return ok(undefined);
  }
  fetch = boom('fetch');
  resolveBaseCommit = boom('resolveBaseCommit');
  createSpecBranch = boom('createSpecBranch');
  checkout = boom('checkout');
  diff = boom('diff');
  diffAgainstWorkingTree = boom('diffAgainstWorkingTree');
  log = boom('log');
  findCommitByRunId = boom('findCommitByRunId');
  push = boom('push');
  remoteUrl = boom('remoteUrl');
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

const REVIEW_FINDINGS = JSON.stringify({
  verdict: 'findings',
  findings: [{ severity: 'must', file: 'src/a.ts', line: 3, text: 'the bound is still wrong' }],
  tests: { ran: true, passed: false, output_tail: '1 failing' },
});

const INVESTIGATE_RESULT = JSON.stringify({
  finding: 'The bound is computed twice, in src/a.ts and src/b.ts.',
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
 * Wait until `ready()` holds, yielding on a real timer between checks: a
 * setImmediate spin would starve nothing but would also outrun a stage that is
 * waiting on a real `git` child process (the end-to-end case).
 */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !ready(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(ready(), `${what} never happened`);
}

interface Harness {
  root: string;
  store: RunStore;
  pipeline: RunPipeline;
  adapter: StubAdapter;
  terminalHost: StubTerminalHost;
  watcherFactory: StubWatcherFactory;
  mainGit: FakeGit;
  worktreeGit: FakeGit;
  events: RunPipelineEvent[];
  outcomes: RunPipelineOutcome[];
  reports: string[];
  setSpecBusy(v: boolean): void;
  /** Wait until the n-th stage watcher exists, then deliver a result. */
  settle(index: number, json: string): Promise<void>;
  /** Wait until the n-th stage watcher exists, then close its terminal. */
  close(index: number, exitCode: number | undefined): Promise<void>;
  waitForWatcher(index: number): Promise<void>;
  runDir(runId?: string): string;
  worktreeDir(runId?: string): string;
}

function makeHarness(
  options: {
    probeOk?: boolean;
    unknownAgent?: boolean;
    execAttempts?: number;
    newRunId?: string;
  } = {},
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runpipe-'));
  const store = createRunStore({ workspaceRoot: root, now: () => '2026-01-01T00:00:00.000Z' });
  const adapter = new StubAdapter(options.probeOk ?? true);
  const terminalHost = new StubTerminalHost();
  const watcherFactory = new StubWatcherFactory();
  const mainGit = new FakeGit();
  const worktreeGit = new FakeGit();
  const events: RunPipelineEvent[] = [];
  const outcomes: RunPipelineOutcome[] = [];
  const reports: string[] = [];
  let specBusy = false;

  const pipeline = createRunPipeline({
    workspaceRoot: root,
    git: mainGit,
    store,
    terminalHost,
    watcherFactory,
    modelForRole: () => ({ model: 'stub-model', effort: 'high' }),
    adapterForRole: () => (options.unknownAgent === true ? undefined : adapter),
    execAttempts: () => options.execAttempts ?? 2,
    verify: () => 'npm test',
    isSpecBusy: () => specBusy,
    createService: () => worktreeGit,
    newRunId: () => options.newRunId ?? RUN_ID,
    newSessionId: () => '11111111-1111-4111-8111-111111111111',
    onComplete: (o) => outcomes.push(o),
    report: (m) => reports.push(m),
  });
  pipeline.onChange((e) => events.push(e));

  const waitForWatcher = (index: number): Promise<void> =>
    waitUntil(() => watcherFactory.watchers.length > index, `watcher ${index} being created`);

  return {
    root,
    store,
    pipeline,
    adapter,
    terminalHost,
    watcherFactory,
    mainGit,
    worktreeGit,
    events,
    outcomes,
    reports,
    setSpecBusy: (v) => {
      specBusy = v;
    },
    waitForWatcher,
    settle: async (index, json) => {
      await waitForWatcher(index);
      watcherFactory.watchers[index].emitResult(json);
      await flush();
    },
    close: async (index, exitCode) => {
      await waitForWatcher(index);
      watcherFactory.watchers[index].emitClose(exitCode);
      await flush();
    },
    runDir: (runId = RUN_ID) => path.join(root, '.baiton', 'runs', runId),
    worktreeDir: (runId = RUN_ID) => path.join(root, '.baiton', 'worktrees', runId),
  };
}

/** A `bug` request with reproduction steps. */
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

/** A request for a mode with no reproduction. */
function modeRequest(mode: RunMode): RunPipelineRequest {
  return {
    mode,
    composerMode: mode,
    explicitMode: false,
    statement: 'tidy the counter module',
    files: ['src/a.ts'],
  };
}

/** The brief one launch wrote, resolved under the launch's own root. */
function briefFor(base: string, launchId: string): string {
  return fs.readFileSync(path.join(base, '.baiton', 'runs', launchId, 'brief.md'), 'utf8');
}

describe('spec-less run pipeline (T07)', () => {
  const roots: string[] = [];
  const track = (h: Harness): Harness => {
    roots.push(h.root);
    return h;
  };

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  describe('a bug run that passes review', () => {
    it('drives plan -> execute -> review in the run worktree and commits the execute', async () => {
      const h = track(makeHarness());

      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok, 'the run should start');
      if (!started.ok) {
        return;
      }
      assert.strictEqual(started.runId, RUN_ID);
      assert.strictEqual(h.pipeline.isRunning(), true, 'the run holds the repo lock');
      assert.strictEqual(started.manifest.worktreeDir, `.baiton/worktrees/${RUN_ID}`);

      // The worktree was created on the run branch at the base head.
      assert.deepStrictEqual(h.mainGit.addWorktreeCalls, [
        {
          dir: h.worktreeDir(),
          branch: `baiton/bug/${RUN_ID}`,
          fromCommit: 'a'.repeat(40),
        },
      ]);

      // Plan launched as the planner, under `<run-id>.plan.1`, with the
      // terminal cwd in the worktree.
      await h.waitForWatcher(0);
      assert.deepStrictEqual(
        h.adapter.launches.map((l) => [l.role, l.runId, l.model]),
        [['planner', `${RUN_ID}.plan.1`, 'stub-model']],
      );
      assert.strictEqual(h.terminalHost.options[0].cwd, h.worktreeDir());

      // The plan brief lives in the WORKTREE's run directory and carries the
      // run framing plus the bug framing.
      const planBrief = briefFor(h.worktreeDir(), `${RUN_ID}.plan.1`);
      assert.ok(planBrief.includes('# Run'), 'the brief carries the run section');
      assert.ok(planBrief.includes('- Mode: bug'));
      assert.ok(planBrief.includes('# Defect'));
      assert.ok(planBrief.includes('# Reproduction'));
      assert.ok(planBrief.includes('Call count() with an empty list.'));
      assert.ok(planBrief.includes(`baiton/bug/${RUN_ID}`));

      await h.settle(0, PLAN_RESULT);
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'done');
      assert.deepStrictEqual(outcome.outcome, { kind: 'verdict', verdict: 'pass' });
      assert.deepStrictEqual(outcome.commits, ['c'.repeat(40)]);
      assert.strictEqual(h.pipeline.isRunning(), false, 'the lock is released');
      assert.strictEqual(h.pipeline.currentStage(), undefined);
      assert.deepStrictEqual(h.outcomes, [outcome]);

      // Each stage launched under its own launch id, in pipeline order.
      assert.deepStrictEqual(
        h.adapter.launches.map((l) => [l.role, l.runId]),
        [
          ['planner', `${RUN_ID}.plan.1`],
          ['executor', `${RUN_ID}.execute.1`],
          ['reviewer', `${RUN_ID}.review.1`],
        ],
      );

      // Artifacts land in the MAIN checkout's run directory, and nothing is
      // written under `.baiton/specs/`.
      for (const file of ['plan.md', 'execute-1.md', 'review-1.md']) {
        assert.ok(fs.existsSync(path.join(h.runDir(), file)), `${file} should be persisted`);
      }
      assert.ok(
        !fs.existsSync(path.join(h.root, '.baiton', 'specs')),
        'a run must never create anything under .baiton/specs/',
      );

      // The manifest ends done, with every counter and a completion stamp.
      const manifest = h.store.read(RUN_ID);
      assert.ok(manifest.ok);
      if (!manifest.ok) {
        return;
      }
      assert.strictEqual(manifest.value.state, 'done');
      assert.deepStrictEqual(manifest.value.outcome, { kind: 'verdict', verdict: 'pass' });
      assert.deepStrictEqual(manifest.value.attempts, {
        plan: 1,
        execute: 1,
        review: 1,
        investigate: 0,
      });
      assert.ok(manifest.value.completedAt !== undefined, 'completedAt is stamped');

      // The execute commit landed on the WORKTREE service, with the RUN id as
      // the trailer value; the main checkout was never committed to.
      assert.deepStrictEqual(h.worktreeGit.commits, [
        {
          message: `bug(${RUN_ID}): execute attempt 1`,
          trailers: { 'Run-Id': RUN_ID },
        },
      ]);
      assert.deepStrictEqual(h.mainGit.commits, []);

      // The journal holds a start+completion pair per stage, keyed by launch id
      // with the run id as the subject, and the execute carries its commit.
      const entries = parseJournal(path.join(h.runDir(), 'runs.jsonl'));
      assert.deepStrictEqual(
        entries.map((e) => [e.runId, e.todoId, e.stage, e.attempt, e.result]),
        [
          [`${RUN_ID}.plan.1`, RUN_ID, 'plan', 1, 'completed'],
          [`${RUN_ID}.execute.1`, RUN_ID, 'execute', 1, 'completed'],
          [`${RUN_ID}.review.1`, RUN_ID, 'review', 1, 'completed'],
        ],
      );
      assert.strictEqual(entries[1].commit, 'c'.repeat(40));
      assert.strictEqual(entries[0].commit, undefined);
    });
  });

  describe('the findings loop', () => {
    it('re-launches execute with the review in its brief and passes on the second round', async () => {
      const h = track(makeHarness({ execAttempts: 2 }));
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.settle(0, PLAN_RESULT);
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_FINDINGS);

      // A second execute attempt launched, carrying the first review.
      await h.waitForWatcher(3);
      assert.deepStrictEqual(
        h.adapter.launches.map((l) => l.runId),
        [
          `${RUN_ID}.plan.1`,
          `${RUN_ID}.execute.1`,
          `${RUN_ID}.review.1`,
          `${RUN_ID}.execute.2`,
        ],
      );
      const retryBrief = briefFor(h.worktreeDir(), `${RUN_ID}.execute.2`);
      assert.ok(retryBrief.includes('# Latest review'), 'the retry carries the review');
      assert.ok(retryBrief.includes('the bound is still wrong'));
      assert.ok(retryBrief.includes('# Plan'), 'the retry still carries the plan');

      await h.settle(3, EXECUTE_RESULT);
      await h.settle(4, REVIEW_PASS);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'done');
      assert.strictEqual(outcome.commits.length, 2, 'each execute attempt committed');
      const manifest = h.store.read(RUN_ID);
      assert.ok(manifest.ok);
      if (manifest.ok) {
        assert.deepStrictEqual(manifest.value.attempts, {
          plan: 1,
          execute: 2,
          review: 2,
          investigate: 0,
        });
      }
      assert.ok(fs.existsSync(path.join(h.runDir(), 'execute-2.md')));
      assert.ok(fs.existsSync(path.join(h.runDir(), 'review-2.md')));
    });

    it('stops at the exec_attempts ceiling with a findings outcome', async () => {
      const h = track(makeHarness({ execAttempts: 1 }));
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.settle(0, PLAN_RESULT);
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_FINDINGS);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'failed');
      assert.deepStrictEqual(outcome.outcome, { kind: 'verdict', verdict: 'findings' });
      assert.match(outcome.message, /findings after 1 execute attempt/);
      assert.strictEqual(
        h.adapter.launches.length,
        3,
        'no further execute is launched at the ceiling',
      );
      const manifest = h.store.read(RUN_ID);
      assert.ok(manifest.ok);
      if (manifest.ok) {
        assert.strictEqual(manifest.value.state, 'failed');
        assert.deepStrictEqual(manifest.value.outcome, { kind: 'verdict', verdict: 'findings' });
      }
    });
  });

  describe('the per-mode framing', () => {
    it('gives a quick run no defect and no behaviour-preservation section', async () => {
      const h = track(makeHarness({ newRunId: 'quick-20260101-000000-aaaa' }));
      const started = await h.pipeline.start(modeRequest('quick'));
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await h.waitForWatcher(0);

      const brief = briefFor(
        h.worktreeDir('quick-20260101-000000-aaaa'),
        'quick-20260101-000000-aaaa.plan.1',
      );
      assert.ok(brief.includes('- Mode: quick'));
      assert.ok(!brief.includes('# Defect'), 'quick has no defect framing');
      assert.ok(!brief.includes('# Behaviour preservation'));

      h.pipeline.cancel();
      await h.close(0, 0);
      await started.completed;
    });

    it('names the verify command under a refactor run\'s behaviour preservation', async () => {
      const h = track(makeHarness({ newRunId: 'refactor-20260101-000000-aaaa' }));
      const started = await h.pipeline.start(modeRequest('refactor'));
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await h.waitForWatcher(0);

      const brief = briefFor(
        h.worktreeDir('refactor-20260101-000000-aaaa'),
        'refactor-20260101-000000-aaaa.plan.1',
      );
      assert.ok(brief.includes('# Behaviour preservation'));
      assert.ok(brief.includes('npm test'));
      assert.ok(!brief.includes('# Defect'));

      h.pipeline.cancel();
      await h.close(0, 0);
      await started.completed;
    });
  });

  describe('an investigate run', () => {
    it('runs one read-only stage from the main checkout and ends answered', async () => {
      const runId = 'investigate-20260101-000000-aaaa';
      const h = track(makeHarness({ newRunId: runId }));

      const started = await h.pipeline.start({
        mode: 'investigate',
        composerMode: 'investigate',
        explicitMode: true,
        statement: 'where is the bound computed?',
        files: ['src/a.ts'],
      });
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.waitForWatcher(0);
      // No worktree at all, and the stage runs from the main checkout.
      assert.deepStrictEqual(h.mainGit.addWorktreeCalls, []);
      assert.ok(!fs.existsSync(h.worktreeDir(runId)), 'no worktree directory is created');
      assert.strictEqual(started.manifest.worktreeDir, undefined);
      assert.strictEqual(h.terminalHost.options[0].cwd, h.root);
      assert.deepStrictEqual(
        h.adapter.launches.map((l) => [l.role, l.runId]),
        [['reviewer', `${runId}.investigate.1`]],
      );

      await h.settle(0, INVESTIGATE_RESULT);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'answered');
      assert.deepStrictEqual(outcome.outcome, {
        kind: 'finding',
        finding: 'The bound is computed twice, in src/a.ts and src/b.ts.',
      });
      assert.deepStrictEqual(outcome.commits, []);
      assert.ok(fs.existsSync(path.join(h.runDir(runId), 'finding.md')));
      assert.deepStrictEqual(h.worktreeGit.commits, [], 'an investigate run never commits');
      assert.deepStrictEqual(h.mainGit.commits, []);

      const manifest = h.store.read(runId);
      assert.ok(manifest.ok);
      if (manifest.ok) {
        assert.strictEqual(manifest.value.state, 'answered');
        assert.deepStrictEqual(manifest.value.attempts, {
          plan: 0,
          execute: 0,
          review: 0,
          investigate: 1,
        });
      }
    });
  });

  describe('refusals', () => {
    it('refuses busy while a spec stage runs, writing nothing', async () => {
      const h = track(makeHarness());
      h.setSpecBusy(true);

      const refused = await h.pipeline.start(bugRequest());
      assert.strictEqual(refused.ok, false);
      if (!refused.ok) {
        assert.strictEqual(refused.error.kind, 'busy');
        assert.match(refused.error.message, /already running for this repository/);
      }
      assert.ok(!fs.existsSync(path.join(h.root, '.baiton', 'runs')), 'no run dir is written');
      assert.strictEqual(h.terminalHost.created.length, 0);
    });

    it('refuses busy while its own run is in flight, and is running until the last stage settles', async () => {
      const h = track(makeHarness());
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      assert.strictEqual(h.pipeline.isRunning(), true);

      const second = await h.pipeline.start(bugRequest());
      assert.strictEqual(second.ok, false);
      if (!second.ok) {
        assert.strictEqual(second.error.kind, 'busy');
      }

      await h.settle(0, PLAN_RESULT);
      assert.strictEqual(h.pipeline.isRunning(), true, 'still running between stages');
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      await started.completed;
      assert.strictEqual(h.pipeline.isRunning(), false);
    });

    it('refuses mode "spec"', async () => {
      const h = track(makeHarness());
      const refused = await h.pipeline.start(bugRequest({ mode: 'spec' }));
      assert.strictEqual(refused.ok, false);
      if (!refused.ok) {
        assert.strictEqual(refused.error.kind, 'invalid-mode');
        assert.match(refused.error.message, /draft_spec/);
      }
      assert.ok(!fs.existsSync(path.join(h.root, '.baiton', 'runs')));
    });

    it('refuses a detached HEAD and a base branch with no commits', async () => {
      const detached = track(makeHarness());
      detached.mainGit.branch = 'HEAD';
      const refusedDetached = await detached.pipeline.start(bugRequest());
      assert.strictEqual(refusedDetached.ok, false);
      if (!refusedDetached.ok) {
        assert.strictEqual(refusedDetached.error.kind, 'detached-head');
        assert.match(refusedDetached.error.message, /check out a named branch first/);
      }
      assert.ok(!fs.existsSync(path.join(detached.root, '.baiton', 'runs')));

      const empty = track(makeHarness());
      empty.mainGit.branchHeads.delete('main');
      const refusedEmpty = await empty.pipeline.start(bugRequest());
      assert.strictEqual(refusedEmpty.ok, false);
      if (!refusedEmpty.ok) {
        assert.strictEqual(refusedEmpty.error.kind, 'no-base-head');
      }
      assert.ok(!fs.existsSync(path.join(empty.root, '.baiton', 'runs')));
    });

    it('records a failed manifest when the worktree cannot be created', async () => {
      const h = track(makeHarness());
      h.mainGit.addWorktreeThrows = true;

      const refused = await h.pipeline.start(bugRequest());
      assert.strictEqual(refused.ok, false);
      if (!refused.ok) {
        assert.strictEqual(refused.error.kind, 'worktree');
      }
      assert.strictEqual(h.pipeline.isRunning(), false);
      assert.strictEqual(h.terminalHost.created.length, 0);

      const manifest = h.store.read(RUN_ID);
      assert.ok(manifest.ok, 'the dead run keeps its manifest');
      if (manifest.ok) {
        assert.strictEqual(manifest.value.state, 'failed');
        assert.strictEqual(manifest.value.outcome?.kind, 'failed');
        assert.strictEqual(manifest.value.worktreeDir, undefined);
      }
    });

    it('fails the run when the role has an unknown agent, after bumping the counter', async () => {
      const h = track(makeHarness({ unknownAgent: true }));
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      const outcome = await started.completed;
      assert.strictEqual(outcome.state, 'failed');
      assert.match(outcome.message, /roles\.planner\.agent/);
      assert.strictEqual(h.terminalHost.created.length, 0);
      const manifest = h.store.read(RUN_ID);
      assert.ok(manifest.ok);
      if (manifest.ok) {
        assert.strictEqual(manifest.value.attempts.plan, 1, 'the attempt was counted');
      }
    });

    it('fails the run when the adapter probe fails', async () => {
      const h = track(makeHarness({ probeOk: false }));
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      const outcome = await started.completed;
      assert.strictEqual(outcome.state, 'failed');
      assert.match(outcome.message, /the CLI was not found/);
      assert.strictEqual(h.terminalHost.created.length, 0);
    });

    it('fails the run when a stage closes without a result', async () => {
      const h = track(makeHarness());
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.close(0, 3);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'failed');
      assert.strictEqual(outcome.outcome.kind, 'failed');
      assert.match(outcome.message, /the plan stage closed without a result \(exit 3\)/);
      assert.strictEqual(h.adapter.launches.length, 1, 'no execute is launched');
      assert.deepStrictEqual(h.worktreeGit.commits, []);
    });
  });

  describe('cancel', () => {
    it('cancels the stage in flight and leaves the worktree in place', async () => {
      const h = track(makeHarness());
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await h.settle(0, PLAN_RESULT);
      await h.waitForWatcher(1);

      const live = h.pipeline.currentStage() as LiveRunStage;
      assert.strictEqual(live.stage, 'execute');
      assert.strictEqual(live.launchId, `${RUN_ID}.execute.1`);

      assert.strictEqual(h.pipeline.cancel(), true);
      assert.ok(
        h.terminalHost.created[1].disposeCount >= 1,
        'the in-flight terminal is disposed',
      );
      await h.close(1, undefined);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'cancelled');
      assert.deepStrictEqual(outcome.outcome, { kind: 'cancelled' });
      assert.match(outcome.message, /cancelled during execute/);

      // The worktree and branch survive for inspection.
      assert.ok(fs.existsSync(h.worktreeDir()), 'the worktree directory stays on disk');
      assert.deepStrictEqual(h.mainGit.removeWorktreeCalls, []);
      assert.deepStrictEqual(h.mainGit.deleteBranchCalls, []);
      assert.deepStrictEqual(h.worktreeGit.removeWorktreeCalls, []);
      assert.deepStrictEqual(h.worktreeGit.deleteBranchCalls, []);

      assert.strictEqual(h.pipeline.cancel(), false, 'cancel when idle returns false');
    });
  });

  describe('the execute drift check', () => {
    it('halts the run when the worktree HEAD moved during execute', async () => {
      const h = track(makeHarness());
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.settle(0, PLAN_RESULT);
      await h.waitForWatcher(1);
      // Someone moved the worktree's HEAD while the executor was running.
      h.worktreeGit.headSha = 'b'.repeat(40);
      await h.settle(1, EXECUTE_RESULT);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'failed');
      assert.strictEqual(outcome.outcome.kind, 'failed');
      assert.match(outcome.message, /git_state_changed/);
      assert.deepStrictEqual(h.worktreeGit.commits, [], 'a drift commits nothing');
      assert.strictEqual(h.adapter.launches.length, 2, 'no review is launched');

      const entries = parseJournal(path.join(h.runDir(), 'runs.jsonl'));
      const execute = entries.find((e) => e.stage === 'execute');
      assert.ok(execute !== undefined);
      assert.strictEqual(execute?.result, 'completed');
      assert.strictEqual(execute?.commit, undefined, 'journaled without a commit');
    });
  });

  describe('change events', () => {
    it('emits started, a stage pair per stage, and completed with the terminal manifest', async () => {
      const h = track(makeHarness());
      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }

      await h.settle(0, PLAN_RESULT);
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      const outcome = await started.completed;

      assert.deepStrictEqual(
        h.events.map((e) =>
          e.kind === 'stage-started' || e.kind === 'stage-completed'
            ? `${e.kind}:${e.stage}.${e.attempt}`
            : e.kind,
        ),
        [
          'started',
          'stage-started:plan.1',
          'stage-completed:plan.1',
          'stage-started:execute.1',
          'stage-completed:execute.1',
          'stage-started:review.1',
          'stage-completed:review.1',
          'completed',
        ],
      );
      const last = h.events[h.events.length - 1];
      assert.strictEqual(last.kind, 'completed');
      if (last.kind === 'completed') {
        assert.strictEqual(last.manifest.state, 'done');
        assert.deepStrictEqual(last.outcome, outcome);
      }
    });

    it('stops delivering after unsubscribe and survives a throwing listener', async () => {
      const h = track(makeHarness());
      const seen: string[] = [];
      const unsubscribe = h.pipeline.onChange((e) => seen.push(e.kind));
      h.pipeline.onChange(() => {
        throw new Error('a bad subscriber');
      });

      const started = await h.pipeline.start(bugRequest());
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      assert.deepStrictEqual(seen, ['started']);
      unsubscribe();

      await h.settle(0, PLAN_RESULT);
      await h.settle(1, EXECUTE_RESULT);
      await h.settle(2, REVIEW_PASS);
      const outcome = await started.completed;

      assert.strictEqual(outcome.state, 'done', 'a throwing listener cannot break the run');
      assert.deepStrictEqual(seen, ['started'], 'nothing arrives after unsubscribe');
    });
  });

  // -------------------------------------------------------------------------
  // The real-git end-to-end case
  // -------------------------------------------------------------------------

  describe('against a real temporary git repository', () => {
    const repos: string[] = [];

    /** Run git synchronously in `cwd`, throwing on non-zero exit. */
    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf8' });
    }

    function makeRepo(): string {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runpipe-git-'));
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.name', 'Baiton Test');
      git(repo, 'config', 'user.email', 'baiton-test@example.com');
      git(repo, 'checkout', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
      fs.mkdirSync(path.join(repo, '.baiton'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.baiton', '.gitignore'), GITIGNORE_CONTENTS);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'initial commit');
      repos.push(repo);
      return repo;
    }

    afterEach(() => {
      while (repos.length > 0) {
        fs.rmSync(repos.pop()!, { recursive: true, force: true });
      }
    });

    it('creates a real worktree, commits the execute with a Run-Id trailer, and leaves main alone', async () => {
      const repo = makeRepo();
      const service = createGitService(repo);
      const store = createRunStore({ workspaceRoot: repo });
      const adapter = new StubAdapter();
      const terminalHost = new StubTerminalHost();
      const watcherFactory = new StubWatcherFactory();
      const mainHeadBefore = (await service.branchHead('main'))!;
      const reports: string[] = [];

      const pipeline = createRunPipeline({
        workspaceRoot: repo,
        git: service,
        store,
        terminalHost,
        watcherFactory,
        modelForRole: () => ({ model: 'stub-model' }),
        adapterForRole: () => adapter,
        execAttempts: () => 2,
        newRunId: () => RUN_ID,
        newSessionId: () => '11111111-1111-4111-8111-111111111111',
        report: (m) => reports.push(m),
      });

      const started = await pipeline.start(bugRequest());
      assert.ok(started.ok, 'the run should start against a real repo');
      if (!started.ok) {
        return;
      }

      const worktree = path.join(repo, '.baiton', 'worktrees', RUN_ID);
      assert.ok(fs.existsSync(path.join(worktree, 'README.md')), 'the worktree is checked out');
      const worktreeBranch = execFileSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      assert.strictEqual(worktreeBranch, `baiton/bug/${RUN_ID}`);

      const waitFor = (index: number): Promise<void> =>
        waitUntil(
          () => watcherFactory.watchers.length > index,
          `watcher ${index} appearing (reports: ${JSON.stringify(reports)})`,
        );

      await waitFor(0);
      watcherFactory.watchers[0].emitResult(PLAN_RESULT);
      await waitFor(1);
      // The stub executor does real work in the worktree, so the commit is not
      // empty.
      fs.writeFileSync(path.join(worktree, 'src.txt'), 'the executor was here\n');
      watcherFactory.watchers[1].emitResult(EXECUTE_RESULT);
      await waitFor(2);
      watcherFactory.watchers[2].emitResult(REVIEW_PASS);

      const outcome = await started.completed;
      assert.strictEqual(outcome.state, 'done');
      assert.strictEqual(outcome.commits.length, 1);

      // The commit is on the run branch, carries the trailer, and is findable.
      const log = execFileSync('git', ['log', '-1', '--format=%B', `baiton/bug/${RUN_ID}`], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.ok(log.includes(`bug(${RUN_ID}): execute attempt 1`), log);
      assert.ok(log.includes(`Run-Id: ${RUN_ID}`), log);
      assert.strictEqual(await service.findCommitByRunId(RUN_ID), outcome.commits[0]);

      // `main` is untouched and nothing appeared under `.baiton/specs/`.
      assert.strictEqual(await service.branchHead('main'), mainHeadBefore);
      assert.ok(!fs.existsSync(path.join(repo, '.baiton', 'specs')));
      assert.ok(fs.existsSync(path.join(repo, '.baiton', 'runs', RUN_ID, 'plan.md')));
      assert.ok((await service.status()).clean, 'the main checkout stays clean');
    });
  });
});
