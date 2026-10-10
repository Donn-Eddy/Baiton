import * as assert from 'assert';
import { buildStageContext } from '../src/engine/stageContext';
import { parsePlan, type ParsedPlan } from '../src/model/parser';

/**
 * Unit tests for the per-stage Brief context assembler (Requirement 18.3;
 * design "Correctness Properties", Property 15).
 *
 * Each phase-level stage is briefed with exactly its own inputs, so a sub-agent
 * never has to open `plan document` or another phase's artifacts:
 *
 *   - plan        — OVERVIEW, the phase line, and the execution summaries of the
 *                   phase's `after` targets (never their plans).
 *   - plan-review — OVERVIEW, the phase line, the plan.
 *   - execute     — the phase line and the plan, with NO OVERVIEW; a retry or a
 *                   resumed session also carries the latest review.
 *   - review      — the phase line, the plan, the execution summary, and the
 *                   execute commit to inspect (or a statement that it is
 *                   unknown).
 *
 * The confinement property has its own generated harness in
 * `stageContext.confinement.property.test.ts`; these are the per-stage shape
 * assertions.
 */

const OVERVIEW_MARK = 'OVERVIEWMARK';
const PLAN_MARK = 'PLANMARK';
const REVIEW_MARK = 'REVIEWMARK';
const EXEC_MARK = 'EXECMARK';

/** A two-phase spec where `T02` depends on `T01`. */
function makeSpec(): ParsedPlan {
  return parsePlan(
    [
      '---',
      'title: sample',
      '---',
      '# OVERVIEW',
      '',
      `Overview prose ${OVERVIEW_MARK}.`,
      '',
      '# TODOS',
      '- [done] T01 First phase TODO-ONE',
      '- [planned] T02 Second phase TODO-TWO (after T01)',
      '',
    ].join('\n'),
  );
}

