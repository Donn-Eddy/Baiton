/**
 * The spec-less run pipeline (host-free core).
 *
 * One confirmed dispatch from the chat's run tool becomes one run here. `bug`,
 * `quick` and `refactor` drive plan -> execute -> review in the run's OWN
 * worktree (`.baiton/worktrees/<run-id>/` on `baiton/<mode>/<run-id>`), looping
 * back to execute while the reviewer reports findings; `investigate` runs one
 * read-only stage from the main checkout and ends in a written finding.
 *
 * Two roots are in play per run, and mixing them corrupts the layout:
 *
 *   - The run's manifest, journal and stage artifacts live in the MAIN checkout
 *     under `.baiton/runs/<run-id>/` (`run.json`, `runs.jsonl`, `plan.md`,
 *     `execute-<n>.md`, `review-<n>.md`, `finding.md`).
 *   - Each stage LAUNCH resolves under the run's worktree, because
 *     `launchStage({ cwd })` is given the worktree directory: its brief, result
 *     and asks files land in `<worktree>/.baiton/runs/<launch-id>/`, so the role
 *     profiles' RELATIVE `.baiton/runs/<launch-id>/` grants still point at the
 *     directory the launcher wrote. An `investigate` launch has no `cwd` and so
 *     resolves under the main checkout; such a run touches git only in `start()`
 *     (to record the base branch and head) and reports its finding through the
 *     `onFinding` sink.
 *
 * Nothing here ever reads or writes anything under `.baiton/specs/`: a spec-less
 * run has no spec and no todo, so the run id stands in for a todo id everywhere
 * the spec pipeline would use one (the journal's `todoId`, `awaitStageResult`'s
 * `todoId`).
 *
 * It holds the one-stage-per-repository lock from both sides, exactly as
 * `specDraft.ts` does: `start()` refuses `busy` while a spec queue or the
 * spec-draft runner has a stage in flight (`isSpecBusy`), and `isRunning()` is
 * what activation feeds back to `RunQueueDeps.isExternallyBusy` (Req 20.1).
 *
 * Every expected failure is a returned value, never a throw, and everything
 * host-specific is injected — the per-role adapter lookup, the terminal host,
 * the watcher factories, git, the per-role model lookup and the completion sink
 * — so the pipeline is unit testable without `vscode`.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

import type { Adapter } from '../adapter';
import type { Role } from '../model/role';
import { type RunMode, isSpecless } from '../model/mode';
import type { GitWorktreeService } from '../git/types';
import type { InvestigateResult } from '../schema';
import { appendCompletion, appendStart, type RunResultKind } from '../journal';
import { launchStage, type LaunchStageInput } from './launcher';
import { awaitStageResult, type RunOutcome } from './resultFlow';
import { buildRunContext } from './runContext';
import { createRunGitService, createRunWorktree, type RunWorktreeError } from './runWorktree';
import {
  newRunId as defaultNewRunId,
  runArtifactPathFor,
  runArtifactWriter,
  runJournalPathFor,
  type RunManifest,
  type RunOutcomeRecord,
  type RunStage,
  type RunState,
  type RunStore,
} from './runStore';
import type { AskWatcher, AskWatcherFactory, ResultWatcherFactory } from './runQueue';
import type { HostTerminal, TerminalHost } from './terminalHost';
import type { Unsubscribe } from './resultWatcher';

/**
 * The role each run stage launches as. `investigate` deliberately reuses the
 * existing `reviewer` role — read + shell, writes confined to the run directory
 * — so a read-only investigation needs no new role and no config migration.
 */
export const ROLE_FOR_RUN_STAGE: Record<RunStage, Role> = {
  plan: 'planner',
  execute: 'executor',
  review: 'reviewer',
  investigate: 'reviewer',
};

/** The execute-attempt ceiling when none is injected; `defaultConfig`'s value. */
export const DEFAULT_EXEC_ATTEMPTS = 3;

/**
 * The commit message one execute attempt lands under, the analogue of the
 * queue's `spec(<slug>): <todoId> execute attempt <n>`.
 */
export function runExecuteCommitMessage(mode: RunMode, runId: string, attempt: number): string {
  return `${mode}(${runId}): execute attempt ${attempt}`;
}

/**
 * The commit trailer key every execute commit carries. The trailer VALUE is the
 * RUN id, not the launch id: `runMergeMessage` in `runWorktree.ts` documents
 * that the eventual merge carries the same `Run-Id: <run-id>` trailer, so
 * `findCommitByRunId(runId)` finds both the execute commits and the merge.
 */
export const RUN_ID_TRAILER = 'Run-Id';

