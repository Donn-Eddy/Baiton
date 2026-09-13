import * as assert from 'assert';
import * as fc from 'fast-check';
import { validateStageResult } from '../src/schema';
import { isErr } from '../src/model/result';
import { STAGES, type Stage } from '../src/model/stage';

/**
 * Feature: baiton-first-pass, Property 19: Schema-violating results are rejected
 *
 * For any result that violates the stage schema (including a review/plan-review
 * `findings` verdict with an empty findings list), validation SHALL reject it.
 *
 * Validates: Requirements 12.3, 12.9, 25.5
 *
 * Strategy: build a schema-conformant base result for a stage, then mutate it
 * into a known-invalid shape (drop a required field, corrupt a field's type,
 * add an extra property since `additionalProperties: false`, or — for the two
 * review stages — declare a `findings` verdict with an empty findings list).
 * Each mutated value must be rejected: `validateStageResult` returns an error
 * carrying at least one flattened schema error.
 */

// --- Conformant base results per stage -------------------------------------

/** A valid result for each stage; mutations below start from a copy of these. */
function baseResult(stage: Stage): Record<string, unknown> {
  switch (stage) {
    case 'spec-draft':
      return {
        overview: 'Build the thing.',
        todos: [{ title: 'Do the first part', after: [], files: ['a.ts'] }],
      };
    case 'plan':
      return {
        steps: [{ title: 'do', detail: 'the thing', files: ['a.ts'] }],
        risks: ['r'],
        acceptance: ['a'],
      };
    case 'plan-review':
      return {
        verdict: 'findings',
        findings: [{ severity: 'must', text: 'fix it' }],
      };
    case 'execute':
      return {
        summary: 's',
        files_changed: ['a.ts'],
        commands_run: ['npm test'],
        notes: [],
      };
    case 'review':
      return {
        verdict: 'findings',
        findings: [{ severity: 'should', file: 'a.ts', line: 3, text: 't' }],
        tests: { ran: true, passed: true, output_tail: 'ok' },
      };
    case 'pr':
      return { title: 'Add greeting', body: 'What changed and why.' };
  }
}

/** Top-level required keys per stage (used for the "drop a required field" mutation). */
function requiredKeys(stage: Stage): string[] {
  return Object.keys(baseResult(stage));
}

/** Deep clone so a mutation never leaks into another run's base. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- Generators ------------------------------------------------------------

const stageArb: fc.Arbitrary<Stage> = fc.constantFrom<Stage>(...STAGES);

/** A JSON value of a type that is never the correct type for our string/array/object fields. */
const wrongTypeArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** A property name unlikely to collide with a schema property. */
const extraKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => `__extra_${s.replace(/[^a-zA-Z0-9_]/g, '')}`);

// --- Property --------------------------------------------------------------

describe('schema-violating stage results are rejected (property)', () => {
  // Feature: baiton-first-pass, Property 19: Schema-violating results are rejected
  it('rejects results with a missing required field, a wrong-typed field, or an extra property', () => {
    fc.assert(
      fc.property(
        stageArb,
        fc.constantFrom('missing-required', 'wrong-type', 'extra-property'),
        fc.integer({ min: 0, max: 100000 }),
        wrongTypeArb,
        extraKeyArb,
        (stage, kind, seed, wrongValue, extraKey) => {
          const value = clone(baseResult(stage));
          const keys = requiredKeys(stage);
          const pick = keys[seed % keys.length];

          switch (kind) {
            case 'missing-required':
              // Removing a required top-level field must fail validation.
              delete value[pick];
              break;
            case 'wrong-type':
              // Replacing a field with a value of the wrong JSON type must fail.
              value[pick] = wrongValue;
              break;
            case 'extra-property':
              // additionalProperties:false -> any unknown key must fail.
              value[extraKey] = 'unexpected';
              break;
          }

          const result = validateStageResult(stage, value);
          assert.ok(
            isErr(result),
            `expected "${kind}" mutation on ${stage}.${pick} to be rejected, but it validated: ${JSON.stringify(
              value,
            )}`,
          );
          assert.ok(
            result.ok === false && result.error.length > 0,
            'a rejected result must carry at least one schema error',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 19: Schema-violating results are rejected
  it('rejects a review/plan-review `findings` verdict with an empty findings list (Req 12.9)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Stage>('plan-review', 'review'),
        (stage) => {
          const value = clone(baseResult(stage));
          value.verdict = 'findings';
          value.findings = [];

          const result = validateStageResult(stage, value);
          assert.ok(
            isErr(result),
            `expected ${stage} findings-verdict with empty findings to be rejected, but it validated: ${JSON.stringify(
              value,
            )}`,
          );
          assert.ok(
            result.ok === false && result.error.length > 0,
            'a rejected result must carry at least one schema error',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
