import * as assert from 'assert';
import * as fc from 'fast-check';
import { validateStageResult, STAGE_SCHEMAS } from '../src/schema';
import type {
  PlanResult,
  PlanReviewResult,
  ExecuteResult,
  PrResult,
  SpecDraftResult,
  ReviewResult,
  StageResult,
} from '../src/schema';
import { STAGES, Stage } from '../src/model/stage';

/**
 * Feature: baiton-first-pass, Property 18: Result-schema validation round trip —
 * For any conformant stage result, JSON-serializing it and validating the
 * parsed value against the stage schema SHALL accept it and yield the same
 * structured value.
 *
 * Validates: Requirements 12.2, 25.4
 *
 * The property generates a schema-conformant result for each of the four stages
 * (Plan, Plan_Review, Execute, Review), runs it through JSON.stringify then
 * JSON.parse to emulate the Result_File round trip, validates the parsed value
 * against the stage's schema, and asserts both acceptance and value equality
 * with the original. Review generators respect the empty-findings rule
 * (Req 12.9): a `pass` verdict carries an empty findings list while a `findings`
 * verdict carries a non-empty one.
 */

// --- Generators ------------------------------------------------------------

/** Arbitrary short text; JSON round-trips arbitrary unicode strings exactly. */
const textArb: fc.Arbitrary<string> = fc.string({ maxLength: 30 });

/** A list of file paths (plain strings for schema purposes). */
const filesArb: fc.Arbitrary<string[]> = fc.array(textArb, { maxLength: 5 });

/** A conformant {@link PlanResult}. */
const planArb: fc.Arbitrary<PlanResult> = fc.record({
  steps: fc.array(
    fc.record({
      title: textArb,
      detail: textArb,
      files: filesArb,
    }),
    { maxLength: 5 },
  ),
  risks: fc.array(textArb, { maxLength: 5 }),
  acceptance: fc.array(textArb, { maxLength: 5 }),
});

/**
 * A conformant {@link PlanReviewResult}. The verdict drives the findings list:
 * `pass` ⇒ empty, `findings` ⇒ non-empty (Req 12.9).
 */
const planReviewArb: fc.Arbitrary<PlanReviewResult> = fc.oneof(
  fc.record({
    verdict: fc.constant<'pass'>('pass'),
    findings: fc.constant([] as PlanReviewResult['findings']),
  }),
  fc.record({
    verdict: fc.constant<'findings'>('findings'),
    findings: fc.array(
      fc.record({
        severity: fc.constantFrom<'must' | 'should'>('must', 'should'),
        text: textArb,
      }),
      { minLength: 1, maxLength: 5 },
    ),
  }),
);

/** A conformant {@link ExecuteResult}. */
const executeArb: fc.Arbitrary<ExecuteResult> = fc.record({
  summary: textArb,
  files_changed: filesArb,
  commands_run: fc.array(textArb, { maxLength: 5 }),
  notes: fc.array(textArb, { maxLength: 5 }),
});

/**
 * A conformant {@link ReviewResult}. The verdict drives the findings list:
 * `pass` ⇒ empty, `findings` ⇒ non-empty (Req 12.9).
 */
const reviewArb: fc.Arbitrary<ReviewResult> = fc.record({
  verdictFindings: fc.oneof(
    fc.record({
      verdict: fc.constant<'pass'>('pass'),
      findings: fc.constant([] as ReviewResult['findings']),
    }),
    fc.record({
      verdict: fc.constant<'findings'>('findings'),
      findings: fc.array(
        fc.record({
          severity: fc.constantFrom<'must' | 'should'>('must', 'should'),
          file: textArb,
          line: fc.integer({ min: 1, max: 100000 }),
          text: textArb,
        }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
  ),
  tests: fc.record({
    ran: fc.boolean(),
    passed: fc.boolean(),
    output_tail: textArb,
  }),
}).map(({ verdictFindings, tests }) => ({
  verdict: verdictFindings.verdict,
  findings: verdictFindings.findings,
  tests,
}));

/** Stage → arbitrary that produces a conformant result for that stage. */
/** A PR draft: a non-empty title and any body. */
const prArb: fc.Arbitrary<PrResult> = fc.record({
  title: fc.string({ minLength: 1, maxLength: 30 }),
  body: textArb,
});

/** A spec draft: an overview plus a dependency-ordered todo list. */
const specDraftArb: fc.Arbitrary<SpecDraftResult> = fc.record({
  overview: textArb,
  todos: fc.array(
    fc.record({
      title: fc.string({ minLength: 1, maxLength: 40 }),
      after: fc.array(fc.string({ minLength: 1, maxLength: 3 }), { maxLength: 3 }),
      files: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    }),
    { maxLength: 5 },
  ),
});

const RESULT_ARBS: Record<Stage, fc.Arbitrary<StageResult>> = {
  'spec-draft': specDraftArb as fc.Arbitrary<StageResult>,
  plan: planArb as fc.Arbitrary<StageResult>,
  'plan-review': planReviewArb as fc.Arbitrary<StageResult>,
  execute: executeArb as fc.Arbitrary<StageResult>,
  review: reviewArb as fc.Arbitrary<StageResult>,
  pr: prArb as fc.Arbitrary<StageResult>,
};

// --- Property --------------------------------------------------------------

describe('result schema round trip (property)', () => {
  it('Property 18: JSON round trip of a conformant result validates and is unchanged', () => {
    // A generator that picks a stage then a conformant result for it, so the
    // property exercises all four stages across its runs.
    const stageAndResult = fc
      .constantFrom<Stage>(...STAGES)
      .chain((stage) =>
        RESULT_ARBS[stage].map((value) => ({ stage, value })),
      );

    fc.assert(
      fc.property(stageAndResult, ({ stage, value }) => {
        // Sanity: the stage has a schema (the brief carries this).
        assert.ok(STAGE_SCHEMAS[stage], `schema exists for stage ${stage}`);

        // Serialize then parse to emulate the Result_File round trip.
        const parsed = JSON.parse(JSON.stringify(value));

        // Validation must accept the round-tripped value (Req 12.2, 25.4).
        const result = validateStageResult(stage, parsed);
        assert.strictEqual(
          result.ok,
          true,
          `validation should accept a conformant ${stage} result` +
            (result.ok ? '' : `: ${JSON.stringify(result.error)}`),
        );

        // The validated value must equal the original structured value.
        if (result.ok) {
          assert.deepStrictEqual(result.value, value, `${stage} value equality`);
        }
      }),
      { numRuns: 200 },
    );
  });
});
