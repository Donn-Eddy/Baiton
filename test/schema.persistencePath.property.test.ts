import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  persistencePathForStage,
  stageArtifactIsNumbered,
} from '../src/schema';
import { STAGES, Stage } from '../src/model/stage';

/**
 * Property test for the stage → persistence-path mapping (Requirement 24.3,
 * design "Stage result schemas" persistence-path table).
 *
 * Feature: baiton-first-pass, Property 23: Artifact persistence path matches
 * the stage naming rule
 *
 * For any stage and round/attempt index n (>= 1), the persistence path SHALL
 * match the naming rule: plan → `plan.md`, plan-review → `plan-review-<n>.md`,
 * execute → `execute-<n>.md`, review → `review-<n>.md`. The `plan` stage
 * persists once and ignores n; the other three stages are numbered and yield
 * the `<stage>-<n>.md` form.
 *
 * The test generates random stages and indexes, then asserts the returned path
 * equals the expected form; it also asserts plan ignores n (always `plan.md`)
 * and that numbered stages yield exactly `<stage>-<n>.md`.
 */

/** A generator over the four known stages. */
const stageArb: fc.Arbitrary<Stage> = fc.constantFrom(...(STAGES as readonly Stage[]));

/** A 1-based round/attempt index. */
const indexArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10_000 });

describe('Stage persistence-path naming (property harness)', () => {
  // Feature: baiton-first-pass, Property 23: Artifact persistence path matches
  // the stage naming rule
  it('matches the stage naming rule for any stage and index', () => {
    fc.assert(
      fc.property(stageArb, indexArb, (stage, n) => {
        const path = persistencePathForStage(stage, n);

        if (stage === 'spec-draft') {
          // The spec draft persists once per spec, as the spec file itself.
          assert.strictEqual(path, 'spec.md', `spec-draft must yield spec.md, got ${path}`);
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'spec-draft artifact must not be numbered',
          );
        } else if (stage === 'plan' || stage === 'pr') {
          // Plan and the PR draft persist once and ignore the index.
          assert.strictEqual(path, `${stage}.md`, `${stage} must yield ${stage}.md, got ${path}`);
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            `${stage} artifact must not be numbered`,
          );
        } else {
          // Numbered stages yield exactly `<stage>-<n>.md`.
          assert.strictEqual(
            path,
            `${stage}-${n}.md`,
            `numbered stage ${stage} must yield ${stage}-${n}.md, got ${path}`,
          );
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            true,
            `${stage} artifact must be numbered`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 23: Artifact persistence path matches
  // the stage naming rule
  it('plan ignores the index across many values', () => {
    fc.assert(
      fc.property(fc.option(indexArb, { nil: undefined }), (n) => {
        assert.strictEqual(persistencePathForStage('plan', n), 'plan.md');
      }),
      { numRuns: 200 },
    );
  });
});
