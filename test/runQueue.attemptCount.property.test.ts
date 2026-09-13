import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createRunQueue,
  type RunQueueDeps,
  type RunRequest,
  type ResultWatcherFactory,
  type SpecStore,
} from '../src/engine/runQueue';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { TerminalHost, HostTerminal } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import { ok } from '../src/model/result';
import type { Role } from '../src/model/role';

/**
 * Property test for the run queue's attempt-counting discipline (Requirements
 * 14.6, 14.7, 18.17; design "Stage engine", `RunQueue.applyOutcome`).
 *
 * Feature: baiton-first-pass, Property 16: Only completed executes count as attempts
 *
 * For any sequence of execute outcomes, only a `completed` outcome counts as an
 * attempt and advances the lifecycle: the queue commits the execution (the
 * counted-attempt observable, carrying `execute attempt <n>`) and writes the
 * `executed` terminal state. A non-`completed` outcome — `invalid_output`,
 * `closed`, or `cancelled` — halts the stage, leaves the todo state unchanged
 * (except `cancelled`, which sets `failed`), and is never counted as an
 * attempt. Over a random sequence of outcomes, the number of counted attempts
 * (execute commits) equals exactly the number of `completed` execute outcomes.
 *
 * The queue is built over fully stubbed dependencies with a controllable
 * terminal host + result-watcher factory so each dispatched execute can be
 * driven to a chosen outcome:
 *   - `completed`       — the test emits a valid execute result.
 *   - `closed`          — the terminal closes before any valid result.
 *   - `invalid_output`  — the test emits an invalid result (kept open for a
 *                         rewrite), then closes the terminal (halts, not counted).
 *   - `cancelled`       — `stop()` disposes the running terminal.
 * The spec store keeps every execute transition legal and records each
 * `executing`→`executed` advance; the git stub records each execute commit as
 * the counted-attempt observable.
 */

/** The four terminal outcome kinds an execute stage can be driven to. */
type OutcomeKind = 'completed' | 'closed' | 'invalid_output' | 'cancelled';

/** A recorded launch the test can drive to its chosen outcome. */
interface LiveStage {
  runId: string;
  /** Emit a valid execute result → drives this stage to `completed`. */
  complete(): void;
  /** Emit an invalid (schema-failing) result → kept open for a rewrite. */
  emitInvalid(): void;
  /** Close the terminal → resolves `closed` (unless already completed). */
  close(): void;
}

/** A test rig wiring controllable host/watcher into the queue. */
interface Rig {
  deps: RunQueueDeps;
  stages: LiveStage[];
  /** How many execute commits the git stub recorded (the counted attempts). */
  commitCount: () => number;
  /** How many `executing`→`executed` writeState advances were observed. */
  advanceCount: () => number;
}

