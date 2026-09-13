import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createRunQueue,
  type RunQueueDeps,
  type RunRequest,
  type SpecStore,
  type ResultWatcherFactory,
} from '../src/engine/runQueue';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { TerminalHost, HostTerminal } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import type { TodoState } from '../src/model/todoState';
import type { Role } from '../src/model/role';
import { ok } from '../src/model/result';

/**
 * Property test for the run queue's revert-on-non-completion behaviour
 * (Requirements 1.1, 1.4, 2.1, 2.2, 3.6; design "Run queue", "Recovery").
 *
 * Feature: baiton-run-controls, Property 1: Stop and closed revert to From_State
 *
 * For every legal running transition (Plan from `pending`, Execute from
 * `planned`/`executed`/`failed`, Review from `executed`) and every outcome a
 * launched stage can settle on:
 *
 * - `closed` (the terminal closed before a result) writes the todo back to
 *   `Transition.from` with a `closed (exit <code>)` / `closed (no exit code)`
 *   note (Req 1.1, 1.4).
 * - `cancelled` (Stop while running) writes the todo back to `Transition.from`
 *   with a `cancelled` note (Req 1.1, 2.1).
 * - `completed` never reverts: no revert write is made.
 *
 * `currentRun()` reports the live run while the stage is in flight and is
 * `undefined` once the dispatch has settled, for every outcome (Req 3.6).
 */

/** One legal (from-state, action) pair the queue can launch a stage for. */
interface Scenario {
  from: TodoState;
  action: 'plan' | 'execute' | 'review';
  role: Role;
  /** A schema-conformant result body for a `completed` outcome. */
  resultJson: string;
}

const SCENARIOS: Scenario[] = [
  {
    from: 'pending',
    action: 'plan',
    role: 'planner',
    resultJson: JSON.stringify({
      steps: [{ title: 'step', detail: 'do it', files: [] }],
      risks: [],
      acceptance: ['done'],
    }),
  },
  {
    from: 'planned',
    action: 'execute',
    role: 'executor',
    resultJson: JSON.stringify({
      summary: 'did it',
      files_changed: [],
      commands_run: [],
      notes: [],
    }),
  },
  {
    from: 'executed',
    action: 'execute',
    role: 'executor',
    resultJson: JSON.stringify({
      summary: 'did it again',
      files_changed: [],
      commands_run: [],
      notes: [],
    }),
  },
  {
    from: 'failed',
    action: 'execute',
    role: 'executor',
    resultJson: JSON.stringify({
      summary: 'retried',
      files_changed: [],
      commands_run: [],
      notes: [],
    }),
  },
  {
    from: 'executed',
    action: 'review',
    role: 'reviewer',
    resultJson: JSON.stringify({
      verdict: 'pass',
      findings: [],
      tests: { ran: true, passed: true, output_tail: 'ok' },
    }),
  },
];

type OutcomeKind = 'completed' | 'closed' | 'cancelled';

/** A recorded `writeState` call, for asserting the revert (or its absence). */
interface WriteCall {
  slug: string;
  todoId: string;
  state: TodoState;
  note?: string;
}

/** Drives the single launched stage's outcome from the test. */
interface Drive {
  runId: string;
  /** Fire a valid schema-conformant result, driving a `completed` outcome. */
  complete(resultJson: string): void;
  /** Fire a terminal-close event directly, driving a `closed` outcome. */
  closeWithExit(exitCode: number | undefined): void;
}

interface Rig {
  deps: RunQueueDeps;
  writes: WriteCall[];
  /** Set once the single stage under test has launched. */
  drive: () => Drive | undefined;
}

const SLUG = 'demo';
const TODO_ID = 'T01';

/** Build a fully-stubbed rig for one scenario over a temp journal path. */
function makeRig(journalPath: string, scenario: Scenario): Rig {
  const writes: WriteCall[] = [];
  let drive: Drive | undefined;

  class FakeTerminal implements HostTerminal {
    disposed = false;
    onDispose?: () => void;
    sendText(): void {
      /* irrelevant to the revert behaviour under test */
    }
    show(): void {
      /* no-op */
    }
    dispose(): void {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      this.onDispose?.();
    }
    get processId(): Promise<number | undefined> {
      return Promise.resolve(undefined);
    }
  }

  const terminalHost: TerminalHost = {
    createTerminal(): HostTerminal {
      return new FakeTerminal();
    },
  };

  const watcherFactory: ResultWatcherFactory = {
    create(input): ResultWatcher {
      const terminal = input.terminal as FakeTerminal;
      let resultListeners: Array<(raw: string) => void> = [];
      let closeListeners: Array<(exitCode: number | undefined) => void> = [];
      let settled = false;
      const settle = (): void => {
        settled = true;
      };

      // A terminal disposed by `stop()` (not through a valid result) is a
      // genuine host-detected close: deliver it to the close listeners on the
      // next tick, mirroring the real vscode `onDidCloseTerminal` timing. A
      // completed run settles the watcher synchronously first, so this is a
      // no-op for that path (matches the pattern in
      // runQueue.serialization.property.test.ts).
      terminal.onDispose = (): void => {
        setImmediate(() => {
          if (settled) {
            return;
          }
          for (const listener of closeListeners) {
            listener(undefined);
          }
          settle();
        });
      };

      drive = {
        runId: input.runId,
        complete: (resultJson: string): void => {
          for (const listener of [...resultListeners]) {
            listener(resultJson);
          }
        },
        closeWithExit: (exitCode: number | undefined): void => {
          settle();
          for (const listener of [...closeListeners]) {
            listener(exitCode);
          }
        },
      };

      return {
        onResult(listener): () => void {
          resultListeners.push(listener);
          return () => {
            resultListeners = resultListeners.filter((l) => l !== listener);
          };
        },
        onTerminalClose(listener): () => void {
          closeListeners.push(listener);
          return () => {
            closeListeners = closeListeners.filter((l) => l !== listener);
          };
        },
        dispose(): void {
          settle();
        },
      };
    },
  };

  const adapter: Adapter = {
    id: 'claude',
    probe: async () => ({ version: 'test', ok: true }),
    launch: () => ({ shellPath: 'claude', shellArgs: [] }),
    attach: () => ({ shellPath: 'claude', shellArgs: [] }),
  };

  const git: GitService = {
    status: async () => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createSpecBranch: async () => {},
    checkout: async () => {},
    commit: async () => 'commitsha',
    head: async () => 'HEAD0',
    currentBranch: async () => 'spec-branch',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async () => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };

  const specStore: SpecStore = {
    currentState: async () => scenario.from,
    isApproved: async () => true,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev0',
    writeState: async (slug, todoId, state, note) => {
      writes.push({ slug, todoId, state, note });
      return true;
    },
  };

  const workspaceRoot = path.dirname(journalPath);

  const deps: RunQueueDeps = {
    workspaceRoot,
    adapter,
    git,
    terminalHost,
    watcherFactory,
    specStore,
    journalPath,
    modelForRole: (_role: Role) => ({ model: 'test-model' }),
    report: () => {},
    clock: (() => {
      let t = 0;
      return () => t++;
    })(),
    newRunId: () => `run-${scenario.from}-${scenario.action}`,
    newSessionId: () => `session-${scenario.from}-${scenario.action}`,
  };

  return { deps, writes, drive: () => drive };
}

