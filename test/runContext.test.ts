import * as assert from 'assert';
import { buildRunContext, type RunContextInput } from '../src/engine/runContext';
import { buildBrief } from '../src/engine/brief';
import { INVESTIGATE_INSTRUCTION, roleInstructions } from '../src/engine/roleInstructions';

/**
 * Unit tests for the per-mode Brief context assembler for spec-less runs
 * (`bug`, `quick`, `refactor`, `investigate`) and the stage-selected investigate
 * role instructions wired into {@link buildBrief}.
 *
 * Every stage opens with `# Run` (mode, statement, branch, files). `bug` adds
 * `# Defect` and `# Reproduction`; `refactor` adds `# Behaviour preservation`
 * naming the verify command; `quick` adds nothing. `execute` carries the plan
 * and, on a retry or a resume, the latest review; `review` also carries the
 * execution summary and the execute commit; `investigate` carries only the
 * question and the files, with no mode framing at all.
 *
 * Nothing this module emits may mention `spec.md` or the spec tree — a
 * spec-less run has no spec to read.
 */

const STATEMENT_MARK = 'STATEMENTMARK';
const REPRO_MARK = 'REPROMARK';
const PLAN_MARK = 'PLANMARK';
const REVIEW_MARK = 'REVIEWMARK';
const EXEC_MARK = 'EXECMARK';

const SPEC_FILE = 'spec' + '.md';
const SPEC_DIR = '.baiton/' + 'specs';

/** A valid input, overridable per case. */
function base(over: Partial<RunContextInput> = {}): RunContextInput {
  return {
    stage: 'plan',
    mode: 'bug',
    statement: `Something is broken ${STATEMENT_MARK}`,
    files: ['src/a.ts', 'src/b.ts'],
    branch: 'baiton/bug/run-1',
    ...over,
  };
}

