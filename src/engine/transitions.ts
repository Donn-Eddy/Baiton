/**
 * The pure Todo State Machine transition table (Requirements 10.5, 18.1–18.16;
 * design "Todo State Machine").
 *
 * This module is a pure `(from-state, action) -> transition` lookup with the
 * guards each transition carries. It contains no I/O, no git, no terminals, and
 * no timing, so it is directly unit- and property-testable. The run queue
 * consumes {@link resolveTransition} to decide whether a requested action is
 * legal for a todo's current state, which running state to write while the
 * stage is in flight, and which terminal state(s) the stage's outcome maps to.
 *
 * The legal transitions, matching the design table (any pair not listed is
 * refused):
 *
 *   | From                         | Action  | Running     | To (outcome)                       | Guard                              |
 *   |------------------------------|---------|-------------|------------------------------------|------------------------------------|
 *   | pending                      | plan    | planning    | planned                            | approved AND not blocked           |
 *   | planned, executed, failed    | execute | executing   | executed                           | clean tree AND input_rev matches   |
 *   | executed                     | review  | reviewing   | done (pass) / executed (findings)  | —                                  |
 *   | any non-running              | replan  | —           | pending                            | —                                  |
 *   | planning, executing, reviewing | stop  | —           | revert: planning→pending, reviewing→executed, executing→executeFrom ?? failed (note `cancelled`) | — |
 *
 * A `plan-review` stage is not a todo-state transition of its own: it runs
 * inside the Plan action's review rounds and does not move the todo between
 * lifecycle states, so it has no row here (the queue drives review rounds while
 * the todo stays in `planning`).
 */
import type { TodoState } from '../model/todoState';

/**
 * A lifecycle action the user (or orchestrator) can trigger for a todo. These
 * are the state-machine actions, distinct from {@link Stage}: `plan`,
 * `execute` and `review` map onto stages, while `replan` and `stop` are
 * control actions that only rewrite state.
 */
export type TransitionAction = 'plan' | 'execute' | 'review' | 'replan' | 'stop';

/** The guard conditions a transition may require before it is legal. */
export interface TransitionGuards {
  /**
   * Requires the spec to be approved (its `approved_rev` byte-equals the
   * current Approval_Hash) AND the todo's derived blocked status to be false
   * (Req 18.1, 18.2). Set on the Plan transition.
   */
  readonly approvedAndUnblocked: boolean;
  /**
   * Requires a clean working tree AND the plan's recorded Input_Rev to match
   * the current Input_Rev (Req 18.7, 18.8, 18.9). Set on the Execute
   * transition. Additionally the approval-hash gate applies to Execute
   * (Req 5.3, 5.4); that is enforced by the queue alongside this guard.
   */
  readonly cleanTreeAndInputRev: boolean;
}

/** No guards required. */
const NO_GUARDS: TransitionGuards = {
  approvedAndUnblocked: false,
  cleanTreeAndInputRev: false,
};

/**
 * A resolved legal transition: the running state to write while the stage is in
 * flight (absent for the instantaneous control actions), the guards to satisfy
 * before dispatch, and the terminal state(s) the outcome maps to.
 */
export interface Transition {
  /** The action this transition is for. */
  readonly action: TransitionAction;
  /** The state the todo held when the transition was resolved. */
  readonly from: TodoState;
  /**
   * The state written while the stage runs, e.g. `planning` for Plan. Absent
   * for control actions (`replan`, `stop`) which apply their terminal state
   * immediately without a running phase.
   */
  readonly running?: TodoState;
  /**
   * The state applied on a successful/`pass` terminal outcome (Req 18.1, 18.7,
   * 18.12). For `stop` this is the `failed` cancellation state (Req 18.15); for
   * `replan` it is `pending` (Req 18.14).
   */
  readonly onSuccess: TodoState;
  /**
   * For the Review action only: the state applied when the reviewer returns a
   * `findings` verdict rather than `pass` (Req 18.13). Absent for every other
   * action, whose single outcome uses {@link onSuccess}.
   */
  readonly onFindings?: TodoState;
  /** The guards that must hold before this transition may be dispatched. */
  readonly guards: TransitionGuards;
}

/** The set of states considered "running" (a stage is in flight). */
const RUNNING_STATES: readonly TodoState[] = ['planning', 'executing', 'reviewing'];

/** Whether a todo state is a running state (a stage is in flight). */
export function isRunningState(state: TodoState): boolean {
  return RUNNING_STATES.includes(state);
}

