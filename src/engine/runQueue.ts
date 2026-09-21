/**
 * The serialized run queue and stage lifecycle (Requirements 10.3–10.5, 12.4,
 * 14.2, 14.5–14.7, 15.5, 15.6, 17.2–17.6, 18.1–18.17, 19.1–19.3, 20.1–20.6,
 * 21.1, 21.2, 5.3, 5.4; design "Stage engine", `RunQueue`).
 *
 * This module owns the run lifecycle independent of which agent runs. A single
 * in-memory FIFO per repository guarantees at most one running stage: a request
 * dispatched while one runs is appended and started only when the running stage
 * reaches a terminal outcome (Req 20.1–20.3). In first-pass manual mode the
 * queue never auto-chains — each user trigger runs exactly one stage and, on
 * completion, the queue is left for the next trigger (Req 19.1, 19.2). `stop()`
 * disposes the running terminal, records the outcome `cancelled`, sets the todo
 * `failed`, and clears every queued request (Req 20.4–20.6).
 *
 * For each dispatched action the queue:
 *   1. Resolves the legal transition from the todo's current state; refuses an
 *      illegal pair (Req 10.5, 18.x).
 *   2. Evaluates the transition's guards against live git/spec state — the
 *      approval-hash gate and clean-tree/input-rev guards for Execute (Req 5.3,
 *      5.4, 17.2, 17.3, 18.8, 18.9).
 *   3. Runs the adapter probe before launching (Req 14.2, 14.5).
 *   4. Writes the running state through the serializer and commits the metadata
 *      change before launch (Req 17.1).
 *   5. Appends a journal start record, launches the stage, and awaits its
 *      {@link RunOutcome} (Req 21.1).
 *   6. On a `completed` outcome, counts an attempt, commits the execution with a
 *      `Run-Id:` trailer (Execute) after a HEAD/branch drift check (Req 17.4,
 *      17.6), applies the terminal state through the serializer, runs the
 *      post-run reset for non-executor stages (Req 15.5, 15.6), and appends a
 *      journal completion record (Req 21.2). A non-`completed` outcome halts the
 *      stage and leaves state unchanged (Req 12.6, 14.7).
 *   7. Whatever the outcome, asks the adapter to discover the session id its CLI
 *      minted for the run (for CLIs that ignore Baiton's pre-assigned one) and
 *      journals it on the completion record, so a later Execute can resume that
 *      session (Req 3.2).
 *   8. When ask relaying is wired, creates a watcher for the launched run's
 *      `asks/` directory and disposes it once the run settles.
 *
 * Everything host-specific is injected — the per-role adapter lookup, git
 * service, terminal host, result-watcher factory, journal path, the
 * serializer-backed spec store, a clock and an id generator, and a reporter —
 * so the queue is unit- and property-testable without `vscode`. The activation
 * layer wires the real implementations.
 */
import type { Role } from '../model/role';
import type { Stage } from '../model/stage';
import type { ParsedSpec } from '../model/parser';
import type { TodoState } from '../model/todoState';
import type { GitService } from '../git';
import type { Adapter } from '../adapter';
import type { HostTerminal } from './terminalHost';
import type { TerminalHost } from './terminalHost';
import type { ResultWatcher } from './resultWatcher';
import { launchStage, type LaunchStageInput } from './launcher';
import { buildStageContext, type ContextStage } from './stageContext';
import { awaitStageResult, type RunOutcome } from './resultFlow';
import {
  resolveTransition,
  stageForAction,
  type Transition,
  type TransitionAction,
} from './transitions';
import { appendCompletion, appendStart, latestStart, parseJournal } from '../journal';
import type { RunResultKind } from '../journal';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

/**
 * A single dispatch request (design "Stage engine", `RunRequest`).
 *
 * `action` is the state-machine action; `role` names the sub-agent role for the
 * launched stage. `attempt` is the caller-supplied 1-based attempt/round index
 * used for numbered artifacts and the Execute commit message; `resume` selects
 * the executor continuation flag (Req 13).
 */
export interface RunRequest {
  /** The spec slug whose todo is being acted on. */
  slug: string;
  /** The todo id being acted on. */
  todoId: string;
  /** The lifecycle action to perform. */
  action: TransitionAction;
  /** The sub-agent role for the launched stage (ignored for control actions). */
  role: Role;
  /** The 1-based attempt/round index for numbered artifacts and commits. */
  attempt: number;
  /** True to resume a prior executor session across rounds (Req 13.2). */
  resume: boolean;
  /**
   * The Session_Id to resume when `resume` is true (Req 3.2). The engine facade
   * supplies the executor's most recent *resumable* Session_Id — the id its CLI
   * actually knows: the pre-assigned one for an adapter that accepts it, else
   * one discovered after a prior run. Absent when none is recorded, in which
   * case the adapter falls back to `-c`/`--last`.
   */
  resumeSessionId?: string;
}

/**
 * Why a dispatch did not run to a stage launch. Every variant means the todo's
 * state is left unchanged (except `input-rev-mismatch`, which reverts the todo
 * to `pending` per Req 18.9) and the reason is surfaced to the user.
 *
 * - `busy`               — a stage is already running (Req 10.4, 19.3).
 * - `illegal-transition` — the action is not legal for the todo's state (Req
 *                          10.5, 18.2).
 * - `not-approved`       — the approval-hash gate failed (Req 5.3, 5.4).
 * - `blocked`            — the todo's derived blocked status is true (Req 18.2).
 * - `dirty-tree`         — the working tree is not clean for Execute (Req 17.3,
 *                          18.8).
 * - `input-rev-mismatch` — the plan's Input_Rev no longer matches; the todo was
 *                          reverted to `pending` (Req 18.9).
 * - `unknown-agent`      — the role's configured `agent` is not a supported
 *                          agent id; no stage is launched and state is
 *                          unchanged (Req 14.1).
 * - `probe-failed`       — the adapter probe reported not-ok (Req 14.5).
 * - `launch-failed`      — writing the brief or resolving the root failed (Req
 *                          11.5).
 * - `reset-failed`       — the post-run reset exited non-zero; the run halts
 *                          before the next stage (Req 15.6).
 * - `git-state-changed`  — HEAD or branch drifted during Execute (Req 17.6).
 * - `spec-write-failed`  — a serializer write of a lifecycle state box aborted
 *                          (Req 6.5).
 * - `outcome`            — the stage produced a non-`completed` outcome
 *                          (`invalid_output`, `closed`, `cancelled`) (Req 12.6,
 *                          14.7).
 */
