import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createStageLock } from '../src/activation/engineFacade';
import { createPlanDraftRunner, renderPlan, requirementsContext } from '../src/engine/planDraft';
import type { PlanDraftOutcome } from '../src/engine/planDraft';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../src/engine/terminalHost';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import type { Role } from '../src/model/role';
import type { GitService, GitStatus } from '../src/git';
import type { ToolServices } from '../src/orchestrator/toolServices';
import { parsePlan } from '../src/model/parser';
import { validatePlan } from '../src/model/validator';
import { parseJournal } from '../src/journal';
import { Result, ok } from '../src/model/result';

/**
 * Unit tests for the plan-draft runner (the harness writes the plan).
 *
 * The agent boundary is stubbed exactly as the plan/execute/review integration
 * test stubs it — an inert adapter, a terminal that only records disposal, and
 * a result watcher the test drives directly — so the runner's real behaviour is
 * exercised without a Claude CLI, a terminal, or a VS Code host: the Brief is
 * written under `.baiton/runs/<runId>/`, the result is validated against the
 * plan-draft schema, the plan is rendered and committed, and the run is
 * journaled to the plan's `runs.jsonl`.
 */

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

/** A git stub recording every commit message; `fail` makes commits throw. */
function recordingGit(commits: string[], fail = false): GitService {
  const boom = (name: string) => (): never => {
    throw new Error(`git.${name} must not be called on this path`);
  };
  return {
    status: async (): Promise<GitStatus> => ({ clean: true, changes: [] }),
    isCleanExceptPlanFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createPlanBranch: async () => undefined,
    checkout: async () => undefined,
    commit: async (message: string) => {
      if (fail) {
        throw new Error('nothing to commit');
      }
      commits.push(message);
      return 'c'.repeat(40);
    },
    head: async () => 'a'.repeat(40),
    currentBranch: async () => 'main',
    diff: boom('diff'),
    diffAgainstWorkingTree: boom('diffAgainstWorkingTree'),
    log: boom('log'),
    resetWorkingTree: async (): Promise<Result<void, never>> => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** A harness bundling the stubs and the runner under test. */
function makeHarness(
  options: { probeOk?: boolean; commitFails?: boolean; unknownAgent?: boolean; isQueueRunning?: () => boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-draft-'));
  const baitonDir = path.join(root, '.baiton');

  const adapter = new StubAdapter(options.probeOk ?? true);
  const terminalHost = new StubTerminalHost();
  const watcherFactory = new StubWatcherFactory();
  const commits: string[] = [];
  const services = {
    repoRoot: root,
    baitonDir: path.join(root, '.baiton'),
    git: recordingGit(commits, options.commitFails ?? false),
    confirm: { confirm: async () => true },
    runQueue: { dispatch: async () => ({ kind: 'busy' as const }) },
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  } as unknown as ToolServices;

  const outcomes: PlanDraftOutcome[] = [];
  const reports: string[] = [];
  let queueRunning = false;

  const runner = createPlanDraftRunner({
    workspaceRoot: root,
    terminalHost,
    watcherFactory,
    services,
    modelForRole: () => ({ model: 'writer-model', effort: 'high' }),
    adapterForRole: () => (options.unknownAgent ? undefined : adapter),
    isQueueRunning: () => options.isQueueRunning?.() ?? queueRunning,
    newRunId: () => 'draft-run-1',
    newSessionId: () => '11111111-1111-4111-8111-111111111111',
    onComplete: (o) => outcomes.push(o),
    report: (m) => reports.push(m),
  });

  return {
    root,
    baitonDir,
    adapter,
    terminalHost,
    watcherFactory,
    commits,
    outcomes,
    reports,
    runner,
    setQueueRunning: (v: boolean) => {
      queueRunning = v;
    },
    planFile: (slug: string) => path.join(baitonDir, 'plans', slug, 'plan.md'),
    legacySpecFile: (slug: string) => path.join(baitonDir, 'specs', slug, 'spec.md'),
    journal: (slug: string) => path.join(baitonDir, 'plans', slug, 'runs.jsonl'),
  };
}

/** A schema-conformant plan-draft result. */
const DRAFT_RESULT = JSON.stringify({
  endstate: 'A greeting module exists and is tested.',
  changes: 'Add src/greeting.ts and its test.',
  constraints: 'No new dependencies.',
  phases: [
    { title: 'Add the greeting function', files: ['src/greeting.ts'] },
    { title: 'Test the greeting function', after: ['1'], files: ['test/greeting.test.ts'] },
  ],
});

describe('plan-draft runner (unit)', () => {
  const roots: string[] = [];
  const track = <T extends { root: string }>(h: T): T => {
    roots.push(h.root);
    return h;
  };

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('adds repository context only when the plan can target multiple repos', () => {
    const requirements = 'Goal: update the API.';
    const baseline = requirementsContext(requirements);
    assert.strictEqual(requirementsContext(requirements, [{ path: '.', hasBaiton: true }]), baseline);
    const contextual = requirementsContext(requirements, [
      { path: '.', hasBaiton: true },
      { path: 'packages/api', hasBaiton: true },
    ]);
    assert.ok(contextual.includes('## Repositories'));
    assert.ok(contextual.includes('The plan is owned by `.`.'));
    assert.ok(contextual.includes('- `packages/api`'));
  });

  it('launches the plan writer, writes the brief, and returns the run id immediately', async () => {
    const h = track(makeHarness());

    const started = await h.runner.start({
      slug: 'greeting',
      requirements: 'Goal: add a greeting module.',
    });

    assert.ok(started.ok, 'the draft should start');
    if (!started.ok) {
      return;
    }
    assert.strictEqual(started.runId, 'draft-run-1');
    assert.strictEqual(h.runner.isRunning(), true, 'the runner holds the repo lock');

    // The brief landed under the fresh run directory and carries the role,
    // the requirements, and the plan-draft schema.
    const brief = fs.readFileSync(
      path.join(h.root, '.baiton', 'runs', 'draft-run-1', 'brief.md'),
      'utf8',
    );
    assert.match(brief, /plan writer/i);
    assert.ok(brief.includes('Goal: add a greeting module.'));
    assert.ok(brief.includes('"phases"'));
    assert.ok(brief.includes('"endstate"'));

    // The launch used the plan-writer role and the configured model.
    assert.deepStrictEqual(
      h.adapter.launches.map((l) => [l.role, l.model, l.effort]),
      [['plan-writer', 'writer-model', 'high']],
    );

    // The start is journaled before the result lands.
    const entries = parseJournal(h.journal('greeting'));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].stage, 'plan-draft');
    assert.strictEqual(entries[0].runId, 'draft-run-1');

    // Let the run finish so the harness is not left holding the lock.
    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    await started.completed;
  });

  it('writes and commits a valid plan once the writer reports a result', async () => {
    const h = track(makeHarness());
    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) {
      return;
    }

    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    const outcome = await started.completed;

    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.strictEqual(outcome.phaseCount, 2);
    assert.strictEqual(outcome.planPath, '.baiton/plans/greeting/plan.md');

    const content = fs.readFileSync(h.planFile('greeting'), 'utf8');
    const plan = parsePlan(content);
    assert.strictEqual(plan.kind, 'plan');
    assert.deepStrictEqual(validatePlan(plan, content), [], 'the drafted plan must be valid');
    assert.deepStrictEqual(
      plan.phases.map((phase) => [phase.id, phase.state, phase.title]),
      [
        ['P01', 'pending', 'Add the greeting function'],
        ['P02', 'pending', 'Test the greeting function'],
      ],
    );
    // The 1-based position in the writer's list became the assigned id.
    assert.deepStrictEqual(plan.phases[1].after, ['P01']);
    assert.deepStrictEqual(plan.phases[0].files, ['src/greeting.ts']);
    assert.strictEqual((plan.frontmatter.get('status') ?? '').trim(), 'draft');
    assert.ok(content.includes('# Endstate'));
    assert.ok(content.includes('A greeting module exists and is tested.'));
    assert.ok(content.includes('# What needs changing'));
    assert.ok(content.includes('Add src/greeting.ts and its test.'));
    assert.ok(content.includes('# Limitations & constraints'));
    assert.ok(content.includes('No new dependencies.'));

    // The plan was committed using its plan-draft commit message.
    assert.deepStrictEqual(h.commits, ['plan(greeting): greeting draft plan']);
    assert.ok(!fs.existsSync(path.join(h.baitonDir, 'specs')));

    // The run was journaled to completion and the lock released.
    const entries = parseJournal(h.journal('greeting'));
    assert.strictEqual(entries[0].result, 'completed');
    assert.strictEqual(h.runner.isRunning(), false);

    // The completion sink saw the same outcome (the chat feedback path).
    assert.deepStrictEqual(h.outcomes, [outcome]);
    // The terminal was disposed once a valid result landed.
    assert.strictEqual(h.terminalHost.created[0].disposeCount, 1);
  });

  it('keeps waiting through an invalid result and accepts a rewrite', async () => {
    const h = track(makeHarness());
    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) {
      return;
    }

    h.watcherFactory.watchers[0].emitResult('{ not json');
    h.watcherFactory.watchers[0].emitResult(JSON.stringify({ endstate: 'missing the rest' }));
    assert.strictEqual(h.runner.isRunning(), true, 'an invalid result keeps the run open');
    assert.strictEqual(h.reports.length, 2, 'each invalid result is surfaced');
    assert.ok(!fs.existsSync(h.planFile('greeting')), 'nothing is written while invalid');

    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    const outcome = await started.completed;
    assert.strictEqual(outcome.ok, true);
  });

  it('reports a failure and keeps the run directory when the terminal closes first', async () => {
    const h = track(makeHarness());
    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) {
      return;
    }

    h.watcherFactory.watchers[0].emitClose(1);
    const outcome = await started.completed;

    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /did not produce a result/i);
    }
    assert.ok(!fs.existsSync(h.planFile('greeting')), 'no plan is written on a failure');
    assert.ok(
      fs.existsSync(path.join(h.root, '.baiton', 'runs', 'draft-run-1', 'brief.md')),
      'a failed run keeps its run directory',
    );
    assert.strictEqual(h.runner.isRunning(), false, 'the lock is released on failure');
    assert.deepStrictEqual(h.outcomes, [outcome]);
  });

  it('reports a commit failure as a failed draft', async () => {
    const h = track(makeHarness({ commitFails: true }));
    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) {
      return;
    }

    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    const outcome = await started.completed;

    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /commit failed/i);
    }
  });

  it('refuses a slug with an existing plan, without launching anything', async () => {
    const h = track(makeHarness());
    fs.mkdirSync(path.dirname(h.planFile('greeting')), { recursive: true });
    fs.writeFileSync(h.planFile('greeting'), '# PHASES\n', 'utf8');

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });

    assert.strictEqual(started.ok, false);
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'duplicate-slug');
    }
    assert.strictEqual(h.terminalHost.created.length, 0);
  });

  it('refuses a slug with an existing legacy plan, without launching anything', async () => {
    const h = track(makeHarness());
    fs.mkdirSync(path.dirname(h.legacySpecFile('greeting')), { recursive: true });
    fs.writeFileSync(h.legacySpecFile('greeting'), '# OVERVIEW\n', 'utf8');

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });

    assert.strictEqual(started.ok, false);
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'duplicate-slug');
      assert.strictEqual(started.error.message, 'legacy spec "greeting" already exists');
    }
    assert.strictEqual(h.terminalHost.created.length, 0);
  });

  it('drafts under plans when a legacy plan directory only has a journal', async () => {
    const h = track(makeHarness());
    const legacyDir = path.dirname(h.legacySpecFile('greeting'));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'runs.jsonl'), '', 'utf8');

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) return;

    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    const outcome = await started.completed;
    assert.strictEqual(outcome.ok, true);
    assert.ok(fs.existsSync(h.planFile('greeting')));
    assert.ok(!fs.existsSync(h.legacySpecFile('greeting')));
    assert.ok(fs.existsSync(path.join(legacyDir, 'runs.jsonl')));
  });

  it('refuses while a planless run is in flight, and reports itself busy to it', async () => {
    const h = track(makeHarness());
    h.setQueueRunning(true);

    const blocked = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.strictEqual(blocked.ok, false);
    if (!blocked.ok) {
      assert.strictEqual(blocked.error.kind, 'busy');
    }
    assert.strictEqual(h.terminalHost.created.length, 0);

    // With the run idle the draft starts and then itself reports busy, which
    // is what the run pipeline's `isPlanBusy` hook reads.
    h.setQueueRunning(false);
    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok);
    if (!started.ok) {
      return;
    }
    assert.strictEqual(h.runner.isRunning(), true);
    const second = await h.runner.start({ slug: 'other', requirements: 'Goal: other.' });
    assert.strictEqual(second.ok, false);
    if (!second.ok) {
      assert.strictEqual(second.error.kind, 'busy');
    }

    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    await started.completed;
  });

  it('is not blocked by phase stages: only a planless run holds the lock', async () => {
    let runRunning = false;
    const phaseStageRunning = true; // deliberately not consulted by the lock
    // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
    let h!: ReturnType<typeof makeHarness>;
    const lock = createStageLock({
      planDraftRunning: () => h.runner.isRunning(),
      runRunning: () => runRunning,
    });
    h = track(makeHarness({ isQueueRunning: () => lock.planDraftBusy() }));
    assert.strictEqual(phaseStageRunning, true);

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.ok(started.ok, 'a running phase stage does not block the draft');
    if (!started.ok) {
      return;
    }
    assert.strictEqual(lock.runPipelineBusy(), true, 'the running draft blocks a planless run');
    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    await started.completed;
    assert.strictEqual(lock.runPipelineBusy(), false);

    // A planless run in flight does block it, before any terminal is created.
    // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
    let blockedHarness!: ReturnType<typeof makeHarness>;
    const blockedLock = createStageLock({
      planDraftRunning: () => blockedHarness.runner.isRunning(),
      runRunning: () => runRunning,
    });
    blockedHarness = track(makeHarness({ isQueueRunning: () => blockedLock.planDraftBusy() }));
    runRunning = true;
    const blocked = await blockedHarness.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.strictEqual(blocked.ok, false);
    if (!blocked.ok) {
      assert.strictEqual(blocked.error.kind, 'busy');
    }
    assert.strictEqual(blockedHarness.terminalHost.created.length, 0);
  });

  it('refuses when the adapter probe fails, before launching', async () => {
    const h = track(makeHarness({ probeOk: false }));

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });

    assert.strictEqual(started.ok, false);
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'probe-failed');
      assert.match(started.error.message, /the CLI was not found/);
    }
    assert.strictEqual(h.terminalHost.created.length, 0);
    assert.ok(!fs.existsSync(path.join(h.root, '.baiton', 'runs')), 'no run directory is created');
  });

  it('refuses an invalid slug', async () => {
    const h = track(makeHarness());
    const started = await h.runner.start({ slug: '../escape', requirements: 'Goal: greet.' });
    assert.strictEqual(started.ok, false);
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'invalid-slug');
    }
  });

  it('refuses with unknown-agent when adapterForRole returns undefined, before probing or launching (Req 14.1)', async () => {
    const h = track(makeHarness({ unknownAgent: true }));

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });

    assert.strictEqual(started.ok, false, 'an unknown agent id must refuse the draft');
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'unknown-agent');
      assert.match(started.error.message, /plan-writer/);
      assert.match(started.error.message, /roles\.plan-writer\.agent/);
      assert.match(started.error.message, /\.baiton\/config\.json/);
    }
    assert.strictEqual(h.adapter.probeCount, 0, 'no probe runs for an unknown agent');
    assert.strictEqual(h.terminalHost.created.length, 0, 'no terminal is created for an unknown agent');
  });
});

