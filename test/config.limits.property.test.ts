import * as assert from 'assert';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config/loadConfig';
import { defaultConfig } from '../src/config/defaultConfig';
import { LIMIT_BOUNDS, Limits } from '../src/config/types';

/**
 * Feature: baiton-first-pass, Property 24: Config limits accept exactly their ranges
 *
 * For any integer values, `loadConfig` SHALL accept the limits iff each is
 * within its closed range — `plan_review_rounds` 0..10, `exec_attempts` 1..10,
 * `stall_notice_minutes` 1..1440 — and reject them otherwise.
 *
 * Validates: Requirements 2.3
 *
 * Each iteration takes an otherwise-valid config (the Initialize default),
 * overrides the three `limits` integers with generated values, writes it to a
 * temp `config.json`, calls {@link loadConfig}, and asserts acceptance iff all
 * three limits sit within their closed ranges. When rejected, the error is a
 * `missing-section` naming the offending `limits.<field>` (out-of-range values
 * surface through the same located path as a missing/malformed field). Every
 * iteration uses a fresh temp directory that is removed afterward.
 */

/** Whether a value lies within a field's inclusive bounds. */
function inRange(field: keyof Limits, value: number): boolean {
  const { min, max } = LIMIT_BOUNDS[field];
  return value >= min && value <= max;
}

/**
 * An integer generator that straddles each field's bounds: it samples inside
 * the range, on the two boundaries, just outside on both sides, and across a
 * wider window, so acceptance and rejection are both exercised heavily.
 */
function limitArb(field: keyof Limits): fc.Arbitrary<number> {
  const { min, max } = LIMIT_BOUNDS[field];
  return fc.oneof(
    // Inside and on the boundaries.
    fc.integer({ min, max }),
    // Boundary and just-outside values, plus a wider window either side.
    fc.constantFrom(min - 1, min, max, max + 1),
    fc.integer({ min: min - 5, max: max + 5 }),
  );
}

describe('config limit ranges (property)', () => {
  // Feature: baiton-first-pass, Property 24: Config limits accept exactly their ranges
  it('Property 24: loadConfig accepts the limits iff each integer is within its closed range', async () => {
    await fc.assert(
      fc.asyncProperty(
        limitArb('plan_review_rounds'),
        limitArb('exec_attempts'),
        limitArb('stall_notice_minutes'),
        async (planReviewRounds, execAttempts, stallNoticeMinutes) => {
          const dir = mkdtempSync(join(tmpdir(), 'baiton-config-limits-'));
          try {
            const config = defaultConfig();
            config.limits = {
              plan_review_rounds: planReviewRounds,
              exec_attempts: execAttempts,
              stall_notice_minutes: stallNoticeMinutes,
            };
            writeFileSync(
              join(dir, 'config.json'),
              `${JSON.stringify(config, null, 2)}\n`,
              'utf8',
            );

            const result = await loadConfig(dir);

            const allInRange =
              inRange('plan_review_rounds', planReviewRounds) &&
              inRange('exec_attempts', execAttempts) &&
              inRange('stall_notice_minutes', stallNoticeMinutes);

            if (allInRange) {
              assert.ok(
                result.ok,
                `expected acceptance for limits ${JSON.stringify(config.limits)}, ` +
                  `got error ${result.ok ? '' : JSON.stringify(result.error)}`,
              );
              assert.deepStrictEqual(result.value.limits, config.limits);
            } else {
              assert.ok(
                !result.ok,
                `expected rejection for limits ${JSON.stringify(config.limits)}, ` +
                  `but loadConfig accepted it`,
              );
              // An out-of-range limit is reported as a located missing-section
              // error naming the offending limits field.
              assert.strictEqual(result.error.kind, 'missing-section');
              if (result.error.kind === 'missing-section') {
                assert.ok(
                  result.error.section.startsWith('limits.'),
                  `expected the error to name a limits field, got section ` +
                    `${result.error.section}`,
                );
              }
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
