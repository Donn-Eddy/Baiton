/**
 * The engine facade that binds a stage/action trigger to the run queue
 * (task 15.2; design "Stage engine"). It also binds the spec-less dispatch
 * tools (`start_run` / `investigate`) to the run pipeline through
 * {@link createRunPipelineSeam} (design "dispatch modes").
 *
 * Both the orchestrator's `run` tool (through {@link RunQueueSeam}) and the VS
 * Code stage-trigger commands and CodeLens ask for "run this stage/action on
 * this todo". The queue's {@link RunRequest} needs more than the caller carries
 * — the sub-agent role, the 1-based attempt/round index, and the executor
 * resume flag — so this facade derives those from the stage and the run journal
 * and dispatches a single {@link RunRequest} (Req 10.3, 19.1).
 *
 * Attempt/round derivation reads the merged spec journal (spec-level + per-todo files) so numbered artifacts and
 * the executor continue flag are consistent across triggers:
 *   - plan → attempt 1 (a single plan artifact, `plan.md`).
 *   - execute → one past the count of prior execute starts for the todo, and
 *     `resume` is set when a prior execute start exists *and* that start left a
 *     session the executor's CLI can actually resume, so the executor CLI
 *     continues its session across rounds (Req 13.2). Only claude honours
 *     Baiton's pre-assigned session id (`Adapter.acceptsSessionId`); codex,
 *     opencode and antigravity mint their own, so for them a resume is only
 *     offered once a real id has been discovered and journaled — otherwise the
 *     attempt launches fresh, carrying the latest review in its retry brief.
 *   - review → one past the count of prior review starts for the todo.
 *   - replan / stop → control actions with no stage; attempt is unused.
 *
 * Run queues are per todo: {@link createTodoQueues} caches one queue per
 * (slug, todo), each running its stages in that todo's worktree, so different
 * todos run concurrently. `busy` on the `run` tool therefore means "a stage is
 * already running (or being dispatched) for THIS todo" — the seam enforces that
 * with an in-flight set, since the FIFO queue itself would enqueue behind a
 * running stage. Only the spec draft and the spec-less run pipeline still hold
 * the repository lock ({@link createStageLock}); per-todo queues neither hold
 * nor wait on it.
 *
 * The facade never imports `vscode`; the command layer and the run tool call
 * into it with plain values. Harness ask relaying is instead a queue-level
 * `RunQueueDeps.askWatcherFactory` dependency wired in `commands.ts`, so all
 * triggers reaching the queue relay asks identically.
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
  SpecBranchWriter,
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
  readSpecJournal,
  resumableSessionId,
  specJournalPathFor,
  todoJournalPathFor,
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
  | { kind: 'stage'; slug: string; todoId: string; stage: Stage }
  | { kind: 'action'; slug: string; todoId: string; action: 'replan' | 'stop' };

/**
 * The stage → sub-agent role mapping the launcher uses (design role table).
 * `plan-review` maps to the plan-reviewer role but is not a lifecycle
 * transition of its own, so it has no dispatchable action here. Exported so
 * the View command (`commands.ts`) can derive the role to `attach` with from
 * the stage recorded on a journal entry without duplicating this table.
 */
