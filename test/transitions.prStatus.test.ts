import * as assert from 'assert';
import * as fc from 'fast-check';
import { isPartialPrStatus, planPrStatus, planPrsMerged, recordedPrUrls, reposToSubmit } from '../src/engine/transitions';
import type { PrState } from '../src/engine/prTool';

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

  it('collects recorded request URLs in stable order', () => {
    assert.deepStrictEqual(recordedPrUrls(undefined, undefined), []);
    assert.deepStrictEqual(recordedPrUrls(' https://h/o/r/pull/1 ', undefined), ['https://h/o/r/pull/1']);
    assert.deepStrictEqual(recordedPrUrls('', ''), []);
    assert.deepStrictEqual(
      recordedPrUrls(
        'https://h/o/r/pull/1',
        '{"a":"https://h/o/a/pull/2","b":"https://h/o/r/pull/1"}',
      ),
      ['https://h/o/r/pull/1', 'https://h/o/a/pull/2'],
    );
    assert.deepStrictEqual(recordedPrUrls(undefined, '{"a":"u1","b":"u2"}'), ['u1', 'u2']);
    assert.deepStrictEqual(recordedPrUrls(undefined, 'not json'), []);
    assert.deepStrictEqual(recordedPrUrls(undefined, '{"a":3,"b":"u"}'), ['u']);
  });

  it('requires every recorded request to be observed as merged', () => {
    assert.strictEqual(planPrsMerged([], new Map()), false);
    assert.strictEqual(planPrsMerged(['u'], new Map([['u', 'merged']])), true);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'open']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'closed']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'unknown']])), false);
    assert.strictEqual(planPrsMerged(['u', 'v'], new Map([['u', 'merged']])), false);
    assert.strictEqual(
      planPrsMerged(['u', 'v'], new Map([['u', 'merged'], ['v', 'merged'], ['extra', 'open']])),
      true,
    );
  });

  it('matches the all-merged rule for generated request states', () => {
    const mergedCasesArb = fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { maxLength: 8 }).chain((ids) =>
      fc.array(fc.option(fc.constantFrom<PrState>('open', 'merged', 'closed', 'unknown'), { nil: undefined }), {
        minLength: ids.length,
        maxLength: ids.length,
      }).map((states) => ({ ids, states })),
    );

    fc.assert(
      fc.property(mergedCasesArb, ({ ids, states }) => {
        const urls = ids.map((id) => `https://h/o/r/pull/${id}`);
        const observed = new Map<string, PrState>();
        urls.forEach((url, index) => {
          const state = states[index];
          if (state !== undefined) observed.set(url, state);
        });

        assert.strictEqual(planPrsMerged(urls, observed), states.length > 0 && states.every((state) => state === 'merged'));
      }),
      { numRuns: 300 },
    );
  });

  it('returns the unique trimmed non-empty set of generated recorded URLs', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (inputs) => {
        const pr = inputs[0];
        const prs = JSON.stringify(Object.fromEntries(inputs.slice(1).map((url, index) => [String(index), url])));
        const recorded = recordedPrUrls(pr, prs);
        const expected = new Set(inputs.map((url) => url.trim()).filter((url) => url.length > 0));

        assert.strictEqual(new Set(recorded).size, recorded.length);
        assert.ok(recorded.every((url) => url.length > 0 && url.trim() === url));
        assert.deepStrictEqual(new Set(recorded), expected);
      }),
      { numRuns: 300 },
    );
  });
});
