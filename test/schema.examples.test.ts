import * as assert from 'assert';
import {
  validatePlanResult,
  validatePlanReviewResult,
  validateExecuteResult,
  validateReviewResult,
  validateSpecDraftResult,
  validateStageResult,
} from '../src/schema';
import { isOk, isErr } from '../src/model/result';

/**
 * Concrete conformant / non-conformant examples for each stage result schema.
 *
 * These are hand-written companions to the property tests: they pin the exact
 * shapes the four stages accept and reject, and give the empty-findings invalid
 * case (Req 12.9) a named, readable example so a regression there is obvious.
 *
 * Validates: Requirements 12.9, 25.1
 */
describe('stage result schema examples (unit)', () => {
  describe('spec-draft stage', () => {
    it('accepts a well-formed spec draft', () => {
      const value = {
        overview: 'Add a greeting module and cover it with tests.',
        todos: [
          { title: 'Add the greeting function', files: ['src/greeting.ts'] },
          { title: 'Test the greeting function', after: ['1'], files: ['test/greeting.test.ts'] },
        ],
      };
      const result = validateSpecDraftResult(value);
      assert.ok(isOk(result), 'a well-formed spec draft should validate');
    });

    it('accepts a draft whose todos carry a title only', () => {
      const result = validateSpecDraftResult({
        overview: 'Do the thing.',
        todos: [{ title: 'Do it' }],
      });
      assert.ok(isOk(result));
    });

    it('accepts a draft with an empty todo list', () => {
      assert.ok(isOk(validateSpecDraftResult({ overview: 'Nothing yet.', todos: [] })));
    });

    it('rejects a draft missing the required `overview` field', () => {
      const result = validateSpecDraftResult({ todos: [{ title: 'Do it' }] });
      assert.ok(isErr(result));
    });

    it('rejects a draft missing the required `todos` field', () => {
      assert.ok(isErr(validateSpecDraftResult({ overview: 'Only prose.' })));
    });

    it('rejects a todo with an empty title', () => {
      assert.ok(isErr(validateSpecDraftResult({ overview: 'x', todos: [{ title: '' }] })));
    });

    it('rejects a todo carrying a lifecycle state (an unexpected extra property)', () => {
      const result = validateSpecDraftResult({
        overview: 'x',
        todos: [{ title: 'Do it', state: 'pending' }],
      });
      assert.ok(isErr(result), 'additionalProperties:false must reject a state');
    });

    it('rejects a draft carrying an unexpected extra property', () => {
      assert.ok(
        isErr(validateSpecDraftResult({ overview: 'x', todos: [], slug: 'mine' })),
      );
    });

    it('rejects `after` positions that are not strings', () => {
      const result = validateSpecDraftResult({
        overview: 'x',
        todos: [{ title: 'Do it', after: [1] }],
      });
      assert.ok(isErr(result));
    });

    it('reaches the same validator through validateStageResult', () => {
      assert.ok(isOk(validateStageResult('spec-draft', { overview: 'x', todos: [] })));
      assert.ok(isErr(validateStageResult('spec-draft', { overview: 'x' })));
    });
  });

  describe('plan stage', () => {
    it('accepts a well-formed plan result', () => {
      const value = {
        steps: [
          { title: 'Add validator', detail: 'wire Ajv in', files: ['src/schema/index.ts'] },
          { title: 'Add tests', detail: 'cover each stage', files: ['test/schema.examples.test.ts'] },
        ],
        risks: ['schema drift between types and schemas'],
        acceptance: ['mocha passes', 'each stage has an accepted and a rejected example'],
      };
      const result = validatePlanResult(value);
      assert.ok(isOk(result), 'a well-formed plan result should validate');
    });

    it('accepts a plan with empty risks and acceptance arrays', () => {
      const value = {
        steps: [{ title: 'noop', detail: 'nothing yet', files: [] }],
        risks: [],
        acceptance: [],
      };
      assert.ok(isOk(validatePlanResult(value)));
    });

    it('rejects a plan missing the required `acceptance` field', () => {
      const value = {
        steps: [{ title: 'x', detail: 'y', files: ['a.ts'] }],
        risks: [],
      };
      const result = validatePlanResult(value);
      assert.ok(isErr(result), 'missing required field should be rejected');
      assert.ok(result.ok === false && result.error.length > 0);
    });

    it('rejects a plan step missing the required `files` field', () => {
      const value = {
        steps: [{ title: 'x', detail: 'y' }],
        risks: [],
        acceptance: [],
      };
      assert.ok(isErr(validatePlanResult(value)));
    });

    it('rejects a plan whose `risks` is a string instead of an array', () => {
      const value = {
        steps: [{ title: 'x', detail: 'y', files: ['a.ts'] }],
        risks: 'not-an-array',
        acceptance: [],
      };
      assert.ok(isErr(validatePlanResult(value)));
    });

    it('rejects a plan carrying an unexpected extra property', () => {
      const value = {
        steps: [{ title: 'x', detail: 'y', files: ['a.ts'] }],
        risks: [],
        acceptance: [],
        extra: 'nope',
      };
      assert.ok(isErr(validatePlanResult(value)));
    });
  });

  describe('plan-review stage', () => {
    it('accepts a `pass` verdict with an empty findings list', () => {
      const value = { verdict: 'pass', findings: [] };
      assert.ok(isOk(validatePlanReviewResult(value)));
    });

    it('accepts a `findings` verdict with at least one finding', () => {
      const value = {
        verdict: 'findings',
        findings: [{ severity: 'must', text: 'the plan skips migrations' }],
      };
      assert.ok(isOk(validatePlanReviewResult(value)));
    });

    it('rejects a `findings` verdict with an empty findings list (Req 12.9)', () => {
      const value = { verdict: 'findings', findings: [] };
      const result = validatePlanReviewResult(value);
      assert.ok(
        isErr(result),
        'a findings verdict with no findings must be rejected (Req 12.9)',
      );
      assert.ok(result.ok === false && result.error.length > 0);
    });

    it('rejects a `pass` verdict that carries a non-empty findings list (Req 12.9)', () => {
      const value = {
        verdict: 'pass',
        findings: [{ severity: 'should', text: 'stray finding on a pass' }],
      };
      assert.ok(isErr(validatePlanReviewResult(value)));
    });

    it('rejects an unknown verdict value', () => {
      const value = { verdict: 'maybe', findings: [] };
      assert.ok(isErr(validatePlanReviewResult(value)));
    });

    it('rejects a finding with an unknown severity', () => {
      const value = {
        verdict: 'findings',
        findings: [{ severity: 'blocker', text: 'bad severity' }],
      };
      assert.ok(isErr(validatePlanReviewResult(value)));
    });

    it('rejects a result missing the required `findings` field', () => {
      const value = { verdict: 'pass' };
      assert.ok(isErr(validatePlanReviewResult(value)));
    });
  });

  describe('execute stage', () => {
    it('accepts a well-formed execute result', () => {
      const value = {
        summary: 'added the schema examples test',
        files_changed: ['test/schema.examples.test.ts'],
        commands_run: ['npm test'],
        notes: ['no source changes required'],
      };
      assert.ok(isOk(validateExecuteResult(value)));
    });

    it('accepts an execute result with empty arrays', () => {
      const value = { summary: 's', files_changed: [], commands_run: [], notes: [] };
      assert.ok(isOk(validateExecuteResult(value)));
    });

    it('rejects an execute result missing the required `summary` field', () => {
      const value = { files_changed: [], commands_run: [], notes: [] };
      assert.ok(isErr(validateExecuteResult(value)));
    });

    it('rejects an execute result whose `summary` is not a string', () => {
      const value = { summary: 42, files_changed: [], commands_run: [], notes: [] };
      assert.ok(isErr(validateExecuteResult(value)));
    });

    it('rejects an execute result whose `files_changed` holds a non-string item', () => {
      const value = { summary: 's', files_changed: [1], commands_run: [], notes: [] };
      assert.ok(isErr(validateExecuteResult(value)));
    });

    it('rejects an execute result carrying an unexpected extra property', () => {
      const value = {
        summary: 's',
        files_changed: [],
        commands_run: [],
        notes: [],
        extra: true,
      };
      assert.ok(isErr(validateExecuteResult(value)));
    });
  });

  describe('review stage', () => {
    it('accepts a `pass` verdict with empty findings and a tests block', () => {
      const value = {
        verdict: 'pass',
        findings: [],
        tests: { ran: true, passed: true, output_tail: 'ok' },
      };
      assert.ok(isOk(validateReviewResult(value)));
    });

    it('accepts a `findings` verdict with a located finding', () => {
      const value = {
        verdict: 'findings',
        findings: [{ severity: 'must', file: 'src/a.ts', line: 12, text: 'missing null check' }],
        tests: { ran: true, passed: false, output_tail: '1 failing' },
      };
      assert.ok(isOk(validateReviewResult(value)));
    });

    it('rejects a `findings` verdict with an empty findings list (Req 12.9)', () => {
      const value = {
        verdict: 'findings',
        findings: [],
        tests: { ran: true, passed: true, output_tail: 'ok' },
      };
      const result = validateReviewResult(value);
      assert.ok(
        isErr(result),
        'a findings verdict with no findings must be rejected (Req 12.9)',
      );
      assert.ok(result.ok === false && result.error.length > 0);
    });

    it('rejects a `pass` verdict that carries a non-empty findings list (Req 12.9)', () => {
      const value = {
        verdict: 'pass',
        findings: [{ severity: 'should', file: 'src/a.ts', line: 1, text: 'stray' }],
        tests: { ran: true, passed: true, output_tail: 'ok' },
      };
      assert.ok(isErr(validateReviewResult(value)));
    });

    it('rejects a review result missing the required `tests` block', () => {
      const value = { verdict: 'pass', findings: [] };
      assert.ok(isErr(validateReviewResult(value)));
    });

    it('rejects a finding whose `line` is not an integer', () => {
      const value = {
        verdict: 'findings',
        findings: [{ severity: 'must', file: 'src/a.ts', line: '12', text: 't' }],
        tests: { ran: true, passed: false, output_tail: '' },
      };
      assert.ok(isErr(validateReviewResult(value)));
    });

    it('rejects a tests block whose `ran` is not a boolean', () => {
      const value = {
        verdict: 'pass',
        findings: [],
        tests: { ran: 'yes', passed: true, output_tail: 'ok' },
      };
      assert.ok(isErr(validateReviewResult(value)));
    });

    it('rejects a tests block missing the required `output_tail` field', () => {
      const value = {
        verdict: 'pass',
        findings: [],
        tests: { ran: true, passed: true },
      };
      assert.ok(isErr(validateReviewResult(value)));
    });
  });

  describe('validateStageResult dispatches by stage', () => {
    it('validates a conformant plan through the generic entry point', () => {
      const value = {
        steps: [{ title: 't', detail: 'd', files: [] }],
        risks: [],
        acceptance: [],
      };
      assert.ok(isOk(validateStageResult('plan', value)));
    });

    it('rejects a plan shape submitted under the review stage', () => {
      const value = {
        steps: [{ title: 't', detail: 'd', files: [] }],
        risks: [],
        acceptance: [],
      };
      assert.ok(isErr(validateStageResult('review', value)));
    });
  });
});