export type DispatchError =
  | { kind: 'busy'; message: string }
  | { kind: 'illegal-transition'; message: string }
  | { kind: 'not-approved'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'dirty-tree'; message: string }
  | { kind: 'input-rev-mismatch'; message: string }
  | { kind: 'unknown-agent'; message: string }
  | { kind: 'probe-failed'; message: string }
  | { kind: 'launch-failed'; message: string }
  | { kind: 'reset-failed'; message: string }
  | { kind: 'git-state-changed'; message: string }
  | { kind: 'spec-write-failed'; message: string }
  | { kind: 'outcome'; outcome: RunOutcome; message: string };

/**
 * The result a `dispatch` resolves to. A successful dispatch resolves with the
 * stage's terminal {@link RunOutcome}; a refusal or halt resolves with a
 * {@link DispatchError}. Both are ordinary resolutions (not rejections) so the
 * caller handles them explicitly.
 */
export type DispatchResult =
  | { ok: true; outcome: RunOutcome }
  | { ok: false; error: DispatchError };

/**
 * The stage currently in flight on a {@link RunQueue}: its run id, the todo it
 * acts on, its Session_Id, and its terminal (Req 3.6). Lets the command layer
 * show/reveal the live terminal without a second terminal registry.
 */
export interface LiveRun {
  runId: string;
  slug: string;
  todoId: string;
  /** The Claude `--session-id` UUID generated for this run (Req 3.1). */
  sessionId: string;
  terminal: HostTerminal;
}

/**
 * The serialized run queue (design "Stage engine", `RunQueue`). `dispatch`
 * enqueues a request and resolves when that specific request has run (or been
 * refused); `stop` cancels the running stage and clears the queue; `isRunning`
 * reports whether a stage is currently in flight; `currentRun` exposes the
 * live run, if any (Req 3.6).
 */
export interface RunQueue {
  /** Enqueue a request; resolves when it runs to a terminal outcome or is refused. */
  dispatch(req: RunRequest): Promise<DispatchResult>;
  /** Cancel the running stage and clear all queued requests (Req 20.4–20.6). */
  stop(): void;
  /** Whether a stage is currently running. */
  isRunning(): boolean;
  /** The stage currently in flight, or `undefined` when idle (Req 3.6, 2.1). */
  currentRun(): LiveRun | undefined;
}

/**
 * The spec-store seam the queue uses to read approval/blocked/input-rev facts
 * and to apply lifecycle state writes through the pure serializer. Keeping this
 * behind an interface lets the queue stay free of `fs`/`vscode` while the
 * activation layer wires a store backed by {@link writeTodoState} over the
 * on-disk spec (re-reading before each write per Req 6.3).
 */
export interface SpecStore {
  /** The todo's current lifecycle state, or `undefined` when it cannot be read. */
  currentState(slug: string, todoId: string): Promise<TodoState | undefined>;
  /**
   * The spec, freshly re-read and parsed, or `undefined` when it cannot be
   * read. The queue uses it to assemble each Brief's Context section (Req 18.3).
   */
  readSpec(slug: string): Promise<ParsedSpec | undefined>;
  /**
   * The text of a todo's persisted artifact for a stage, or `undefined` when
   * none is on file. For the numbered stages this is the artifact with the
   * highest `<n>` in `todos/<todoId>/`, found by listing that directory rather
   * than by trusting the journal (Req 24.3).
   */
  readArtifact(
    slug: string,
    todoId: string,
    stage: Stage,
  ): Promise<string | undefined>;
  /**
   * The commit the todo's most recent completed Execute landed in, from the
   * journal's completion record, or `undefined` when none is recorded. The
   * reviewer's Brief names it so the reviewer inspects that commit (Req 21.2).
   */
  latestExecuteCommit(slug: string, todoId: string): Promise<string | undefined>;
  /**
   * Whether the spec is approved: its `approved_rev` byte-equals the current
   * Approval_Hash and is non-empty (Req 5.3, 5.4).
   */
  isApproved(slug: string): Promise<boolean>;
  /** The todo's derived blocked status (Req 4.10, 18.2). */
  isBlocked(slug: string, todoId: string): Promise<boolean>;
  /**
   * Whether the plan's recorded Input_Rev still matches the current Input_Rev
   * for the todo (Req 18.9). `false` reverts Execute to `pending`.
   */
  inputRevMatches(slug: string, todoId: string): Promise<boolean>;
  /** The plan's recorded Input_Rev, journaled at stage start (Req 21.1). */
  inputRev(slug: string, todoId: string): Promise<string>;
  /**
   * Apply a lifecycle state write through the serializer, committing the change
   * on the spec branch before the next stage (Req 17.1). Resolves `false` when
   * the serializer aborted (the target could not be located) so the caller can
   * surface a `spec-write-failed` error and leave state unchanged (Req 6.5).
   */
  writeState(
    slug: string,
    todoId: string,
    state: TodoState,
    note?: string,
  ): Promise<boolean>;
}

