/**
 * The mode of one Baiton chat conversation, and so the pipeline a dispatch
 * from that conversation runs. A conversation starts in `default`, a
 * recommend-and-confirm mode that is never itself a run: it inspects the ask,
 * recommends one of the five concrete modes via one ask_user card, and
 * dispatches the picked mode with the existing tools. `plan` keeps the existing
 * gather -> draft_plan -> approve -> run per-phase flow byte-for-byte; `bug`,
 * `quick` and `refactor` share one plan-less plan -> execute -> review
 * pipeline that differs only in the framing handed to the sub-agents; and
 * `investigate` is a read-only dispatch that ends in a written finding.
 */
export type RunMode = 'default' | 'plan' | 'bug' | 'quick' | 'refactor' | 'investigate';

/** All modes a conversation can be in, default first. */
export const RUN_MODES: readonly RunMode[] = [
  'default',
  'plan',
  'bug',
  'quick',
  'refactor',
  'investigate',
] as const;

/**
 * The mode a Workspace conversation starts in and the mode an absent/unknown
 * stored value falls back to. Plan conversations do not follow it: callers
 * that must stay Plan (a plan conversation's effective mode, webview
 * fallbacks) use the literal `'plan'`.
 */
export const DEFAULT_MODE: RunMode = 'default';

/** Whether an arbitrary string is a known RunMode. */
export function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

/** Parse a persisted mode, accepting the pre-rename value for compatibility. */
export function toRunMode(value: string): RunMode | undefined {
  // Legacy: workspace state written before the phased-plan rename stored `spec`.
  if (value === 'spec') {
    return 'plan';
  }
  return isRunMode(value) ? value : undefined;
}

/**
 * Whether a mode's dispatches live entirely outside the plan document roots:
 * true for every mode except `plan`. A plan-less run owns only
 * `.baiton/runs/<run-id>/` and `.baiton/worktrees/<run-id>/`, so this is the
 * predicate later code uses to decide that no plan is read or written.
 * `investigate` is plan-less too — it simply runs a different pipeline, which
 * callers distinguish with `mode === 'investigate'`. `default` is plan-less
 * too — it never dispatches as itself and never reads or writes a plan; it
 * maps to the run phase beside bug/quick/refactor/investigate, and
 * runPipeline/runStore refuse it as a run mode just like 'plan'.
 */
export function isPlanless(mode: RunMode): boolean {
  return mode !== 'plan';
}
