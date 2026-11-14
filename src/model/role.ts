/**
 * A sub-agent role. `phased-planner` drafts the whole phased plan during the
 * plan-draft stage with the `draft_plan` tool; `step-planner` writes one phase's
 * plan during the plan stage; and `step-reviewer` reviews that phase plan in
 * the plan-review sub-stage. The remaining roles execute, review, or write PRs.
 */
export type Role =
  | 'phased-planner'
  | 'step-planner'
  | 'step-reviewer'
  | 'executor'
  | 'reviewer'
  | 'pr-writer';

/** All roles named in the config `roles` mapping (Requirement 2.2). */
export const ROLES: readonly Role[] = [
  'phased-planner',
  'step-planner',
  'step-reviewer',
  'executor',
  'reviewer',
  'pr-writer',
] as const;

/** Whether an arbitrary string is a known Role. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