/** Constructs a {@link ResultWatcher} for one launched run's result file. */
export interface ResultWatcherFactory {
  create(input: {
    slug: string;
    runId: string;
    resultPath: string;
    terminal: HostTerminal;
  }): ResultWatcher;
}

/** A live watcher over one launched run's `asks/` directory. */
export interface AskWatcher {
  /** Tear down the directory watch and settle anything still pending. Idempotent. */
  dispose(): void;
}

/** Constructs an {@link AskWatcher} for one launched run's relayed harness asks. */
export interface AskWatcherFactory {
  create(input: {
    slug: string;
    todoId: string;
    runId: string;
    /** The adapter id the run launched with (`adapter.id`), for the card's agent line. */
    agent: string;
    /** Absolute path of `.baiton/runs/<run-id>/asks/`, from the launch's relay descriptor. */
    asksDir: string;
  }): AskWatcher;
}

/** Surfaces a dispatch refusal or halt reason to the user (the notify seam). */
export type QueueReporter = (error: DispatchError) => void;

/** A monotonic clock; injected so tests are deterministic. */
export type Clock = () => number;

/** Generates a unique run id per launched stage; injected for determinism. */
export type RunIdGenerator = (req: RunRequest) => string;

/** Everything a {@link RunQueue} needs, all injectable for testing. */
export interface RunQueueDeps {
  /** Absolute workspace root; the terminal cwd and artifact base. */
  workspaceRoot: string;
  /** The spec slug's git branch is assumed already checked out (Req 16.6). */
  git: GitService;
  terminalHost: TerminalHost;
  watcherFactory: ResultWatcherFactory;
  /** When wired, launched stages relay harness asks into chat; absent leaves launches unchanged. */
  askWatcherFactory?: AskWatcherFactory;
  specStore: SpecStore;
  /** Absolute path of the run journal `runs.jsonl` (Req 21.1, 21.2). */
  journalPath: string;
  /** Per-role model, resolved from config; selects the adapter `--model`. */
  modelForRole(role: Role): { model: string; effort?: string };
  /**
   * Per-role adapter, selected from the role's configured `agent` id;
   * `undefined` when that id is not a known agent (Requirement 14.1).
   */
  adapterForRole(role: Role): Adapter | undefined;
  /** Surfaces refusals/halts; defaults to a no-op the activation layer overrides. */
  report?: QueueReporter;
  /** Monotonic clock; defaults to `Date.now`. */
  clock?: Clock;
  /** Run-id generator; defaults to a slug/todo/stage/attempt/time composite. */
  newRunId?: RunIdGenerator;
  /**
   * Session-id generator for each launched stage's `--session-id` (Req 1.2,
   * 3.1); defaults to `crypto.randomUUID`.
   */
  newSessionId?: () => string;
  /**
   * Reports a stage running outside this queue — today the spec-draft runner,
   * which is spec-scoped and so cannot be expressed as a queue request. The
   * queue refuses a dispatch as `busy` while it answers true, which keeps the
   * one-stage-per-repository guarantee across both paths (Req 20.1).
   */
  isExternallyBusy?: () => boolean;
}

/** Create a {@link RunQueue} bound to the injected dependencies. */
export function createRunQueue(deps: RunQueueDeps): RunQueue {
  return new SerialRunQueue(deps);
}

/** One queued item: the request plus the resolver of its `dispatch` promise. */
interface QueuedItem {
  req: RunRequest;
  resolve: (result: DispatchResult) => void;
}

/** The live state of the currently running stage, for `stop()` and `currentRun()`. */
interface RunningState {
  runId: string;
  slug: string;
  todoId: string;
  sessionId: string;
  terminal: HostTerminal;
  /** Marks the run cancelled so its outcome is recorded as `cancelled`. */
  cancel(): void;
}

class SerialRunQueue implements RunQueue {
  private readonly deps: RunQueueDeps;
  private readonly report: QueueReporter;
  private readonly clock: Clock;
  private readonly newRunId: RunIdGenerator;
  private readonly newSessionId: () => string;

  /** The FIFO of pending requests (Req 20.1, 20.2). */
  private readonly queue: QueuedItem[] = [];
  /** The running stage, or `undefined` when idle (at most one, Req 20.1). */
  private running: RunningState | undefined;
  /** True while the queue is draining, to avoid re-entrant `drain` loops. */
  private draining = false;