/** One confirmed dispatch from the chat's run tool. */
export interface RunPipelineRequest {
  /** The mode the run executes as; never 'spec' or 'default'. */
  mode: RunMode;
  /** What the composer's Mode select said when the run was confirmed (may be 'default'). */
  composerMode: RunMode;
  /** True when the orchestrator proposed a mode other than composerMode. */
  explicitMode: boolean;
  statement: string;
  files: string[];
  reproduction?: string;
}

/** Why a run never started; nothing was written and no worktree exists. */
export type RunPipelineRefusal =
  | { kind: 'busy'; message: string }
  | { kind: 'invalid-mode'; message: string }
  | { kind: 'detached-head'; message: string }
  | { kind: 'no-base-head'; message: string }
  | { kind: 'manifest'; message: string }
  | { kind: 'worktree'; message: string; error?: RunWorktreeError };

export type RunPipelineStart =
  | { ok: true; runId: string; manifest: RunManifest; completed: Promise<RunPipelineOutcome> }
  | { ok: false; error: RunPipelineRefusal };

/** How a run ended, reported to `onComplete` and resolved by `completed`. */
export interface RunPipelineOutcome {
  runId: string;
  mode: RunMode;
  /** The terminal run state: done | failed | cancelled | answered. */
  state: RunState;
  outcome: RunOutcomeRecord;
  /** The execute commits this run landed in its worktree, oldest first. */
  commits: string[];
  /** A one-line, user-facing description of the ending. */
  message: string;
  /**
   * Present exactly when an `investigate` run completed (`state: 'answered'`).
   * Every other ending, including a cancelled or failed investigate, leaves it
   * undefined.
   */
  finding?: RunFinding;
}

/**
 * The result of an `investigate` run, handed to the completion sink and
 * carried on the run's outcome. It is deliberately richer than the manifest's
 * `{ kind: 'finding', finding }` record: the chat's promote card (Bug / Quick /
 * dismiss) needs the files and next steps as well as the one-line finding, and
 * re-reading `finding.md` to recover them would parse prose back into data.
 */
export interface RunFinding {
  runId: string;
  /** Always 'investigate'; carried so a sink can switch on the mode alone. */
  mode: RunMode;
  /** The question the run was dispatched with (`manifest.statement`). */
  question: string;
  /** The files the dispatch named (`manifest.files`). */
  questionFiles: string[];
  /** The investigator's one-line finding. */
  finding: string;
  /** The files the investigator found the answer in. */
  files: string[];
  /** What the investigator suggests doing next. */
  nextSteps: string[];
  /** Repository-relative path of the rendered artifact: `.baiton/runs/<run-id>/finding.md`. */
  findingPath: string;
  /** The manifest as it stands once the run is `answered`. */
  manifest: RunManifest;
}

/** The stage currently in flight for the active run. */
export interface LiveRunStage {
  runId: string;
  /** `<run-id>.<stage>.<n>` — the id the stage launched under. */
  launchId: string;
  mode: RunMode;
  stage: RunStage;
  attempt: number;
  sessionId: string;
  terminal: HostTerminal;
}

/** What the Runs view and the chat subscribe to. */
export type RunPipelineEvent =
  | { kind: 'started'; runId: string; manifest: RunManifest }
  | { kind: 'stage-started'; runId: string; stage: RunStage; attempt: number; manifest: RunManifest }
  | {
      kind: 'stage-completed';
      runId: string;
      stage: RunStage;
      attempt: number;
      outcome: RunOutcome;
      manifest: RunManifest;
    }
  | { kind: 'completed'; runId: string; manifest: RunManifest; outcome: RunPipelineOutcome };

export interface RunPipeline {
  /** Launch a run; resolves as soon as the first stage is running or the run was refused. */
  start(req: RunPipelineRequest): Promise<RunPipelineStart>;
  /** Cancel the in-flight run; returns false when idle. Leaves the worktree and branch in place. */
  cancel(): boolean;
  /** Whether a run is in flight (the spec queue and the spec draft consult this). */
  isRunning(): boolean;
  /** The stage currently in flight, or undefined when idle. */
  currentStage(): LiveRunStage | undefined;
  /** The id of the run in flight, or undefined when idle. */
  currentRunId(): string | undefined;
  /** Subscribe to change events; the returned function unsubscribes. */
  onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe;
}

