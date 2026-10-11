import * as assert from 'assert';
import * as fc from 'fast-check';
import { isBlocked } from '../src/model/hash';
import { Phase } from '../src/model/parser';
import { writePhaseState } from '../src/model/writer';
import { PHASE_STATES, PhaseState, isPhaseState } from '../src/model/phaseState';

/**
 * Feature: baiton-first-pass, Property 6: Blocked is derived, never written —
 * For any plan and any phase, `isBlocked(phase)` SHALL be true if and only if at
 * least one of that phase's `after` targets is in a state other than `done`, and
 * the serializer output SHALL never contain a written blocked marker.
 *
 * Validates: Requirements 4.10
 *
 * Two halves are exercised together:
 *
 *   1. Derivation. Over random phase sets with random `after` edges into that
 *      set (and occasional dangling ids), `isBlocked(phase, all)` must equal the
 *      independent reference "some after target is not done" — where a target
 *      that is absent from the set counts as not done, since an unmet/unknown
 *      dependency cannot be complete.
 *
 *   2. Never written. `blocked` is not one of the eight legal PhaseStates, so it
 *      can never be produced by `writePhaseState`. For every legal state the
 *      writer emits, the resulting phase line's `[state]` box must hold that
 *      exact legal state and must never read `[blocked]`.
 */

/** Legacy fixture ids use `T` followed by two or more decimal digits (Req 3.3). */
const legacyPhaseIdArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/** Sanity: `blocked` is not, and must never become, a legal phase state. */
const BLOCKED = 'blocked';

/**
 * A small set of phases with unique ids, each carrying a random state and a
 * random `after` list. Edges point mostly at ids in the set, with a sprinkling
 * of dangling ids so the "absent target counts as not done" branch is covered.
 */
const phaseSetArb: fc.Arbitrary<Phase[]> = fc
  .uniqueArray(legacyPhaseIdArb, { minLength: 1, maxLength: 8 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id, index) =>
        fc
          .record({
            state: fc.constantFrom<PhaseState>(...PHASE_STATES),
            // `after` targets: any of the set's ids, plus a possible dangling
            // id that is deliberately not one of the set members.
            after: fc.subarray([...ids, 'T99999999']),
          })
          .map(
            ({ state, after }): Phase => ({
              id,
              state,
              title: `phase ${id}`,
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
 * matching phase in the set is treated as not done (blocking).
 */
function referenceIsBlocked(phase: Phase, all: Phase[]): boolean {
  return phase.after.some((depId) => {
    const dep = all.find((t) => t.id === depId);
    return dep === undefined || dep.state !== 'done';
  });
}

describe('blocked derivation (property)', () => {
  // Feature: baiton-first-pass, Property 6: Blocked is derived, never written
  it('isBlocked is true iff some after target is not done', () => {
    fc.assert(
      fc.property(phaseSetArb, (phases) => {
        for (const phase of phases) {
          const expected = referenceIsBlocked(phase, phases);
          const actual = isBlocked(phase, phases);
          assert.strictEqual(
            actual,
            expected,
            `isBlocked(${phase.id}) mismatch; after=${JSON.stringify(
              phase.after,
            )}, states=${JSON.stringify(phases.map((t) => [t.id, t.state]))}`,
          );

          // A phase with no dependencies is never blocked.
          if (phase.after.length === 0) {
            assert.strictEqual(actual, false, `${phase.id} with no deps is not blocked`);
          }
          // Blocked exactly matches "not all after targets are done".
          const allDone = phase.after.every((depId) => {
            const dep = phases.find((t) => t.id === depId);
            return dep !== undefined && dep.state === 'done';
          });
          assert.strictEqual(actual, !allDone, `${phase.id} blocked iff not all deps done`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 6: Blocked is derived, never written
  it('writePhaseState never emits a blocked state token', () => {
    // `blocked` is not one of the eight legal states, so the writer can never
    // produce it. Generate a plan with one non-done phase and write every legal
    // state into it; assert the box holds that exact state and never `blocked`.
    const startStateArb = fc.constantFrom<PhaseState>(
      ...PHASE_STATES.filter((s) => s !== 'done'),
    );

    fc.assert(
      fc.property(
        legacyPhaseIdArb,
        startStateArb,
        fc.constantFrom<PhaseState>(...PHASE_STATES),
        (id, startState, target) => {
          // Legacy: this serializer input exercises the preserved OVERVIEW/TODOS format.
          const raw = [
            '# OVERVIEW',
            '',
            'Overview prose.',
            '',
            '# TODOS',
            '',
            `- [${startState}] ${id} some title (after T99999999)`,
          ].join('\n');

          const result = writePhaseState(raw, id, target);
          assert.ok(result.ok, `write should succeed for target ${target}`);
          const out = (result as { ok: true; value: string }).value;

          // The written box holds exactly the requested legal state.
          const box = new RegExp(`^- \\[([^\\]]*)\\] ${id}\\b`, 'm').exec(out);
          assert.ok(box, `expected a state box for ${id} in:\n${out}`);
          const written = box![1];
          assert.strictEqual(written, target, 'box holds the requested state');
          assert.ok(isPhaseState(written), `written state "${written}" is legal`);
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
