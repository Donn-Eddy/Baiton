/**
 * The engine facade binds phase and control triggers to run queues. It also
 * binds plan-less dispatch tools (`start_run` / `investigate`) to the run
 * pipeline through {@link createRunPipelineSeam}.
 *
 * The facade derives the role, attempt/round index, and executor resume flag
 * from the stage and the merged plan journal, then dispatches one RunRequest.
 * Phase queues are keyed by (slug, phase), each using its own worktree, so
 * phases can run concurrently. The plan draft and plan-less pipeline still
 * share the repository lock; phase queues do not hold or wait on it.
 *
 * The facade has no VS Code dependency. Commands and the run tool call it with
 * plain values, and the queue relays harness asks through its shared watcher.
 */
import type { RunMode } from '../model/mode';
import type { Role } from '../model/role';
import type { Stage } from '../model/stage';
import type {
  DispatchResult,
  LiveRun,
  QueueWorktreeSeam,
  RunPipeline,
  RunPipelineRequest,
  RunQueue,
  RunQueueDeps,
  PlanBranchWriter,
  TransitionAction,
} from '../engine';
import { createQueueWorktreeSeam, createRunQueue } from '../engine';
import type { GitWorktreeService } from '../git';
import type {
  RunDispatchOutcome,
  RunDispatchRequest,
  RunPipelineSeam,
  RunQueueSeam,
  StartRunOutcome,
  StartRunRequest,
} from '../orchestrator';
import type { Adapter } from '../adapter';
import {
  latestStart,
  readPlanJournal,
  resumableSessionId,
  planJournalPathFor,
  phaseJournalPathFor,
  JournalEntry,
} from '../journal';

/**
 * Resolves the adapter a role's configured agent maps to — the same lookup the
 * run queue uses (`RunQueueDeps.adapterForRole`). The facade needs it to know
 * whether a journaled session id is resumable at all; `undefined` (an
 * unsupported agent id) is left for the queue to refuse with `unknown-agent`.
 */
export type AdapterForRole = (role: Role) => Adapter | undefined;

/** A trigger the facade can dispatch: a stage run or a control action. */
export type EngineTrigger =
  | { kind: 'stage'; slug: string; phaseId: string; stage: Stage }
  | { kind: 'action'; slug: string; phaseId: string; action: 'replan' | 'stop' };

/**
 * The stage → sub-agent role mapping used by the launcher.
 * `plan-review` maps to the plan-reviewer role but is not a lifecycle
 * transition of its own, so it has no dispatchable action here. Exported so
 * the View command (`commands.ts`) can derive the role to `attach` with from
 * the stage recorded on a journal entry without duplicating this table.
 */
export const STAGE_ROLE: Record<Stage, Role> = {
  // `plan-draft` is plan-scoped and runs through its own runner
  // (`src/engine/planDraft.ts`), never through the phase-scoped queue; the entry
  // is here so the stage → role table stays total.
  'plan-draft': 'plan-writer',
  plan: 'planner',
  'plan-review': 'plan-reviewer',
  execute: 'executor',
  review: 'reviewer',
  pr: 'pr-writer',
  // `investigate` is run-scoped and runs through the run pipeline, never
  // through the phase-scoped queue; the existing `reviewer` role already has
  // exactly the surface it needs (read + search + shell, writes only its run
  // result), so no new role is introduced.
  investigate: 'reviewer',
};

