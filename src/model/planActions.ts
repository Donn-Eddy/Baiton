/** Legal actions for a plan root, derived from the facts the tree model carries. */
import { PhaseState } from './phaseState';

/** User-facing actions for a plan root. */
export type PlanAction = 'approve' | 'submitPr' | 'showPr';

/** The derived facts used to calculate a plan root's legal actions. */
export interface PlanActionInput {
  approved: boolean;
  invalid: boolean;
  prUrl: string | undefined;
  phaseStates: readonly PhaseState[];
}

/** Return legal actions in deterministic order: approve, submitPr, showPr. */
export function legalPlanActions(input: PlanActionInput): PlanAction[] {
  if (input.invalid) {
    return [];
  }
  if (input.prUrl !== undefined) {
    return ['showPr'];
  }
  const actions: PlanAction[] = [];
  if (!input.approved) {
    actions.push('approve');
  }
  if (
    input.approved &&
    input.phaseStates.length > 0 &&
    input.phaseStates.every((state) => state === 'done')
  ) {
    actions.push('submitPr');
  }
  return actions;
}

/** Build the Plan Explorer root's action context value. */
export function planContextValue(actions: PlanAction[]): string {
  // Matched by the view/item/context when clauses in package.json; the prefix itself must never match an action token.
  return 'baiton.planRoot' + actions.map((a) => ' ' + a).join('');
}
