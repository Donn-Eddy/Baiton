import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  artifactPathFor,
  renderArtifact,
  renderExecuteArtifact,
  renderPlanArtifact,
  renderPlanReviewArtifact,
  renderReviewArtifact,
} from '../src/engine/resultFlow';
import type {
  ExecuteResult,
  PlanResult,
  PlanReviewResult,
  ReviewResult,
} from '../src/schema';

/**
 * Unit tests for the per-todo artifact paths and the per-stage Markdown
 * renderers (Requirement 24.3).
 *
 * The persisted `.md` artifact is what the next stage's Brief carries verbatim,
 * so the renderers are the real interface between stages: a plan has to read as
 * an implementable plan, an execution summary as a record of what changed. The
 * structured JSON stays in the run directory's `result.json`.
 */

const PLAN: PlanResult = {
  steps: [
    {
      title: 'Add the greeting function',
      detail: 'Export `greet(name)` returning a greeting.\nKeep it pure.',
      files: ['src/greeting.ts'],
    },
    { title: 'Cover it', detail: 'One unit test.', files: [] },
  ],
  risks: ['The module may already export a conflicting name.'],
  acceptance: ['`npm test` passes.'],
};

const EXECUTE: ExecuteResult = {
  summary: 'Added greet() and its test.',
  files_changed: ['src/greeting.ts', 'test/greeting.test.ts'],
  commands_run: ['npm test'],
  notes: ['Left the version constant alone.'],
};

const REVIEW: ReviewResult = {
  verdict: 'findings',
  findings: [
    { severity: 'must', file: 'src/greeting.ts', line: 3, text: 'Missing null guard.' },
  ],
  tests: { ran: true, passed: false, output_tail: '1 failing' },
};

const PLAN_REVIEW: PlanReviewResult = {
  verdict: 'findings',
  findings: [{ severity: 'should', text: 'Name the test file.' }],
};

describe('artifactPathFor (per-phase isolation, Req 24.3)', () => {
  let workspaceRoot: string;
  beforeEach(() => { workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-artifact-path-')); });
  afterEach(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  it('defaults to the plans phases folder when no document exists', () => {
    const base = path.join(workspaceRoot, '.baiton', 'plans', 'demo', 'phases');
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'plan', 'P06'),
      path.join(base, 'P06', 'plan.md'),
    );
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'execute', 'P06', 2),
      path.join(base, 'P06', 'execute-2.md'),
    );
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'review', 'P06', 1),
      path.join(base, 'P06', 'review-1.md'),
    );
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'plan-review', 'P06', 1),
      path.join(base, 'P06', 'plan-review-1.md'),
    );
    assert.strictEqual(artifactPathFor(workspaceRoot, 'demo', 'plan-draft'), path.join(workspaceRoot, '.baiton', 'plans', 'demo', 'plan.md'));
  });

  it('never lets one phase overwrite another at the same attempt', () => {
    assert.notStrictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'execute', 'P05', 1),
      artifactPathFor(workspaceRoot, 'demo', 'execute', 'P06', 1),
    );
  });

  it('resolves legacy specs to their todos layout', () => {
    const specDir = path.join(workspaceRoot, '.baiton', 'specs', 'demo');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec.md'), '# OVERVIEW\nLegacy.\n');
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'plan-draft', 'T06'),
      path.join(specDir, 'spec.md'),
    );
    assert.strictEqual(
      artifactPathFor(workspaceRoot, 'demo', 'pr'),
      path.join(specDir, 'pr.md'),
    );
    assert.strictEqual(artifactPathFor(workspaceRoot, 'demo', 'plan', 'T06'), path.join(specDir, 'todos', 'T06', 'plan.md'));
  });
});

