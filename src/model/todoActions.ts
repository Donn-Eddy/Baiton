/**
 * Legal actions for a todo, derived from the pure transition table
 * (Requirement 4: only legal actions are shown).
 *
 * `legalActions` is the single host-free function that both the Spec_Explorer
 * tree and the CodeLens provider consult, so they cannot disagree about which
 * buttons a todo shows (Req 4.3). It reuses `isLegalTransition` for the
 * state-machine actions and adds `view` per Req 4.4; it never re-implements
 * the transition table.
 *
 * This module carries no `vscode` import so it is directly unit- and
 * property-testable without a VS Code host.
 */
import { isLegalTransition, isRunningState, TransitionAction } from '../engine/transitions';
import { TodoState } from './todoState';

/**
 * A user-facing action for a todo: the state-machine actions (`plan`,
 * `execute`, `review`, `replan`, `stop`) plus `view`, which opens/attaches a
 * terminal to a recorded sub-agent session rather than transitioning state.
 */
export type TodoAction = 'plan' | 'execute' | 'review' | 'replan' | 'stop' | 'view';

/** The state-machine actions considered, in the order actions are reported. */
const TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'plan',
  'execute',
  'review',
  'replan',
  'stop',
];

/**
 * The legal actions for a todo in `state`, given whether the journal records a
 * Session_Id for it (`hasSession`). The state-machine actions come from
 * {@link isLegalTransition}; `view` is legal when the todo is in a running
 * state or has a recorded session (Req 4.3, 4.4). Order is deterministic:
 * plan, execute, review, replan, stop, view.
 */
export function legalActions(state: TodoState, hasSession: boolean): TodoAction[] {
  const actions: TodoAction[] = TRANSITION_ACTIONS.filter((action) =>
    isLegalTransition(state, action),
  );
  if (isRunningState(state) || hasSession) {
    actions.push('view');
  }
  return actions;
}

/**
 * Builds the tree item `contextValue` for a todo: `baiton.todo` followed by
 * one space-separated token per legal action (Req 4.1), e.g.
 * `baiton.todo plan replan`. The `view/item/context` `when` clauses in
 * `package.json` match on these tokens via `\b<action>\b` regexes.
 */
export function todoContextValue(actions: TodoAction[]): string {
  return 'baiton.todo' + actions.map((a) => ' ' + a).join('');
}
