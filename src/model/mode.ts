/**
 * The mode of one Baiton chat conversation, and so the pipeline a dispatch
 * from that conversation runs. `spec` is the default and keeps the existing
 * gather -> draft_spec -> approve -> run per-todo flow byte-for-byte; `bug`,
 * `quick` and `refactor` share one spec-less plan -> execute -> review
 * pipeline that differs only in the framing handed to the sub-agents; and
 * `investigate` is a read-only dispatch that ends in a written finding.
 */
export type RunMode = 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate';

/** All modes a conversation can be in, spec first. */
export const RUN_MODES: readonly RunMode[] = [
  'spec',
  'bug',
  'quick',
  'refactor',
  'investigate',
] as const;

/**
 * The mode a conversation starts in and the mode an absent/unknown stored
 * value falls back to, so every existing code path keeps today's behaviour.
 */
export const DEFAULT_MODE: RunMode = 'spec';

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
 * callers distinguish with `mode === 'investigate'`.
 */
export function isSpecless(mode: RunMode): boolean {
  return mode !== 'spec';
}
