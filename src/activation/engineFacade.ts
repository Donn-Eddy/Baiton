/**
 * The engine facade that binds a stage/action trigger to the run queue
 * (task 15.2; design "Stage engine").
 *
 * Both the orchestrator's `run` tool (through {@link RunQueueSeam}) and the VS
 * Code stage-trigger commands and CodeLens ask for "run this stage/action on
 * this todo". The queue's {@link RunRequest} needs more than the caller carries
 * — the sub-agent role, the 1-based attempt/round index, and the executor
 * resume flag — so this facade derives those from the stage and the run journal
 * and dispatches a single {@link RunRequest} (Req 10.3, 19.1).
 *
 * Attempt/round derivation reads the per-spec journal so numbered artifacts and
 * the executor continue flag are consistent across triggers:
 *   - plan → attempt 1 (a single plan artifact, `plan.md`).
 *   - execute → one past the count of prior execute starts for the todo, and
 *     `resume` is set when a prior execute start exists so the executor CLI
 *     continues its session across rounds (Req 13.2).
 *   - review → one past the count of prior review starts for the todo.
 *   - replan / stop → control actions with no stage; attempt is unused.
 *
 * The facade never imports `vscode`; the command layer and the run tool call
 * into it with plain values.
 */
import * as path from 'path';
import type { Role } from '../model/role';
import type { Stage } from '../model/stage';
import type {
  DispatchResult,
  RunQueue,
  TransitionAction,
} from '../engine';
import type { RunDispatchOutcome, RunDispatchRequest, RunQueueSeam } from '../orchestrator';
import { latestStart, parseJournal, JournalEntry } from '../journal';

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

  const journalPath = path.join(specsDir, trigger.slug, 'runs.jsonl');
  const entries = parseJournal(journalPath);
  const priorStarts = countStageStarts(entries, trigger.todoId, trigger.stage);
  const attempt = priorStarts + 1;
  const resume = trigger.stage === 'execute' && priorStarts > 0;
  // Resume by Session_Id: the executor continues the todo's most recent
  // execute start's session, falling back to `-c` when it has none (Req 3.2).
  const resumeSessionId = resume
    ? latestStart(entries, trigger.todoId, 'execute')?.sessionId
    : undefined;

  return queue.dispatch({
    slug: trigger.slug,
    todoId: trigger.todoId,
    action,
    role: STAGE_ROLE[trigger.stage],
    attempt,
    resume,
    resumeSessionId,
  });
}

/**
 * A {@link RunQueueSeam} for the orchestrator's `run` tool, backed by
 * {@link dispatchTrigger}. It maps the queue's rich {@link DispatchResult} down
 * to the tool's narrow `dispatched | busy | illegal` answer (Req 10.4, 10.5);
 * every other refusal (probe/launch/guard) is surfaced by the queue's reporter
 * and reported to the tool as `illegal` with the queue's message so the model
 * sees why the stage did not start.
 */
export function createRunQueueSeam(
  queueForSlug: (slug: string) => RunQueue,
  specsDir: string,
): RunQueueSeam {
  return {
    async dispatch(req: RunDispatchRequest): Promise<RunDispatchOutcome> {
      const result = await dispatchTrigger(queueForSlug(req.slug), specsDir, {
        kind: 'stage',
        slug: req.slug,
        todoId: req.todoId,
        stage: req.stage,
      });
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