export interface RunPipelineDeps {
  /** Absolute workspace root: the MAIN checkout. Run dirs resolve under it. */
  workspaceRoot: string;
  /** Service bound to the MAIN checkout; worktree add/branchHead/currentBranch. */
  git: GitWorktreeService;
  /** The manifest store, already bound to `workspaceRoot`. */
  store: RunStore;
  terminalHost: TerminalHost;
  watcherFactory: ResultWatcherFactory;
  /** When wired, launched stages relay harness asks into chat. */
  askWatcherFactory?: AskWatcherFactory;
  modelForRole(role: Role): { model: string; effort?: string };
  adapterForRole(role: Role): Adapter | undefined;
  /** `limits.exec_attempts`, read per run; defaults to DEFAULT_EXEC_ATTEMPTS. */
  execAttempts?: () => number;
  /** `git.verify`, for the refactor brief's behaviour-preservation section. */
  verify?: () => string | undefined;
  /** True while a spec queue or the spec-draft runner has a stage in flight. */
  isSpecBusy?: () => boolean;
  /** Factory for a git service bound to the run's worktree; injected for tests. */
  createService?: (dir: string) => GitWorktreeService;
  newRunId?: (mode: RunMode) => string;
  newSessionId?: () => string;
  onComplete?: (outcome: RunPipelineOutcome) => void;
  /**
   * The finding sink: called exactly once per `investigate` run that completed,
   * after the manifest is `answered` and `finding.md` exists on disk, and
   * BEFORE `onComplete`. A cancelled, failed or non-completed investigate run
   * never calls it. This is what the chat subscribes to in order to post the
   * promote card; a throwing sink is swallowed (and reported through `report`)
   * so a host failure can never turn an answered run into a failed one.
   */
  onFinding?: (finding: RunFinding) => void;
  /** Surfaces an invalid result.json / a refusal while the run stays open. */
  report?: (message: string) => void;
}

/** Create a {@link RunPipeline} bound to the injected dependencies. */
export function createRunPipeline(deps: RunPipelineDeps): RunPipeline {
  return new DefaultRunPipeline(deps);
}

/** What one stage launch produced, or why it never ran. */
type StageRun =
  | {
      ok: true;
      outcome: RunOutcome;
      attempt: number;
      launchId: string;
      /** The worktree HEAD recorded before the launch, for the drift check. */
      startHead: string;
      /** The worktree branch recorded before the launch, for the drift check. */
      startBranch: string;
    }
  | { ok: false; refusal: string };

class DefaultRunPipeline implements RunPipeline {
  private readonly deps: RunPipelineDeps;
  private activeRunId: string | undefined;
  private stage: LiveRunStage | undefined;
  private cancelled = false;
  private readonly listeners = new Set<(event: RunPipelineEvent) => void>();
  /** The execute commits of the run in flight, oldest first. */
  private commits: string[] = [];
  /** The latest execute commit, named in the next review's brief. */
  private lastExecuteCommit: string | undefined;

  constructor(deps: RunPipelineDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.activeRunId !== undefined;
  }

  currentRunId(): string | undefined {
    return this.activeRunId;
  }

  currentStage(): LiveRunStage | undefined {
    return this.stage;
  }

  onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Cancel the in-flight run. Disposing the stage's terminal drives the
   * watcher's terminal-close path, `awaitStageResult` resolves `closed`, and the
   * `cancelled` flag turns that into `{ kind: 'cancelled' }`, recorded as
   * `state: 'cancelled'`.
   *
   * It deliberately does NOT call `removeRunWorktree`: a cancelled run keeps its
   * worktree and branch on disk for inspection, and removing them is the Runs
   * view's own explicit cleanup/merge path.
   */
  cancel(): boolean {
    if (this.activeRunId === undefined) {
      return false;
    }
    this.cancelled = true;
    this.stage?.terminal.dispose();
    return true;
  }

