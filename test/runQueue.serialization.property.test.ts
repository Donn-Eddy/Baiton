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
} from '../src/engine/runQueue';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { SpecStore } from '../src/engine/runQueue';
import type { TerminalHost, HostTerminal } from '../src/engine/terminalHost';
import type { ResultWatcher } from '../src/engine/resultWatcher';
import { ok } from '../src/model/result';
import type { Role } from '../src/model/role';

/**
 * Property test for the serialized run queue's concurrency and dispatch
 * discipline (Requirement 10.3, 10.4, 19.1, 19.2, 19.3, 20.1, 20.2, 20.3,
 * 20.4, 20.5; design "Stage engine", `RunQueue`).
 *
 * Feature: baiton-first-pass, Property 17: At most one running stage and
 * single-trigger dispatch
 *
 * For any interleaving of dispatches the per-repo queue SHALL run at most one
 * stage at a time: `isRunning()` is true while a stage is in flight and never
 * more than one stage is instrumented as concurrently in flight (Req 10.3,
 * 10.4, 20.1). A dispatch issued while a stage runs is appended to the FIFO and
 * only started once the running stage reaches its terminal outcome, and started
 * requests run in the order they were dispatched (Req 20.2, 20.3). Manual mode
 * never auto-chains: each dispatch corresponds to exactly one launched stage —
 * completing a stage never enqueues a follow-on itself (Req 19.1, 19.2). And
 * `stop()` cancels the running stage and clears the queue so every queued
 * dispatch resolves as cancelled and none of them ever launch (Req 20.4, 20.5).
 *
 * The queue is built over fully stubbed dependencies. A controllable
 * terminal host + result-watcher factory make each stage's completion
 * test-driven: a stage does not finish until the test emits a valid result
 * (or `stop()` disposes its terminal). The spec store returns states that make
 * the `execute` transition legal, the adapter probe is ok, git is a no-op
 * stub, and the journal path is a temp file cleaned up after each case.
 */

/** A recorded launch, so the test can drive and observe each stage in order. */
interface LiveStage {
  /** The run id the queue assigned to this launch. */
  runId: string;
  /** Emit a valid `execute` result, driving this stage to a `completed` outcome. */
  complete(): void;
  /** Whether the stage's terminal has been disposed (completion or stop()). */
  disposed: () => boolean;
}

/**
 * A test rig wiring a controllable terminal host + watcher factory into the
 * queue. `stages` records each launched stage in launch order; `inFlight`
 * tracks how many stages are concurrently running (to detect any overlap);
 * `peakInFlight` is the maximum ever observed.
 */
interface Rig {
  deps: RunQueueDeps;
  stages: LiveStage[];
  peakInFlight: () => number;
}

