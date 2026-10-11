/**
 * A pipeline stage the extension can dispatch. Every stage except
 * `plan-draft` and `investigate` are not scoped to a single phase; `plan-draft` is
 * plan-scoped and runs before the plan exists, turning the requirements the
 * orchestrator gathered into the plan's preamble and phase list. `investigate`
 * is run-scoped: it is run by the existing `reviewer` role and persists a
 * single `finding.md` at the root of its run directory.
 */
export type Stage =
  | 'plan-draft'
  | 'plan'
  | 'plan-review'
  | 'execute'
  | 'review'
  | 'pr'
  | 'investigate';

/** All stages the extension knows. */
export const STAGES: readonly Stage[] = [
  'plan-draft',
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

/** Parse a persisted stage, accepting the pre-rename journal value. */
export function toStage(value: string): Stage | undefined {
  // Legacy: journal entries written before the phased-plan rename use `spec-draft`.
  if (value === 'spec-draft') {
    return 'plan-draft';
  }
  return isStage(value) ? value : undefined;
}
