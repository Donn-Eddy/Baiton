import * as assert from 'assert';
import { isErr, isOk } from '../src/model/result';
import { writeFrontmatterKey, writeTodoState } from '../src/model/writer';

/** A representative spec with frontmatter, an OVERVIEW and several todos. */
const SPEC = [
  '---',
  'status: draft',
  'branch:',
  'approved_rev: ',
  'title: My Feature', // non-managed key: must never be touched
  '---',
  '',
  '# OVERVIEW',
  '',
  'Some prose the user owns.',
  '',
  '# TODOS',
  '',
  '- [pending] T01 First todo (after T02; files: a.ts, b.ts)',
  '- [executing] T02 Second todo',
  '- [done] T03 Third todo',
  '',
].join('\n');

describe('writer', () => {
  describe('writeTodoState', () => {
    it('rewrites only the target todo state box, leaving every other byte identical', () => {
      const r = writeTodoState(SPEC, 'T01', 'planning');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        const expected = SPEC.replace(
          '- [pending] T01 First todo',
          '- [planning] T01 First todo',
        );
        assert.strictEqual(r.value, expected);
      }
    });

    it('preserves the id, title and hints on the edited line', () => {
      const r = writeTodoState(SPEC, 'T01', 'executed');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        assert.ok(
          r.value.includes(
            '- [executed] T01 First todo (after T02; files: a.ts, b.ts)',
          ),
        );
      }
    });

    it('aborts with todo-not-found when the id is absent', () => {
      const r = writeTodoState(SPEC, 'T99', 'planning');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'todo-not-found');
      }
    });

    it('refuses to change a done todo and reports done-protected', () => {
      const r = writeTodoState(SPEC, 'T03', 'executing');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
        if (r.error.kind === 'done-protected') {
          assert.strictEqual(r.error.todoId, 'T03');
        }
      }
    });

    it('leaves a done todo unchanged even when the requested state is done', () => {
      const r = writeTodoState(SPEC, 'T03', 'done');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
      }
    });
  });

  describe('writeFrontmatterKey', () => {
    it('writes a managed key value, leaving every other byte identical', () => {
      const r = writeFrontmatterKey(SPEC, 'branch', 'spec/my-feature');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        const expected = SPEC.replace(
          'branch:',
          'branch: spec/my-feature',
        );
        assert.strictEqual(r.value, expected);
      }
    });

    it('overwrites an existing managed value in place', () => {
      const withStatus = writeFrontmatterKey(SPEC, 'status', 'approved');
      assert.strictEqual(isOk(withStatus), true);
      if (isOk(withStatus)) {
        assert.ok(withStatus.value.includes('status: approved'));
        assert.ok(!withStatus.value.includes('status: draft'));
      }
    });

    it('does not touch a non-managed key that shares a value shape', () => {
      const r = writeFrontmatterKey(SPEC, 'status', 'approved');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        // The user-owned `title` key is untouched.
        assert.ok(r.value.includes('title: My Feature'));
      }
    });

    it('aborts with key-not-found when the managed key is absent', () => {
      const r = writeFrontmatterKey(SPEC, 'pr', '42');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'key-not-found');
      }
    });

    it('aborts with key-not-found when there is no frontmatter block', () => {
      const noFrontmatter = '# OVERVIEW\n\nprose\n\n# TODOS\n';
      const r = writeFrontmatterKey(noFrontmatter, 'branch', 'x');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'key-not-found');
      }
    });
  });
});
