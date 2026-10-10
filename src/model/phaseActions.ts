/**
 * Legal actions for a phase, derived from the pure transition table.
 * `legalActions` is shared by the Plan Explorer tree and CodeLens provider.
 */
import { isLegalTransition, isRunningState, TransitionAction } from '../engine/transitions';
import { PhaseState } from './phaseState';

/** User-facing actions available for a phase. */
export type PhaseAction =
  | 'plan'
  | 'execute'
  | 'review'
  | 'replan'
  | 'stop'
  | 'view'
  | 'viewPlan';

const TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'plan',
  'execute',
  'review',
  'replan',
  'stop',
];

const VIEW_PLAN_STATES: readonly PhaseState[] = [
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
];

/**
 * A phase's plan is at `phases/<id>/plan.md` (legacy `todos/<id>/plan.md`).
 * Return the legal actions for a phase with the supplied session and plan facts.
 */
export function legalActions(
  state: PhaseState,
  hasSession: boolean,
  hasPlan: boolean,
): PhaseAction[] {
  const actions: PhaseAction[] = TRANSITION_ACTIONS.filter((action) =>
    isLegalTransition(state, action),
  );
  if (isRunningState(state) || hasSession) {
    actions.push('view');
  }
  if (hasPlan && VIEW_PLAN_STATES.includes(state)) {
    actions.push('viewPlan');
  }
  return actions;
}

/** Build the Plan Explorer tree item's action context value. */
export function phaseContextValue(actions: PhaseAction[]): string {
  // This contextValue is still matched by package.json; the Activation/UI todo renames it.
  return 'baiton.todo' + actions.map((a) => ' ' + a).join('');
}