/** Build a fully-stubbed rig around a temp journal path. */
function makeRig(journalPath: string): Rig {
  const stages: LiveStage[] = [];
  let inFlight = 0;
  let peak = 0;

  // Each launched stage gets one fake terminal and one fake watcher. The
  // watcher captures its onResult/onTerminalClose listeners so the test can
  // drive completion (valid result) or observe cancellation (terminal close).
  interface PendingWatcher {
    runId: string;
    resultPath: string;
    resultListeners: Array<(raw: string) => void>;
    closeListeners: Array<(code: number | undefined) => void>;
    disposed: boolean;
    settled: boolean;
  }

  // The terminal host records each created terminal keyed by run dir so the
  // watcher factory (called right after launch) can pair with it.
  const terminalByName = new Map<string, FakeTerminal>();

  class FakeTerminal implements HostTerminal {
    disposed = false;
    onDispose?: () => void;
    sendText(): void {
      /* no-op: the initial prompt is irrelevant to serialization */
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
    createTerminal(options): HostTerminal {
      const terminal = new FakeTerminal();
      terminalByName.set(options.name, terminal);
      return terminal;
    },
  };

  const watcherFactory: ResultWatcherFactory = {
    create(input): ResultWatcher {
      const terminal = input.terminal as FakeTerminal;
      // A watcher's creation marks the stage as in flight. Overlap here would
      // mean two stages running concurrently, which must never happen.
      inFlight += 1;
      peak = Math.max(peak, inFlight);

      const pending: PendingWatcher = {
        runId: input.runId,
        resultPath: input.resultPath,
        resultListeners: [],
        closeListeners: [],
        disposed: false,
        settled: false,
      };

      const settle = (): void => {
        if (pending.settled) {
          return;
        }
        pending.settled = true;
        inFlight -= 1;
      };

      // A terminal is disposed on two paths: the flow disposes it right before
      // resolving `completed` (a normal finish), or `stop()` disposes it to
      // cancel. We must fire the terminal-close listeners only for a genuine
      // cancel, never for a completion. The completion path disposes the
      // watcher (settling `pending`) synchronously right after disposing the
      // terminal, so by the next tick a completed run is already settled and we
      // skip firing close. A cancel disposes only the terminal, leaving the run
      // unsettled, so the deferred close listeners fire and resolve `closed`
      // (which the queue's `stop()` then records as `cancelled`).
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
          return () => {
            /* unsubscribe not needed for the test */
          };
        },
        onTerminalClose(listener): () => void {
          pending.closeListeners.push(listener);
          return () => {
            /* unsubscribe not needed for the test */
          };
        },
        dispose(): void {
          pending.disposed = true;
          settle();
        },
      };

      stages.push({
        runId: input.runId,
        complete: (): void => {
          // Emit a valid execute result, which the flow validates, persists,
          // disposes the terminal, and resolves `completed`.
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
        disposed: (): boolean => terminal.disposed,
      });

      return watcher;
    },
  };

  const adapter = {
    id: 'claude' as const,
    acceptsSessionId: true,
    probe: async () => ({ version: 'test', ok: true }),
    launch: () => ({ shellPath: 'claude', shellArgs: [] as string[] }),
    attach: () => ({ shellPath: 'claude', shellArgs: [] as string[] }),
  } satisfies Adapter;

  // A git stub: clean tree, stable HEAD/branch (no drift), successful reset.
  const git = {
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
  } satisfies GitService;

  // A spec store that keeps the `execute` transition legal: the todo is
  // `planned`, the spec is approved, unblocked, and the input rev matches.
  const specStore: SpecStore = {
    currentState: async () => 'planned',
    readSpec: async () => undefined,
    readArtifact: async () => '# Plan T01\n',
    latestExecuteCommit: async () => undefined,
    isApproved: async () => true,
    isBlocked: async () => false,
    inputRevMatches: async () => true,
    inputRev: async () => 'rev0',
    writeState: async () => true,
  };

  // Persist artifacts into the temp dir the journal lives in, not the CWD.
  const workspaceRoot = path.dirname(journalPath);

  let idCounter = 0;
  const nextId = (): number => idCounter++;

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
    newRunId: (req) => `${req.slug}-${req.todoId}-${req.attempt}-${nextId()}`,
  };

  return { deps, stages, peakInFlight: () => peak };
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