/** The lifecycle action a stage maps to, or `undefined` for `plan-review`. */
function actionForStage(stage: Stage): TransitionAction | undefined {
  switch (stage) {
    case 'plan':
      return 'plan';
    case 'execute':
      return 'execute';
    case 'review':
      return 'review';
    case 'plan-review':
      // `investigate` lands in the `default:` arm below for the same reason:
      // it is dispatched by the run pipeline, not the per-phase queue.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Dispatch a trigger through the run queue, deriving role/attempt/resume from
 * the plan's journal. Resolves with the queue's {@link DispatchResult}.
 */
export function dispatchTrigger(
  queue: RunQueue,
  baitonDir: string,
  trigger: EngineTrigger,
  adapterForRole: AdapterForRole,
): Promise<DispatchResult> {
  if (trigger.kind === 'action') {
    // Control actions launch no sub-agent; role/attempt/resume are unused.
    return queue.dispatch({
      slug: trigger.slug,
      phaseId: trigger.phaseId,
      action: trigger.action,
      role: 'planner',
      attempt: 1,
      resume: false,
    });
  }

  const action = actionForStage(trigger.stage);
  if (action === undefined) {
    // `plan-review` runs inside the Plan action's review rounds; it is not a
    // standalone trigger in the manual first pass.
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'illegal-transition',
        message: `stage "${trigger.stage}" is not a standalone trigger`,
      },
    });
  }

  const entries = readPlanJournal(baitonDir, trigger.slug);
  const priorStarts = countStageStarts(entries, trigger.phaseId, trigger.stage);
  const attempt = priorStarts + 1;
  const role = STAGE_ROLE[trigger.stage];

  // Resume by Session_Id: the executor continues the phase's most recent
  // execute start's session (Req 3.2). Whether that is possible at all depends
  // on the executor's CLI: claude accepts the id Baiton pre-assigned, so its
  // journal `sessionId` is resumable (and `-c` is a safe fallback when an old
  // start recorded none); opencode tags its session with that id and the run
  // queue resolves it to opencode's own before launch. codex/antigravity mint
  // their own id, so the journal's `sessionId` names nothing — resuming with
  // it fails before a session exists — and the only resumable id is one
  // discovered after a prior run. With none, launch fresh: the retry brief
  // still carries the latest review (see `stageContext.ts`).
  const accepts = adapterForRole(role)?.acceptsSessionId === true;
  const priorExecute =
    trigger.stage === 'execute'
      ? latestStart(entries, trigger.phaseId, 'execute')
      : undefined;
  const priorSessionId = resumableSessionId(priorExecute, accepts);
  const resume =
    trigger.stage === 'execute' &&
    priorStarts > 0 &&
    (accepts || priorSessionId !== undefined);
  const resumeSessionId = resume ? priorSessionId : undefined;

  return queue.dispatch({
    slug: trigger.slug,
    phaseId: trigger.phaseId,
    action,
    role,
    attempt,
    resume,
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });
}

/** The cache key of a phase's run queue. */
export function phaseQueueKey(slug: string, phaseId: string): string {
  return `${slug}/${phaseId}`;
}

/** Dependencies shared by every per-phase queue; slug/phase/journal wiring is derived per queue. */
export type PhaseQueuesDeps = Omit<
  RunQueueDeps,
  | 'slug'
  | 'phaseId'
  | 'journalPath'
  | 'journalPathFor'
  | 'readJournal'
  | 'worktrees'
  | 'planWriter'
  | 'isExternallyBusy'
  | 'git'
> & {
  baitonDir: string;
  /** Git service over the main checkout. */
  git: GitWorktreeService;
  /** The one writer shared with the plan store so per-slug writes serialize. */
  planWriter: PlanBranchWriter;
  worktrees?: QueueWorktreeSeam;
};

/** A cache of run queues keyed by (slug, phase). */
export interface PhaseQueues {
  /** The phase's queue, created on first use. */
  queueFor(slug: string, phaseId: string): RunQueue;
  /** The phase's queue if one exists; never creates one. */
  find(slug: string, phaseId: string): RunQueue | undefined;
  /** Every live run across all queues. */
  running(): LiveRun[];
  /** True when any queue (of `slug`, when given) has a stage in flight. */
  isRunning(slug?: string): boolean;
}

/**
 * One {@link RunQueue} per (slug, phase), all sharing one worktree seam and one
 * plan-branch writer. No queue is given `isExternallyBusy`: phase stages run in
 * their own worktrees, outside the repository lock.
 */
