import * as assert from 'assert';
import * as fc from 'fast-check';
import { isPartialPrStatus, planPrStatus, reposToSubmit } from '../src/engine/transitions';

const casesArb = fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }).chain((ids) =>
  fc.tuple(
    fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
    fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
  ).map(([recordedMask, successMask]) => ({ ids, recordedMask, successMask })),
);

describe('plan PR status helpers', () => {
  it('reports complete, partial and absent PR state from recorded and new outcomes', () => {
    fc.assert(
      fc.property(casesArb, ({ ids, recordedMask, successMask }) => {
        const touched = ids.map((id) => `repo-${id}`);
        const recorded = new Set(touched.filter((_, i) => recordedMask[i]));
        const outcomes = touched.flatMap((repo, i) => recordedMask[i] ? [] : [{ repo, ok: successMask[i] }]);
        const hasPr = touched.map((_, i) => recordedMask[i] || successMask[i]);
        const count = hasPr.filter(Boolean).length;
        const expected = count === 0 ? undefined : count === touched.length ? 'pr' : 'pr-partial';

        assert.strictEqual(planPrStatus(touched, recorded, outcomes), expected);
        assert.deepStrictEqual(reposToSubmit(touched, recorded), touched.filter((_, i) => !recordedMask[i]));
        if (touched.length === 1) assert.notStrictEqual(planPrStatus(touched, recorded, outcomes), 'pr-partial');
      }),
      { numRuns: 300 },
    );
  });

  it('recognizes only a trimmed pr-partial status as retryable', () => {
    assert.strictEqual(isPartialPrStatus(' pr-partial '), true);
    assert.strictEqual(isPartialPrStatus('pr'), false);
    assert.strictEqual(isPartialPrStatus(undefined), false);
  });
});
