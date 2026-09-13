import * as assert from 'assert';
import * as fc from 'fast-check';
import { isLegalTransition, TransitionAction } from '../src/engine/transitions';
import { legalActions, todoContextValue, TodoAction } from '../src/model/todoActions';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Property test for the host-free legal-actions function (Requirement 4).
 *
 * Feature: baiton-run-controls, Property 2: Legal actions match the transition table
 */

const TRANSITION_ACTIONS: readonly TransitionAction[] = [
  'plan',
  'execute',
  'review',
  'replan',
  'stop',
];

const RUNNING_STATES: readonly TodoState[] = ['planning', 'executing', 'reviewing'];

describe('todoActions (property)', () => {
  it('legalActions equals isLegalTransition set plus view iff running or has session', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TODO_STATES),
        fc.boolean(),
        (state, hasSession) => {
          const actions = legalActions(state, hasSession);

          const expectedTransitionActions = TRANSITION_ACTIONS.filter((a) =>
            isLegalTransition(state, a),
          );
          const expectedView = RUNNING_STATES.includes(state) || hasSession;

          const actualTransitionActions = actions.filter(
            (a): a is TransitionAction => a !== 'view',
          );
          assert.deepStrictEqual(actualTransitionActions, expectedTransitionActions);
          assert.strictEqual(actions.includes('view'), expectedView);

          // No duplicates and deterministic ordering: plan, execute, review,
          // replan, stop, view.
          const order: TodoAction[] = ['plan', 'execute', 'review', 'replan', 'stop', 'view'];
          const orderedIndices = actions.map((a) => order.indexOf(a));
          const sorted = [...orderedIndices].sort((a, b) => a - b);
          assert.deepStrictEqual(orderedIndices, sorted);
          assert.strictEqual(new Set(actions).size, actions.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('todoContextValue matches \\b<action>\\b exactly for its actions and no other token', () => {
    const ALL_ACTIONS: readonly TodoAction[] = [
      'plan',
      'execute',
      'review',
      'replan',
      'stop',
      'view',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...TODO_STATES),
        fc.boolean(),
        (state, hasSession) => {
          const actions = legalActions(state, hasSession);
          const contextValue = todoContextValue(actions);

          // Begins with the fixed prefix.
          assert.ok(contextValue.startsWith('baiton.todo'));

          for (const action of ALL_ACTIONS) {
            const regex = new RegExp(`\\b${action}\\b`);
            const matches = regex.test(contextValue);
            const expected = actions.includes(action);
            assert.strictEqual(
              matches,
              expected,
              `contextValue "${contextValue}" token match for "${action}" expected ${expected}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