  async start(req: RunPipelineRequest): Promise<RunPipelineStart> {
    // 1. Mode. Neither 'spec' nor 'default' is ever a run. Belt and braces:
    //    a run pipeline for a spec conversation would write under
    //    `.baiton/specs/`, and 'default' is spec-less per `isSpecless` but only
    //    recommends a concrete mode.
    if (req.mode === 'spec' || !isSpecless(req.mode)) {
      return refuse({
        kind: 'invalid-mode',
        message: 'mode "spec" has no run pipeline: a spec conversation dispatches draft_spec',
      });
    }
    if (req.mode === 'default') {
      return refuse({
        kind: 'invalid-mode',
        message:
          'mode "default" has no run pipeline: Default recommends a mode and dispatches it with start_run or investigate, or a spec conversation dispatches draft_spec',
      });
    }

    // 2. One stage per repository, from both directions (Req 20.1).
    if (this.activeRunId !== undefined || this.deps.isSpecBusy?.() === true) {
      return refuse({
        kind: 'busy',
        message: 'a stage is already running for this repository; try again after it finishes',
      });
    }

    // 3. The base the run branches from — needed by every mode, because the
    //    manifest requires a non-empty `baseBranch`/`baseHead` even for an
    //    investigate run that never branches.
    let baseBranch: string;
    try {
      baseBranch = await this.deps.git.currentBranch();
    } catch (e) {
      return refuse({
        kind: 'detached-head',
        message: `Could not read the current branch of ${this.deps.workspaceRoot}: ${describe(e)}.`,
      });
    }
    if (baseBranch.length === 0 || baseBranch === 'HEAD') {
      return refuse({
        kind: 'detached-head',
        message:
          'Cannot start a run from a detached HEAD: check out a named branch first, because the ' +
          "run's branch is merged back into the branch it started from.",
      });
    }
    const baseHead = await this.deps.git.branchHead(baseBranch);
    if (baseHead === undefined) {
      return refuse({
        kind: 'no-base-head',
        message:
          `The branch ${baseBranch} has no commits yet, so there is nothing to branch from. ` +
          'Make an initial commit, then start the run again.',
      });
    }

    // 4. Allocate the run id and write the manifest. No `worktreeDir` yet: the
    //    manifest only claims one once git has really made it.
    const runId = (this.deps.newRunId ?? ((m: RunMode) => defaultNewRunId(m)))(req.mode);
    const created = this.deps.store.create({
      id: runId,
      mode: req.mode,
      composerMode: req.composerMode,
      explicitMode: req.explicitMode,
      statement: req.statement,
      files: req.files,
      ...(req.reproduction !== undefined ? { reproduction: req.reproduction } : {}),
      baseBranch,
      baseHead,
    });
    if (!created.ok) {
      return refuse({ kind: 'manifest', message: created.error.message });
    }
    let manifest = created.value;

    // 5. The worktree, for every mode but `investigate`, which is read-only and
    //    runs from the main checkout.
    let worktreeDir: string | undefined;
    if (req.mode !== 'investigate') {
      const wt = await createRunWorktree(
        {
          workspaceRoot: this.deps.workspaceRoot,
          git: this.deps.git,
          ...(this.deps.createService !== undefined ? { createService: this.deps.createService } : {}),
        },
        { runId, mode: req.mode },
      );
      if (!wt.ok) {
        // Record the dead run so the Runs view shows it rather than a manifest
        // that claims a worktree which does not exist.
        this.deps.store.update(runId, {
          state: 'failed',
          outcome: { kind: 'failed', message: wt.error.message },
        });
        return refuse({ kind: 'worktree', message: wt.error.message, error: wt.error });
      }
      worktreeDir = wt.value.worktreeDir;
      const updated = this.deps.store.update(runId, {
        worktreeDir: wt.value.relativeWorktreeDir,
      });
      if (updated.ok) {
        manifest = updated.value;
      }
    }

    this.activeRunId = runId;
    this.cancelled = false;
    this.commits = [];
    this.lastExecuteCommit = undefined;
    this.emit({ kind: 'started', runId, manifest });

    // Deliberately not awaited: the chat turn is not blocked on the pipeline.
    const completed = this.drive(runId, req.mode, worktreeDir);
    return { ok: true, runId, manifest, completed };
  }

  /**
   * Drive the whole run to its terminal outcome. Never rejects: a throw becomes
   * a `failed` outcome, and the active-run lock is always released.
   */
  private async drive(
    runId: string,
    mode: RunMode,
    worktreeDir: string | undefined,
  ): Promise<RunPipelineOutcome> {
    let outcome: RunPipelineOutcome;
    try {
      outcome =
        mode === 'investigate'
          ? await this.driveInvestigate(runId, mode)
          : await this.driveBuild(runId, mode, worktreeDir);
    } catch (e) {
      outcome = this.finishRun(runId, mode, 'failed', {
        kind: 'failed',
        message: `the run failed: ${describe(e)}`,
      }, `the run failed: ${describe(e)}`);
    } finally {
      this.activeRunId = undefined;
      this.stage = undefined;
    }

    this.deps.onComplete?.(outcome);
    this.emit({ kind: 'completed', runId, manifest: this.freshManifest(runId), outcome });
    return outcome;
  }

