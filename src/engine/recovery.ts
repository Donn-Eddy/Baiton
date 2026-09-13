/**
 * Crash recovery over the run journal (Requirements 21.3, 21.4, 21.5, 21.7;
 * design "Recovery").
 *
 * A stage runs in a VS Code terminal that outlives no single tick: if the host
 * process dies (window reload, crash, power loss) mid-stage, the journal is
 * left with a START record and no COMPLETION record. On the next activation the
 * extension must reconcile every such result-less entry rather than leave the
 * todo wedged in a running state (`planning`/`executing`/`reviewing`) forever.
 *
 * {@link recoverJournal} reads `runs.jsonl` via {@link parseJournal}, selects
 * the entries with no `result` (Req 21.3), and for each one, in order:
 *
 *   1. If the entry recorded a `terminalPid` and a process with that id is
 *      still alive, terminate it before reconciling — a leftover sub-agent must
 *      not keep mutating the tree while we reconcile (Req 21.4).
 *   2. If a commit carrying the run's `Run-Id` trailer landed (the git seam's
 *      {@link GitService.findCommitByRunId} returns a sha), treat the work as
 *      landed and replay the lost lifecycle state write — the stage's success
 *      state (Req 21.5).
 *   3. Otherwise the work did not land: set the todo `failed` with note
 *      `host exited` (Req 21.7).
 *
 * The PR-run reconciliation branch (Req 21.6) is deferred with the rest of the
 * PR stage; a first-pass journal never records a PR run, so a landed/absent
 * `Run-Id` commit fully decides every entry here.
 *
 * Everything host-specific is injected — the journal path, the git seam, a
 * process-control seam (liveness + kill), and the serializer-backed spec-write
 * seam — so recovery is unit-testable without real PIDs or `vscode`. The
 * activation layer wires the real implementations.
 */
import type { GitService } from '../git';
import type { JournalEntry } from '../journal';
import { parseJournal } from '../journal';
import type { SpecStore } from './runQueue';
import type { TodoState } from '../model/todoState';
import type { Stage } from '../model/stage';

/**
 * The process-control seam recovery uses to reconcile a still-live sub-agent
 * (Req 21.4). Kept behind an interface so tests exercise the kill decision with
 * fabricated pids and no real processes. The activation layer wires this to
 * `process.kill(pid, 0)` for liveness and `process.kill(pid)` (or a terminal
 * dispose) for termination.
 */
export interface ProcessControl {
  /**
   * Whether a process with `pid` is currently alive. Implementations typically
   * probe with signal `0`; any failure (no such process, or not permitted to
   * signal it) is reported as not alive.
   */
  isAlive(pid: number): boolean;
  /**
   * Terminate the process with `pid`. Best-effort: an already-dead pid or a
   * failed signal is swallowed so reconciliation continues.
   */
  kill(pid: number): void;
}

/** How a single result-less entry was reconciled, for reporting/tests. */
export type RecoveryAction =
  /** A still-live recorded pid was terminated before reconciling (Req 21.4). */
  | 'killed-process'
  /** A `Run-Id` commit landed; the stage's success state was replayed (Req 21.5). */
  | 'replayed-state'
  /**
   * No commit landed and the entry carries `fromState`: that From_State was
   * written with the `host exited` note instead of `failed` (Req 1.3).
   */
  | 'reverted-state'
  /**
   * No commit landed and the entry predates `fromState` (a legacy entry): the
   * todo was set `failed` with note `host exited`, as before (Req 21.7).
   */
  | 'marked-failed'
  /** The entry needed no state write (e.g. a stage with no lifecycle state, or a write abort). */
  | 'no-op';

/** The outcome of reconciling one result-less journal entry. */
export interface RecoveryOutcome {
  /** The run id of the reconciled entry. */
  readonly runId: string;
  /** The todo the entry acted on. */
  readonly todoId: string;
  /** The stage the entry was running. */
  readonly stage: Stage;
  /** Whether a still-live recorded pid was terminated first (Req 21.4). */
  readonly killedPid: boolean;
  /** The reconciliation applied to the todo state. */
  readonly action: RecoveryAction;
  /** The `Run-Id` commit sha when the work landed (Req 21.5), else undefined. */
  readonly commit?: string;
}

/** Everything {@link recoverJournal} needs, all injectable for testing. */
export interface RecoveryDeps {
  /** The spec slug whose journal is being reconciled. */
  slug: string;
  /** Absolute path of the run journal `runs.jsonl` (Req 21.3). */
  journalPath: string;
  /** The git seam; only {@link GitService.findCommitByRunId} is used (Req 21.5). */
  git: Pick<GitService, 'findCommitByRunId'>;
  /** The process-control seam for the still-live-pid kill (Req 21.4). */
  process: ProcessControl;
  /** The serializer-backed spec-write seam; only {@link SpecStore.writeState} is used. */
  specStore: Pick<SpecStore, 'writeState'>;
}