/** Yield control so queued microtasks (drain steps) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('run queue serialization + single-trigger dispatch (property harness)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runqueue-'));
    // The artifact writer targets .baiton/specs/<slug>/; ensure it exists so a
    // completed execute result can persist without error.
    fs.mkdirSync(path.join(tmpDir, '.baiton', 'specs', 'demo'), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Feature: baiton-first-pass, Property 17: At most one running stage and
  // single-trigger dispatch
  it('runs at most one stage at a time and starts queued dispatches FIFO after each completes', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 2..6 dispatches issued back-to-back, then completed one by one.
        fc.integer({ min: 2, max: 6 }),
        async (count) => {
          const journalPath = path.join(tmpDir, 'runs.jsonl');
          const rig = makeRig(journalPath);
          const queue = createRunQueue(rig.deps);

          // Issue all dispatches "simultaneously" (before awaiting any).
          const results: Array<Promise<unknown>> = [];
          for (let i = 0; i < count; i++) {
            results.push(queue.dispatch(executeRequest(i)));
          }

          // Let the queue start draining. Only the first should be launched.
          await flush();
          assert.strictEqual(
            queue.isRunning(),
            true,
            'a stage should be running after dispatching',
          );
          assert.strictEqual(
            rig.stages.length,
            1,
            'exactly one stage should be launched while one runs (no overlap)',
          );

          // Complete each running stage in turn; each completion should start
          // exactly the next queued dispatch, in FIFO order, and never launch
          // more than one at a time.
          for (let i = 0; i < count; i++) {
            assert.strictEqual(
              rig.stages.length,
              i + 1,
              `only ${i + 1} stage(s) should have launched by step ${i}`,
            );
            rig.stages[i].complete();
            await flush();
          }

          // Every dispatch ran exactly one stage: no auto-chaining (Req 19.2).
          assert.strictEqual(
            rig.stages.length,
            count,
            'each dispatch must launch exactly one stage (no auto-chaining)',
          );
          // Never more than one stage in flight at once (Req 10.4, 20.1).
          assert.strictEqual(
            rig.peakInFlight(),
            1,
            'at most one stage may be in flight at any time',
          );

          const settled = (await Promise.all(results)) as Array<{
            ok: boolean;
            outcome?: { kind: string };
          }>;
          for (const r of settled) {
            assert.strictEqual(r.ok, true, 'each dispatch should succeed');
            assert.strictEqual(
              r.outcome?.kind,
              'completed',
              'each dispatch should resolve with a completed outcome',
            );
          }

          // The queue is idle once everything has drained.
          assert.strictEqual(queue.isRunning(), false, 'queue should be idle at the end');
        },
      ),
      { numRuns: 120 },
    );
  });

  // Feature: baiton-first-pass, Property 17: At most one running stage and
  // single-trigger dispatch
  it('stop() cancels the running stage and clears the queue so queued dispatches resolve cancelled and never launch', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1 running + 1..5 queued dispatches, then stop().
        fc.integer({ min: 1, max: 5 }),
        async (queuedCount) => {
          const journalPath = path.join(tmpDir, 'runs.jsonl');
          const rig = makeRig(journalPath);
          const queue = createRunQueue(rig.deps);

          const total = queuedCount + 1;
          const results: Array<Promise<{ ok: boolean; [k: string]: unknown }>> =
            [];
          for (let i = 0; i < total; i++) {
            results.push(
              queue.dispatch(executeRequest(i)) as Promise<{
                ok: boolean;
                [k: string]: unknown;
              }>,
            );
          }

          await flush();
          assert.strictEqual(queue.isRunning(), true, 'one stage should be running');
          assert.strictEqual(
            rig.stages.length,
            1,
            'only the first dispatch should have launched',
          );

          // Stop: cancels the running stage and clears every queued dispatch.
          queue.stop();
          // Drain a few ticks so the deferred terminal-close propagates through
          // the result flow and the queue records the cancellation.
          await flush();
          await flush();
          await flush();

          // Only the one running stage was ever launched — nothing queued started.
          assert.strictEqual(
            rig.stages.length,
            1,
            'stop() must not allow any queued dispatch to launch (Req 20.5)',
          );
          // The running stage's terminal was disposed (cancelled).
          assert.strictEqual(
            rig.stages[0].disposed(),
            true,
            'stop() must dispose the running stage terminal (Req 20.4)',
          );
          assert.strictEqual(
            queue.isRunning(),
            false,
            'queue should be idle after stop()',
          );

          const settled = await Promise.all(results);
          for (const r of settled) {
            assert.strictEqual(
              r.ok,
              false,
              'every dispatch should resolve as a refusal after stop()',
            );
            const error = (r as unknown as {
              error: { outcome?: { kind: string } };
            }).error;
            assert.strictEqual(
              error.outcome?.kind,
              'cancelled',
              'each cleared/cancelled dispatch should carry a cancelled outcome',
            );
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
