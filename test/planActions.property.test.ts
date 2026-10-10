import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  legalPlanActions,
  planContextValue,
  PlanAction,
} from '../src/model/planActions';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';

/**
 * Property test for the host-free legalPlanActions function (Requirement 4).
 *
 * A plan root SHALL offer exactly the actions that are legal for its derived
 * facts: nothing for an invalid plan, only Show PR once a PR URL is recorded,
 * and otherwise Approve while unapproved / Submit PR when approved with at
 * least one phase and every phase done (mirroring the engine's `checkReady`
 * gate). The `contextValue` SHALL carry exactly those actions as `\b<action>\b`
 * tokens, which is what the `view/item/context` `when` clauses match.
 */

/** Every plan action, for the token round-trip. */
const ALL_PLAN_ACTIONS: readonly PlanAction[] = ['approve', 'submitPr', 'showPr'];

/** A recorded PR URL, or undefined when the frontmatter key is absent/empty. */
const prUrlArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.constantFrom(
    'https://example.com/org/repo/pull/1',
    'https://github.test/o/r/pull/42',
  ),
  { nil: undefined },
);

/** Phase states in file order; an empty list means the plan has no phases. */
const phaseStatesArb: fc.Arbitrary<PhaseState[]> = fc.oneof(
  fc.array(fc.constantFrom(...PHASE_STATES), { maxLength: 6 }),
  // Bias towards all-done lists so the Submit PR branch is exercised often.
  fc.array(fc.constant<PhaseState>('done'), { minLength: 1, maxLength: 6 }),
);

describe('planActions (property)', () => {
  it('legalPlanActions gates approve/submitPr/showPr on the derived facts', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        phaseStatesArb,
        (approved, invalid, prUrl, phaseStates) => {
          const actions = legalPlanActions({ approved, invalid, prUrl, phaseStates });

          if (invalid) {
            assert.deepStrictEqual(actions, []);
            return;
          }

          // A recorded PR replaces every other action with Show PR, regardless
          // of the approval or the phase states.
          if (prUrl !== undefined) {
            assert.deepStrictEqual(actions, ['showPr']);
            return;
          }

          assert.strictEqual(actions.includes('showPr'), false);
          assert.strictEqual(actions.includes('approve'), !approved);
          assert.strictEqual(
            actions.includes('submitPr'),
            approved && phaseStates.length > 0 && phaseStates.every((s) => s === 'done'),
          );

          // No duplicates and deterministic ordering: approve, submitPr, showPr.
          const orderedIndices = actions.map((a) => ALL_PLAN_ACTIONS.indexOf(a));
          const sorted = [...orderedIndices].sort((a, b) => a - b);
          assert.deepStrictEqual(orderedIndices, sorted);
          assert.strictEqual(new Set(actions).size, actions.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('showPr is offered exactly when a PR URL is recorded on a valid plan', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        phaseStatesArb,
        (approved, invalid, prUrl, phaseStates) => {
          const actions = legalPlanActions({ approved, invalid, prUrl, phaseStates });
          assert.strictEqual(
            actions.includes('showPr'),
            !invalid && prUrl !== undefined,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('planContextValue matches \\b<action>\\b exactly for its actions and no other token', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        phaseStatesArb,
        (approved, invalid, prUrl, phaseStates) => {
          const actions = legalPlanActions({ approved, invalid, prUrl, phaseStates });
          const contextValue = planContextValue(actions);

          // Begins with the fixed prefix the menu clauses share.
          assert.ok(contextValue.startsWith('baiton.planRoot'));

          for (const action of ['plan', 'execute', 'review', 'replan', 'stop', 'view', 'viewPlan']) {
            const phaseOnly = new RegExp(`\\b${action}\\b`);
            assert.ok(!phaseOnly.test(contextValue), `plan root must not match phase action "${action}"`);
          }

          for (const action of ALL_PLAN_ACTIONS) {
            // The exact regex shape used by the `when` clauses in package.json.
            const regex = new RegExp(`\\b${action}\\b`);
            const expected = actions.includes(action);
            assert.strictEqual(
              regex.test(contextValue),
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
