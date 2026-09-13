import * as assert from 'assert';
import * as fc from 'fast-check';
import { isBlocked } from '../src/model/hash';
import { Todo } from '../src/model/parser';
import { writeTodoState } from '../src/model/writer';
import { TODO_STATES, TodoState, isTodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 6: Blocked is derived, never written —
 * For any spec and any todo, `isBlocked(todo)` SHALL be true if and only if at
 * least one of that todo's `after` targets is in a state other than `done`, and
 * the serializer output SHALL never contain a written blocked marker.
 *
 * Validates: Requirements 4.10
 *
 * Two halves are exercised together:
 *
 *   1. Derivation. Over random todo sets with random `after` edges into that
 *      set (and occasional dangling ids), `isBlocked(todo, all)` must equal the
 *      independent reference "some after target is not done" — where a target
 *      that is absent from the set counts as not done, since an unmet/unknown
 *      dependency cannot be complete.
 *
 *   2. Never written. `blocked` is not one of the eight legal TodoStates, so it
 *      can never be produced by `writeTodoState`. For every legal state the
 *      writer emits, the resulting todo line's `[state]` box must hold that
 *      exact legal state and must never read `[blocked]`.
 */

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/** Sanity: `blocked` is not, and must never become, a legal todo state. */
const BLOCKED = 'blocked';

/**
 * A small set of todos with unique ids, each carrying a random state and a
 * random `after` list. Edges point mostly at ids in the set, with a sprinkling
 * of dangling ids so the "absent target counts as not done" branch is covered.
 */
const todoSetArb: fc.Arbitrary<Todo[]> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 8 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id, index) =>
        fc
          .record({
            state: fc.constantFrom<TodoState>(...TODO_STATES),
            // `after` targets: any of the set's ids, plus a possible dangling
            // id that is deliberately not one of the set members.
            after: fc.subarray([...ids, 'T99999999']),
          })
          .map(
            ({ state, after }): Todo => ({
              id,
              state,
              title: `todo ${id}`,
              after,
              files: [],
              lineIndex: index,
            }),
          ),
      ),
    ),
  );

/**
 * Reference derivation, independent of the implementation: blocked exactly when
 * some `after` target is in a state other than `done`. A target with no
 * matching todo in the set is treated as not done (blocking).
 */
function referenceIsBlocked(todo: Todo, all: Todo[]): boolean {
  return todo.after.some((depId) => {
    const dep = all.find((t) => t.id === depId);
    return dep === undefined || dep.state !== 'done';
  });
}

describe('blocked derivation (property)', () => {
  // Feature: baiton-first-pass, Property 6: Blocked is derived, never written
  it('isBlocked is true iff some after target is not done', () => {
    fc.assert(
      fc.property(todoSetArb, (todos) => {
        for (const todo of todos) {
          const expected = referenceIsBlocked(todo, todos);
          const actual = isBlocked(todo, todos);
          assert.strictEqual(
            actual,
            expected,
            `isBlocked(${todo.id}) mismatch; after=${JSON.stringify(
              todo.after,
            )}, states=${JSON.stringify(todos.map((t) => [t.id, t.state]))}`,
          );

          // A todo with no dependencies is never blocked.
          if (todo.after.length === 0) {
            assert.strictEqual(actual, false, `${todo.id} with no deps is not blocked`);
          }
          // Blocked exactly matches "not all after targets are done".
          const allDone = todo.after.every((depId) => {
            const dep = todos.find((t) => t.id === depId);
            return dep !== undefined && dep.state === 'done';
          });
          assert.strictEqual(actual, !allDone, `${todo.id} blocked iff not all deps done`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 6: Blocked is derived, never written
  it('writeTodoState never emits a blocked state token', () => {
    // `blocked` is not one of the eight legal states, so the writer can never
    // produce it. Generate a spec with one non-done todo and write every legal
    // state into it; assert the box holds that exact state and never `blocked`.
    const startStateArb = fc.constantFrom<TodoState>(
      ...TODO_STATES.filter((s) => s !== 'done'),
    );

    fc.assert(
      fc.property(
        idArb,
        startStateArb,
        fc.constantFrom<TodoState>(...TODO_STATES),
        (id, startState, target) => {
          const raw = [
            '# OVERVIEW',
            '',
            'Overview prose.',
            '',
            '# TODOS',
            '',
            `- [${startState}] ${id} some title (after T99999999)`,
          ].join('\n');

          const result = writeTodoState(raw, id, target);
          assert.ok(result.ok, `write should succeed for target ${target}`);
          const out = (result as { ok: true; value: string }).value;

          // The written box holds exactly the requested legal state.
          const box = new RegExp(`^- \\[([^\\]]*)\\] ${id}\\b`, 'm').exec(out);
          assert.ok(box, `expected a state box for ${id} in:\n${out}`);
          const written = box![1];
          assert.strictEqual(written, target, 'box holds the requested state');
          assert.ok(isTodoState(written), `written state "${written}" is legal`);
          assert.notStrictEqual(written, BLOCKED, 'written state is never "blocked"');

          // The output never contains a written blocked marker.
          assert.ok(
            !/\[blocked\]/.test(out),
            `output must not contain a [blocked] marker:\n${out}`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
