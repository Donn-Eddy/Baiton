import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createPhaseQueues,
  dispatchTrigger,
  phaseQueueKey,
  type PhaseQueueOwner,
} from '../src/activation/engineFacade';
import {
  createRepoLocks,
  createRunQueue,
  type QueueWorktreeSeam,
  type RepoLocks,
  type RunQueueDeps,
  type ResultWatcherFactory,
  type PlanStore,
} from '../src/engine/runQueue';
import type { GitWorktreeService } from '../src/git';
import { createPlanBranchWriter } from '../src/engine/planBranchWriter';
import { createPlanDraftRunner } from '../src/engine/planDraft';
import { createRunPipeline } from '../src/engine/runPipeline';
import type { RunPipelineDeps } from '../src/engine/runPipeline';
import type { RunStore } from '../src/engine/runStore';
import type { ToolServices } from '../src/orchestrator';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import { ClaudeAdapter } from '../src/adapter/claude';
import { CodexAdapter } from '../src/adapter/codex';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { Role } from '../src/model/role';
import {
  appendCompletion,
  appendStart,
  readPlanJournal,
  planJournalPathFor,
  phaseJournalPathFor,
} from '../src/journal';
import { ok } from '../src/model/result';

/**
 * The engine facade resumes the executor by Session_Id.
 *
 * For a second `execute` dispatch on a phase, `dispatchTrigger` reads the same
 * parsed journal it uses for the attempt count and, via `latestStart`, finds
 * the phase's most recent execute start. When that start recorded a
 * Session_Id, the facade carries it as `resumeSessionId` on the `RunRequest`
 * so the launched CLI leads with `--resume <id>` (Requirement 3.2); when the
 * prior start has no Session_Id, the launch falls back to `-c`.
 *
 * Task 1 (codex resume) narrows that: only a CLI whose adapter reports
 * `acceptsSessionId` honours the id Baiton pre-assigned. codex mints its own,
 * so its journal `sessionId` names no session it knows and `codex resume
 * <that uuid>` fails before a session exists — the facade must therefore launch
 * a codex executor fresh on attempt 2 and only resume once a real id has been
 * discovered and journaled as `discoveredSessionId`.
 *
 * The test runs the real `RunQueue` + `ClaudeAdapter`/`CodexAdapter` over
 * stubbed terminal/watcher/git/plan-store dependencies and inspects the actual
 * `shellArgs` the terminal host was asked to launch.
 */

/** A no-op terminal double; supports the full `HostTerminal` seam. */
function makeTerminal(): HostTerminal {
  return {
    sendText(): void {
      /* no-op */
    },
    dispose(): void {
      /* no-op */
    },
    processId: Promise.resolve(undefined),
    show(): void {
      /* no-op */
    },
  };
}

/** A terminal host that records every launch's shellArgs, in dispatch order. */
function makeTerminalHost(): TerminalHost & { launches: CreateTerminalOptions[] } {
  const launches: CreateTerminalOptions[] = [];
  return {
    launches,
    createTerminal(options: CreateTerminalOptions): HostTerminal {
      launches.push(options);
      return makeTerminal();
    },
  };
}

/** A watcher factory that immediately completes every execute with a valid result. */
function makeCompletingWatcherFactory(): ResultWatcherFactory {
  return {
    create(): ResultWatcher {
      let resultListener: ((raw: string) => void) | undefined;
      return {
        onResult(listener): () => void {
          resultListener = listener;
          setImmediate(() => {
            resultListener?.(
              JSON.stringify({
                summary: 'done',
                files_changed: [],
                commands_run: [],
                notes: [],
              }),
            );
          });
          return () => {
            resultListener = undefined;
          };
        },
        onTerminalClose(): () => void {
          return () => {};
        },
        dispose(): void {
          resultListener = undefined;
        },
      };
    },
  };
}