export const STAGE_ROLE: Record<Stage, Role> = {
  // `spec-draft` is spec-scoped and runs through its own runner
  // (`src/engine/specDraft.ts`), never through the todo-scoped queue; the entry
  // is here so the stage → role table stays total.
  'spec-draft': 'spec-writer',
  plan: 'planner',
  'plan-review': 'plan-reviewer',
  execute: 'executor',
  review: 'reviewer',
  pr: 'pr-writer',
  // `investigate` is run-scoped and runs through the run pipeline, never
  // through the todo-scoped queue; the existing `reviewer` role already has
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
      // it is dispatched by the run pipeline, not the per-todo queue.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Dispatch a trigger through the run queue, deriving role/attempt/resume from
 * the spec's journal. Resolves with the queue's {@link DispatchResult}.
 */
export function dispatchTrigger(
  queue: RunQueue,
  specsDir: string,
  trigger: EngineTrigger,
  adapterForRole: AdapterForRole,
): Promise<DispatchResult> {
  if (trigger.kind === 'action') {
    // Control actions launch no sub-agent; role/attempt/resume are unused.
    return queue.dispatch({
      slug: trigger.slug,
      todoId: trigger.todoId,
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

  const entries = readSpecJournal(specsDir, trigger.slug);
  const priorStarts = countStageStarts(entries, trigger.todoId, trigger.stage);
  const attempt = priorStarts + 1;
  const role = STAGE_ROLE[trigger.stage];

  // Resume by Session_Id: the executor continues the todo's most recent
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
      ? latestStart(entries, trigger.todoId, 'execute')
      : undefined;
  const priorSessionId = resumableSessionId(priorExecute, accepts);
  const resume =
    trigger.stage === 'execute' &&
    priorStarts > 0 &&
    (accepts || priorSessionId !== undefined);
  const resumeSessionId = resume ? priorSessionId : undefined;

  return queue.dispatch({
    slug: trigger.slug,
    todoId: trigger.todoId,
    action,
    role,
    attempt,
    resume,
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });
}

/** The cache key of a todo's run queue. */
export function todoQueueKey(slug: string, todoId: string): string {
  return `${slug}/${todoId}`;
}

/** Dependencies shared by every per-todo queue; slug/todo/journal wiring is derived per queue. */
export type TodoQueuesDeps = Omit<
  RunQueueDeps,
  | 'slug'
  | 'todoId'
  | 'journalPath'
  | 'journalPathFor'
  | 'readJournal'
  | 'worktrees'
  | 'specWriter'
  | 'isExternallyBusy'
  | 'git'
> & {
  specsDir: string;
  /** Git service over the main checkout. */
  git: GitWorktreeService;
  /** The one writer shared with the spec store so per-slug writes serialize. */
  specWriter: SpecBranchWriter;
  worktrees?: QueueWorktreeSeam;
};

/** A cache of run queues keyed by (slug, todo). */
export interface TodoQueues {
  /** The todo's queue, created on first use. */
  queueFor(slug: string, todoId: string): RunQueue;
  /** The todo's queue if one exists; never creates one. */
  find(slug: string, todoId: string): RunQueue | undefined;
  /** Every live run across all queues. */
  running(): LiveRun[];
  /** True when any queue (of `slug`, when given) has a stage in flight. */
  isRunning(slug?: string): boolean;
}

/**
 * One {@link RunQueue} per (slug, todo), all sharing one worktree seam and one
 * spec-branch writer. No queue is given `isExternallyBusy`: todo stages run in
 * their own worktrees, outside the repository lock.
 */
export function createTodoQueues(deps: TodoQueuesDeps): TodoQueues {
  const { specsDir, specWriter, worktrees, ...rest } = deps;
  const seam =
    worktrees ??
    createQueueWorktreeSeam({
      workspaceRoot: deps.workspaceRoot,
      git: deps.git,
      writer: specWriter,
    });
  const queues = new Map<string, { slug: string; queue: RunQueue }>();
  return {
    queueFor(slug, todoId) {
      const key = todoQueueKey(slug, todoId);
      const existing = queues.get(key);
      if (existing !== undefined) {
        return existing.queue;
      }
      const queue = createRunQueue({
        ...rest,
        slug,
        todoId,
        worktrees: seam,
        specWriter,
        journalPath: specJournalPathFor(specsDir, slug),
        journalPathFor: (id) => todoJournalPathFor(specsDir, slug, id),
        readJournal: () => readSpecJournal(specsDir, slug),
      });
      queues.set(key, { slug, queue });
      return queue;
    },
    find: (slug, todoId) => queues.get(todoQueueKey(slug, todoId))?.queue,
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
 * The repository lock after per-todo worktrees: the spec draft and spec-less
 * runs still exclude each other. Per-todo queues neither hold nor wait on it.
 */
export function createStageLock(holders: {
  specDraftRunning: () => boolean;
  runRunning: () => boolean;
}): { runPipelineBusy(): boolean; specDraftBusy(): boolean } {
  return {
    runPipelineBusy: () => holders.specDraftRunning(),
    specDraftBusy: () => holders.runRunning(),
  };
}

/**
 * A {@link RunQueueSeam} for the orchestrator's `run` tool, backed by
 * {@link dispatchTrigger} over the todo's own queue. It maps the queue's rich
 * {@link DispatchResult} down to the tool's narrow `dispatched | busy |
 * illegal` answer (Req 10.4, 10.5); every other refusal (probe/launch/guard) is
 * surfaced by the queue's reporter and reported to the tool as `illegal` with
 * the queue's message (for example `deps-unlanded`).
 *
 * `busy` means a stage is already running or being dispatched for THIS todo.
 * The queue is FIFO and would otherwise enqueue behind the running stage, so
 * the seam tracks in-flight dispatches itself. Different todos never see busy
 * from each other.
 */
export function createRunQueueSeam(
  queueFor: (slug: string, todoId: string) => RunQueue,
  specsDir: string,
  adapterForRole: AdapterForRole,
): RunQueueSeam {
  const inFlight = new Set<string>();
  return {
    async dispatch(req: RunDispatchRequest): Promise<RunDispatchOutcome> {
      const key = todoQueueKey(req.slug, req.todoId);
      const queue = queueFor(req.slug, req.todoId);
      if (inFlight.has(key) || queue.isRunning()) {
        return { kind: 'busy' };
      }
      inFlight.add(key);
      let result: DispatchResult;
      try {
        result = await dispatchTrigger(
          queue,
          specsDir,
          {
            kind: 'stage',
            slug: req.slug,
            todoId: req.todoId,
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
 * Count an already-parsed journal's start records for a todo's stage
 * (Req 21.1). Takes the parsed entry array so callers that also need
 * {@link latestStart} read the journal once (Req 3.2).
 */
function countStageStarts(
  entries: JournalEntry[],
  todoId: string,
  stage: Stage,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.todoId === todoId && entry.stage === stage) {
      count += 1;
    }
  }
  return count;
}
