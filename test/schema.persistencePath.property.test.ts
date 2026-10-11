import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  persistencePathForStage,
  stageArtifactIsNumbered,
} from '../src/schema';
import { STAGES, Stage } from '../src/model/stage';
import type { DocumentKind } from '../src/model/parser';

/**
 * Property test for the stage → persistence-path mapping (Requirement 24.3,
 * design "Stage result schemas" persistence-path table).
 *
 * Feature: baiton-first-pass, Property 23: Artifact persistence path matches
 * the stage naming rule
 *
 * For any stage, phase id and round/attempt index n (>= 1), the persistence path
 * SHALL match the naming rule. The four phase-level stages persist under the
 * phase's own folder so one phase can never overwrite another's artifacts:
 * Legacy: plan → `todos/<id>/plan.md`, plan-review → `todos/<id>/plan-review-<n>.md`,
 * Legacy: execute → `todos/<id>/execute-<n>.md`, review → `todos/<id>/review-<n>.md`.
 * The `plan` stage persists once per phase and ignores n; the other three are
 * numbered. The two plan-scoped stages ignore the phase id entirely: plan-draft
 * Legacy: → `spec.md`, pr → `pr.md`.
 *
 * The test generates random stages, phase ids and indexes, then asserts the
 * returned path equals the expected form; it also asserts plan ignores n, that
 * two distinct phase ids never collide on a path, and that a phase-level stage
 * refuses a missing or non-segment phase id.
 */

/** A generator over the four known stages. */
const stageArb: fc.Arbitrary<Stage> = fc.constantFrom(...(STAGES as readonly Stage[]));

/** A 1-based round/attempt index. */
const indexArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10_000 });

/** A phase id: `T` followed by two or more decimal digits (Req 3.3). */
const phaseIdArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

describe('Stage persistence-path naming (property harness)', () => {
  // Feature: baiton-first-pass, Property 23: Artifact persistence path matches
  // the stage naming rule
  it('matches the stage naming rule for any stage, phase id and index', () => {
    fc.assert(
      fc.property(stageArb, phaseIdArb, indexArb, fc.constantFrom<DocumentKind>('plan', 'legacy-spec'), (stage, phaseId, n, kind) => {
        const path = persistencePathForStage(stage, phaseId, n, kind);

        if (stage === 'plan-draft') {
          const documentFile = kind === 'plan' ? 'plan.md' : 'spec.md';
          assert.strictEqual(path, documentFile, `plan-draft must yield ${documentFile}, got ${path}`);
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'plan-draft artifact must not be numbered',
          );
        } else if (stage === 'pr') {
          // The PR draft persists once per plan, at the plan root.
          assert.strictEqual(path, 'pr.md', `pr must yield pr.md, got ${path}`);
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'pr artifact must not be numbered',
          );
        } else if (stage === 'investigate') {
          // An investigate run persists one finding at its run-dir root.
          assert.strictEqual(
            path,
            'finding.md',
            `investigate must yield finding.md, got ${path}`,
          );
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'investigate artifact must not be numbered',
          );
        } else if (stage === 'plan') {
          // The plan persists once per phase, under the phase's own folder.
          assert.strictEqual(
            path,
            `${kind === 'plan' ? 'phases' : 'todos'}/${phaseId}/plan.md`,
            `plan must yield the phase artifact path, got ${path}`,
          );
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'plan artifact must not be numbered',
          );
        } else {
          // Legacy: Numbered todo-level stages yield `todos/<id>/<stage>-<n>.md`.
          assert.strictEqual(
            path,
            `${kind === 'plan' ? 'phases' : 'todos'}/${phaseId}/${stage}-${n}.md`,
            `numbered stage ${stage} must yield the phase artifact path, got ${path}`,
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
      fc.property(phaseIdArb, fc.option(indexArb, { nil: undefined }), (phaseId, n) => {
        assert.strictEqual(persistencePathForStage('plan', phaseId, n), `phases/${phaseId}/plan.md`);
        assert.strictEqual(
          persistencePathForStage('plan', phaseId, n, 'legacy-spec'),
          `todos/${phaseId}/plan.md`,
        );
      }),
      { numRuns: 200 },
    );
  });

  // Per-phase isolation: two distinct phases never share an artifact path, so one
  // phase's run can never overwrite another's plan or numbered artifact.
  it('never yields the same path for two distinct phase ids', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Stage>('plan', 'plan-review', 'execute', 'review'),
        phaseIdArb,
        phaseIdArb,
        indexArb,
        fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
        (stage, a, b, n, kind) => {
          fc.pre(a !== b);
          assert.notStrictEqual(
            persistencePathForStage(stage, a, n, kind),
            persistencePathForStage(stage, b, n, kind),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // A phase-level artifact has no location without a plain-segment phase id, so
  // a missing or path-shaped id throws rather than escaping the plan folder.
  it('refuses a missing or path-shaped phase id for a phase-level stage', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Stage>('plan', 'plan-review', 'execute', 'review'),
        fc.constantFrom<string | undefined>(undefined, '', '..', 'a/b', 'a\\b', '.'),
        fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
        (stage, phaseId, kind) => {
          assert.throws(() => persistencePathForStage(stage, phaseId, 1, kind));
        },
      ),
      { numRuns: 100 },
    );
  });

  // The plan-scoped stages ignore the phase id entirely, and so does the
  // run-scoped investigate stage.
  it('the run- and plan-scoped stages ignore the phase id', () => {
    fc.assert(
      fc.property(fc.option(phaseIdArb, { nil: undefined }), (phaseId) => {
        assert.strictEqual(persistencePathForStage('plan-draft', phaseId), 'plan.md');
        assert.strictEqual(persistencePathForStage('plan-draft', phaseId, undefined, 'legacy-spec'), 'spec.md');
        assert.strictEqual(persistencePathForStage('pr', phaseId), 'pr.md');
        assert.strictEqual(
          persistencePathForStage('investigate', phaseId),
          'finding.md',
        );
      }),
      { numRuns: 100 },
    );
  });
});
