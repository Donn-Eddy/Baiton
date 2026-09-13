import * as assert from 'assert';
import * as fc from 'fast-check';
import { ok, err, isOk, isErr } from '../src/model';

// This file establishes the property-testing harness (fast-check, >=100
// iterations). Feature property tests are added under their own tasks and
// carry a `Feature: baiton-first-pass, Property {number}: {property text}`
// comment.
describe('shared types (property harness)', () => {
  it('Result is exactly one of ok or err for any value', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const good = ok(v);
        const bad = err(v);
        assert.strictEqual(isOk(good) && !isErr(good), true);
        assert.strictEqual(isErr(bad) && !isOk(bad), true);
      }),
      { numRuns: 100 }
    );
  });
});