  /**
   * The read-only branch: one `investigate` stage from the main checkout, ending
   * in a finding. No worktree, no commit and no diff — git is simply never
   * touched here.
   *
   * `RunState` has no "investigating" state: the run stays `confirmed` while its
   * single stage runs and moves to `answered`. The live stage is visible through
   * {@link currentStage} and the `attempts.investigate` counter, so a `confirmed`
   * investigate run does not mean "nothing started".
   */
  private async driveInvestigate(runId: string, mode: RunMode): Promise<RunPipelineOutcome> {
    const result = await this.runStage({
      runId,
      mode,
      stage: 'investigate',
      journalCompletion: true,
    });
    if (!result.ok) {
      return this.finishRun(runId, mode, 'failed', { kind: 'failed', message: result.refusal }, result.refusal);
    }
    if (result.outcome.kind !== 'completed') {
      return this.finishNonCompleted(runId, mode, result.outcome, 'investigate');
    }

    // The cast is sound because `awaitStageResult` resolves `completed` only for
    // a result.json that validated against `investigateSchema`.
    const investigated = result.outcome.structured as InvestigateResult;
    const outcome = this.finishRun(
      runId,
      mode,
      'answered',
      { kind: 'finding', finding: investigated.finding },
      'investigation answered',
    );

    // The manifest is read back AFTER finishRun, so the sink sees the run in
    // its terminal `answered` state with its outcome and completedAt stamped. A
    // manifest that cannot be read is not worth failing an answered run over:
    // the finding is on disk either way, so the sink is simply skipped.
    const read = this.deps.store.read(runId);
    if (!read.ok) {
      this.deps.report?.(
        `the finding sink was skipped: the manifest for run ${runId} could not be read`,
      );
      return outcome;
    }
    const manifest = read.value;
    const finding: RunFinding = {
      runId,
      mode,
      question: manifest.statement,
      questionFiles: [...manifest.files],
      finding: investigated.finding,
      files: [...investigated.files],
      nextSteps: [...investigated.next_steps],
      findingPath: `.baiton/runs/${runId}/finding.md`,
      manifest,
    };
    try {
      this.deps.onFinding?.(finding);
    } catch (e) {
      // A host sink's failure is not the run's failure: the finding is on disk
      // and the manifest is answered either way.
      this.deps.report?.(`the finding sink threw: ${describe(e)}`);
    }
    return { ...outcome, finding };
  }

  /** The `bug`/`quick`/`refactor` branch: plan -> execute -> review in the worktree. */
  private async driveBuild(
    runId: string,
    mode: RunMode,
    worktreeDir: string | undefined,
  ): Promise<RunPipelineOutcome> {
    // Every head/branch/commit call for this run goes through its worktree, not
    // the main checkout: the run works on its own branch, so the main
    // checkout's HEAD moving is none of the run's business.
    const runGit = createRunGitService(this.deps.workspaceRoot, runId, this.deps.createService);
    const limit = Math.max(1, this.deps.execAttempts?.() ?? DEFAULT_EXEC_ATTEMPTS);

    // Plan.
    this.deps.store.update(runId, { state: 'planning' });
    const planned = await this.runStage({
      runId,
      mode,
      stage: 'plan',
      ...(worktreeDir !== undefined ? { cwd: worktreeDir } : {}),
      runGit,
      journalCompletion: true,
    });
    if (!planned.ok) {
      return this.finishRun(runId, mode, 'failed', { kind: 'failed', message: planned.refusal }, planned.refusal);
    }
    if (planned.outcome.kind !== 'completed') {
      return this.finishNonCompleted(runId, mode, planned.outcome, 'plan');
    }
    this.deps.store.update(runId, { state: 'planned' });

    for (;;) {
      // A cancel landing between stages must stop the loop before the next
      // attempt is bumped and launched.
      if (this.cancelled) {
        return this.finishNonCompleted(runId, mode, { kind: 'cancelled' }, 'execute');
      }

      // Execute.
      this.deps.store.update(runId, { state: 'executing' });
      const executed = await this.runStage({
        runId,
        mode,
        stage: 'execute',
        ...(worktreeDir !== undefined ? { cwd: worktreeDir } : {}),
        runGit,
        // The execute completion is journaled by this driver instead, so the
        // record can carry the commit the attempt landed in.
        journalCompletion: false,
      });
      if (!executed.ok) {
        return this.finishRun(runId, mode, 'failed', { kind: 'failed', message: executed.refusal }, executed.refusal);
      }
      if (executed.outcome.kind !== 'completed') {
        this.journalDone(runId, executed.launchId, journalResultKind(executed.outcome));
        return this.finishNonCompleted(runId, mode, executed.outcome, 'execute');
      }

      // Drift check against the WORKTREE's own service, before any state write
      // (Req 17.6). A drift in the MAIN checkout does not abort a run.
      const head = await safeHead(runGit);
      const branch = await safeBranch(runGit);
      if (head !== executed.startHead || branch !== executed.startBranch) {
        this.journalDone(runId, executed.launchId, 'completed');
        const message = 'HEAD or branch changed during execute; run halted (git_state_changed)';
        return this.finishRun(runId, mode, 'failed', { kind: 'failed', message }, message);
      }

      // Commit inside the worktree. The trailer VALUE is the RUN id, not the
      // launch id, because `runMergeMessage` in `runWorktree.ts` gives the merge
      // the same `Run-Id: <run-id>` trailer — so `findCommitByRunId(runId)`
      // finds both the execute commits and the merge. A run whose executor
      // changed nothing must not fail, so a git failure yields no commit.
      const commit = await safeCommit(
        runGit,
        runExecuteCommitMessage(mode, runId, executed.attempt),
        { [RUN_ID_TRAILER]: runId },
      );
      if (commit !== undefined) {
        this.commits.push(commit);
        this.lastExecuteCommit = commit;
      }
      this.journalDone(runId, executed.launchId, 'completed', commit);
      this.deps.store.update(runId, { state: 'executed' });

      // Review.
      this.deps.store.update(runId, { state: 'reviewing' });
      const reviewed = await this.runStage({
        runId,
        mode,
        stage: 'review',
        ...(worktreeDir !== undefined ? { cwd: worktreeDir } : {}),
        runGit,
        journalCompletion: true,
      });
      if (!reviewed.ok) {
        return this.finishRun(runId, mode, 'failed', { kind: 'failed', message: reviewed.refusal }, reviewed.refusal);
      }
      if (reviewed.outcome.kind !== 'completed') {
        return this.finishNonCompleted(runId, mode, reviewed.outcome, 'review');
      }

      const verdict = readVerdict(reviewed.outcome.structured);
      if (verdict === 'pass') {
        return this.finishRun(
          runId,
          mode,
          'done',
          { kind: 'verdict', verdict: 'pass' },
          this.commits.length > 0
            ? `review passed; ${this.commits.length} execute commit(s): ${this.commits.join(', ')}`
            : 'review passed with no execute commit',
        );
      }

      if (executed.attempt >= limit) {
        return this.finishRun(
          runId,
          mode,
          'failed',
          { kind: 'verdict', verdict: 'findings' },
          `review still reports findings after ${limit} execute attempt(s)`,
        );
      }
      // Loop: the next execute's brief carries this review, because
      // `buildRunContext` includes `# Latest review` from attempt 2 on.
    }
  }

