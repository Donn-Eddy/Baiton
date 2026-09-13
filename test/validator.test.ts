import * as assert from 'assert';
import { parseSpec, validateSpec, SpecError } from '../src/model';

/**
 * Unit tests for validator error messages and located errors (Task 3.7).
 *
 * These tests pin down the concrete, user-visible output of `validateSpec`:
 * the located `line`/`text` of each error and the human-readable `reason`
 * displayed to the user. They cover grammar failures, duplicate ids, unknown
 * states, missing and self `after` dependencies, and merge-conflict marker
 * line numbers.
 *
 * Requirements: 4.2 (grammar failure line + reason), 4.3 (duplicate id),
 * 4.4 (unknown state value), 4.5 (missing dependency id), 4.6 (self
 * dependency), 4.8 (conflict-marker line numbers), 25.1 (validation unit
 * coverage).
 */

/** Parses `raw` then validates it, returning the located errors. */
function validate(raw: string): SpecError[] {
  return validateSpec(parseSpec(raw), raw);
}

/** Finds the first error whose reason contains `needle`, or fails the test. */
function findError(errors: SpecError[], needle: string): SpecError {
  const match = errors.find((e) => e.reason.includes(needle));
  assert.ok(
    match,
    `expected an error whose reason contains "${needle}"; got: ${JSON.stringify(
      errors,
      null,
      2,
    )}`,
  );
  return match!;
}

describe('validator error messages and located errors', () => {
  describe('grammar failure (Req 4.2)', () => {
    it('locates a malformed todo line and displays the grammar reason', () => {
      // The offending line is on line 5 (1-based). Only the state box would
      // parse; there is no id, so the line fails the todo grammar.
      const raw = [
        '# OVERVIEW', // 1
        '', // 2
        '# TODOS', // 3
        '', // 4
        '- [pending] not-an-id title here', // 5
      ].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'malformed');

      assert.strictEqual(err.line, 5, 'error should point at the offending line');
      assert.strictEqual(
        err.text,
        '- [pending] not-an-id title here',
        'error text should be the raw offending line',
      );
      assert.match(
        err.reason,
        /malformed id "not-an-id"/,
        'reason should name the malformed id',
      );
    });

    it('reports a fully malformed line missing the id and title', () => {
      const raw = ['# TODOS', '- [pending]'].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'malformed');

      assert.strictEqual(err.line, 2);
      assert.strictEqual(err.text, '- [pending]');
      assert.match(
        err.reason,
        /expected "- \[<state>\] <id> <title>"/,
        'reason should describe the expected grammar',
      );
    });
  });

  describe('duplicate id (Req 4.3)', () => {
    it('locates the second occurrence and names the duplicated id', () => {
      const raw = [
        '# TODOS', // 1
        '- [pending] T01 first', // 2
        '- [pending] T02 second', // 3
        '- [pending] T01 dupe of first', // 4
      ].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'duplicate id');

      assert.strictEqual(err.line, 4, 'should locate the duplicate occurrence');
      assert.strictEqual(err.reason, 'duplicate id "T01"');
      assert.ok(
        err.text.includes('T01'),
        'error text should reference the duplicated todo',
      );
    });
  });

  describe('unknown state (Req 4.4)', () => {
    it('displays the unknown state value in the reason', () => {
      const raw = [
        '# TODOS', // 1
        '- [bogus] T01 has a bad state', // 2
      ].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'unknown state');

      assert.strictEqual(err.line, 2);
      assert.strictEqual(err.text, '- [bogus] T01 has a bad state');
      assert.match(
        err.reason,
        /unknown state "bogus"/,
        'reason should display the unknown state value',
      );
    });
  });

  describe('missing dependency (Req 4.5)', () => {
    it('displays the missing dependency id in the reason', () => {
      const raw = [
        '# TODOS', // 1
        '- [pending] T01 depends on a ghost (after T99)', // 2
      ].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'unknown id');

      assert.strictEqual(err.line, 2, 'should locate the referencing todo');
      assert.match(
        err.reason,
        /depends on unknown id "T99"/,
        'reason should display the missing dependency id',
      );
      assert.ok(err.text.includes('T01'));
    });
  });

  describe('self dependency (Req 4.6)', () => {
    it('reports a todo that lists its own id in after', () => {
      const raw = [
        '# TODOS', // 1
        '- [pending] T01 depends on itself (after T01)', // 2
      ].join('\n');

      const errors = validate(raw);
      const err = findError(errors, 'lists itself');

      assert.strictEqual(err.line, 2);
      assert.match(
        err.reason,
        /todo "T01" lists itself in its "after" dependencies/,
        'reason should identify the self-referencing todo',
      );
      // A self-reference is a dependency error, not a cycle: no cycle reason.
      assert.ok(
        !errors.some((e) => e.reason.includes('dependency cycle')),
        'a self-reference should not also be reported as a cycle',
      );
    });
  });

  describe('merge-conflict markers (Req 4.8)', () => {
    it('reports each marker line with its 1-based line number', () => {
      const raw = [
        '# OVERVIEW', // 1
        '<<<<<<< HEAD', // 2
        'ours', // 3
        '=======', // 4
        'theirs', // 5
        '>>>>>>> branch', // 6
        '# TODOS', // 7
        '- [pending] T01 a todo', // 8
      ].join('\n');

      const errors = validate(raw);
      const conflictErrors = errors.filter((e) =>
        e.reason.includes('merge-conflict marker'),
      );

      const lines = conflictErrors.map((e) => e.line).sort((a, b) => a - b);
      assert.deepStrictEqual(
        lines,
        [2, 4, 6],
        'should report the line number of every conflict marker',
      );

      const opening = conflictErrors.find((e) => e.line === 2)!;
      assert.strictEqual(opening.text, '<<<<<<< HEAD');
      assert.match(opening.reason, /merge-conflict marker "<<<<<<<" found/);
    });
  });

  describe('valid spec', () => {
    it('produces no errors for a well-formed spec', () => {
      const raw = [
        '# OVERVIEW',
        '',
        'A valid spec.',
        '',
        '# TODOS',
        '- [pending] T01 first',
        '- [planned] T02 second (after T01)',
      ].join('\n');

      assert.deepStrictEqual(validate(raw), []);
    });
  });
});