/** A git stub: clean tree, stable HEAD/branch, successful commit/reset. */
function makeGit(): GitService {
  return {
    status: async () => ({ clean: true, changes: [] }),
    isCleanExceptPlanFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createPlanBranch: async () => {},
    checkout: async () => {},
    commit: async () => 'commit-sha',
    head: async () => 'head-sha',
    currentBranch: async () => 'spec/branch',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async () => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** A plan store that keeps every `execute` transition legal, regardless of history. */
const planStore: PlanStore = {
  currentState: async () => 'planned',
  // Every phase has a plan on file, so the Execute brief can be assembled; the
  // plan itself is not needed for what this test observes.
  readPlan: async () => undefined,
  readArtifact: async () => '# Plan P01\n',
  latestExecuteCommit: async () => undefined,
  isApproved: async () => true,
  isBlocked: async () => false,
  inputRevMatches: async () => true,
  inputRev: async () => 'rev-0',
  writeState: async () => true,
};

/**
 * A real adapter with its probe stubbed ok, so the launch args under test are
 * the genuine ones while the test never spawns a CLI. `discoverSessionId` is
 * deliberately not forwarded: the facade's behaviour here is driven by what
 * the journal already records, not by scanning a real `~/.codex`.
 */
function withStubbedProbe(inner: Adapter): Adapter {
  return {
    id: inner.id,
    acceptsSessionId: inner.acceptsSessionId,
    probe: async () => ({ version: 'stub', ok: true }),
    launch: (req) => inner.launch(req),
    attach: (req) => inner.attach(req),
  };
}

/** Yield control so queued microtasks (the deferred result emission) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('engine facade: executor resume by Session_Id (Req 3.2)', () => {
  let tmpDir: string;
  let legacySpecsDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-resume-'));
    legacySpecsDir = path.join(tmpDir, '.baiton', 'specs');
    fs.mkdirSync(path.join(legacySpecsDir, 'demo'), { recursive: true });
    journalPath = path.join(legacySpecsDir, 'demo', 'runs.jsonl');
  });

  it('carries --resume <prior id> on the second execute for a phase with a recorded session', async () => {
    const terminalHost = makeTerminalHost();
    let sessionCounter = 0;
    const deps: RunQueueDeps = {
      workspaceRoot: tmpDir,
      adapterForRole: () => new ClaudeAdapter(),
      git: makeGit(),
      terminalHost,
      watcherFactory: makeCompletingWatcherFactory(),
      planStore,
      journalPath,
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
      newSessionId: () => `session-${sessionCounter++}`,
    };
    const queue = createRunQueue(deps);

    const first = await dispatchTrigger(
      queue,
      path.dirname(legacySpecsDir),
      { kind: 'stage', slug: 'demo', phaseId: 't1', stage: 'execute' },
      deps.adapterForRole,
    );
    assert.strictEqual(first.ok, true, `first execute dispatch should succeed: ${JSON.stringify(first)}`);
    await flush();

    const second = await dispatchTrigger(
      queue,
      path.dirname(legacySpecsDir),
      { kind: 'stage', slug: 'demo', phaseId: 't1', stage: 'execute' },
      deps.adapterForRole,
    );
    assert.strictEqual(second.ok, true, `second execute dispatch should succeed: ${JSON.stringify(second)}`);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 2);
    const secondArgs = terminalHost.launches[1].shellArgs;
    assert.deepStrictEqual(
      secondArgs.slice(0, 2),
      ['--resume', 'session-0'],
      `second execute must resume the first start's session: ${JSON.stringify(secondArgs)}`,
    );
    assert.ok(!secondArgs.includes('-c'));
  });

  it('falls back to -c when the prior execute start has no recorded Session_Id', async () => {
    // Fixture: a prior execute start for t2 written before Session_Id existed.
    appendStart(journalPath, {
      runId: 'run-legacy',
      phaseId: 't2',
      stage: 'execute',
      attempt: 1,
      startHead: 'head-0',
      inputRev: 'rev-0',
      // sessionId intentionally omitted.
    });

    const terminalHost = makeTerminalHost();
    const deps: RunQueueDeps = {
      workspaceRoot: tmpDir,
      adapterForRole: () => new ClaudeAdapter(),
      git: makeGit(),
      terminalHost,
      watcherFactory: makeCompletingWatcherFactory(),
      planStore,
      journalPath,
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
    };
    const queue = createRunQueue(deps);

    const result = await dispatchTrigger(
      queue,
      path.dirname(legacySpecsDir),
      { kind: 'stage', slug: 'demo', phaseId: 't2', stage: 'execute' },
      deps.adapterForRole,
    );
    assert.strictEqual(result.ok, true, `execute dispatch should succeed: ${JSON.stringify(result)}`);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 1);
    const args = terminalHost.launches[0].shellArgs;
    assert.strictEqual(
      args[0],
      '-c',
      `resume with no recorded session must fall back to -c: ${JSON.stringify(args)}`,
    );
    assert.ok(!args.includes('--resume'));
  });
});

describe('repo locks', () => {
  it('locks canonical roots independently and protects a re-acquired lock from a stale release', () => {
    const locks = createRepoLocks();
    const a = locks.tryAcquire('/w/a', 'plan-draft');
    assert.ok(a);
    assert.strictEqual(locks.tryAcquire('/w/a', 'run-pipeline'), undefined);
    assert.strictEqual(locks.tryAcquire('/w/a/./', 'run-pipeline'), undefined);
    assert.strictEqual(locks.holder('/w/a'), 'plan-draft');

    const b = locks.tryAcquire('/w/b', 'run-pipeline');
    const parent = locks.tryAcquire('/w', 'plan-draft');
    const child = locks.tryAcquire('/w/packages/api', 'run-pipeline');
    assert.ok(b && parent && child);
    assert.deepStrictEqual(locks.heldRepos(), ['/w/a', '/w/b', '/w', '/w/packages/api']);

    a.release();
    assert.strictEqual(locks.isHeld('/w/a'), false);
    const stale = locks.tryAcquire('/w/a', 'run-pipeline');
    assert.ok(stale);
    a.release();
    assert.strictEqual(locks.holder('/w/a'), 'run-pipeline');
    stale.release();
    assert.strictEqual(locks.isHeld('/w/a'), false);
    b.release();
    parent.release();
    child.release();
  });
});

describe('phase queues keyed by owning repo', () => {
  it('scopes queue identity, live status and journals to each owner', async () => {
    const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-owner-default-'));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-owner-other-'));
    const defaultBaitonDir = path.join(defaultRoot, '.baiton');
    const otherBaitonDir = path.join(otherRoot, '.baiton');
    fs.mkdirSync(defaultBaitonDir, { recursive: true });
    fs.mkdirSync(otherBaitonDir, { recursive: true });

    const defaultGit = { ...makeGit(), commitPaths: async () => 'commit' } as unknown as GitWorktreeService;
    const otherGit = { ...makeGit(), commitPaths: async () => 'commit' } as unknown as GitWorktreeService;
    const defaultWriter = createPlanBranchWriter({ baitonDir: defaultBaitonDir, git: defaultGit });
    const otherWriter = createPlanBranchWriter({ baitonDir: otherBaitonDir, git: otherGit });
    let resultListener: ((raw: string) => void) | undefined;
    let onResultReady!: () => void;
    const resultReady = new Promise<void>((resolve) => {
      onResultReady = resolve;
    });
    const watcherFactory: ResultWatcherFactory = {
      create(): ResultWatcher {
        return {
          onResult(listener): () => void {
            resultListener = listener;
            onResultReady();
            return () => {
              resultListener = undefined;
            };
          },
          onTerminalClose(): () => void {
            return () => {};
          },
          dispose(): void {
            resultListener = undefined;
          },
        };
      },
    };
    const worktreesFor = (root: string, git: GitWorktreeService): QueueWorktreeSeam => ({
      ensure: async () => ok({ dir: root, git }),
      unlanded: async () => [],
    });
    const otherOwner: PhaseQueueOwner = {
      workspaceRoot: otherRoot,
      baitonDir: otherBaitonDir,
      git: otherGit,
      planWriter: otherWriter,
      planStore,
      worktrees: worktreesFor(otherRoot, otherGit),
    };
    const queues = createPhaseQueues({
      workspaceRoot: defaultRoot,
      baitonDir: defaultBaitonDir,
      git: defaultGit,
      planWriter: defaultWriter,
      worktrees: worktreesFor(defaultRoot, defaultGit),
      planStore,
      terminalHost: makeTerminalHost(),
      watcherFactory,
      modelForRole: () => ({ model: 'test-model' }),
      adapterForRole: () => withStubbedProbe(new ClaudeAdapter()),
      report: () => {},
      owners: (root) => (path.resolve(root) === otherRoot ? otherOwner : undefined),
    });

    const defaultQueue = queues.queueFor('demo', 'P01');
    assert.strictEqual(queues.queueFor('demo', 'P01', defaultRoot), defaultQueue);
    assert.strictEqual(queues.find('demo', 'P01', otherRoot), undefined);
    const otherQueue = queues.queueFor('demo', 'P01', otherRoot);
    assert.notStrictEqual(otherQueue, defaultQueue);
    assert.throws(() => queues.queueFor('demo', 'P01', '/unknown'), /unknown owning repo/);
    assert.notStrictEqual(phaseQueueKey(defaultRoot, 'demo', 'P01'), phaseQueueKey(otherRoot, 'demo', 'P01'));
    assert.strictEqual(phaseQueueKey(otherRoot, 'demo', 'P01'), phaseQueueKey(`${otherRoot}/./`, 'demo', 'P01'));

    const dispatch = otherQueue.dispatch({
      slug: 'demo',
      phaseId: 'P01',
      action: 'execute',
      role: 'executor',
      attempt: 1,
      resume: false,
    });
    await resultReady;
    assert.strictEqual(queues.isRunning('demo', otherRoot), true);
    assert.strictEqual(queues.isRunning('demo', defaultRoot), false);
    assert.strictEqual(queues.isRunning('demo'), true);
    assert.strictEqual(queues.running()[0].repo, path.resolve(otherRoot));
    const otherJournal = phaseJournalPathFor(otherBaitonDir, 'demo', 'P01');
    const defaultJournal = phaseJournalPathFor(defaultBaitonDir, 'demo', 'P01');
    assert.ok(fs.existsSync(otherJournal));
    assert.ok(!fs.existsSync(defaultJournal));
    assert.ok(readPlanJournal(otherBaitonDir, 'demo').some((entry) => entry.phaseId === 'P01'));

    resultListener?.(JSON.stringify({ summary: 'done', files_changed: [], commands_run: [], notes: [] }));
    await dispatch;
    assert.strictEqual(queues.isRunning('demo', otherRoot), false);
  });
});

describe('plan draft and run pipeline share the per-repo lock', () => {
  it('refuses a same-repo lock, ignores another repo lock, and releases after a post-lock refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-draft-lock-'));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-draft-other-'));
    const baitonDir = path.join(root, '.baiton');
    fs.mkdirSync(baitonDir, { recursive: true });
    const repoLocks: RepoLocks = createRepoLocks();
    const adapter = new ClaudeAdapter();
    adapter.probe = async () => ({ version: 'stub', ok: false, reason: 'unavailable' });
    const runner = createPlanDraftRunner({
      workspaceRoot: root,
      terminalHost: makeTerminalHost(),
      watcherFactory: makeCompletingWatcherFactory(),
      services: { baitonDir } as unknown as ToolServices,
      modelForRole: () => ({ model: 'test-model' }),
      adapterForRole: () => adapter,
      repoLocks,
    });

    const runLease = repoLocks.tryAcquire(root, 'run-pipeline');
    assert.ok(runLease);
    const blocked = await runner.start({ slug: 'same-repo', requirements: 'Goal: run.' });
    assert.strictEqual(blocked.ok, false);
    if (!blocked.ok) assert.strictEqual(blocked.error.kind, 'busy');
    runLease.release();

    const otherLease = repoLocks.tryAcquire(otherRoot, 'run-pipeline');
    assert.ok(otherLease);
    const probeRefusal = await runner.start({ slug: 'probe-fails', requirements: 'Goal: draft.' });
    assert.strictEqual(probeRefusal.ok, false);
    if (!probeRefusal.ok) assert.strictEqual(probeRefusal.error.kind, 'probe-failed');
    assert.strictEqual(repoLocks.isHeld(root), false, 'post-acquisition refusal releases the draft lock');
    assert.strictEqual(repoLocks.isHeld(otherRoot), true, 'another repo keeps its own lock');
    otherLease.release();
  });

  it('makes the pipeline refuse its own repo lock and release after detached-head refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-pipeline-lock-'));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-pipeline-other-'));
    const repoLocks = createRepoLocks();
    const git = {
      ...makeGit(),
      currentBranch: async () => 'HEAD',
    } as unknown as GitWorktreeService;
    const deps: RunPipelineDeps = {
      workspaceRoot: root,
      git,
      store: {} as RunStore,
      terminalHost: makeTerminalHost(),
      watcherFactory: makeCompletingWatcherFactory(),
      modelForRole: () => ({ model: 'test-model' }),
      adapterForRole: () => undefined,
      repoLocks,
    };
    const pipeline = createRunPipeline(deps);
    const draftLease = repoLocks.tryAcquire(root, 'plan-draft');
    assert.ok(draftLease);
    const blocked = await pipeline.start({
      mode: 'investigate',
      composerMode: 'default',
      explicitMode: true,
      statement: 'Question',
      files: [],
    });
    assert.strictEqual(blocked.ok, false);
    if (!blocked.ok) assert.strictEqual(blocked.error.kind, 'busy');
    draftLease.release();

    const otherLease = repoLocks.tryAcquire(otherRoot, 'plan-draft');
    assert.ok(otherLease);
    const detached = await pipeline.start({
      mode: 'investigate',
      composerMode: 'default',
      explicitMode: true,
      statement: 'Question',
      files: [],
    });
    assert.strictEqual(detached.ok, false);
    if (!detached.ok) assert.strictEqual(detached.error.kind, 'detached-head');
    assert.strictEqual(repoLocks.isHeld(root), false, 'post-acquisition refusal releases the pipeline lock');
    assert.strictEqual(repoLocks.isHeld(otherRoot), true, 'another repo keeps its own lock');
    otherLease.release();
  });
});

/**
 * Task 1 — a CLI that mints its own session id is never resumed with Baiton's.
 *
 * The journal's `sessionId` is a UUID Baiton generated. codex ignores it on a
 * fresh launch (see the CodexAdapter degrade notes), so resuming with it runs
 * `codex resume <uuid>`, which prints "No saved session found with ID <uuid>"
 * and exits 1 before any session exists — the run is journaled `closed (exit
 * 1)` and the phase reverts. Attempt 2 must therefore launch fresh; the retry
 * brief still carries the latest review. Once a real id has been discovered for
 * a prior run and journaled as `discoveredSessionId`, that id — and only that
 * id — is resumable.
 */
describe('engine facade: adapters that mint their own session id (Req 3.2)', () => {
  let tmpDir: string;
  let legacySpecsDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-resume-codex-'));
    legacySpecsDir = path.join(tmpDir, '.baiton', 'specs');
    fs.mkdirSync(path.join(legacySpecsDir, 'demo'), { recursive: true });
    journalPath = path.join(legacySpecsDir, 'demo', 'runs.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a queue whose every role runs on the given adapter. */
  function makeQueue(adapter: Adapter): {
    queue: ReturnType<typeof createRunQueue>;
    terminalHost: ReturnType<typeof makeTerminalHost>;
    adapterForRole: () => Adapter;
  } {
    const terminalHost = makeTerminalHost();
    let sessionCounter = 0;
    const adapterForRole = (): Adapter => adapter;
    const deps: RunQueueDeps = {
      workspaceRoot: tmpDir,
      adapterForRole,
      git: makeGit(),
      terminalHost,
      watcherFactory: makeCompletingWatcherFactory(),
      planStore,
      journalPath,
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
      newSessionId: () => `baiton-session-${sessionCounter++}`,
    };
    return { queue: createRunQueue(deps), terminalHost, adapterForRole };
  }

  it('launches a codex executor fresh on attempt 2 instead of resuming Baiton\'s unusable id', async () => {
    const { queue, terminalHost, adapterForRole } = makeQueue(
      withStubbedProbe(new CodexAdapter()),
    );
    const trigger = { kind: 'stage', slug: 'demo', phaseId: 't1', stage: 'execute' } as const;

    const first = await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    assert.strictEqual(first.ok, true, `first execute should succeed: ${JSON.stringify(first)}`);
    await flush();

    const second = await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    assert.strictEqual(second.ok, true, `second execute should succeed: ${JSON.stringify(second)}`);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 2);
    const secondArgs = terminalHost.launches[1].shellArgs;
    assert.ok(
      !secondArgs.includes('resume'),
      `codex must not resume Baiton's pre-assigned id: ${JSON.stringify(secondArgs)}`,
    );
    assert.ok(
      !secondArgs.some((arg) => arg.startsWith('baiton-session-')),
      `no journaled session id may reach the command line: ${JSON.stringify(secondArgs)}`,
    );
    // A fresh launch carries the brief prompt (the `resume --last` branch drops it).
    assert.strictEqual(secondArgs[secondArgs.length - 2], '--');
  });

  it('resumes a codex executor with the session id discovered for the prior run', async () => {
    // Fixture: a prior execute whose real codex session was recovered after the
    // run settled and journaled on its completion record.
    appendStart(journalPath, {
      runId: 'run-prior',
      phaseId: 't3',
      stage: 'execute',
      attempt: 1,
      startHead: 'head-0',
      inputRev: 'rev-0',
      sessionId: 'baiton-minted-uuid',
    });
    appendCompletion(journalPath, {
      runId: 'run-prior',
      result: 'closed',
      discoveredSessionId: 'codex-real-session',
    });

    const { queue, terminalHost, adapterForRole } = makeQueue(
      withStubbedProbe(new CodexAdapter()),
    );
    const result = await dispatchTrigger(
      queue,
      path.dirname(legacySpecsDir),
      { kind: 'stage', slug: 'demo', phaseId: 't3', stage: 'execute' },
      adapterForRole,
    );
    assert.strictEqual(result.ok, true, `execute dispatch should succeed: ${JSON.stringify(result)}`);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 1);
    const args = terminalHost.launches[0].shellArgs;
    assert.deepStrictEqual(
      args.slice(0, 2),
      ['resume', 'codex-real-session'],
      `the discovered id is the one resumed: ${JSON.stringify(args)}`,
    );
    assert.ok(!args.includes('baiton-minted-uuid'));
  });

  it('journals the id the adapter discovers for a run and resumes it next time', async () => {
    // End-to-end of the recovery path: the queue asks the adapter for the id
    // the CLI minted once the run settles, journals it on the completion
    // record, and the facade resumes with it on the next Execute.
    const codex = withStubbedProbe(new CodexAdapter());
    const adapter: Adapter = {
      ...codex,
      discoverSessionId: async ({ runId }) => `codex-session-for-${runId}`,
    };
    const { queue, terminalHost, adapterForRole } = makeQueue(adapter);
    const trigger = { kind: 'stage', slug: 'demo', phaseId: 't5', stage: 'execute' } as const;

    await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    await flush();
    await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    await flush();

    const journal = fs.readFileSync(journalPath, 'utf8');
    assert.match(journal, /"discoveredSessionId":"codex-session-for-demo-t5-execute-1-/);

    assert.strictEqual(terminalHost.launches.length, 2);
    const args = terminalHost.launches[1].shellArgs;
    assert.strictEqual(args[0], 'resume');
    assert.ok(
      args[1].startsWith('codex-session-for-demo-t5-execute-1-'),
      `the discovered id is resumed: ${JSON.stringify(args)}`,
    );
  });

  it('keeps the claude executor resuming its pre-assigned id on attempt 2', async () => {
    // The same rig with an adapter that accepts session ids: unchanged behaviour.
    const { queue, terminalHost, adapterForRole } = makeQueue(
      withStubbedProbe(new ClaudeAdapter()),
    );
    const trigger = { kind: 'stage', slug: 'demo', phaseId: 't4', stage: 'execute' } as const;

    await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    await flush();
    await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 2);
    assert.deepStrictEqual(terminalHost.launches[1].shellArgs.slice(0, 2), [
      '--resume',
      'baiton-session-0',
    ]);
  });
});

describe('engine facade: per-phase journals (sub-agent chats)', () => {
  let tmpDir: string;
  let legacySpecsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-resume-pertodo-'));
    legacySpecsDir = path.join(tmpDir, '.baiton', 'specs');
    fs.mkdirSync(path.join(legacySpecsDir, 'demo'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeQueue(): {
    queue: ReturnType<typeof createRunQueue>;
    terminalHost: ReturnType<typeof makeTerminalHost>;
    adapterForRole: () => Adapter;
  } {
    const terminalHost = makeTerminalHost();
    let sessionCounter = 0;
    const adapterForRole = (): Adapter => new ClaudeAdapter();
    const deps: RunQueueDeps = {
      workspaceRoot: tmpDir,
      adapterForRole,
      git: makeGit(),
      terminalHost,
      watcherFactory: makeCompletingWatcherFactory(),
      planStore,
      journalPath: planJournalPathFor(path.dirname(legacySpecsDir), 'demo'),
      journalPathFor: (id) => phaseJournalPathFor(path.dirname(legacySpecsDir), 'demo', id),
      readJournal: () => readPlanJournal(path.dirname(legacySpecsDir), 'demo'),
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
      newSessionId: () => `session-${sessionCounter++}`,
    };
    return { queue: createRunQueue(deps), terminalHost, adapterForRole };
  }

  it('journals to phases/<id>/runs.jsonl and resumes on the second execute', async () => {
    const { queue, terminalHost, adapterForRole } = makeQueue();
    const trigger = { kind: 'stage', slug: 'demo', phaseId: 't1', stage: 'execute' } as const;
    assert.strictEqual((await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole)).ok, true);
    await flush();
    assert.strictEqual((await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole)).ok, true);
    await flush();

    assert.deepStrictEqual(terminalHost.launches[1].shellArgs.slice(0, 2), ['--resume', 'session-0']);
    const phaseJournalFile = phaseJournalPathFor(path.dirname(legacySpecsDir), 'demo', 't1');
    assert.ok(fs.existsSync(phaseJournalFile));
    assert.ok(!fs.existsSync(planJournalPathFor(path.dirname(legacySpecsDir), 'demo')));
    assert.strictEqual(readPlanJournal(path.dirname(legacySpecsDir), 'demo').length, 2);
  });

  it('resumes a session recorded in a legacy plan-level journal', async () => {
    appendStart(planJournalPathFor(path.dirname(legacySpecsDir), 'demo'), {
      runId: 'run-legacy',
      phaseId: 't6',
      stage: 'execute',
      attempt: 1,
      startHead: 'h',
      inputRev: 'r',
      sessionId: 'legacy-session',
    });
    const { queue, terminalHost, adapterForRole } = makeQueue();
    const trigger = { kind: 'stage', slug: 'demo', phaseId: 't6', stage: 'execute' } as const;
    assert.strictEqual((await dispatchTrigger(queue, path.dirname(legacySpecsDir), trigger, adapterForRole)).ok, true);
    await flush();

    assert.deepStrictEqual(terminalHost.launches[0].shellArgs.slice(0, 2), ['--resume', 'legacy-session']);
    const entries = readPlanJournal(path.dirname(legacySpecsDir), 'demo').filter((e) => e.phaseId === 't6');
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].attempt, 2);
  });
});