/** The note recorded on a todo whose host exited without the work landing (Req 21.7). */
export const HOST_EXITED_NOTE = 'host exited';

/**
 * Reconcile every result-less journal entry on activation (Req 21.3–21.7).
 *
 * Reads the journal, filters to entries with no `result`, and reconciles each
 * in journal order. Returns one {@link RecoveryOutcome} per reconciled entry so
 * the activation layer can surface what recovery did. Never throws: a git or
 * spec-write failure for one entry is contained so the remaining entries are
 * still reconciled.
 */
export async function recoverJournal(deps: RecoveryDeps): Promise<RecoveryOutcome[]> {
  const entries = parseJournal(deps.journalPath).filter(isResultLess);
  const outcomes: RecoveryOutcome[] = [];
  for (const entry of entries) {
    outcomes.push(await reconcileEntry(deps, entry));
  }
  return outcomes;
}

/** An entry with no recorded completion result is the recovery target (Req 21.3). */
function isResultLess(entry: JournalEntry): boolean {
  return entry.result === undefined;
}

/**
 * Reconcile a single result-less entry: kill a still-live pid (Req 21.4), then
 * replay the landed state (Req 21.5) or mark the todo failed (Req 21.7).
 */
async function reconcileEntry(
  deps: RecoveryDeps,
  entry: JournalEntry,
): Promise<RecoveryOutcome> {
  // 1. Terminate a still-live recorded process before reconciling (Req 21.4).
  const killedPid = killIfAlive(deps.process, entry.terminalPid);

  // 2. If a commit carrying this run's `Run-Id` landed, the work is done —
  //    replay the stage's success state write (Req 21.5).
  const commit = await findLandedCommit(deps.git, entry.runId);
  if (commit !== undefined) {
    const successState = successStateFor(entry.stage);
    const action = await applyState(deps, entry, successState);
    return {
      runId: entry.runId,
      todoId: entry.todoId,
      stage: entry.stage,
      killedPid,
      action: action === 'wrote' ? 'replayed-state' : 'no-op',
      commit,
    };
  }

  // 3. No commit landed: the host exited before the work completed. When the
  //    entry recorded the From_State it launched from, revert to that state
  //    with the `host exited` note (Req 1.3); a legacy entry without
  //    `fromState` is set `failed` as before (Req 21.7).
  const revertTo = entry.fromState ?? 'failed';
  const action = await applyState(deps, entry, revertTo, HOST_EXITED_NOTE);
  return {
    runId: entry.runId,
    todoId: entry.todoId,
    stage: entry.stage,
    killedPid,
    action:
      action === 'wrote'
        ? entry.fromState !== undefined
          ? 'reverted-state'
          : 'marked-failed'
        : 'no-op',
  };
}

/**
 * Terminate a recorded pid when it is still alive (Req 21.4). Returns whether a
 * kill was issued. A missing pid or a dead pid is a no-op.
 */
function killIfAlive(control: ProcessControl, pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  if (!control.isAlive(pid)) {
    return false;
  }
  control.kill(pid);
  return true;
}

/**
 * Look up a landed commit for a run id, tolerating a git failure by reporting
 * "not landed" so recovery falls through to the `host exited` branch rather
 * than throwing (Req 21.5, 21.7).
 */
async function findLandedCommit(
  git: Pick<GitService, 'findCommitByRunId'>,
  runId: string,
): Promise<string | undefined> {
  try {
    return await git.findCommitByRunId(runId);
  } catch {
    return undefined;
  }
}

/**
 * The lifecycle success state a completed stage would have written, replayed
 * on recovery when the run's commit landed (Req 21.5): `plan` → `planned`,
 * `execute` → `executed`, `review` → `done`. `plan-review` runs inside the Plan
 * action and moves no lifecycle state of its own, so it has no success state to
 * replay (the todo is left in `planning` for the next trigger).
 */
function successStateFor(stage: Stage): TodoState | undefined {
  switch (stage) {
    case 'plan':
      return 'planned';
    case 'execute':
      return 'executed';
    case 'review':
      return 'done';
    case 'plan-review':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Apply a recovery state write through the serializer seam, tolerating a git or
 * serializer failure. Returns `'wrote'` when the write landed, `'skipped'` when
 * there was no state to write, and `'skipped'` when the write aborted (the
 * target could not be located) so the caller records a `no-op` rather than
 * claiming a state change (Req 6.5).
 */
async function applyState(
  deps: RecoveryDeps,
  entry: JournalEntry,
  state: TodoState | undefined,
  note?: string,
): Promise<'wrote' | 'skipped'> {
  if (state === undefined) {
    return 'skipped';
  }
  try {
    const wrote = await deps.specStore.writeState(deps.slug, entry.todoId, state, note);
    return wrote ? 'wrote' : 'skipped';
  } catch {
    return 'skipped';
  }
}