/**
 * The static transition table: for each action, the map from a legal `from`
 * state to the transition it produces. A `from`/`action` pair absent here is
 * an illegal transition and is refused by {@link resolveTransition} (Req 10.5,
 * 18.x).
 *
 * `replan` and `stop` are computed rather than tabulated because they apply to
 * a whole class of states (any non-running state for `replan`; every running
 * state for `stop`); {@link resolveTransition} handles those two actions
 * directly.
 */
const TABLE: Partial<Record<TransitionAction, Partial<Record<TodoState, Transition>>>> = {
  plan: {
    pending: {
      action: 'plan',
      from: 'pending',
      running: 'planning',
      onSuccess: 'planned',
      guards: { approvedAndUnblocked: true, cleanTreeAndInputRev: false },
    },
  },
  execute: {
    planned: executeTransition('planned'),
    executed: executeTransition('executed'),
    failed: executeTransition('failed'),
  },
  review: {
    executed: {
      action: 'review',
      from: 'executed',
      running: 'reviewing',
      onSuccess: 'done',
      onFindings: 'executed',
      guards: NO_GUARDS,
    },
  },
};

/** Build the Execute transition for a given legal `from` state (Req 18.7). */
function executeTransition(from: TodoState): Transition {
  return {
    action: 'execute',
    from,
    running: 'executing',
    onSuccess: 'executed',
    guards: { approvedAndUnblocked: false, cleanTreeAndInputRev: true },
  };
}

/**
 * The state a running todo returns to when its in-flight stage is stopped
 * rather than completing (Req 18.15). `planning` reverts to `pending`,
 * `reviewing` reverts to `executed`, and `executing` reverts to the state the
 * todo held before that Execute stage started (`executeFrom`), defaulting to
 * `failed` when that origin is unknown. Any non-running state is returned
 * unchanged.
 */
export function revertStateFor(running: TodoState, executeFrom?: TodoState): TodoState {
  switch (running) {
    case 'planning':
      return 'pending';
    case 'reviewing':
      return 'executed';
    case 'executing':
      return executeFrom ?? 'failed';
    default:
      return running; // not running: unchanged
  }
}

/**
 * Resolve the legal {@link Transition} for an action requested against a todo's
 * current state, or `undefined` when the pair is not a legal transition and
 * must be refused (Req 10.5, 18.x). Resolving a transition does not check the
 * guards — it only reports the shape of the (guarded) move; the queue evaluates
 * {@link Transition.guards} against live git/spec state before dispatching.
 *
 * - `plan`/`execute`/`review` come from the static {@link TABLE}.
 * - `replan` is legal from any non-running state and moves the todo to
 *   `pending`, retaining prior artifacts as superseded (Req 18.14).
 * - `stop` is legal only from a running state and reverts the todo to the
 *   state it held before that stage began, via {@link revertStateFor}
 *   (Req 18.15); `opts.executeFrom` supplies the Execute stage's origin state
 *   when `from` is `executing`.
 */
export function resolveTransition(
  from: TodoState,
  action: TransitionAction,
  opts?: { executeFrom?: TodoState },
): Transition | undefined {
  if (action === 'replan') {
    // Re-plan is legal from any state that is not currently running (Req 18.14).
    if (isRunningState(from)) {
      return undefined;
    }
    return {
      action: 'replan',
      from,
      onSuccess: 'pending',
      guards: NO_GUARDS,
    };
  }

  if (action === 'stop') {
    // Stop is legal only while a stage is running (Req 18.15).
    if (!isRunningState(from)) {
      return undefined;
    }
    return {
      action: 'stop',
      from,
      onSuccess: revertStateFor(from, opts?.executeFrom),
      guards: NO_GUARDS,
    };
  }

  return TABLE[action]?.[from];
}

/**
 * Whether the `action`/`from` pair is a legal transition at all, ignoring
 * guard evaluation (Req 10.5). A thin predicate over {@link resolveTransition}
 * for callers that only need the legality decision.
 */
export function isLegalTransition(from: TodoState, action: TransitionAction): boolean {
  return resolveTransition(from, action) !== undefined;
}

/**
 * The {@link Stage} an action dispatches, or `undefined` for the control
 * actions (`replan`, `stop`) that only rewrite state without launching a
 * sub-agent. `plan-review` is not produced here: it is a sub-stage the queue
 * runs inside the Plan action's review rounds.
 */
export function stageForAction(action: TransitionAction): 'plan' | 'execute' | 'review' | undefined {
  switch (action) {
    case 'plan':
      return 'plan';
    case 'execute':
      return 'execute';
    case 'review':
      return 'review';
    default:
      return undefined;
  }
}