  constructor(deps: RunQueueDeps) {
    this.deps = deps;
    this.report = deps.report ?? (() => {});
    this.clock = deps.clock ?? Date.now;
    this.newRunId = deps.newRunId ?? ((req) => defaultRunId(req, this.clock));
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  currentRun(): LiveRun | undefined {
    if (this.running === undefined) {
      return undefined;
    }
    const { runId, slug, todoId, sessionId, terminal } = this.running;
    return { runId, slug, todoId, sessionId, terminal };
  }

  /**
   * Enqueue a request. If a stage is running, the request is appended and only
   * started when the running stage reaches a terminal outcome (Req 20.2). The
   * returned promise resolves when *this* request has run or been refused.
   */
  dispatch(req: RunRequest): Promise<DispatchResult> {
    return new Promise<DispatchResult>((resolve) => {
      this.queue.push({ req, resolve });
      void this.drain();
    });
  }

  /**
   * Cancel the running stage — dispose its terminal to end the process tree,
   * mark it cancelled so its outcome is recorded `cancelled` and the todo set
   * `failed` — and clear every queued request (Req 20.4–20.6). Each cleared
   * request resolves with a `busy`/cancellation refusal so its caller is not
   * left hanging.
   */
  stop(): void {
    // Clear the queue first so nothing starts after cancellation (Req 20.5).
    const cleared = this.queue.splice(0, this.queue.length);
    for (const item of cleared) {
      item.resolve({
        ok: false,
        error: {
          kind: 'outcome',
          outcome: { kind: 'cancelled' },
          message: 'run queue was cleared by Stop',
        },
      });
    }

    // Cancel the running stage: disposing the terminal drives the watcher's
    // terminal-close path; `cancel()` flips the outcome to `cancelled` so the
    // lifecycle records a cancellation and sets the todo `failed` (Req 20.6).
    if (this.running) {
      this.running.cancel();
      this.running.terminal.dispose();
    }
  }

  /**
   * Start the next queued request when idle. Manual mode never auto-chains: this
   * only starts a request already placed on the queue by a user `dispatch`; it
   * never enqueues a follow-on stage itself (Req 19.1, 19.2). Runs one request
   * to completion, then loops to pick up anything a caller enqueued while it ran
   * (Req 20.3).
   */
  private async drain(): Promise<void> {
    if (this.draining || this.running !== undefined) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.running === undefined) {
        const item = this.queue.shift() as QueuedItem;
        const result = await this.runOne(item.req);
        item.resolve(result);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Run a single request end to end: resolve and guard the transition, probe,
   * launch, await the outcome, and apply the terminal state + commits + reset +
   * journal. Never throws; every failure path resolves with a
   * {@link DispatchError} that has already been reported.
   */
  private async runOne(req: RunRequest): Promise<DispatchResult> {
    // A stage running outside the queue (a spec draft) holds the same
    // one-stage-per-repository lock (Req 20.1).
    if (this.deps.isExternallyBusy?.() === true) {
      return this.refuse({
        kind: 'busy',
        message: 'a stage is already running for this repository; try again after it finishes',
      });
    }

    const state = await this.deps.specStore.currentState(req.slug, req.todoId);
    if (state === undefined) {
      return this.refuse({
        kind: 'illegal-transition',
        message: `todo "${req.todoId}" could not be read`,
      });
    }

    // `stop` reverting from `executing` needs the state that Execute stage
    // launched from; look it up from the journal's most recent execute start
    // (Req 2.2, 3.6). Other actions/states pass no opts (unused by the table).
    const opts =
      state === 'executing'
        ? {
            executeFrom: latestStart(
              parseJournal(this.deps.journalPath),
              req.todoId,
              'execute',
            )?.fromState,
          }
        : undefined;
    const transition = resolveTransition(state, req.action, opts);
    if (transition === undefined) {
      // Any pair not in the table is refused (Req 10.5, 18.2).
      return this.refuse({
        kind: 'illegal-transition',
        message: `"${req.action}" is not a legal transition from "${state}"`,
      });
    }

    // Control actions (`replan`, `stop`) only rewrite state; they launch no
    // sub-agent and are applied immediately.
    const stage = stageForAction(req.action);
    if (stage === undefined) {
      return this.applyControlAction(req, transition);
    }

    // Evaluate guards against live git/spec state before launching.
    const guarded = await this.checkGuards(req, transition);
    if (!guarded.ok) {
      return this.refuse(guarded.error);
    }

    // Resolve the role's configured adapter before probing (Req 14.1). An
    // unrecognised agent id is a config problem, reported distinctly from a
    // probe failure, and refuses before any process is spawned.
    const adapter = this.deps.adapterForRole(req.role);
    if (adapter === undefined) {
      return this.refuse({
        kind: 'unknown-agent',
        message: `role "${req.role}" is configured with an unsupported agent; update "roles.${req.role}.agent" in .baiton/config.json`,
      });
    }

    // Probe the adapter before every stage (Req 14.2). A not-ok probe stops the
    // stage with the returned reason surfaced (Req 14.5).
    const probe = await adapter.probe();
    if (!probe.ok) {
      return this.refuse({
        kind: 'probe-failed',
        message: `adapter probe failed: ${probe.reason ?? 'unknown reason'}`,
      });
    }

    return this.launchAndComplete(req, transition, stage, adapter);
  }

  /**
   * Apply a control action's state immediately (Req 18.14, 18.15). Re-plan sets
   * `pending`; Stop sets `failed` with a `cancelled` note. A serializer abort
   * surfaces `spec-write-failed` and leaves state unchanged (Req 6.5).
   */
  private async applyControlAction(
    req: RunRequest,
    transition: Transition,
  ): Promise<DispatchResult> {
    const note = req.action === 'stop' ? 'cancelled' : undefined;
    const wrote = await this.deps.specStore.writeState(
      req.slug,
      req.todoId,
      transition.onSuccess,
      note,
    );
    if (!wrote) {
      return this.refuse({
        kind: 'spec-write-failed',
        message: `could not write "${transition.onSuccess}" for "${req.todoId}"`,
      });
    }
    return { ok: true, outcome: { kind: 'control-applied', state: transition.onSuccess } };
  }

  /**
   * Evaluate a transition's guards against live state. Plan requires approval +
   * unblocked (Req 18.1, 18.2). Execute requires the approval-hash gate (Req
   * 5.3, 5.4), a clean tree (Req 17.2, 17.3, 18.8), and a matching Input_Rev; a
   * mismatch reverts the todo to `pending` and refuses (Req 18.9).
   */
  private async checkGuards(
    req: RunRequest,
    transition: Transition,
  ): Promise<{ ok: true } | { ok: false; error: DispatchError }> {
    if (transition.guards.approvedAndUnblocked) {
      if (!(await this.deps.specStore.isApproved(req.slug))) {
        return {
          ok: false,
          error: { kind: 'not-approved', message: 'spec is not approved; planning is not allowed' },
        };
      }
      if (await this.deps.specStore.isBlocked(req.slug, req.todoId)) {
        return {
          ok: false,
          error: { kind: 'blocked', message: `todo "${req.todoId}" is blocked by unmet dependencies` },
        };
      }
    }

    if (transition.guards.cleanTreeAndInputRev) {
      // The approval-hash gate also protects Execute (Req 5.3, 5.4).
      if (!(await this.deps.specStore.isApproved(req.slug))) {
        return {
          ok: false,
          error: { kind: 'not-approved', message: 'spec approval is stale; re-approve before executing' },
        };
      }
      // Clean tree required except changes confined to the spec folder (Req
      // 16.1, 17.2, 17.3).
      if (!(await this.deps.git.isCleanExceptSpecFolder(req.slug))) {
        return {
          ok: false,
          error: { kind: 'dirty-tree', message: 'a clean working tree is required to execute' },
        };
      }
      // Input_Rev mismatch reverts the todo to `pending` with a note and does
      // not start executing (Req 18.9).
      if (!(await this.deps.specStore.inputRevMatches(req.slug, req.todoId))) {
        await this.deps.specStore.writeState(
          req.slug,
          req.todoId,
          'pending',
          'plan input changed; re-plan required',
        );
        return {
          ok: false,
          error: {
            kind: 'input-rev-mismatch',
            message: `plan input for "${req.todoId}" changed; reverted to pending`,
          },
        };
      }
    }

    return { ok: true };
  }

  /**
   * Launch the stage, await its outcome, and apply the terminal lifecycle:
   * write the running state, journal start, launch, await, then on `completed`
   * commit (Execute) with drift check, apply the terminal state, run the
   * post-run reset for non-executor stages, and journal completion. A
   * non-`completed` outcome halts and leaves state (Req 12.6, 14.7).
   */
  private async launchAndComplete(
    req: RunRequest,
    transition: Transition,
    stage: Stage,
    adapter: Adapter,
  ): Promise<DispatchResult> {
    const runId = this.newRunId(req);
    const sessionId = this.newSessionId();
    const { model, effort } = this.deps.modelForRole(req.role);

    // 0. Assemble the Brief's Context section from the spec and the todo's own
    //    artifacts (Req 18.3). This runs before any state write, so a stage
    //    that cannot be briefed — Execute or Review with no plan on file —
    //    refuses with the todo's state untouched, exactly like a guard.
    const briefContext = await this.buildBriefContext(req, stage);
    if (!briefContext.ok) {
      return this.refuse(briefContext.error);
    }

    // 1. Write the running state and commit the metadata before launch (Req
    //    17.1). A serializer abort halts before launching (Req 6.5).
    if (transition.running !== undefined) {
      const wrote = await this.deps.specStore.writeState(
        req.slug,
        req.todoId,
        transition.running,
      );
      if (!wrote) {
        return this.refuse({
          kind: 'spec-write-failed',
          message: `could not write "${transition.running}" for "${req.todoId}"`,
        });
      }
    }

    // 2. Record the starting HEAD for the drift check and the journal (Req
    //    17.2, 21.1) and the launch time, which bounds the adapter's search for
    //    the session the CLI mints for itself (Req 3.2).
    const launchedAt = this.clock();
    const startHead = await this.safeHead();
    const startBranch = await this.safeBranch();
    const inputRev = await this.deps.specStore.inputRev(req.slug, req.todoId);

    // 3. Launch the stage (Req 11). A launch failure halts and leaves state.
    //    Adapters whose CLI mints its own session ids (opencode) first map the
    //    journaled Baiton Session_Id to the CLI's own; an unresolved id is
    //    dropped so the adapter falls back to its "most recent session" flag
    //    instead of failing on an id the CLI has never seen.
    const resumeSessionId = await resolveResumeSessionId(
      adapter,
      req,
      this.deps.workspaceRoot,
    );
    const launchInput: LaunchStageInput = {
      workspaceRoot: this.deps.workspaceRoot,
      runId,
      stage,
      role: req.role,
      model,
      effort,
      resume: req.resume,
      sessionId,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(briefContext.value !== undefined
        ? { briefContext: briefContext.value }
        : {}),
      ...(this.deps.askWatcherFactory !== undefined ? { relayAsks: true } : {}),
    };
    const launched = launchStage(launchInput, {
      adapter,
      terminalHost: this.deps.terminalHost,
    });
    if (!launched.ok) {
      return this.refuse({
        kind: 'launch-failed',
        message: `stage launch failed: ${launched.error.message}`,
      });
    }
    const { terminal, resultPath, relay } = launched.value;

    // 4. Journal the start (Req 21.1). The pid is best-effort.
    const terminalPid = await resolvePid(terminal);
    appendStart(this.deps.journalPath, {
      runId,
      todoId: req.todoId,
      stage,
      attempt: req.attempt,
      startHead,
      inputRev,
      ...(terminalPid !== undefined ? { terminalPid } : {}),
      fromState: transition.from,
      sessionId,
    });

    // 5. Watch for the result and await the terminal outcome (Req 12). `stop()`
    //    flips `cancelled` so a disposed terminal records cancellation.
    let cancelled = false;
    const watcher = this.deps.watcherFactory.create({
      slug: req.slug,
      runId,
      resultPath,
      terminal,
    });
    this.running = {
      runId,
      slug: req.slug,
      todoId: req.todoId,
      sessionId,
      terminal,
      cancel: () => {
        cancelled = true;
      },
    };
    let askWatcher: AskWatcher | undefined;
    if (this.deps.askWatcherFactory !== undefined && relay !== undefined) {
      try {
        askWatcher = this.deps.askWatcherFactory.create({
          slug: req.slug,
          todoId: req.todoId,
          runId,
          agent: adapter.id,
          asksDir: relay.dir,
        });
      } catch {
        // A host watcher must never prevent an already-launched run from completing.
      }
    }

    let outcome: RunOutcome;
    try {
      outcome = await awaitStageResult(
        {
          workspaceRoot: this.deps.workspaceRoot,
          slug: req.slug,
          stage,
          todoId: req.todoId,
          index: req.attempt,
          terminal,
          watcher,
        },
        {
          reportInvalid: (detail) =>
            this.report({ kind: 'outcome', outcome: { kind: 'invalid_output', detail }, message: detail }),
        },
      );
    } finally {
      askWatcher?.dispose();
      this.running = undefined;
    }

    // A Stop during the run turns any resolved outcome into `cancelled`.
    if (cancelled) {
      outcome = { kind: 'cancelled' };
    }

    // Recover the session id the CLI actually minted, for adapters that ignore
    // the one Baiton pre-assigned (Req 3.2). This runs for every outcome kind,
    // not just `completed`: a run that closed without a result is exactly the
    // one a user wants to resume, and its session exists all the same.
    const discoveredSessionId = await this.discoverSessionId(adapter, runId, launchedAt);

    return this.applyOutcome(
      req,
      transition,
      stage,
      runId,
      startHead,
      startBranch,
      outcome,
      resultPath,
      discoveredSessionId,
    );
  }

  /**
   * Assemble the Brief's Context section for a stage (Req 18.3), reading the
   * spec and the todo's own artifacts through the {@link SpecStore} seam.
   *
   * Each role gets exactly what it needs and nothing else — the planner the
   * OVERVIEW, its todo line and its dependencies' execution summaries; the
   * executor its todo line and plan; the reviewer those plus the execution
   * summary and the commit it landed in — so no sub-agent has to read `spec.md`
   * or another todo's artifacts.
   *
   * Execute and Review consume a plan, so a todo with no `todos/<id>/plan.md`
   * refuses here rather than launching a sub-agent that would have to guess.
   * Plan needs no artifact: a dependency with no execution summary simply
   * contributes nothing. An unreadable spec yields no context rather than a
   * refusal — the stage still launches with the four required Brief sections.
   */
  private async buildBriefContext(
    req: RunRequest,
    stage: Stage,
  ): Promise<{ ok: true; value: string | undefined } | { ok: false; error: DispatchError }> {
    const store = this.deps.specStore;
    const contextStage = stage as ContextStage;

    // Execute and Review are briefed from the plan; without one there is
    // nothing to implement or to review against (see the View plan action).
    let plan: string | undefined;
    if (contextStage !== 'plan') {
      plan = await store.readArtifact(req.slug, req.todoId, 'plan');
      const missing = plan === undefined || plan.trim() === '';
      if (missing && (contextStage === 'execute' || contextStage === 'review')) {
        return {
          ok: false,
          error: {
            kind: 'launch-failed',
            message: `no plan on file for "${req.todoId}"; run Plan first`,
          },
        };
      }
    }

    const spec = await store.readSpec(req.slug);
    if (spec === undefined) {
      return { ok: true, value: undefined };
    }

    switch (contextStage) {
      case 'plan': {
        // Only the target's own `after` targets are consulted; every other
        // todo's artifacts are never read, which is the confinement rule.
        const target = spec.todos.find((t) => t.id === req.todoId);
        const afterExecutes: Record<string, string> = {};
        for (const depId of target?.after ?? []) {
          const summary = await store.readArtifact(req.slug, depId, 'execute');
          if (summary !== undefined) {
            afterExecutes[depId] = summary;
          }
        }
        return {
          ok: true,
          value: buildStageContext({
            stage: 'plan',
            spec,
            todoId: req.todoId,
            afterExecutes,
          }),
        };
      }
      case 'execute': {
        // A retry or a resumed session carries the latest review so the
        // executor knows what it has to fix (Req 13.2, 18.13).
        const retry = req.attempt >= 2 || req.resume;
        const latestReview = retry
          ? await store.readArtifact(req.slug, req.todoId, 'review')
          : undefined;
        return {
          ok: true,
          value: buildStageContext({
            stage: 'execute',
            spec,
            todoId: req.todoId,
            attempt: req.attempt,
            resume: req.resume,
            ...(plan !== undefined ? { plan } : {}),
            ...(latestReview !== undefined ? { latestReview } : {}),
          }),
        };
      }
      case 'review': {
        const latestExecute = await store.readArtifact(
          req.slug,
          req.todoId,
          'execute',
        );
        const executeCommit = await store.latestExecuteCommit(
          req.slug,
          req.todoId,
        );
        return {
          ok: true,
          value: buildStageContext({
            stage: 'review',
            spec,
            todoId: req.todoId,
            ...(plan !== undefined ? { plan } : {}),
            ...(latestExecute !== undefined ? { latestExecute } : {}),
            ...(executeCommit !== undefined ? { executeCommit } : {}),
          }),
        };
      }
      default:
        return {
          ok: true,
          value: buildStageContext({
            stage: 'plan-review',
            spec,
            todoId: req.todoId,
            ...(plan !== undefined ? { plan } : {}),
          }),
        };
    }
  }

  /**
   * Apply a stage's terminal outcome. Only `completed` counts as an attempt and
   * advances the lifecycle (Req 14.6, 14.7, 18.17): it commits the execution
   * (Execute) after a drift check, applies the terminal state, runs the
   * post-run reset for non-executor stages, and journals completion. Any other
   * outcome halts, leaves state, and journals the non-completing kind.
   *
   * `resultPath` is the run's `result.json`; a `closed` outcome whose result
   * file never appeared gets {@link MISSING_RESULT_HINT} appended to the
   * refusal so a mis-permissioned sub-agent profile is diagnosable — unless it
   * was an Execute that left work in the tree, which gets
   * {@link PRESERVED_CHANGES_HINT} instead (see below).
   *
   * `discoveredSessionId` is the id the CLI minted for this run, when the
   * adapter could recover one; it is journaled with the completion record so a
   * later Execute can resume that session (Req 3.2).
   */
  private async applyOutcome(
    req: RunRequest,
    transition: Transition,
    stage: Stage,
    runId: string,
    startHead: string,
    startBranch: string,
    outcome: RunOutcome,
    resultPath: string,
    discoveredSessionId?: string,
  ): Promise<DispatchResult> {
    // Every completion record for this run carries the discovered session id,
    // whatever the outcome kind.
    const journalDone = (result: RunResultKind, commit?: string): void => {
      appendCompletion(this.deps.journalPath, {
        runId,
        result,
        ...(commit !== undefined ? { commit } : {}),
        ...(discoveredSessionId !== undefined ? { discoveredSessionId } : {}),
      });
    };

    if (outcome.kind !== 'completed') {
      // Halt and journal the non-completing kind (Req 12.6, 14.7). A `closed`
      // or `cancelled` outcome additionally reverts the todo to the state the
      // stage launched from (Req 1.1, 1.4); `invalid_output` leaves state
      // unchanged (unreachable today — the flow keeps waiting for a valid
      // result — but kept as the conservative default).
      journalDone(outcome.kind as RunResultKind);

      if (
        transition.running !== undefined &&
        (outcome.kind === 'cancelled' || outcome.kind === 'closed')
      ) {
        const note =
          outcome.kind === 'cancelled' ? 'cancelled' : closedNote(outcome.exitCode);
        const wrote = await this.deps.specStore.writeState(
          req.slug,
          req.todoId,
          transition.from,
          note,
        );
        if (!wrote) {
          return this.refuse({
            kind: 'spec-write-failed',
            message: `could not write "${transition.from}" for "${req.todoId}"`,
          });
        }
        const detail =
          outcome.kind === 'closed' && outcome.exitCode !== undefined
            ? ` (exit ${outcome.exitCode})`
            : '';
        // A `closed` outcome with no result file on disk is almost always a
        // permission problem: the sub-agent's CLI profile would not let it
        // write `.baiton/runs/<run-id>/result.json`, so it answered in the
        // terminal and exited cleanly. Name that cause rather than leaving the
        // user with a bare "closed (exit 0)" (see the opencode adapter's
        // `OPENCODE_CONFIG_CONTENT` grant and the antigravity plan-mode note).
        //
        // An Execute that closed without a result but DID change the tree is a
        // different animal: the executor plainly did the work and simply never
        // wrote the result file. Its changes are never reset or discarded here
        // — the post-run reset runs only for non-executor stages on a
        // `completed` outcome — so say so, and point at the re-run, instead of
        // blaming permissions.
        const missingResult = outcome.kind === 'closed' && !resultFileExists(resultPath);
        const preservedChanges =
          missingResult && stage === 'execute' && (await this.workingTreeChanged(startHead));
        const hint = preservedChanges
          ? PRESERVED_CHANGES_HINT
          : missingResult
            ? MISSING_RESULT_HINT
            : '';
        return this.refuse({
          kind: 'outcome',
          outcome,
          message: `stage ${outcome.kind}${detail}; "${req.todoId}" reverted to "${transition.from}"${hint}`,
        });
      }

      return this.refuse({
        kind: 'outcome',
        outcome,
        message: `stage produced "${outcome.kind}"; state left unchanged`,
      });
    }

    // Execute: commit the working-tree changes with a `Run-Id:` trailer, but
    // only after confirming HEAD/branch did not drift during the run (Req 17.4,
    // 17.6). A drift halts with `git_state_changed` and leaves state unchanged.
    let commit: string | undefined;
    if (stage === 'execute') {
      const drifted = await this.headOrBranchDrifted(startHead, startBranch);
      if (drifted) {
        journalDone('completed');
        return this.refuse({
          kind: 'git-state-changed',
          message: 'HEAD or branch changed during execute; stage halted (git_state_changed)',
        });
      }
      const message = `spec(${req.slug}): ${req.todoId} execute attempt ${req.attempt}`;
      commit = await this.safeCommit(message, { 'Run-Id': runId });
    }

    // Apply the terminal lifecycle state (Req 18.1, 18.7, 18.12, 18.13). Review
    // branches on the reviewer's verdict.
    const terminalState = this.terminalStateFor(transition, stage, outcome);
    if (terminalState !== undefined) {
      const wrote = await this.deps.specStore.writeState(req.slug, req.todoId, terminalState);
      if (!wrote) {
        journalDone('completed', commit);
        return this.refuse({
          kind: 'spec-write-failed',
          message: `could not write "${terminalState}" for "${req.todoId}"`,
        });
      }
    }

    // Post-run reset for non-executor stages: restore the tree to the run's
    // starting commit; a non-zero reset halts before the next stage (Req 15.5,
    // 15.6). The executor's changes are preserved by its own commit above.
    if (stage !== 'execute') {
      const reset = await this.deps.git.resetWorkingTree();
      if (!reset.ok) {
        journalDone('completed', commit);
        return this.refuse({
          kind: 'reset-failed',
          message: `working tree was not restored: ${reset.error.command} exited ${String(reset.error.exitCode)}`,
        });
      }
    }

    // Journal the completion with the resulting commit (Req 21.2).
    journalDone('completed', commit);

    return { ok: true, outcome };
  }

  /**
   * The terminal lifecycle state a completed stage applies. Plan → `planned`;
   * Execute → `executed`; Review → `done` on a `pass` verdict, `executed` on
   * `findings` (Req 18.12, 18.13). Returns `undefined` when the transition has
   * no running phase (control actions, handled elsewhere).
   */
  private terminalStateFor(
    transition: Transition,
    stage: Stage,
    outcome: Extract<RunOutcome, { kind: 'completed' }>,
  ): TodoState | undefined {
    if (stage === 'review' && transition.onFindings !== undefined) {
      const verdict = readVerdict(outcome.structured);
      return verdict === 'pass' ? transition.onSuccess : transition.onFindings;
    }
    return transition.onSuccess;
  }

  /**
   * The session id the CLI minted for a run, via the adapter's optional
   * discovery hook (Req 3.2). Adapters whose CLI honours Baiton's pre-assigned
   * id implement no hook, and a hook that cannot find the session answers
   * `undefined`; either way the run is journaled without a discovered id.
   * Never throws — discovery is best effort and must not affect the outcome.
   */
  private async discoverSessionId(
    adapter: Adapter,
    runId: string,
    launchedAt: number,
  ): Promise<string | undefined> {
    if (adapter.discoverSessionId === undefined) {
      return undefined;
    }
    try {
      const id = await adapter.discoverSessionId({
        runId,
        workspaceRoot: this.deps.workspaceRoot,
        launchedAt,
      });
      return id !== undefined && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the working tree differs from the run's starting commit — the
   * evidence that a stage which wrote no result still did work. Uses the same
   * git seam as the drift check; a git failure reads as "no changes", the
   * conservative answer (it only suppresses a hint).
   */
  private async workingTreeChanged(startHead: string): Promise<boolean> {
    if (startHead.length === 0) {
      return false;
    }
    try {
      const diff = await this.deps.git.diffAgainstWorkingTree(startHead);
      return diff.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Whether HEAD or the current branch drifted from the recorded start (Req 17.6). */
  private async headOrBranchDrifted(startHead: string, startBranch: string): Promise<boolean> {
    const head = await this.safeHead();
    const branch = await this.safeBranch();
    return head !== startHead || branch !== startBranch;
  }

  /** Refuse a dispatch: report the error and resolve with it. */
  private refuse(error: DispatchError): DispatchResult {
    this.report(error);
    return { ok: false, error };
  }

  /** Read HEAD, tolerating a git failure by returning an empty marker. */
  private async safeHead(): Promise<string> {
    try {
      return await this.deps.git.head();
    } catch {
      return '';
    }
  }

  /** Read the current branch, tolerating a git failure. */
  private async safeBranch(): Promise<string> {
    try {
      return await this.deps.git.currentBranch();
    } catch {
      return '';
    }
  }

  /** Commit, tolerating a git failure by returning `undefined`. */
  private async safeCommit(
    message: string,
    trailers: Record<string, string>,
  ): Promise<string | undefined> {
    try {
      return await this.deps.git.commit(message, trailers);
    } catch {
      return undefined;
    }
  }
}

/**
 * Read a review result's verdict from its structured output. The result was
 * already schema-validated by the result flow, so a well-formed review carries
 * a `verdict` of `pass` or `findings`; anything else is treated as `findings`
 * (the conservative, non-advancing branch).
 */
function readVerdict(structured: unknown): 'pass' | 'findings' {
  if (
    typeof structured === 'object' &&
    structured !== null &&
    (structured as { verdict?: unknown }).verdict === 'pass'
  ) {
    return 'pass';
  }
  return 'findings';
}

/** The note recorded on a revert for a `closed` outcome (Req 1.1). */
function closedNote(exitCode: number | undefined): string {
  return exitCode !== undefined ? `closed (exit ${exitCode})` : 'closed (no exit code)';
}

/**
 * Appended to a `closed` refusal when the run wrote no `result.json`: the
 * common cause is a sub-agent launched under a CLI permission profile that
 * forbids writing the run directory (the opencode `--agent plan` bug).
 */
export const MISSING_RESULT_HINT =
  '; the agent exited without writing result.json — check that its permission profile allows writes to the run directory';

/**
 * Appended instead of {@link MISSING_RESULT_HINT} when an Execute closed with
 * no `result.json` but left changes against the run's starting commit: the
 * executor did the work and only missed the last step, so the refusal says the
 * changes were kept (nothing is reset or discarded on this path) and that
 * re-running Execute picks up where it left off — resuming the CLI session when
 * one was discovered for the run (Req 3.2).
 */
export const PRESERVED_CHANGES_HINT =
  '; the executor exited without writing result.json but left changes in the working tree — those changes were preserved (nothing was reset or discarded). Re-run Execute to finish the todo; it resumes the executor\'s session when one was discovered.';

/** Whether the run's `result.json` exists on disk; any fs error reads as absent. */
function resultFileExists(resultPath: string): boolean {
  try {
    return fs.existsSync(resultPath);
  } catch {
    return false;
  }
}

/** Best-effort resolution of a terminal's process id for the journal (Req 21.1). */
async function resolvePid(terminal: HostTerminal): Promise<number | undefined> {
  try {
    return await terminal.processId;
  } catch {
    return undefined;
  }
}

/**
 * The default run-id generator: a stable composite of the request identity and
 * the injected clock so concurrent-looking runs never collide while staying
 * deterministic under a test clock. The activation layer may inject a UUID
 * generator instead.
 */
function defaultRunId(req: RunRequest, clock: Clock): string {
  const stage = stageForAction(req.action) ?? req.action;
  return `${req.slug}-${req.todoId}-${stage}-${req.attempt}-${clock()}`;
}

/**
 * The Session_Id to hand the adapter for a resume: the request's own when the
 * adapter has no id mapping, otherwise the adapter's resolution of it (which
 * may be `undefined` when the CLI has no session tagged with that id). Never
 * throws — a resolution failure is treated as "unknown".
 */
async function resolveResumeSessionId(
  adapter: Adapter,
  req: RunRequest,
  cwd: string,
): Promise<string | undefined> {
  if (!req.resume || req.resumeSessionId === undefined || req.resumeSessionId.length === 0) {
    return req.resumeSessionId;
  }
  if (adapter.resolveSessionId === undefined) {
    return req.resumeSessionId;
  }
  try {
    return await adapter.resolveSessionId(req.resumeSessionId, cwd);
  } catch {
    return undefined;
  }
}
