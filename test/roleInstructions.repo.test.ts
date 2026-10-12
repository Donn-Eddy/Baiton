import * as assert from 'assert';
import {
  CONTEXT_IS_COMPLETE_INSTRUCTION,
  PLAN_WRITER_INSTRUCTION,
  PLAN_WRITER_REPO_INSTRUCTION,
  PLANNER_REPO_INSTRUCTION,
  roleInstructions,
} from '../src/engine/roleInstructions';

describe('role instructions for repository targeting', () => {
  it('tells the plan writer to select the lowest repo and use child-relative hints', () => {
    assert.ok(PLAN_WRITER_INSTRUCTION.includes(PLAN_WRITER_REPO_INSTRUCTION));
    assert.match(PLAN_WRITER_INSTRUCTION, /Choose the lowest repository/);
    assert.match(PLAN_WRITER_INSTRUCTION, /never name a sibling or an ancestor/);
    assert.match(PLAN_WRITER_INSTRUCTION, /plan belongs in that child repository/);
  });

  it('explains repo hints to planners before the complete-context rule', () => {
    const planner = roleInstructions('planner');
    assert.ok(planner.includes(PLANNER_REPO_INSTRUCTION));
    assert.ok(planner.includes(CONTEXT_IS_COMPLETE_INSTRUCTION));
    assert.ok(planner.indexOf(PLANNER_REPO_INSTRUCTION) < planner.indexOf(CONTEXT_IS_COMPLETE_INSTRUCTION));
  });

  it('preserves executor, reviewer and investigate instructions', () => {
    const executorSnapshot = [
      'You are the executor. The Context section gives you the phase and its plan — and, when this is a retry, the review that sent it back. Implement this single phase by editing the workspace files to satisfy the plan. Run whatever you need to verify your work.',
      'The phase is not complete until the result file named in the "Result file" section of this brief exists: writing that file is the last step of the work, not an optional report about it.',
      'Everything you need is in the Context section of this brief. Do not read the plan document (`plan.md` at the plan root, or a legacy `spec.md`), anything under `.baiton/plans` or `.baiton/specs`, or any other phase\'s artifacts; the Context is the complete and authoritative statement of your inputs.',
      'Do not commit, stash, or change branches. The extension manages all git operations; leave your changes in the working tree.',
    ].join('\n\n');
    const reviewerSnapshot = [
      'You are the reviewer. The Context section gives you the phase, its plan, the executor\'s summary, and the commit the execution landed in. Inspect that commit with git — `git show <commit>` — rather than reading the whole tree, and judge whether the phase was implemented correctly against its plan. Run checks as needed. Do not modify any source files outside your run directory.',
      'Everything you need is in the Context section of this brief. Do not read the plan document (`plan.md` at the plan root, or a legacy `spec.md`), anything under `.baiton/plans` or `.baiton/specs`, or any other phase\'s artifacts; the Context is the complete and authoritative statement of your inputs.',
    ].join('\n\n');
    const investigateSnapshot = [
      'You are the investigator. The Context section gives you one question and the files to start from. Study the repository read-only and answer the question from the code as it is. Make no code changes: no edits outside your run directory, no commits, no branches, no stashes.',
      'Answer with a finding: what is actually true of the code, why it is true, and the evidence (file and symbol names) that grounds it. Do not propose a fix as though it were the answer; list the follow-up work you would do as next steps.',
      'Everything you need is in the Context section of this brief. Do not read the plan document (`plan.md` at the plan root, or a legacy `spec.md`), anything under `.baiton/plans` or `.baiton/specs`, or any other phase\'s artifacts; the Context is the complete and authoritative statement of your inputs.',
    ].join('\n\n');
    assert.strictEqual(roleInstructions('executor'), executorSnapshot);
    assert.strictEqual(roleInstructions('reviewer'), reviewerSnapshot);
    assert.strictEqual(roleInstructions('reviewer', 'investigate'), investigateSnapshot);
  });
});
