import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dispatchTrigger } from '../src/activation/engineFacade';
import {
  createRunQueue,
  type RunQueueDeps,
  type ResultWatcherFactory,
  type SpecStore,
} from '../src/engine/runQueue';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import { ClaudeAdapter } from '../src/adapter/claude';
import { CodexAdapter } from '../src/adapter/codex';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { Role } from '../src/model/role';
import { appendCompletion, appendStart } from '../src/journal';
import { ok } from '../src/model/result';

/**
 * Task 3.4 — the engine facade resumes the executor by Session_Id.
 *
 * For a second `execute` dispatch on a todo, `dispatchTrigger` reads the same
 * parsed journal it uses for the attempt count and, via `latestStart`, finds
 * the todo's most recent execute start. When that start recorded a
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
 * stubbed terminal/watcher/git/spec-store dependencies and inspects the actual
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
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createSpecBranch: async () => {},
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

/** A spec store that keeps every `execute` transition legal, regardless of history. */
const specStore: SpecStore = {
  currentState: async () => 'planned',
  // Every todo has a plan on file, so the Execute brief can be assembled; the
  // spec itself is not needed for what this test observes.
  readSpec: async () => undefined,
  readArtifact: async () => '# Plan T01\n',
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
  let specsDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-resume-'));
    specsDir = path.join(tmpDir, '.baiton', 'specs');
    fs.mkdirSync(path.join(specsDir, 'demo'), { recursive: true });
    journalPath = path.join(specsDir, 'demo', 'runs.jsonl');
  });

  it('carries --resume <prior id> on the second execute for a todo with a recorded session', async () => {
    const terminalHost = makeTerminalHost();
    let sessionCounter = 0;
    const deps: RunQueueDeps = {
      workspaceRoot: tmpDir,
      adapterForRole: () => new ClaudeAdapter(),
      git: makeGit(),
      terminalHost,
      watcherFactory: makeCompletingWatcherFactory(),
      specStore,
      journalPath,
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
      newSessionId: () => `session-${sessionCounter++}`,
    };
    const queue = createRunQueue(deps);

    const first = await dispatchTrigger(
      queue,
      specsDir,
      { kind: 'stage', slug: 'demo', todoId: 't1', stage: 'execute' },
      deps.adapterForRole,
    );
    assert.strictEqual(first.ok, true, `first execute dispatch should succeed: ${JSON.stringify(first)}`);
    await flush();

    const second = await dispatchTrigger(
      queue,
      specsDir,
      { kind: 'stage', slug: 'demo', todoId: 't1', stage: 'execute' },
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
      todoId: 't2',
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
      specStore,
      journalPath,
      modelForRole: (_role: Role) => ({ model: 'test-model' }),
      report: () => {},
    };
    const queue = createRunQueue(deps);

    const result = await dispatchTrigger(
      queue,
      specsDir,
      { kind: 'stage', slug: 'demo', todoId: 't2', stage: 'execute' },
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

/**
 * Task 1 — a CLI that mints its own session id is never resumed with Baiton's.
 *
 * The journal's `sessionId` is a UUID Baiton generated. codex ignores it on a
 * fresh launch (see the CodexAdapter degrade notes), so resuming with it runs
 * `codex resume <uuid>`, which prints "No saved session found with ID <uuid>"
 * and exits 1 before any session exists — the run is journaled `closed (exit
 * 1)` and the todo reverts. Attempt 2 must therefore launch fresh; the retry
 * brief still carries the latest review. Once a real id has been discovered for
 * a prior run and journaled as `discoveredSessionId`, that id — and only that
 * id — is resumable.
 */
describe('engine facade: adapters that mint their own session id (Req 3.2)', () => {
  let tmpDir: string;
  let specsDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-resume-codex-'));
    specsDir = path.join(tmpDir, '.baiton', 'specs');
    fs.mkdirSync(path.join(specsDir, 'demo'), { recursive: true });
    journalPath = path.join(specsDir, 'demo', 'runs.jsonl');
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
      specStore,
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
    const trigger = { kind: 'stage', slug: 'demo', todoId: 't1', stage: 'execute' } as const;

    const first = await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
    assert.strictEqual(first.ok, true, `first execute should succeed: ${JSON.stringify(first)}`);
    await flush();

    const second = await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
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
      todoId: 't3',
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
      specsDir,
      { kind: 'stage', slug: 'demo', todoId: 't3', stage: 'execute' },
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
    const trigger = { kind: 'stage', slug: 'demo', todoId: 't5', stage: 'execute' } as const;

    await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
    await flush();
    await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
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
    const trigger = { kind: 'stage', slug: 'demo', todoId: 't4', stage: 'execute' } as const;

    await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
    await flush();
    await dispatchTrigger(queue, specsDir, trigger, adapterForRole);
    await flush();

    assert.strictEqual(terminalHost.launches.length, 2);
    assert.deepStrictEqual(terminalHost.launches[1].shellArgs.slice(0, 2), [
      '--resume',
      'baiton-session-0',
    ]);
  });
});
