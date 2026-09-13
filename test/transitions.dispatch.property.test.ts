import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  isLegalTransition,
  resolveTransition,
  isRunningState,
  Transition,
  TransitionAction,
} from '../src/engine/transitions';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 14: Stage dispatch obeys the transition
 * table — For any pair of a todo's current state and a requested stage/action,
 * the extension SHALL dispatch iff that pair is a legal transition in the state
 * table (Plan from `pending` when approved and unblocked; Execute from
 * `planned`/`executed`/`failed` with a clean tree; Review from `executed`;
 * Re-plan from any non-running state; Stop from a running state), and SHALL
 * apply the table's resulting state.
 *
 * Validates: Requirements 10.5, 18.1, 18.2, 18.7, 18.12, 18.13, 18.14, 18.15
 *
 * The check exhaustively cross-products the eight `TodoState` values with the
 * five `TransitionAction` values and compares `isLegalTransition` /
 * `resolveTransition` against an independent reference derived directly from the
 * design's "Todo State Machine" table. For legal pairs the reference also pins
 * the `running`, `onSuccess`, and `onFindings` states, so the property fails if
 * the implementation dispatches an illegal pair, refuses a legal one, or applies
 * the wrong resulting state.
 */

const ALL_ACTIONS: readonly TransitionAction[] = ['plan', 'execute', 'review', 'replan', 'stop'];

/** The running states, per the design (a stage is in flight). */
const RUNNING: readonly TodoState[] = ['planning', 'executing', 'reviewing'];

/**
 * Independent reference for the design's transition table. Returns the expected
 * resolved transition shape for a legal (`from`, `action`) pair, or `undefined`
 * when the pair must be refused. Written from the design table rather than the
 * implementation so the two can disagree.
 */
function referenceTransition(from: TodoState, action: TransitionAction): Transition | undefined {
  const running = RUNNING.includes(from);
  switch (action) {
    case 'plan':
      // Legal only from `pending`: planning -> planned, approved AND not blocked.
      return from === 'pending'
        ? {
            action: 'plan',
            from,
            running: 'planning',
            onSuccess: 'planned',
            guards: { approvedAndUnblocked: true, cleanTreeAndInputRev: false },
          }
        : undefined;
    case 'execute':
      // Legal from planned/executed/failed: executing -> executed, clean tree + input_rev.
      return from === 'planned' || from === 'executed' || from === 'failed'
        ? {
            action: 'execute',
            from,
            running: 'executing',
            onSuccess: 'executed',
            guards: { approvedAndUnblocked: false, cleanTreeAndInputRev: true },
          }
        : undefined;
    case 'review':
      // Legal only from `executed`: reviewing -> done (pass) / executed (findings).
      return from === 'executed'
        ? {
            action: 'review',
            from,
            running: 'reviewing',
            onSuccess: 'done',
            onFindings: 'executed',
            guards: { approvedAndUnblocked: false, cleanTreeAndInputRev: false },
          }
        : undefined;
    case 'replan':
      // Legal from any non-running state -> pending, no guards, no running phase.
      return running
        ? undefined
        : {
            action: 'replan',
            from,
            onSuccess: 'pending',
            guards: { approvedAndUnblocked: false, cleanTreeAndInputRev: false },
          };
    case 'stop': {
      // Legal only from a running state -> revert to the pre-stage state (note
      // `cancelled`), no running phase. planning -> pending, reviewing ->
      // executed, executing -> failed (no executeFrom supplied here).
      if (!running) {
        return undefined;
      }
      const reverted: TodoState =
        from === 'planning' ? 'pending' : from === 'reviewing' ? 'executed' : 'failed';
      return {
        action: 'stop',
        from,
        onSuccess: reverted,
        guards: { approvedAndUnblocked: false, cleanTreeAndInputRev: false },
      };
    }
    default:
      return undefined;
  }
}

/** Compare two transitions field-by-field, tolerating undefined optional fields. */
function assertSameTransition(
  actual: Transition,
  expected: Transition,
  label: string,
): void {
  assert.strictEqual(actual.action, expected.action, `${label}: action`);
  assert.strictEqual(actual.from, expected.from, `${label}: from`);
  assert.strictEqual(actual.running, expected.running, `${label}: running`);
  assert.strictEqual(actual.onSuccess, expected.onSuccess, `${label}: onSuccess`);
  assert.strictEqual(actual.onFindings, expected.onFindings, `${label}: onFindings`);
  assert.strictEqual(
    actual.guards.approvedAndUnblocked,
    expected.guards.approvedAndUnblocked,
    `${label}: guards.approvedAndUnblocked`,
  );
  assert.strictEqual(
    actual.guards.cleanTreeAndInputRev,
    expected.guards.cleanTreeAndInputRev,
    `${label}: guards.cleanTreeAndInputRev`,
  );
}

describe('stage dispatch obeys the transition table (property)', () => {
  // Feature: baiton-first-pass, Property 14: Stage dispatch obeys the transition table
  it('legality and resolved state match the design table for every (state, action) pair', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TodoState>(...TODO_STATES),
        fc.constantFrom<TransitionAction>(...ALL_ACTIONS),
        (from, action) => {
          const expected = referenceTransition(from, action);
          const resolved = resolveTransition(from, action);
          const legal = isLegalTransition(from, action);
          const label = `(${from}, ${action})`;

          // Legality: dispatch iff the pair is in the table.
          assert.strictEqual(legal, expected !== undefined, `${label}: isLegalTransition`);
          // isLegalTransition is a thin predicate over resolveTransition.
          assert.strictEqual(legal, resolved !== undefined, `${label}: legality vs resolve`);

          if (expected === undefined) {
            assert.strictEqual(resolved, undefined, `${label}: illegal pair must not resolve`);
            return;
          }

          assert.ok(resolved, `${label}: legal pair must resolve`);
          assertSameTransition(resolved as Transition, expected, label);

          // The running-state marker must agree with isRunningState.
          assert.strictEqual(
            isRunningState(from),
            RUNNING.includes(from),
            `${label}: isRunningState`,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  // Feature: baiton-first-pass, Property 14: Stage dispatch obeys the transition table
  it('exhaustively covers all 40 (state, action) pairs against the reference', () => {
    // A deterministic full sweep so no legal/illegal pair can be missed by sampling.
    for (const from of TODO_STATES) {
      for (const action of ALL_ACTIONS) {
        const expected = referenceTransition(from, action);
        const resolved = resolveTransition(from, action);
        const label = `(${from}, ${action})`;

        assert.strictEqual(
          isLegalTransition(from, action),
          expected !== undefined,
          `${label}: legality`,
        );
        if (expected === undefined) {
          assert.strictEqual(resolved, undefined, `${label}: must be refused`);
        } else {
          assert.ok(resolved, `${label}: must resolve`);
          assertSameTransition(resolved as Transition, expected, label);
        }
      }
    }
  });
});