describe('stage artifact renderers', () => {
  it('renders the plan as steps with details and files, then risks and acceptance', () => {
    const md = renderPlanArtifact('T06', PLAN);

    assert.ok(md.startsWith('# Plan T06'), 'the plan names its todo in the heading');
    assert.ok(md.includes('## Steps'));
    assert.ok(md.includes('1. Add the greeting function'), 'steps are a numbered list');
    assert.ok(md.includes('2. Cover it'));
    assert.ok(md.includes('Export `greet(name)`'), "a step carries its detail");
    assert.ok(md.includes('Keep it pure.'), 'a multi-line detail survives');
    assert.ok(md.includes('Files: `src/greeting.ts`'), 'a step names its files');
    assert.ok(md.includes('Files: (none)'), 'a step with no files says so');
    assert.ok(md.includes('## Risks'));
    assert.ok(md.includes('- The module may already export a conflicting name.'));
    assert.ok(md.includes('## Acceptance'));
    assert.ok(md.includes('- `npm test` passes.'));
    assert.ok(!md.includes('```json'), 'the plan is prose, not a JSON dump');
  });

  it('renders the execution summary, files, commands and notes as sections', () => {
    const md = renderExecuteArtifact('T06', EXECUTE);

    assert.ok(md.startsWith('# Execute T06'));
    assert.ok(md.includes('## Summary'));
    assert.ok(md.includes('Added greet() and its test.'));
    assert.ok(md.includes('## Files changed'));
    assert.ok(md.includes('- `src/greeting.ts`'));
    assert.ok(md.includes('## Commands run'));
    assert.ok(md.includes('- `npm test`'));
    assert.ok(md.includes('## Notes'));
    assert.ok(md.includes('- Left the version constant alone.'));
  });

  it('renders the review verdict, located findings and the test outcome', () => {
    const md = renderReviewArtifact('T06', REVIEW);

    assert.ok(md.startsWith('# Review T06'));
    assert.ok(md.includes('Verdict: **findings**'));
    assert.ok(md.includes('**must**'), 'a finding carries its severity');
    assert.ok(md.includes('`src/greeting.ts`:3'), 'a finding carries its location');
    assert.ok(md.includes('Missing null guard.'));
    assert.ok(md.includes('- ran: true'));
    assert.ok(md.includes('- passed: false'));
    assert.ok(md.includes('1 failing'), 'the test output tail is kept');
  });

  it('renders a passing review with an explicit empty findings list', () => {
    const md = renderReviewArtifact('T06', {
      verdict: 'pass',
      findings: [],
      tests: { ran: true, passed: true, output_tail: '' },
    });

    assert.ok(md.includes('Verdict: **pass**'));
    assert.ok(md.includes('- (none)'), 'an empty findings list is stated, not omitted');
  });

  it('renders the plan review verdict and findings', () => {
    const md = renderPlanReviewArtifact('T06', PLAN_REVIEW);

    assert.ok(md.startsWith('# Plan review T06'));
    assert.ok(md.includes('Verdict: **findings**'));
    assert.ok(md.includes('**should**'));
    assert.ok(md.includes('Name the test file.'));
  });

  it('dispatches each stage to its renderer and keeps JSON for the spec-scoped stages', () => {
    assert.strictEqual(renderArtifact('plan', PLAN, 'T06'), renderPlanArtifact('T06', PLAN));
    assert.strictEqual(
      renderArtifact('execute', EXECUTE, 'T06'),
      renderExecuteArtifact('T06', EXECUTE),
    );
    assert.strictEqual(
      renderArtifact('review', REVIEW, 'T06'),
      renderReviewArtifact('T06', REVIEW),
    );
    assert.strictEqual(
      renderArtifact('plan-review', PLAN_REVIEW, 'T06'),
      renderPlanReviewArtifact('T06', PLAN_REVIEW),
    );

    // The PR draft has its own file rendered by the submit flow; the generic
    // artifact keeps the structured result verbatim.
    const pr = renderArtifact('pr', { title: 't', body: 'b' });
    assert.ok(pr.includes('```json'), 'the spec-scoped stages keep the JSON form');
  });

  it('is pure: rendering twice yields the same text', () => {
    assert.strictEqual(renderPlanArtifact('T06', PLAN), renderPlanArtifact('T06', PLAN));
  });
});