  /**
   * Record a non-`completed` stage outcome as the run's ending. Every state
   * write goes through `store.update`; no extra event is emitted, because the
   * `stage-completed` event already carried the fresh manifest.
   */
  private finishNonCompleted(
    runId: string,
    mode: RunMode,
    outcome: RunOutcome,
    stage: RunStage,
  ): RunPipelineOutcome {
    if (outcome.kind === 'cancelled') {
      return this.finishRun(
        runId,
        mode,
        'cancelled',
        { kind: 'cancelled' },
        `run cancelled during ${stage}`,
      );
    }
    if (outcome.kind === 'closed') {
      const exit = outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : '';
      const message = `the ${stage} stage closed without a result${exit}`;
      return this.finishRun(runId, mode, 'failed', { kind: 'failed', message }, message);
    }
    if (outcome.kind === 'invalid_output') {
      const message = `the ${stage} stage produced an invalid result: ${outcome.detail}`;
      return this.finishRun(runId, mode, 'failed', { kind: 'failed', message }, message);
    }
    const message = `the ${stage} stage produced "${outcome.kind}"`;
    return this.finishRun(runId, mode, 'failed', { kind: 'failed', message }, message);
  }

  /** Write the run's terminal state and outcome, and build the reported outcome. */
  private finishRun(
    runId: string,
    mode: RunMode,
    state: RunState,
    outcome: RunOutcomeRecord,
    message: string,
  ): RunPipelineOutcome {
    this.deps.store.update(runId, { state, outcome });
    return { runId, mode, state, outcome, commits: [...this.commits], message };
  }

