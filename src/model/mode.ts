/**
 * The mode of one Baiton chat conversation, and so the pipeline a dispatch
 * from that conversation runs. A conversation starts in `default`, a
 * recommend-and-confirm mode that is never itself a run: it inspects the ask,
 * recommends one of the five concrete modes via one ask_user card, and
 * dispatches the picked mode with the existing tools. `spec` keeps the existing
 * gather -> draft_spec -> approve -> run per-todo flow byte-for-byte; `bug`,
 * `quick` and `refactor` share one spec-less plan -> execute -> review
 * pipeline that differs only in the framing handed to the sub-agents; and
 * `investigate` is a read-only dispatch that ends in a written finding.
 */
export type RunMode = 'default' | 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate';

/** All modes a conversation can be in, default first. */
export const RUN_MODES: readonly RunMode[] = [
  'default',
  'spec',
  'bug',
  'quick',
  'refactor',
  'investigate',
] as const;

/**
 * The mode a Workspace conversation starts in and the mode an absent/unknown
 * stored value falls back to. Spec conversations do not follow it: callers
 * that must stay Spec (a spec conversation's effective mode, webview
 * fallbacks) use the literal `'spec'`.
 */
export const DEFAULT_MODE: RunMode = 'default';

/** Whether an arbitrary string is a known RunMode. */
export function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Whether a mode's dispatches live entirely outside `.baiton/specs/`: true for
 * every mode except `spec`. A spec-less run owns only
 * `.baiton/runs/<run-id>/` and `.baiton/worktrees/<run-id>/`, so this is the
 * predicate later code uses to decide that no spec is read or written.
 * `investigate` is spec-less too — it simply runs a different pipeline, which
 * callers distinguish with `mode === 'investigate'`. `default` is spec-less
 * too — it never dispatches as itself and never reads or writes a spec; it
 * maps to the run phase beside bug/quick/refactor/investigate, and
 * runPipeline/runStore refuse it as a run mode just like 'spec'.
 */
export function isSpecless(mode: RunMode): boolean {
  return mode !== 'spec';
}
