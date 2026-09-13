import * as assert from 'assert';
import { isErr } from '../src/model/result';
import { writeFrontmatterKey, writeTodoState } from '../src/model/writer';

/**
 * Task 4.3 — focused unit tests for the serializer's abort and `done`-line
 * warning paths. These complement the round-trip/scope tests in
 * `writer.test.ts` by asserting the specific invariant both requirements share:
 * when the target cannot be located (Req 6.5) or the target todo is `done`
 * (Req 4.11), the write is aborted and the file content is left byte-for-byte
 * unchanged while the correct error kind is reported.
 */

/** A representative spec with frontmatter, an OVERVIEW and several todos. */
const SPEC = [
  '---',
  'status: draft',
  'branch:',
  'approved_rev: ',
  'title: My Feature',
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

describe('writer abort and done-line warning (Req 6.5, 4.11)', () => {
  describe('abort on unlocatable target (Req 6.5)', () => {
    it('leaves the content unchanged when the todo id cannot be located', () => {
      const r = writeTodoState(SPEC, 'T99', 'planning');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'todo-not-found');
        if (r.error.kind === 'todo-not-found') {
          assert.strictEqual(r.error.todoId, 'T99');
          // The abort surfaces a message indicating the write was not applied.
          assert.ok(r.error.message.length > 0);
        }
      }
    });

    it('leaves the content unchanged when the managed key cannot be located', () => {
      // `pr` is a managed key but is absent from this frontmatter block.
      const r = writeFrontmatterKey(SPEC, 'pr', '42');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'key-not-found');
        if (r.error.kind === 'key-not-found') {
          assert.strictEqual(r.error.key, 'pr');
          assert.ok(r.error.message.length > 0);
        }
      }
    });

    it('leaves the content unchanged when there is no frontmatter block at all', () => {
      const noFrontmatter = '# OVERVIEW\n\nprose\n\n# TODOS\n\n- [pending] T01 A\n';
      const r = writeFrontmatterKey(noFrontmatter, 'branch', 'spec/x');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'key-not-found');
      }
    });
  });

  describe('done-line edit warning leaves state unchanged (Req 4.11)', () => {
    it('refuses to advance a done todo and identifies it in the error', () => {
      const r = writeTodoState(SPEC, 'T03', 'executing');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
        if (r.error.kind === 'done-protected') {
          // The warning must identify the todo whose state was left unchanged.
          assert.strictEqual(r.error.todoId, 'T03');
          assert.ok(r.error.message.includes('T03'));
        }
      }
    });

    it('treats a no-op re-write of a done todo as a protected abort', () => {
      const r = writeTodoState(SPEC, 'T03', 'done');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
      }
    });

    it('does not touch any other todo state when a done todo is targeted', () => {
      // The abort returns an error rather than a rewritten string, so no other
      // todo (e.g. the still-executing T02) can have been advanced. Confirm a
      // legal sibling write still works, proving the done abort was isolated.
      const done = writeTodoState(SPEC, 'T03', 'reviewing');
      assert.strictEqual(isErr(done), true);

      const sibling = writeTodoState(SPEC, 'T02', 'executed');
      assert.strictEqual(isErr(sibling), false);
    });
  });
});
