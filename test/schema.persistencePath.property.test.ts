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
 * For any stage, todo id and round/attempt index n (>= 1), the persistence path
 * SHALL match the naming rule. The four todo-level stages persist under the
 * todo's own folder so one todo can never overwrite another's artifacts:
 * plan → `todos/<id>/plan.md`, plan-review → `todos/<id>/plan-review-<n>.md`,
 * execute → `todos/<id>/execute-<n>.md`, review → `todos/<id>/review-<n>.md`.
 * The `plan` stage persists once per todo and ignores n; the other three are
 * numbered. The two spec-scoped stages ignore the todo id entirely: plan-draft
 * → `spec.md`, pr → `pr.md`.
 *
 * The test generates random stages, todo ids and indexes, then asserts the
 * returned path equals the expected form; it also asserts plan ignores n, that
 * two distinct todo ids never collide on a path, and that a todo-level stage
 * refuses a missing or non-segment todo id.
 */

/** A generator over the four known stages. */
const stageArb: fc.Arbitrary<Stage> = fc.constantFrom(...(STAGES as readonly Stage[]));

/** A 1-based round/attempt index. */
const indexArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 10_000 });

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const todoIdArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

describe('Stage persistence-path naming (property harness)', () => {
  // Feature: baiton-first-pass, Property 23: Artifact persistence path matches
  // the stage naming rule
  it('matches the stage naming rule for any stage, todo id and index', () => {
    fc.assert(
      fc.property(stageArb, todoIdArb, indexArb, fc.constantFrom<DocumentKind>('plan', 'legacy-spec'), (stage, todoId, n, kind) => {
        const path = persistencePathForStage(stage, todoId, n, kind);

        if (stage === 'plan-draft') {
          const documentFile = kind === 'plan' ? 'plan.md' : 'spec.md';
          assert.strictEqual(path, documentFile, `plan-draft must yield ${documentFile}, got ${path}`);
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'plan-draft artifact must not be numbered',
          );
        } else if (stage === 'pr') {
          // The PR draft persists once per spec, at the spec root.
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
          // The plan persists once per todo, under the todo's own folder.
          assert.strictEqual(
            path,
            `${kind === 'plan' ? 'phases' : 'todos'}/${todoId}/plan.md`,
            `plan must yield the phase artifact path, got ${path}`,
          );
          assert.strictEqual(
            stageArtifactIsNumbered(stage),
            false,
            'plan artifact must not be numbered',
          );
        } else {
          // Numbered todo-level stages yield `todos/<id>/<stage>-<n>.md`.
          assert.strictEqual(
            path,
            `${kind === 'plan' ? 'phases' : 'todos'}/${todoId}/${stage}-${n}.md`,
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
      fc.property(todoIdArb, fc.option(indexArb, { nil: undefined }), (todoId, n) => {
        assert.strictEqual(persistencePathForStage('plan', todoId, n), `phases/${todoId}/plan.md`);
        assert.strictEqual(
          persistencePathForStage('plan', todoId, n, 'legacy-spec'),
          `todos/${todoId}/plan.md`,
        );
      }),
      { numRuns: 200 },
    );
  });

  // Per-todo isolation: two distinct todos never share an artifact path, so one
  // todo's run can never overwrite another's plan or numbered artifact.
  it('never yields the same path for two distinct todo ids', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Stage>('plan', 'plan-review', 'execute', 'review'),
        todoIdArb,
        todoIdArb,
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

  // A todo-level artifact has no location without a plain-segment todo id, so
  // a missing or path-shaped id throws rather than escaping the spec folder.
  it('refuses a missing or path-shaped todo id for a todo-level stage', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Stage>('plan', 'plan-review', 'execute', 'review'),
        fc.constantFrom<string | undefined>(undefined, '', '..', 'a/b', 'a\\b', '.'),
        fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
        (stage, todoId, kind) => {
          assert.throws(() => persistencePathForStage(stage, todoId, 1, kind));
        },
      ),
      { numRuns: 100 },
    );
  });

  // The spec-scoped stages ignore the todo id entirely, and so does the
  // run-scoped investigate stage.
  it('the run- and spec-scoped stages ignore the todo id', () => {
    fc.assert(
      fc.property(fc.option(todoIdArb, { nil: undefined }), (todoId) => {
        assert.strictEqual(persistencePathForStage('plan-draft', todoId), 'plan.md');
        assert.strictEqual(persistencePathForStage('plan-draft', todoId, undefined, 'legacy-spec'), 'spec.md');
        assert.strictEqual(persistencePathForStage('pr', todoId), 'pr.md');
        assert.strictEqual(
          persistencePathForStage('investigate', todoId),
          'finding.md',
        );
      }),
      { numRuns: 100 },
    );
  });
});
