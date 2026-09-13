/**
 * A sub-agent role. Each role gets its own permission flags from the adapter
 * (see the Claude adapter permission table in the design). `pr-writer` is
 * carried for the deferred PR stage and is unused in the first pass.
 */
export type Role =
  | 'spec-writer'
  | 'planner'
  | 'plan-reviewer'
  | 'executor'
  | 'reviewer'
  | 'pr-writer';

/** All roles named in the config `roles` mapping (Requirement 2.2). */
export const ROLES: readonly Role[] = [
  'spec-writer',
  'planner',
  'plan-reviewer',
  'executor',
  'reviewer',
  'pr-writer',
] as const;

/** Whether an arbitrary string is a known Role. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