describe('buildRunContext', () => {
  describe('# Run section', () => {
    it('carries the mode, statement, branch and one bullet per file in order', () => {
      const text = buildRunContext(base());
      assert.ok(text.includes('# Run'));
      assert.ok(text.includes('- Mode: bug'));
      assert.ok(text.includes(`- Statement: Something is broken ${STATEMENT_MARK}`));
      assert.ok(text.includes('- Target branch: `baiton/bug/run-1`'));
      const first = text.indexOf('  - `src/a.ts`');
      const second = text.indexOf('  - `src/b.ts`');
      assert.ok(first > 0, 'first file bullet present');
      assert.ok(second > first, 'file bullets keep the given order');
    });

    it('says "none named." and emits no bullet when files is empty', () => {
      const text = buildRunContext(base({ files: [] }));
      assert.ok(text.includes('- Files: none named.'));
      assert.ok(!text.includes('  - `'), 'no stray file bullet');
    });

    it('says "none named." when files is omitted', () => {
      const text = buildRunContext(base({ files: undefined }));
      assert.ok(text.includes('- Files: none named.'));
    });
  });

  describe('bug mode', () => {
    for (const stage of ['plan', 'execute', 'review'] as const) {
      it(`carries # Defect and # Reproduction at the ${stage} stage`, () => {
        const text = buildRunContext(base({ stage, reproduction: `Steps ${REPRO_MARK}` }));
        assert.ok(text.includes('# Defect'));
        assert.ok(text.includes('Find and fix the root cause, not the symptom.'));
        assert.ok(text.includes('# Reproduction'));
        assert.ok(text.includes(REPRO_MARK));
      });
    }

    it('keeps # Reproduction with a fallback when no steps were supplied', () => {
      const text = buildRunContext(base({ reproduction: undefined }));
      assert.ok(text.includes('# Reproduction'));
      assert.ok(text.includes('No reproduction steps were supplied'));
    });

    it('keeps # Reproduction with a fallback when the steps are blank', () => {
      const text = buildRunContext(base({ reproduction: '   \n ' }));
      assert.ok(text.includes('No reproduction steps were supplied'));
    });
  });

  describe('quick mode', () => {
    it('carries the run framing only, with no mode sections', () => {
      const text = buildRunContext(base({ mode: 'quick' }));
      assert.ok(text.includes('# Run'));
      assert.ok(text.includes(STATEMENT_MARK));
      assert.ok(text.includes('  - `src/a.ts`'));
      assert.ok(!text.includes('# Defect'));
      assert.ok(!text.includes('# Reproduction'));
      assert.ok(!text.includes('# Behaviour preservation'));
    });
  });

  describe('refactor mode', () => {
    it('names the configured verify command in # Behaviour preservation', () => {
      const text = buildRunContext(base({ mode: 'refactor', verify: 'npm test' }));
      assert.ok(text.includes('# Behaviour preservation'));
      assert.ok(text.includes('Run `npm test` and keep it green.'));
    });

    it('falls back when no verify command is configured', () => {
      const text = buildRunContext(base({ mode: 'refactor', verify: undefined }));
      assert.ok(text.includes('# Behaviour preservation'));
      assert.ok(text.includes('No verify command is configured'));
      assert.ok(!text.includes('Run `'), 'no backticked command is named');
    });
  });

  describe('execute stage', () => {
    it('carries the plan', () => {
      const text = buildRunContext(base({ stage: 'execute', plan: `Plan body ${PLAN_MARK}` }));
      assert.ok(text.includes('# Plan'));
      assert.ok(text.includes(PLAN_MARK));
    });

    it('falls back when no plan is on file', () => {
      const text = buildRunContext(base({ stage: 'execute' }));
      assert.ok(text.includes('No plan is on file for this run.'));
    });

    it('omits # Latest review on attempt 1', () => {
      const text = buildRunContext(
        base({ stage: 'execute', attempt: 1, latestReview: `Review ${REVIEW_MARK}` }),
      );
      assert.ok(!text.includes('# Latest review'));
      assert.ok(!text.includes(REVIEW_MARK));
    });

    it('includes # Latest review on attempt 2', () => {
      const text = buildRunContext(
        base({ stage: 'execute', attempt: 2, latestReview: `Review ${REVIEW_MARK}` }),
      );
      assert.ok(text.includes('# Latest review'));
      assert.ok(text.includes(REVIEW_MARK));
    });

    it('includes # Latest review when resuming attempt 1', () => {
      const text = buildRunContext(
        base({ stage: 'execute', attempt: 1, resume: true, latestReview: `Review ${REVIEW_MARK}` }),
      );
      assert.ok(text.includes('# Latest review'));
    });

    it('never emits # Latest review for a blank review', () => {
      const text = buildRunContext(
        base({ stage: 'execute', attempt: 2, resume: true, latestReview: '  \n ' }),
      );
      assert.ok(!text.includes('# Latest review'));
    });
  });

  describe('review stage', () => {
    it('carries the plan, the execution summary and the execute commit', () => {
      const text = buildRunContext(
        base({
          stage: 'review',
          plan: `Plan body ${PLAN_MARK}`,
          latestExecute: `Did it ${EXEC_MARK}`,
          executeCommit: 'abc1234',
        }),
      );
      assert.ok(text.includes('# Plan'));
      assert.ok(text.includes(PLAN_MARK));
      assert.ok(text.includes('# Execution'));
      assert.ok(text.includes(EXEC_MARK));
      assert.ok(text.includes('# Execute commit'));
      assert.ok(text.includes('commit `abc1234`'));
      assert.ok(text.includes('git show abc1234'));
    });

    it('carries both headings with fallbacks when neither is known', () => {
      const text = buildRunContext(base({ stage: 'review' }));
      assert.ok(text.includes('# Execution'));
      assert.ok(text.includes('No execution summary is on file for this run.'));
      assert.ok(text.includes('# Execute commit'));
      assert.ok(text.includes('The execute commit is unknown'));
    });
  });

  describe('investigate stage', () => {
    const input = base({ stage: 'investigate', mode: 'investigate', branch: undefined });

    it('carries # Question and # Files', () => {
      const text = buildRunContext(input);
      assert.ok(text.includes('# Question'));
      assert.ok(text.includes(STATEMENT_MARK));
      assert.ok(text.includes('# Files'));
      assert.ok(text.includes('- `src/a.ts`'));
      assert.ok(text.includes('- `src/b.ts`'));
    });

    it('states that there are no files when none were named', () => {
      const text = buildRunContext({ ...input, files: [] });
      assert.ok(text.includes('No files were named; start from the question.'));
    });

    it('carries no plan, execution, commit, defect or target branch', () => {
      const text = buildRunContext(input);
      assert.ok(!text.includes('# Plan'));
      assert.ok(!text.includes('# Execution'));
      assert.ok(!text.includes('# Execute commit'));
      assert.ok(!text.includes('# Defect'));
      assert.ok(!text.includes('Target branch'));
    });

    it('carries the read-only note', () => {
      const text = buildRunContext(input);
      assert.ok(text.includes('- No branch: this run is read-only and makes no commits.'));
    });

    it('carries no target branch even when a branch is supplied', () => {
      const text = buildRunContext({ ...input, branch: 'baiton/investigate/run-1' });
      assert.ok(!text.includes('Target branch'));
    });
  });

  describe('hygiene', () => {
    const stages: readonly RunContextInput['stage'][] = [
      'plan',
      'execute',
      'review',
      'investigate',
    ];
    const modes: readonly RunContextInput['mode'][] = ['bug', 'quick', 'refactor', 'investigate'];

    it('ends every stage/mode output with exactly one newline', () => {
      for (const stage of stages) {
        for (const mode of modes) {
          const text = buildRunContext(
            base({
              stage,
              mode,
              reproduction: REPRO_MARK,
              verify: 'npm test',
              plan: PLAN_MARK,
              latestExecute: EXEC_MARK,
              executeCommit: 'abc1234',
            }),
          );
          assert.ok(text.endsWith('\n'), `${stage}/${mode} ends with a newline`);
          assert.ok(!text.endsWith('\n\n'), `${stage}/${mode} ends with exactly one newline`);
        }
      }
    });

    it('never mentions the spec file or the spec tree', () => {
      for (const stage of stages) {
        for (const mode of modes) {
          const text = buildRunContext(base({ stage, mode }));
          assert.ok(!text.includes(SPEC_FILE), `${stage}/${mode} does not name ${SPEC_FILE}`);
          assert.ok(!text.includes(SPEC_DIR), `${stage}/${mode} does not name ${SPEC_DIR}`);
        }
      }
    });
  });

  describe('purity', () => {
    it('returns identical strings for identical inputs', () => {
      const input = base({
        stage: 'review',
        plan: PLAN_MARK,
        latestExecute: EXEC_MARK,
        executeCommit: 'abc1234',
        reproduction: REPRO_MARK,
      });
      assert.strictEqual(buildRunContext(input), buildRunContext(input));
    });
  });
});

describe('investigate role instructions in the Brief', () => {
  const resultPath = '/tmp/r/result.json';

  it('opens an investigate Brief with INVESTIGATE_INSTRUCTION, not the reviewer prose', () => {
    const text = buildBrief({ stage: 'investigate', role: 'reviewer', resultPath });
    assert.ok(text.includes(INVESTIGATE_INSTRUCTION));
    assert.ok(!text.includes('You are the reviewer.'));
  });

  it('leaves the review Brief on the reviewer prose', () => {
    const text = buildBrief({ stage: 'review', role: 'reviewer', resultPath });
    assert.ok(text.includes('You are the reviewer.'));
    assert.ok(!text.includes(INVESTIGATE_INSTRUCTION));
  });

  it('is unchanged when roleInstructions is called with no stage', () => {
    assert.strictEqual(roleInstructions('reviewer'), roleInstructions('reviewer', 'review'));
  });
});