describe('buildStageContext', () => {
  describe('plan', () => {
    it('carries the OVERVIEW, the phase line, and each after target execution summary', () => {
      const context = buildStageContext({
        stage: 'plan',
        plan: makeSpec(),
        phaseId: 'T02',
        afterExecutes: { T01: `Execution of T01 ${EXEC_MARK}` },
      });

      assert.ok(context.includes('# OVERVIEW'), 'plan carries the OVERVIEW heading');
      assert.ok(context.includes(OVERVIEW_MARK), 'plan carries the OVERVIEW text');
      assert.ok(context.includes('TODO-TWO'), 'plan carries the target phase line');
      assert.ok(
        context.includes('## After target T01'),
        'plan carries a heading per after target',
      );
      assert.ok(context.includes(EXEC_MARK), "plan carries the after target's execution summary");
      assert.ok(
        !context.includes('TODO-ONE'),
        "plan does not carry another phase's own line",
      );
    });

    it('omits after targets with no execution summary on file', () => {
      const context = buildStageContext({
        stage: 'plan',
        plan: makeSpec(),
        phaseId: 'T02',
        afterExecutes: {},
      });

      assert.ok(context.includes(OVERVIEW_MARK), 'the OVERVIEW is still carried');
      assert.ok(context.includes('TODO-TWO'), 'the phase line is still carried');
      assert.ok(
        !context.includes('## After target'),
        'an after target with no artifact contributes nothing at all',
      );
    });

    it('yields just the OVERVIEW for a phase the plan does not carry', () => {
      const context = buildStageContext({
        stage: 'plan',
        plan: makeSpec(),
        phaseId: 'T99',
        afterExecutes: { T01: EXEC_MARK },
      });

      assert.ok(context.includes(OVERVIEW_MARK));
      assert.ok(!context.includes('# Phase'), 'no phase line is fabricated');
      assert.ok(!context.includes(EXEC_MARK), 'no after content without a target phase');
    });
  });

  describe('plan-review', () => {
    it('carries the OVERVIEW, the phase line and the plan under review', () => {
      const context = buildStageContext({
        stage: 'plan-review',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: `Plan body ${PLAN_MARK}`,
      });

      assert.ok(context.includes(OVERVIEW_MARK), 'plan-review carries the OVERVIEW');
      assert.ok(context.includes('TODO-TWO'), 'plan-review carries the phase line');
      assert.ok(context.includes('# Plan'), 'the plan is delimited by its own heading');
      assert.ok(context.includes(PLAN_MARK), 'plan-review carries the plan text');
    });

    it('names a phase that is absent from the plan', () => {
      const context = buildStageContext({
        stage: 'plan-review',
        plan: makeSpec(),
        phaseId: 'T99',
        phasePlan: PLAN_MARK,
      });
      assert.ok(context.includes('The phase "T99" is not present in the plan.'));
    });
  });

  describe('execute', () => {
    it('carries the phase line and the plan but never the OVERVIEW', () => {
      const context = buildStageContext({
        stage: 'execute',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: `Plan body ${PLAN_MARK}`,
        attempt: 1,
        resume: false,
      });

      assert.ok(context.includes('TODO-TWO'), 'execute carries the phase line');
      assert.ok(context.includes(PLAN_MARK), 'execute carries the plan');
      assert.ok(!context.includes('# OVERVIEW'), 'execute carries no OVERVIEW heading');
      assert.ok(!context.includes(OVERVIEW_MARK), 'execute carries no OVERVIEW text');
    });

    it('omits the latest review on the first attempt', () => {
      const context = buildStageContext({
        stage: 'execute',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: PLAN_MARK,
        latestReview: `Review body ${REVIEW_MARK}`,
        attempt: 1,
        resume: false,
      });

      assert.ok(!context.includes('# Latest review'));
      assert.ok(!context.includes(REVIEW_MARK), 'a first attempt has nothing to fix');
    });

    it('carries the latest review from the second attempt on', () => {
      const context = buildStageContext({
        stage: 'execute',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: PLAN_MARK,
        latestReview: `Review body ${REVIEW_MARK}`,
        attempt: 2,
        resume: false,
      });

      assert.ok(context.includes('# Latest review'), 'the review has its own section');
      assert.ok(context.includes(REVIEW_MARK), 'the executor is told what to fix');
    });

    it('carries the latest review on a resumed first attempt', () => {
      const context = buildStageContext({
        stage: 'execute',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: PLAN_MARK,
        latestReview: `Review body ${REVIEW_MARK}`,
        attempt: 1,
        resume: true,
      });

      assert.ok(context.includes(REVIEW_MARK), 'a resumed run is a continuation, not a fresh start');
    });
  });

  describe('review', () => {
    it('carries the phase line, plan, execution summary and the commit to inspect', () => {
      const context = buildStageContext({
        stage: 'review',
        plan: makeSpec(),
        phaseId: 'T02',
        phasePlan: `Plan body ${PLAN_MARK}`,
        latestExecute: `Execution ${EXEC_MARK}`,
        executeCommit: 'abc1234',
      });

      assert.ok(context.includes('TODO-TWO'), 'review carries the phase line');
      assert.ok(context.includes(PLAN_MARK), 'review carries the plan it judges against');
      assert.ok(context.includes(EXEC_MARK), 'review carries the execution summary');
      assert.ok(context.includes('abc1234'), 'review names the commit');
      assert.ok(
        context.includes('git show abc1234'),
        'review is told to inspect the commit rather than the tree',
      );
      assert.ok(!context.includes(OVERVIEW_MARK), 'review carries no OVERVIEW');
    });

    it('says so when the plan and execute commit are not on file', () => {
      const context = buildStageContext({
        stage: 'review',
        plan: makeSpec(),
        phaseId: 'T02',
      });

      assert.ok(context.includes('No plan is on file for this phase.'));
      assert.ok(context.includes('No execution summary is on file for this phase.'));
      assert.ok(
        context.includes('# Execute commit'),
        'the section is present either way so the reviewer is never left guessing',
      );
      assert.ok(context.toLowerCase().includes('unknown'), 'the unknown commit is stated');
      assert.ok(!context.includes('git show'), 'no commit is named to inspect');
    });
  });
});
