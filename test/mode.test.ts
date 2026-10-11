import * as assert from 'assert';
import {
  DEFAULT_MODE,
  RUN_MODES,
  STAGES,
  isRunMode,
  isPlanless,
  isStage,
  toRunMode,
  toStage,
} from '../src/model';
import {
  investigateSchema,
  persistencePathForStage,
  schemaForStage,
  stageArtifactIsNumbered,
  validateInvestigateResult,
  type InvestigateResult,
} from '../src/schema';
import {
  renderArtifact,
  renderInvestigateArtifact,
} from '../src/engine/resultFlow';
import { STAGE_ROLE } from '../src/activation/engineFacade';
import { isErr, isOk } from '../src/model/result';

/**
 * The run-mode vocabulary and the Investigate stage.
 *
 * Pins the `RunMode` union (including the recommend-and-confirm `default` mode) and its `isPlanless` predicate, the wiring of the
 * `investigate` stage (schema, persistence path, artifact renderer, role), and —
 * as a regression guard — that adding the stage moved nothing about the six
 * stages that already existed.
 */
describe('run modes and the investigate stage', () => {
  describe('RunMode', () => {
    it('defaults to default so a Workspace conversation starts in recommend-and-confirm', () => {
      assert.strictEqual(DEFAULT_MODE, 'default');
    });

    it('lists every mode, default first', () => {
      assert.deepStrictEqual(
        [...RUN_MODES],
        ['default', 'plan', 'bug', 'quick', 'refactor', 'investigate'],
      );
    });

    it('recognises default as a mode', () => {
      assert.strictEqual(isRunMode('default'), true);
    });

    it('recognises every listed mode', () => {
      for (const mode of RUN_MODES) {
        assert.strictEqual(isRunMode(mode), true, `isRunMode(${mode})`);
      }
    });

    it('rejects a string that is not a mode', () => {
      assert.strictEqual(isRunMode('bogus'), false);
      assert.strictEqual(isRunMode(''), false);
      assert.strictEqual(isRunMode('Spec'), false);
      assert.strictEqual(isRunMode('Default'), false);
    });

    it('treats every mode but plan as plan-less', () => {
      assert.strictEqual(isPlanless('plan'), false);
      assert.strictEqual(isPlanless('default'), true);
      for (const mode of RUN_MODES) {
        if (mode === 'plan') {
          continue;
        }
        assert.strictEqual(isPlanless(mode), true, `isPlanless(${mode})`);
      }
    });

    it('reads the legacy persisted mode and recognizes every current mode', () => {
      assert.strictEqual(toRunMode('spec'), 'plan');
      for (const mode of RUN_MODES) {
        assert.strictEqual(toRunMode(mode), mode);
      }
      assert.strictEqual(toRunMode('nope'), undefined);
    });
  });

  describe('toStage', () => {
    it('reads the legacy journal stage and recognizes every current stage', () => {
      assert.strictEqual(toStage('spec-draft'), 'plan-draft');
      for (const stage of STAGES) {
        assert.strictEqual(toStage(stage), stage);
      }
      assert.strictEqual(toStage('nope'), undefined);
    });
  });

  describe('investigate stage', () => {
    it('is a known stage, appended to STAGES', () => {
      assert.strictEqual(isStage('investigate'), true);
      assert.ok(STAGES.includes('investigate'));
      assert.strictEqual(STAGES[STAGES.length - 1], 'investigate');
    });

    it('leaves the six pre-existing stages in place', () => {
      assert.deepStrictEqual(
        [...STAGES],
        [
          'plan-draft',
          'plan',
          'plan-review',
          'execute',
          'review',
          'pr',
          'investigate',
        ],
      );
      assert.strictEqual(STAGES.length, 7);
    });

    it('maps to the investigate schema', () => {
      assert.strictEqual(schemaForStage('investigate'), investigateSchema);
    });

    it('persists one unnumbered finding.md, whatever the call shape', () => {
      assert.strictEqual(persistencePathForStage('investigate'), 'finding.md');
      assert.strictEqual(
        persistencePathForStage('investigate', 'P01'),
        'finding.md',
      );
      assert.strictEqual(
        persistencePathForStage('investigate', 'P01', 3),
        'finding.md',
      );
      assert.strictEqual(stageArtifactIsNumbered('investigate'), false);
    });

    it('runs as the existing reviewer role', () => {
      assert.strictEqual(STAGE_ROLE.investigate, 'reviewer');
    });
  });

  describe('investigate result', () => {
    const value: InvestigateResult = {
      finding: 'f',
      files: ['src/a.ts'],
      next_steps: ['n'],
    };

    it('validates a well-formed result and rejects a missing finding', () => {
      assert.ok(isOk(validateInvestigateResult(value)));
      assert.ok(isErr(validateInvestigateResult({ files: [], next_steps: [] })));
    });

    it('renders the finding, its files and its next steps', () => {
      const md = renderInvestigateArtifact('R01', value);
      assert.ok(md.startsWith('# Finding R01'), md);
      assert.ok(md.includes('## Finding'));
      assert.ok(md.includes('## Files'));
      assert.ok(md.includes('`src/a.ts`'));
      assert.ok(md.includes('## Next steps'));
      assert.ok(md.includes('- n'));
    });

    it('renders `- (none)` for empty lists', () => {
      const md = renderInvestigateArtifact('R01', {
        finding: 'f',
        files: [],
        next_steps: [],
      });
      assert.ok(md.includes('- (none)'), md);
    });

    it('is reached through the generic renderArtifact entry point', () => {
      assert.strictEqual(
        renderArtifact('investigate', value, 'R01'),
        renderInvestigateArtifact('R01', value),
      );
    });
  });

  describe('existing stages unchanged', () => {
    it('keeps every pre-existing persistence path', () => {
      assert.strictEqual(persistencePathForStage('plan-draft'), 'plan.md');
      assert.strictEqual(persistencePathForStage('plan-draft', undefined, undefined, 'legacy-spec'), 'spec.md');
      assert.strictEqual(persistencePathForStage('pr'), 'pr.md');
      assert.strictEqual(
        persistencePathForStage('plan', 'P01'),
        'phases/P01/plan.md',
      );
      assert.strictEqual(
        persistencePathForStage('plan-review', 'P01', 2),
        'phases/P01/plan-review-2.md',
      );
      assert.strictEqual(
        persistencePathForStage('execute', 'P01', 3),
        'phases/P01/execute-3.md',
      );
      assert.strictEqual(
        persistencePathForStage('review', 'P01', 1),
        'phases/P01/review-1.md',
      );
      assert.strictEqual(
        persistencePathForStage('plan', 'T01', undefined, 'legacy-spec'),
        'todos/T01/plan.md',
      );
      assert.strictEqual(
        persistencePathForStage('execute', 'T01', 3, 'legacy-spec'),
        'todos/T01/execute-3.md',
      );
    });

    it('keeps every pre-existing numbering decision', () => {
      assert.strictEqual(stageArtifactIsNumbered('plan'), false);
      assert.strictEqual(stageArtifactIsNumbered('pr'), false);
      assert.strictEqual(stageArtifactIsNumbered('plan-draft'), false);
      assert.strictEqual(stageArtifactIsNumbered('plan-review'), true);
      assert.strictEqual(stageArtifactIsNumbered('execute'), true);
      assert.strictEqual(stageArtifactIsNumbered('review'), true);
    });

    it('keeps every pre-existing stage → role mapping', () => {
      assert.strictEqual(STAGE_ROLE.plan, 'planner');
      assert.strictEqual(STAGE_ROLE.execute, 'executor');
      assert.strictEqual(STAGE_ROLE.review, 'reviewer');
      assert.strictEqual(STAGE_ROLE['plan-draft'], 'plan-writer');
      assert.strictEqual(STAGE_ROLE['plan-review'], 'plan-reviewer');
      assert.strictEqual(STAGE_ROLE.pr, 'pr-writer');
    });
  });
});