  /**
   * Launch one stage and await its outcome: bump the attempt counter, resolve
   * and probe the role's adapter, build the brief context, record the drift
   * anchors, launch, journal the start, watch, await, and emit the events.
   */
  private async runStage(input: {
    runId: string;
    mode: RunMode;
    stage: RunStage;
    /** The worktree a build stage launches in; absent for `investigate`. */
    cwd?: string;
    /** The worktree-bound git service; absent for `investigate`. */
    runGit?: GitWorktreeService;
    /** False for `execute`, whose completion the driver journals with its commit. */
    journalCompletion: boolean;
  }): Promise<StageRun> {
    const { runId, mode, stage } = input;

    // 1. Count this launch and learn the id it runs under.
    const bumped = this.deps.store.bumpAttempt(runId, stage);
    if (!bumped.ok) {
      return { ok: false, refusal: bumped.error.message };
    }
    const { manifest, attempt, launchId } = bumped.value;

    // 2. The role's configured adapter, then its probe (Req 14.1, 14.2).
    const role = ROLE_FOR_RUN_STAGE[stage];
    const adapter = this.deps.adapterForRole(role);
    if (adapter === undefined) {
      return {
        ok: false,
        refusal: `role "${role}" is configured with an unsupported agent; update "roles.${role}.agent" in .baiton/config.json`,
      };
    }
    const probe = await adapter.probe();
    if (!probe.ok) {
      return { ok: false, refusal: `adapter probe failed: ${probe.reason ?? 'unknown reason'}` };
    }

    // 3. The brief's context, assembled from the manifest and the run's own
    //    artifacts — never from a spec.
    const verify = this.deps.verify?.();
    const briefContext = buildRunContext({
      stage,
      mode,
      statement: manifest.statement,
      files: manifest.files,
      attempt,
      resume: false,
      ...(manifest.reproduction !== undefined ? { reproduction: manifest.reproduction } : {}),
      ...(stage !== 'investigate' ? { branch: manifest.branch } : {}),
      ...(verify !== undefined ? { verify } : {}),
      ...(stage === 'execute' || stage === 'review'
        ? { plan: this.readRunArtifact(runId, 'plan') }
        : {}),
      ...(stage === 'execute' && manifest.attempts.review >= 1
        ? { latestReview: this.readRunArtifact(runId, 'review', manifest.attempts.review) }
        : {}),
      ...(stage === 'review'
        ? {
            latestExecute: this.readRunArtifact(runId, 'execute', manifest.attempts.execute),
            ...(this.lastExecuteCommit !== undefined
              ? { executeCommit: this.lastExecuteCommit }
              : {}),
          }
        : {}),
    });

    // 4. The drift anchors, recorded BEFORE the launch, against the worktree's
    //    own service for a build stage.
    // A read-only investigate run touches git exactly once, in `start()`, to
    // record the base branch and head in the manifest. It has no worktree, no
    // commit and no drift check, so the journal's anchors come from the
    // manifest rather than from a fresh git call.
    let startHead: string;
    let startBranch: string;
    if (stage === 'investigate') {
      startHead = manifest.baseHead;
      startBranch = manifest.baseBranch;
    } else {
      const git = input.runGit ?? this.deps.git;
      startHead = await safeHead(git);
      startBranch = await safeBranch(git);
    }

    // 5. Launch. `cwd` is the run's worktree for a build stage and absent for
    //    `investigate`, which runs from the main checkout; either way the
    //    launch's brief/result/asks land under `.baiton/runs/<launch-id>/`
    //    relative to that root.
    const sessionId = (this.deps.newSessionId ?? randomUUID)();
    const { model, effort } = this.deps.modelForRole(role);
    const launchInput: LaunchStageInput = {
      workspaceRoot: this.deps.workspaceRoot,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      runId: launchId,
      stage,
      role,
      model,
      ...(effort !== undefined ? { effort } : {}),
      resume: false,
      sessionId,
      briefContext,
      ...(this.deps.askWatcherFactory !== undefined ? { relayAsks: true } : {}),
    };
    const launched = launchStage(launchInput, {
      adapter,
      terminalHost: this.deps.terminalHost,
    });
    if (!launched.ok) {
      return { ok: false, refusal: `stage launch failed: ${launched.error.message}` };
    }
    const { terminal, resultPath, relay } = launched.value;

    // 6. Journal the start. The run id stands in for `todoId` exactly as
    //    `specDraft.ts` passes the spec slug, and `inputRev` is empty because a
    //    run has no plan input rev. The run directory already exists — the
    //    manifest was written there — so the append has somewhere to go.
    const journalPath = runJournalPathFor(this.deps.workspaceRoot, runId);
    const terminalPid = await resolvePid(terminal);
    appendStart(journalPath, {
      runId: launchId,
      todoId: runId,
      stage,
      attempt,
      startHead,
      inputRev: '',
      sessionId,
      ...(terminalPid !== undefined ? { terminalPid } : {}),
    });

    // 7. Watch the result file, publish the live stage, and relay asks.
    const watcher = this.deps.watcherFactory.create({
      slug: runId,
      runId: launchId,
      resultPath,
      terminal,
    });
    this.stage = { runId, launchId, mode, stage, attempt, sessionId, terminal };
    this.emit({ kind: 'stage-started', runId, stage, attempt, manifest });

    let askWatcher: AskWatcher | undefined;
    if (this.deps.askWatcherFactory !== undefined && relay !== undefined) {
      try {
        askWatcher = this.deps.askWatcherFactory.create({
          slug: runId,
          todoId: runId,
          runId: launchId,
          agent: adapter.id,
          role,
          asksDir: relay.dir,
        });
      } catch {
        // A host watcher must never prevent an already-launched run from completing.
      }
    }

    // 8. Await the outcome. `slug`/`workspaceRoot`/`todoId` only feed the
    //    spec-relative `artifactPath` that `awaitStageResult` composes and puts
    //    on the outcome; nothing is written there, because `target.write`
    //    ignores its path argument and writes into the run directory instead.
    const isNumbered = stage === 'execute' || stage === 'review';
    const target = runArtifactWriter(
      this.deps.workspaceRoot,
      runId,
      stage,
      isNumbered ? attempt : undefined,
    );
    let outcome: RunOutcome;
    try {
      outcome = await awaitStageResult(
        {
          workspaceRoot: input.cwd ?? this.deps.workspaceRoot,
          slug: runId,
          stage,
          todoId: runId,
          ...(isNumbered ? { index: attempt } : {}),
          terminal,
          watcher,
        },
        {
          writeArtifact: target.write,
          reportInvalid: (detail) => this.deps.report?.(detail),
        },
      );
    } finally {
      askWatcher?.dispose();
      this.stage = undefined;
    }

    // 9. A cancel during the stage turns any resolved outcome into `cancelled`.
    if (this.cancelled) {
      outcome = { kind: 'cancelled' };
    }

    if (input.journalCompletion) {
      this.journalDone(runId, launchId, journalResultKind(outcome));
    }
    this.emit({
      kind: 'stage-completed',
      runId,
      stage,
      attempt,
      outcome,
      manifest: this.freshManifest(runId, manifest),
    });

    return { ok: true, outcome, attempt, launchId, startHead, startBranch };
  }

