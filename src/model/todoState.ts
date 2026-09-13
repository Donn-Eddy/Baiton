/**
 * The lifecycle state of a single todo, written inside the `[state]` box of a
 * todo line. Matches the grammar in Requirement 3.2 and the state machine in
 * the design.
 */
export type TodoState =
  | 'pending'
  | 'planning'
  | 'planned'
  | 'executing'
  | 'executed'
  | 'reviewing'
  | 'done'
  | 'failed';

/** All valid todo states, in lifecycle order. */
export const TODO_STATES: readonly TodoState[] = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
] as const;

/** Whether an arbitrary string is a known TodoState. */
export function isTodoState(value: string): value is TodoState {
  return (TODO_STATES as readonly string[]).includes(value);
}
