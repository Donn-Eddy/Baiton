/** Legal actions for a plan root, derived from the facts the tree model carries. */
import { PhaseState } from './phaseState';

/** The frontmatter status used when at least one repo PR is open and another failed. */
export const PR_PARTIAL_STATUS = 'pr-partial';
/** The frontmatter status used when all touched repo PRs are open. */
export const PR_STATUS = 'pr';

/** User-facing actions for a plan root. */
export type PlanAction = 'approve' | 'submitPr' | 'showPr';

/** The derived facts used to calculate a plan root's legal actions. */
export interface PlanActionInput {
  approved: boolean;
  invalid: boolean;
  prUrl: string | undefined;
  phaseStates: readonly PhaseState[];
  /** Trimmed frontmatter status, when present. */
  status?: string;
}

/** Return legal actions in deterministic order: approve, submitPr, showPr. A partial plan offers Submit PR as a retry beside Show PR. */
export function legalPlanActions(input: PlanActionInput): PlanAction[] {
  if (input.invalid) {
    return [];
  }
  if (input.status === PR_PARTIAL_STATUS) {
    const actions: PlanAction[] = [];
    if (
      input.approved &&
      input.phaseStates.length > 0 &&
      input.phaseStates.every((state) => state === 'done')
    ) {
      actions.push('submitPr');
    }
    if (input.prUrl !== undefined) {
      actions.push('showPr');
    }
    return actions;
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
