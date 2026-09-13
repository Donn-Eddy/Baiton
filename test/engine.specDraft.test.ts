import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createSpecDraftRunner } from '../src/engine/specDraft';
import type { SpecDraftOutcome } from '../src/engine/specDraft';
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
import { parseSpec } from '../src/model/parser';
import { validateSpec } from '../src/model/validator';
import { parseJournal } from '../src/journal';
import { Result, ok } from '../src/model/result';

/**
 * Unit tests for the spec-draft runner (the harness writes the spec).
 *
 * The agent boundary is stubbed exactly as the plan/execute/review integration
 * test stubs it — an inert adapter, a terminal that only records disposal, and
 * a result watcher the test drives directly — so the runner's real behaviour is
 * exercised without a Claude CLI, a terminal, or a VS Code host: the Brief is
 * written under `.baiton/runs/<runId>/`, the result is validated against the
 * spec-draft schema, the spec is rendered and committed, and the run is
 * journaled to the spec's `runs.jsonl`.
 */

/** A stub adapter whose probe verdict the test controls. */
class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  public launches: LaunchRequest[] = [];
  private readonly probeOk: boolean;
  constructor(probeOk = true) {
    this.probeOk = probeOk;
  }
  async probe(): Promise<ProbeResult> {
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
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createSpecBranch: async () => undefined,
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
function makeHarness(options: { probeOk?: boolean; commitFails?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-draft-'));
  const specsDir = path.join(root, '.baiton', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });

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

  const outcomes: SpecDraftOutcome[] = [];
  const reports: string[] = [];
  let queueRunning = false;

  const runner = createSpecDraftRunner({
    workspaceRoot: root,
    specsDir,
    adapter,
    terminalHost,
    watcherFactory,
    services,
    modelForRole: () => ({ model: 'writer-model', effort: 'high' }),
    isQueueRunning: () => queueRunning,
    newRunId: () => 'draft-run-1',
    newSessionId: () => '11111111-1111-4111-8111-111111111111',
    onComplete: (o) => outcomes.push(o),
    report: (m) => reports.push(m),
  });

  return {
    root,
    specsDir,
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
    specFile: (slug: string) => path.join(specsDir, slug, 'spec.md'),
    journal: (slug: string) => path.join(specsDir, slug, 'runs.jsonl'),
  };
}

/** A schema-conformant spec-draft result. */
const DRAFT_RESULT = JSON.stringify({
  overview: 'Add a greeting module and cover it with tests.',
  todos: [
    { title: 'Add the greeting function', files: ['src/greeting.ts'] },
    { title: 'Test the greeting function', after: ['1'], files: ['test/greeting.test.ts'] },
  ],
});

describe('spec-draft runner (unit)', () => {
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

  it('launches the spec writer, writes the brief, and returns the run id immediately', async () => {
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
    // the requirements, and the spec-draft schema.
    const brief = fs.readFileSync(
      path.join(h.root, '.baiton', 'runs', 'draft-run-1', 'brief.md'),
      'utf8',
    );
    assert.match(brief, /spec writer/i);
    assert.ok(brief.includes('Goal: add a greeting module.'));
    assert.ok(brief.includes('"todos"'));

    // The launch used the spec-writer role and the configured model.
    assert.deepStrictEqual(
      h.adapter.launches.map((l) => [l.role, l.model, l.effort]),
      [['spec-writer', 'writer-model', 'high']],
    );

    // The start is journaled before the result lands.
    const entries = parseJournal(h.journal('greeting'));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].stage, 'spec-draft');
    assert.strictEqual(entries[0].runId, 'draft-run-1');

    // Let the run finish so the harness is not left holding the lock.
    h.watcherFactory.watchers[0].emitResult(DRAFT_RESULT);
    await started.completed;
  });

  it('renders and commits a valid spec once the writer reports a result', async () => {
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
    assert.strictEqual(outcome.todoCount, 2);
    assert.strictEqual(outcome.specPath, '.baiton/specs/greeting/spec.md');

    const content = fs.readFileSync(h.specFile('greeting'), 'utf8');
    const spec = parseSpec(content);
    assert.deepStrictEqual(validateSpec(spec, content), [], 'the drafted spec must be valid');
    assert.deepStrictEqual(
      spec.todos.map((t) => [t.id, t.state, t.title]),
      [
        ['T01', 'pending', 'Add the greeting function'],
        ['T02', 'pending', 'Test the greeting function'],
      ],
    );
    // The 1-based position in the writer's list became the assigned id.
    assert.deepStrictEqual(spec.todos[1].after, ['T01']);
    assert.deepStrictEqual(spec.todos[0].files, ['src/greeting.ts']);
    assert.strictEqual((spec.frontmatter.get('status') ?? '').trim(), 'draft');

    // The spec was committed under the spec-folder commit convention.
    assert.deepStrictEqual(h.commits, ['spec(greeting): greeting draft spec']);

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
    h.watcherFactory.watchers[0].emitResult(JSON.stringify({ overview: 'missing todos' }));
    assert.strictEqual(h.runner.isRunning(), true, 'an invalid result keeps the run open');
    assert.strictEqual(h.reports.length, 2, 'each invalid result is surfaced');
    assert.ok(!fs.existsSync(h.specFile('greeting')), 'nothing is written while invalid');

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
    assert.ok(!fs.existsSync(h.specFile('greeting')), 'no spec is written on a failure');
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

  it('refuses a slug that already exists, without launching anything', async () => {
    const h = track(makeHarness());
    fs.mkdirSync(path.join(h.specsDir, 'greeting'), { recursive: true });
    fs.writeFileSync(path.join(h.specsDir, 'greeting', 'spec.md'), '# OVERVIEW\n', 'utf8');

    const started = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });

    assert.strictEqual(started.ok, false);
    if (!started.ok) {
      assert.strictEqual(started.error.kind, 'duplicate-slug');
    }
    assert.strictEqual(h.terminalHost.created.length, 0);
  });

  it('refuses while the todo-scoped queue is running, and vice versa', async () => {
    const h = track(makeHarness());
    h.setQueueRunning(true);

    const blocked = await h.runner.start({ slug: 'greeting', requirements: 'Goal: greet.' });
    assert.strictEqual(blocked.ok, false);
    if (!blocked.ok) {
      assert.strictEqual(blocked.error.kind, 'busy');
    }
    assert.strictEqual(h.terminalHost.created.length, 0);

    // With the queue idle the draft starts and then itself reports busy, which
    // is what the queue's `isExternallyBusy` hook reads.
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
});