  /** Append one stage's completion record to the run's journal. */
  private journalDone(
    runId: string,
    launchId: string,
    result: RunResultKind,
    commit?: string,
  ): void {
    appendCompletion(runJournalPathFor(this.deps.workspaceRoot, runId), {
      runId: launchId,
      result,
      ...(commit !== undefined ? { commit } : {}),
    });
  }

  /**
   * One of the run's own stage artifacts (`plan.md`, `execute-<n>.md`,
   * `review-<n>.md`) from the MAIN checkout's run directory, or `undefined` when
   * it is absent or blank.
   */
  private readRunArtifact(runId: string, stage: RunStage, attempt?: number): string | undefined {
    try {
      const text = readFileSync(
        runArtifactPathFor(this.deps.workspaceRoot, runId, stage, attempt),
        'utf8',
      );
      return text.trim() === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  /** The manifest as it stands on disk, falling back to a known-good copy. */
  private freshManifest(runId: string, fallback?: RunManifest): RunManifest {
    const read = this.deps.store.read(runId);
    if (read.ok) {
      return read.value;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    // Only reachable if the manifest was deleted mid-run; the event still needs
    // a value, and every field but the id would be a guess.
    throw new Error(`the manifest for run ${runId} could not be read`);
  }

  /** Notify subscribers; a throwing listener can never break a run. */
  private emit(event: RunPipelineEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's failure is its own problem.
      }
    }
  }
}

/** A refusal, shaped as a {@link RunPipelineStart}. */
function refuse(error: RunPipelineRefusal): RunPipelineStart {
  return { ok: false, error };
}

/**
 * Read a review result's verdict. A local copy of `runQueue.ts`'s own reader:
 * `pass` only when the structured result says so, everything else `findings`
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

/** The journal's result kind for a stage outcome. */
function journalResultKind(outcome: RunOutcome): RunResultKind {
  switch (outcome.kind) {
    case 'completed':
      return 'completed';
    case 'invalid_output':
      return 'invalid_output';
    case 'closed':
      return 'closed';
    default:
      // `cancelled`, and the queue-only `control-applied` a run never produces.
      return 'cancelled';
  }
}

/** Read HEAD, tolerating a git failure by returning an empty marker. */
async function safeHead(git: GitWorktreeService): Promise<string> {
  try {
    return await git.head();
  } catch {
    return '';
  }
}

/** Read the current branch, tolerating a git failure. */
async function safeBranch(git: GitWorktreeService): Promise<string> {
  try {
    return await git.currentBranch();
  } catch {
    return '';
  }
}

/** Commit, tolerating a git failure by returning `undefined`. */
async function safeCommit(
  git: GitWorktreeService,
  message: string,
  trailers: Record<string, string>,
): Promise<string | undefined> {
  try {
    return await git.commit(message, trailers);
  } catch {
    return undefined;
  }
}

/** Best-effort resolution of a terminal's process id for the journal. */
async function resolvePid(terminal: HostTerminal): Promise<number | undefined> {
  try {
    return await terminal.processId;
  } catch {
    return undefined;
  }
}

/** A short description of a thrown value. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
