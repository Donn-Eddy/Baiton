/** The lifecycle state of a single phase, written inside the `[state]` box of a phase line. */
export type PhaseState =
  | 'pending'
  | 'planning'
  | 'planned'
  | 'executing'
  | 'executed'
  | 'reviewing'
  | 'done'
  | 'failed';

/** All valid phase states, in lifecycle order. */
export const PHASE_STATES: readonly PhaseState[] = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
] as const;

/** Whether an arbitrary string is a known PhaseState. */
export function isPhaseState(value: string): value is PhaseState {
  return (PHASE_STATES as readonly string[]).includes(value);
}
