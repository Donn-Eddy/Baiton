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
import type { GitService } from '../src/git';
import type { Role } from '../src/model/role';
import { appendStart } from '../src/journal';
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
 * The test runs the real `RunQueue` + `ClaudeAdapter` over stubbed
 * terminal/watcher/git/spec-store dependencies and inspects the actual
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
  isApproved: async () => true,
  isBlocked: async () => false,
  inputRevMatches: async () => true,
  inputRev: async () => 'rev-0',
  writeState: async () => true,
};

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

    const first = await dispatchTrigger(queue, specsDir, {
      kind: 'stage',
      slug: 'demo',
      todoId: 't1',
      stage: 'execute',
    });
    assert.strictEqual(first.ok, true, `first execute dispatch should succeed: ${JSON.stringify(first)}`);
    await flush();

    const second = await dispatchTrigger(queue, specsDir, {
      kind: 'stage',
      slug: 'demo',
      todoId: 't1',
      stage: 'execute',
    });
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

    const result = await dispatchTrigger(queue, specsDir, {
      kind: 'stage',
      slug: 'demo',
      todoId: 't2',
      stage: 'execute',
    });
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