/** Build a fully-stubbed rig around a temp journal path. */
function makeRig(journalPath: string): Rig {
  const stages: LiveStage[] = [];
  let commitCount = 0;
  let advanceCount = 0;

  interface PendingWatcher {
    resultListeners: Array<(raw: string) => void>;
    closeListeners: Array<(code: number | undefined) => void>;
    settled: boolean;
  }

  class FakeTerminal implements HostTerminal {
    disposed = false;
    onDispose?: () => void;
    sendText(): void {
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
    show(): void {
      /* no-op */
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
      const pending: PendingWatcher = {
        resultListeners: [],
        closeListeners: [],
        settled: false,
      };

      const settle = (): void => {
        pending.settled = true;
      };

      // A disposed terminal that has not yet settled (a genuine cancel/close,
      // not a completion) fires the deferred close listeners so the flow
      // resolves `closed` — which `stop()` records as `cancelled`.
      terminal.onDispose = (): void => {
        setImmediate(() => {
          if (pending.settled) {
            return;
          }
          for (const listener of pending.closeListeners) {
            listener(undefined);
          }
          settle();
        });
      };

      const watcher: ResultWatcher = {
        onResult(listener): () => void {
          pending.resultListeners.push(listener);
          return () => {};
        },
        onTerminalClose(listener): () => void {
          pending.closeListeners.push(listener);
          return () => {};
        },
        dispose(): void {
          settle();
        },
      };

      stages.push({
        runId: input.runId,
        complete: (): void => {
          const validExecuteResult = JSON.stringify({
            summary: 'done',
            files_changed: [],
            commands_run: [],
            notes: [],
          });
          for (const listener of pending.resultListeners) {
            listener(validExecuteResult);
          }
        },
        emitInvalid: (): void => {
          // Malformed JSON fails parse/validate → the flow keeps the run open.
          for (const listener of pending.resultListeners) {
            listener('{ this is not valid json');
          }
        },
        close: (): void => {
          terminal.dispose();
        },
      });

      return watcher;
    },
  };

  const adapter = {
    id: 'claude' as const,
    probe: async () => ({ version: 'test', ok: true }),
    launch: () => ({ shellPath: 'claude', shellArgs: [] as string[] }),
    attach: () => ({ shellPath: 'claude', shellArgs: [] as string[] }),
  } satisfies Adapter;

  // A git stub: clean tree, stable HEAD/branch (no drift), successful reset.
  // Every execute commit is the counted-attempt observable (Req 18.17, 17.4).
  const git = {
    status: async () => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => {},
    resolveBaseCommit: async () => 'base',
    createSpecBranch: async () => {},
    checkout: async () => {},
    commit: async () => {
      commitCount += 1;
      return 'commitsha';
    },
    head: async () => 'HEAD0',
    currentBranch: async () => 'spec-branch',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async () => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  } satisfies GitService;

  // A spec store that keeps every execute transition legal. Each dispatch's
  // todo is `planned` (legal for execute). Observing an `executing`→`executed`
  // write is the lifecycle-advance observable that only a completed run drives.
  const specStore: SpecStore = {
    currentState: async () => 'planned',
    isApproved: async () => true,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev0',
    writeState: async (_slug, _todoId, state) => {
      if (state === 'executed') {
        advanceCount += 1;
      }
      return true;
    },
  };

  const workspaceRoot = path.dirname(journalPath);

  let idCounter = 0;
  const deps: RunQueueDeps = {
    workspaceRoot,
    adapterForRole: () => adapter,
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
    newRunId: (req) => `${req.slug}-${req.todoId}-${req.attempt}-${idCounter++}`,
  };

  return {
    deps,
    stages,
    commitCount: () => commitCount,
    advanceCount: () => advanceCount,
  };
}

/** Build an `execute` dispatch request with a per-index todo/attempt. */
function executeRequest(index: number): RunRequest {
  return {
    slug: 'demo',
    todoId: `todo-${index}`,
    action: 'execute',
    role: 'executor',
    attempt: index + 1,
    resume: false,
  };
}

/** Yield control so queued microtasks (drain/deferred close) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('run queue attempt counting (property harness)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-attempts-'));
    fs.mkdirSync(path.join(tmpDir, '.baiton', 'specs', 'demo'), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Feature: baiton-first-pass, Property 16: Only completed executes count as attempts
  it('counts only completed execute outcomes as attempts; invalid_output/closed/cancelled do not', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random non-empty sequence of execute outcomes.
        fc.array(
          fc.constantFrom<OutcomeKind>(
            'completed',
            'closed',
            'invalid_output',
            'cancelled',
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (outcomes) => {
          const journalPath = path.join(tmpDir, 'runs.jsonl');
          const rig = makeRig(journalPath);
          const queue = createRunQueue(rig.deps);

          const results: Array<Promise<{ ok: boolean }>> = [];

          // Drive each dispatch to its chosen outcome, one at a time. The queue
          // serializes runs, so only the head stage is in flight at any point.
          for (let i = 0; i < outcomes.length; i++) {
            results.push(
              queue.dispatch(executeRequest(i)) as Promise<{ ok: boolean }>,
            );
            await flush();

            // The stage for this dispatch is now launched and in flight.
            const stage = rig.stages[i];
            assert.ok(stage, `stage ${i} should have launched`);

            switch (outcomes[i]) {
              case 'completed':
                stage.complete();
                break;
              case 'closed':
                stage.close();
                break;
              case 'invalid_output':
                // Invalid result keeps the run open; closing the terminal then
                // halts it as a non-completing outcome (never counted).
                stage.emitInvalid();
                stage.close();
                break;
              case 'cancelled':
                // Stop disposes the running terminal and clears the queue.
                queue.stop();
                break;
            }

            // Let the outcome propagate (deferred terminal-close needs ticks).
            await flush();
            await flush();
            await flush();
          }

          await Promise.all(results);

          const expectedAttempts = outcomes.filter(
            (o) => o === 'completed',
          ).length;

          // The counted-attempt observable: exactly one execute commit per
          // completed outcome, and none for any non-completed outcome (Req
          // 14.6, 14.7, 18.17).
          assert.strictEqual(
            rig.commitCount(),
            expectedAttempts,
            `execute commits (counted attempts) must equal completed outcomes: ` +
              `expected ${expectedAttempts}, got ${rig.commitCount()} for [${outcomes.join(', ')}]`,
          );

          // The lifecycle-advance observable corroborates: only a completed run
          // writes the `executed` terminal state.
          assert.strictEqual(
            rig.advanceCount(),
            expectedAttempts,
            `lifecycle advances (executing->executed) must equal completed outcomes: ` +
              `expected ${expectedAttempts}, got ${rig.advanceCount()} for [${outcomes.join(', ')}]`,
          );

          assert.strictEqual(
            queue.isRunning(),
            false,
            'queue should be idle after all outcomes are driven',
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