export function createPhaseQueues(deps: PhaseQueuesDeps): PhaseQueues {
  const { baitonDir, planWriter, worktrees, ...rest } = deps;
  const seam =
    worktrees ??
    createQueueWorktreeSeam({
      workspaceRoot: deps.workspaceRoot,
      git: deps.git,
      writer: planWriter,
    });
  const queues = new Map<string, { slug: string; queue: RunQueue }>();
  return {
    queueFor(slug, phaseId) {
      const key = phaseQueueKey(slug, phaseId);
      const existing = queues.get(key);
      if (existing !== undefined) {
        return existing.queue;
      }
      const queue = createRunQueue({
        ...rest,
        slug,
        phaseId,
        worktrees: seam,
        planWriter,
        journalPath: planJournalPathFor(baitonDir, slug),
        journalPathFor: (id) => phaseJournalPathFor(baitonDir, slug, id),
        readJournal: () => readPlanJournal(baitonDir, slug),
      });
      queues.set(key, { slug, queue });
      return queue;
    },
    find: (slug, phaseId) => queues.get(phaseQueueKey(slug, phaseId))?.queue,
    running() {
      const live: LiveRun[] = [];
      for (const { queue } of queues.values()) {
        const run = queue.currentRun();
        if (run !== undefined) {
          live.push(run);
        }
      }
      return live;
    },
    isRunning(slug) {
      for (const entry of queues.values()) {
        if ((slug === undefined || entry.slug === slug) && entry.queue.isRunning()) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * The repository lock after per-phase worktrees: the plan draft and plan-less
 * runs still exclude each other. Per-phase queues neither hold nor wait on it.
 */
export function createStageLock(holders: {
  planDraftRunning: () => boolean;
  runRunning: () => boolean;
}): { runPipelineBusy(): boolean; planDraftBusy(): boolean } {
  return {
    runPipelineBusy: () => holders.planDraftRunning(),
    planDraftBusy: () => holders.runRunning(),
  };
}

/**
 * A {@link RunQueueSeam} for the orchestrator's `run` tool, backed by
 * {@link dispatchTrigger} over the phase's own queue. It maps the queue's rich
 * {@link DispatchResult} down to the tool's narrow `dispatched | busy |
 * illegal` answer (Req 10.4, 10.5); every other refusal (probe/launch/guard) is
 * surfaced by the queue's reporter and reported to the tool as `illegal` with
 * the queue's message (for example `deps-unlanded`).
 *
 * `busy` means a stage is already running or being dispatched for THIS phase.
 * The queue is FIFO and would otherwise enqueue behind the running stage, so
 * the seam tracks in-flight dispatches itself. Different phases never see busy
 * from each other.
 */
export function createRunQueueSeam(
  queueFor: (slug: string, phaseId: string) => RunQueue,
  baitonDir: string,
  adapterForRole: AdapterForRole,
): RunQueueSeam {
  const inFlight = new Set<string>();
  return {
    async dispatch(req: RunDispatchRequest): Promise<RunDispatchOutcome> {
      const key = phaseQueueKey(req.slug, req.phaseId);
      const queue = queueFor(req.slug, req.phaseId);
      if (inFlight.has(key) || queue.isRunning()) {
        return { kind: 'busy' };
      }
      inFlight.add(key);
      let result: DispatchResult;
      try {
        result = await dispatchTrigger(
          queue,
          baitonDir,
          {
            kind: 'stage',
            slug: req.slug,
            phaseId: req.phaseId,
            stage: req.stage,
          },
          adapterForRole,
        );
      } finally {
        inFlight.delete(key);
      }
      if (result.ok) {
        return { kind: 'dispatched', runId: outcomeRunId(result) };
      }
      if (result.error.kind === 'busy') {
        return { kind: 'busy' };
      }
      return { kind: 'illegal', reason: result.error.message };
    },
  };
}

/**
 * A stable run identifier to report back for a dispatched stage. The queue's
 * outcome does not surface its internal run id, so the seam reports the
 * outcome kind as an opaque acknowledgement the model can log.
 */
function outcomeRunId(result: Extract<DispatchResult, { ok: true }>): string {
  return result.outcome.kind;
}

/**
 * A {@link RunPipelineSeam} for the `start_run` / `investigate` dispatch tools,
 * backed by the real run pipeline.
 *
 * The seam is narrower than {@link RunPipelineRequest} on purpose: a tool knows
 * the mode it was called with, but only the host knows what the composer's Mode
 * select said, so this adapter fills `composerMode` from the host and derives
 * `explicitMode` — true exactly when the orchestrator dispatched a mode other
 * than the one the user selected (an Investigate dispatched from a Bug
 * conversation, say). A run dispatched from a Default conversation always
 * records `composerMode: 'default'` with `explicitMode: true`, since Default is
 * never itself a run mode.
 *
 * It resolves as soon as the run is launched: the pipeline's `completed`
 * promise is deliberately not awaited here (the chat mirrors completion through
 * `RunPipeline.onChange`), only guarded, so a rejection can never surface as an
 * unhandled rejection in the extension host.
 */
export function createRunPipelineSeam(
  pipeline: Pick<RunPipeline, 'start'>,
  composerMode: () => RunMode,
  report?: (message: string) => void,
): RunPipelineSeam {
  return {
    async start(req: StartRunRequest): Promise<StartRunOutcome> {
      const composer = composerMode();
      const request: RunPipelineRequest = {
        mode: req.mode,
        composerMode: composer,
        explicitMode: req.mode !== composer,
        statement: req.statement,
        files: [...req.files],
        ...(req.reproduction !== undefined ? { reproduction: req.reproduction } : {}),
      };
      const result = await pipeline.start(request);
      if (result.ok) {
        void result.completed.catch((e: unknown) => {
          report?.(`run ${result.runId} failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        return { kind: 'started', runId: result.runId, branch: result.manifest.branch };
      }
      return result.error.kind === 'busy'
        ? { kind: 'busy' }
        : { kind: 'refused', reason: result.error.message };
    },
  };
}

/**
 * Count an already-parsed journal's start records for a phase stage
 * (Req 21.1). Takes the parsed entry array so callers that also need
 * {@link latestStart} read the journal once (Req 3.2).
 */
function countStageStarts(
  entries: JournalEntry[],
  phaseId: string,
  stage: Stage,
): number {
  let count = 0;
  for (const entry of entries) {
    // JournalEntry.todoId is a persisted field name.
    if (entry.todoId === phaseId && entry.stage === stage) {
      count += 1;
    }
  }
  return count;
}
