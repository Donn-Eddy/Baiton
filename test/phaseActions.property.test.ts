import * as assert from 'assert';
import * as fc from 'fast-check';
import { isLegalTransition, TransitionAction } from '../src/engine/transitions';
import { legalActions, phaseContextValue, PhaseAction } from '../src/model/phaseActions';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';

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

const RUNNING_STATES: readonly PhaseState[] = ['planning', 'executing', 'reviewing'];

/** The states from which a plan on file can be opened (`planned` and later). */
const PLANNED_OR_LATER: readonly PhaseState[] = [
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
];

describe('todoActions (property)', () => {
  it('legalActions equals isLegalTransition set plus view/viewPlan on their own facts', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PHASE_STATES),
        fc.boolean(),
        fc.boolean(),
        (state, hasSession, hasPlan) => {
          const actions = legalActions(state, hasSession, hasPlan);

          const expectedTransitionActions = TRANSITION_ACTIONS.filter((a) =>
            isLegalTransition(state, a),
          );
          const expectedView = RUNNING_STATES.includes(state) || hasSession;
          // View plan needs both a plan on file and a state at `planned` or
          // later; neither fact alone offers it.
          const expectedViewPlan = hasPlan && PLANNED_OR_LATER.includes(state);

          const actualTransitionActions = actions.filter(
            (a): a is TransitionAction => a !== 'view' && a !== 'viewPlan',
          );
          assert.deepStrictEqual(actualTransitionActions, expectedTransitionActions);
          assert.strictEqual(actions.includes('view'), expectedView);
          assert.strictEqual(actions.includes('viewPlan'), expectedViewPlan);

          // No duplicates and deterministic ordering: plan, execute, review,
          // replan, stop, view, viewPlan.
          const order: PhaseAction[] = [
            'plan',
            'execute',
            'review',
            'replan',
            'stop',
            'view',
            'viewPlan',
          ];
          const orderedIndices = actions.map((a) => order.indexOf(a));
          const sorted = [...orderedIndices].sort((a, b) => a - b);
          assert.deepStrictEqual(orderedIndices, sorted);
          assert.strictEqual(new Set(actions).size, actions.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('phaseContextValue matches \\b<action>\\b exactly for its actions and no other token', () => {
    const ALL_ACTIONS: readonly PhaseAction[] = [
      'plan',
      'execute',
      'review',
      'replan',
      'stop',
      'view',
      'viewPlan',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...PHASE_STATES),
        fc.boolean(),
        fc.boolean(),
        (state, hasSession, hasPlan) => {
          const actions = legalActions(state, hasSession, hasPlan);
          const contextValue = phaseContextValue(actions);

          // Begins with the fixed prefix.
          assert.ok(contextValue.startsWith('baiton.phase'));

          for (const action of ['approve', 'submitPr', 'showPr']) {
            const planOnly = new RegExp(`\\b${action}\\b`);
            assert.ok(!planOnly.test(contextValue), `phase item must not match plan action "${action}"`);
          }

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