describe('renderPlan', () => {
  it('numbers phases, maps only earlier dependencies, and drops blank files', () => {
    const content = renderPlan(
      'example',
      { endstate: 'Done.', changes: 'Make changes.', constraints: 'Keep rules.' },
      [
        { title: 'First', after: ['1', '10', '0', 'bad'], files: ['', '   '] },
        { title: 'Second', after: ['1', '2', '3', '99', '1'], files: ['src/two.ts', ' '] },
        ...Array.from({ length: 8 }, (_, index) => `Phase ${index + 3}`),
      ],
    );
    const plan = parsePlan(content);

    assert.strictEqual(plan.kind, 'plan');
    assert.deepStrictEqual(validatePlan(plan, content), []);
    assert.strictEqual(plan.phases.length, 10);
    assert.strictEqual(plan.phases[9].id, 'P10');
    assert.deepStrictEqual(plan.phases[0].after, []);
    assert.deepStrictEqual(plan.phases[0].files, []);
    assert.deepStrictEqual(plan.phases[1].after, ['P01']);
    assert.deepStrictEqual(plan.phases[1].files, ['src/two.ts']);
  });

  it('renders a child repo hint last and keeps owner or blank repo values implicit', () => {
    const content = renderPlan(
      'example',
      { endstate: 'Done.', changes: 'Make changes.', constraints: 'Keep rules.' },
      [
        'First',
        { title: 'Second', after: ['1'], files: ['a.ts'], repo: 'packages/api' },
        { title: 'Owner repo', repo: '.' },
        { title: 'Blank repo', repo: '  ' },
      ],
    );
    assert.ok(content.includes('- [pending] P02 Second (after P01; files: a.ts; repo: packages/api)'));
    assert.ok(content.includes('- [pending] P03 Owner repo\n'));
    assert.ok(content.includes('- [pending] P04 Blank repo\n'));
    assert.strictEqual(parsePlan(content).phases[1].repo, 'packages/api');
    assert.strictEqual(parsePlan(content).phases[0].repo, undefined);
  });
});