/** Yield control so queued microtasks (drain steps, deferred close) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('run queue revert on non-completion (property harness)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runqueue-revert-'));
    fs.mkdirSync(path.join(tmpDir, '.baiton', 'specs', SLUG), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Feature: baiton-run-controls, Property 1: Stop and closed revert to From_State
  it('reverts to From_State on closed/cancelled, leaves state alone on completed, and clears currentRun() after', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SCENARIOS),
        fc.constantFrom<OutcomeKind>('completed', 'closed', 'cancelled'),
        fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
        async (scenario, outcomeKind, exitCode) => {
          const journalPath = path.join(tmpDir, `runs-${Date.now()}-${Math.random()}.jsonl`);
          const rig = makeRig(journalPath, scenario);
          const queue = createRunQueue(rig.deps);

          const req: RunRequest = {
            slug: SLUG,
            todoId: TODO_ID,
            action: scenario.action,
            role: scenario.role,
            attempt: 1,
            resume: false,
          };

          const resultPromise = queue.dispatch(req);
          await flush();

          // The stage is live: currentRun() reports it (Req 3.6).
          const live = queue.currentRun();
          assert.ok(live !== undefined, 'currentRun() is defined while the stage runs');
          assert.strictEqual(live?.todoId, TODO_ID);
          assert.strictEqual(live?.slug, SLUG);
          assert.strictEqual(typeof live?.sessionId, 'string');

          const drive = rig.drive();
          assert.ok(drive !== undefined, 'the stage should have launched');

          if (outcomeKind === 'completed') {
            drive!.complete(scenario.resultJson);
          } else if (outcomeKind === 'closed') {
            drive!.closeWithExit(exitCode);
          } else {
            queue.stop();
          }

          await flush();
          await flush();
          await flush();

          const result = (await resultPromise) as {
            ok: boolean;
            outcome?: { kind: string };
            error?: { outcome?: { kind: string } };
          };

          // The stage is no longer live once it has settled (Req 3.6).
          assert.strictEqual(
            queue.currentRun(),
            undefined,
            'currentRun() is undefined once the dispatch has settled',
          );

          if (outcomeKind === 'completed') {
            assert.strictEqual(result.ok, true, 'a completed outcome resolves ok');
            assert.strictEqual(result.outcome?.kind, 'completed');
            const revertWrite = rig.writes.find(
              (w) => w.note === 'cancelled' || w.note?.startsWith('closed'),
            );
            assert.strictEqual(
              revertWrite,
              undefined,
              'a completed outcome makes no revert write',
            );
            return;
          }

          // closed / cancelled: refused, and reverted to Transition.from.
          assert.strictEqual(result.ok, false, `a ${outcomeKind} outcome is refused`);
          assert.strictEqual(result.error?.outcome?.kind, outcomeKind === 'cancelled' ? 'cancelled' : 'closed');

          // The first write is the running-state write made before launch
          // (e.g. `planning`); the revert write is the last one made.
          assert.ok(rig.writes.length >= 1, 'at least the revert write was made');
          const write = rig.writes[rig.writes.length - 1];
          assert.strictEqual(write.slug, SLUG);
          assert.strictEqual(write.todoId, TODO_ID);
          assert.strictEqual(
            write.state,
            scenario.from,
            `reverted to the transition's From_State ("${scenario.from}")`,
          );

          if (outcomeKind === 'cancelled') {
            assert.strictEqual(write.note, 'cancelled', 'Stop notes the revert as cancelled');
          } else {
            const expectedNote =
              exitCode !== undefined ? `closed (exit ${exitCode})` : 'closed (no exit code)';
            assert.strictEqual(write.note, expectedNote, 'closed notes the exit code when known');
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
