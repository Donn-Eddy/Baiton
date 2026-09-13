import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  legalSpecActions,
  specContextValue,
  SpecAction,
} from '../src/model/specActions';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Property test for the host-free legal-spec-actions function (Requirement 4).
 *
 * A spec root SHALL offer exactly the actions that are legal for its derived
 * facts: nothing for an invalid spec, only Show PR once a PR URL is recorded,
 * and otherwise Approve while unapproved / Submit PR when approved with at
 * least one todo and every todo done (mirroring the engine's `checkReady`
 * gate). The `contextValue` SHALL carry exactly those actions as `\b<action>\b`
 * tokens, which is what the `view/item/context` `when` clauses match.
 */

/** Every spec action, for the token round-trip. */
const ALL_SPEC_ACTIONS: readonly SpecAction[] = ['approve', 'submitPr', 'showPr'];

/** A recorded PR URL, or undefined when the frontmatter key is absent/empty. */
const prUrlArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.constantFrom(
    'https://example.com/org/repo/pull/1',
    'https://github.test/o/r/pull/42',
  ),
  { nil: undefined },
);

/** The todo states of a spec, in file order; an empty list is a todo-less spec. */
const todoStatesArb: fc.Arbitrary<TodoState[]> = fc.oneof(
  fc.array(fc.constantFrom(...TODO_STATES), { maxLength: 6 }),
  // Bias towards all-done lists so the Submit PR branch is exercised often.
  fc.array(fc.constant<TodoState>('done'), { minLength: 1, maxLength: 6 }),
);

describe('specActions (property)', () => {
  it('legalSpecActions gates approve/submitPr/showPr on the derived facts', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        todoStatesArb,
        (approved, invalid, prUrl, todoStates) => {
          const actions = legalSpecActions({ approved, invalid, prUrl, todoStates });

          if (invalid) {
            assert.deepStrictEqual(actions, []);
            return;
          }

          // A recorded PR replaces every other action with Show PR, regardless
          // of the approval or the todo states.
          if (prUrl !== undefined) {
            assert.deepStrictEqual(actions, ['showPr']);
            return;
          }

          assert.strictEqual(actions.includes('showPr'), false);
          assert.strictEqual(actions.includes('approve'), !approved);
          assert.strictEqual(
            actions.includes('submitPr'),
            approved && todoStates.length > 0 && todoStates.every((s) => s === 'done'),
          );

          // No duplicates and deterministic ordering: approve, submitPr, showPr.
          const orderedIndices = actions.map((a) => ALL_SPEC_ACTIONS.indexOf(a));
          const sorted = [...orderedIndices].sort((a, b) => a - b);
          assert.deepStrictEqual(orderedIndices, sorted);
          assert.strictEqual(new Set(actions).size, actions.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('showPr is offered exactly when a PR URL is recorded on a valid spec', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        todoStatesArb,
        (approved, invalid, prUrl, todoStates) => {
          const actions = legalSpecActions({ approved, invalid, prUrl, todoStates });
          assert.strictEqual(
            actions.includes('showPr'),
            !invalid && prUrl !== undefined,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('specContextValue matches \\b<action>\\b exactly for its actions and no other token', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        prUrlArb,
        todoStatesArb,
        (approved, invalid, prUrl, todoStates) => {
          const actions = legalSpecActions({ approved, invalid, prUrl, todoStates });
          const contextValue = specContextValue(actions);

          // Begins with the fixed prefix the menu clauses share.
          assert.ok(contextValue.startsWith('baiton.spec'));

          for (const action of ALL_SPEC_ACTIONS) {
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
