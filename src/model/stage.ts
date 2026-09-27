/**
 * A pipeline stage the extension can dispatch. Every stage except
 * `spec-draft` and `investigate` is scoped to a single todo; `spec-draft` is
 * spec-scoped and runs before the spec exists, turning the requirements the
 * orchestrator gathered into the spec's OVERVIEW and todo list. `investigate`
 * is run-scoped: it is run by the existing `reviewer` role and persists a
 * single `finding.md` at the root of its run directory.
 */
export type Stage =
  | 'spec-draft'
  | 'plan'
  | 'plan-review'
  | 'execute'
  | 'review'
  | 'pr'
  | 'investigate';

/** All stages the extension knows. */
export const STAGES: readonly Stage[] = [
  'spec-draft',
  'plan',
  'plan-review',
  'execute',
  'review',
  'pr',
  'investigate',
] as const;

/** Whether an arbitrary string is a known Stage. */
export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}
