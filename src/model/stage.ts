/**
 * A pipeline stage the extension can dispatch. Every stage except
 * `spec-draft` is scoped to a single todo; `spec-draft` is spec-scoped and runs
 * before the spec exists, turning the requirements the orchestrator gathered
 * into the spec's OVERVIEW and todo list.
 */
export type Stage =
  | 'spec-draft'
  | 'plan'
  | 'plan-review'
  | 'execute'
  | 'review'
  | 'pr';

/** All stages the extension knows. */
export const STAGES: readonly Stage[] = [
  'spec-draft',
  'plan',
  'plan-review',
  'execute',
  'review',
  'pr',
] as const;

/** Whether an arbitrary string is a known Stage. */
export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}
