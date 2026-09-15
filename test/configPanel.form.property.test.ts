import * as assert from 'assert';
import * as fc from 'fast-check';
import { applyFormToDocument, formFromConfig, formFromDocument, validateConfigForm } from '../src/config/configPanel';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { LIMIT_BOUNDS, Limits } from '../src/config/types';
import { ROLES } from '../src/model';
import { createAdapterRegistry } from '../src/adapter';

/**
 * Feature: config-panel, Property: form-side limits accept exactly their ranges
 *
 * For any integer values, `validateConfigForm` SHALL accept the `limits`
 * fields of a {@link ConfigForm} iff each is within its closed range —
 * `plan_review_rounds` 0..10, `exec_attempts` 1..10, `stall_notice_minutes`
 * 1..1440 — mirroring loadConfig's Property 24 on the form side. This is what
 * keeps `media/config.js` (T09) honest against the same bounds. Pure: no
 * filesystem access inside the loop.
 */

/** Whether a value lies within a field's inclusive bounds. */
function inRange(field: keyof Limits, value: number): boolean {
  const { min, max } = LIMIT_BOUNDS[field];
  return value >= min && value <= max;
}

/**
 * An integer generator that straddles each field's bounds: it samples inside
 * the range, on the two boundaries, just outside on both sides, and across a
 * wider window (same shape as test/config.limits.property.test.ts).
 */
function limitArb(field: keyof Limits): fc.Arbitrary<number> {
  const { min, max } = LIMIT_BOUNDS[field];
  return fc.oneof(
    fc.integer({ min, max }),
    fc.constantFrom(min - 1, min, max, max + 1),
    fc.integer({ min: min - 5, max: max + 5 }),
  );
}

describe('config panel form properties (config-panel T03)', () => {
  const AGENTS = createAdapterRegistry().ids;

  // Feature: config-panel, Property: form-side limits accept exactly their ranges
  it('validateConfigForm accepts the limits iff each integer is within its closed range', () => {
    fc.assert(
      fc.property(
        limitArb('plan_review_rounds'),
        limitArb('exec_attempts'),
        limitArb('stall_notice_minutes'),
        (planReviewRounds, execAttempts, stallNoticeMinutes) => {
          const form = formFromConfig(defaultConfig());
          form.limits.plan_review_rounds = String(planReviewRounds);
          form.limits.exec_attempts = String(execAttempts);
          form.limits.stall_notice_minutes = String(stallNoticeMinutes);

          const errors = validateConfigForm(form, { agents: AGENTS });

          const outOfRange: (keyof Limits)[] = [];
          if (!inRange('plan_review_rounds', planReviewRounds)) {
            outOfRange.push('plan_review_rounds');
          }
          if (!inRange('exec_attempts', execAttempts)) {
            outOfRange.push('exec_attempts');
          }
          if (!inRange('stall_notice_minutes', stallNoticeMinutes)) {
            outOfRange.push('stall_notice_minutes');
          }

          if (outOfRange.length === 0) {
            assert.strictEqual(errors.length, 0);
          } else {
            const limitErrors = errors.filter((e) => e.path.startsWith('limits.'));
            assert.strictEqual(limitErrors.length, outOfRange.length);
            for (const field of outOfRange) {
              const matches = limitErrors.filter((e) => e.path === `limits.${field}`);
              assert.strictEqual(matches.length, 1, `expected ${field} to be named exactly once`);
            }
          }
        },
      ),
    );
  });

  // Feature: config-panel, Property: unmanaged keys survive applyFormToDocument
  it('applyFormToDocument preserves every key the form does not manage', () => {
    const jsonLeaf = fc.oneof(
      fc.boolean(),
      fc.integer(),
      fc.string(),
      fc.constant(null),
    );
    const keyArb = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));

    fc.assert(
      fc.property(
        fc.dictionary(keyArb.filter((k) => !['version', 'roles', 'limits', 'git'].includes(k)), jsonLeaf, {
          maxKeys: 3,
        }),
        fc.dictionary(keyArb.filter((k) => !['remote', 'base'].includes(k)), jsonLeaf, { maxKeys: 3 }),
        fc.dictionary(keyArb.filter((k) => !['agent', 'model', 'effort'].includes(k)), jsonLeaf, { maxKeys: 3 }),
        (unknownTop, unknownGit, unknownRoleEntry) => {
          const raw = JSON.parse(defaultConfigJson()) as Record<string, unknown>;
          Object.assign(raw, unknownTop);
          Object.assign(raw.git as Record<string, unknown>, unknownGit);
          Object.assign((raw.roles as Record<string, Record<string, unknown>>).planner, unknownRoleEntry);
          const before = JSON.parse(JSON.stringify(raw));

          const form = formFromConfig(defaultConfig());
          const out = applyFormToDocument(raw, form);

          for (const [k, v] of Object.entries(unknownTop)) {
            assert.deepStrictEqual(out[k], v);
          }
          for (const [k, v] of Object.entries(unknownGit)) {
            assert.deepStrictEqual((out.git as Record<string, unknown>)[k], v);
          }
          for (const [k, v] of Object.entries(unknownRoleEntry)) {
            assert.deepStrictEqual((out.roles as Record<string, Record<string, unknown>>).planner[k], v);
          }
          assert.deepStrictEqual(raw, before);
        },
      ),
    );
  });

  // Feature: config-panel, Property: formFromDocument never throws
  it('formFromDocument never throws and always returns the six ROLES keys with string leaves', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 2 }), (value) => {
        const form = formFromDocument(value);
        assert.deepStrictEqual(Object.keys(form.roles), [...ROLES]);
        for (const role of ROLES) {
          assert.strictEqual(typeof form.roles[role].agent, 'string');
          assert.strictEqual(typeof form.roles[role].model, 'string');
          assert.strictEqual(typeof form.roles[role].effort, 'string');
        }
        assert.strictEqual(typeof form.limits.plan_review_rounds, 'string');
        assert.strictEqual(typeof form.limits.exec_attempts, 'string');
        assert.strictEqual(typeof form.limits.stall_notice_minutes, 'string');
        assert.strictEqual(typeof form.git.remote, 'string');
        assert.strictEqual(typeof form.git.base, 'string');
      }),
    );
  });
});
