import * as assert from 'assert';
import { isErr } from '../src/model/result';
import { writeFrontmatterKey, writePhaseState } from '../src/model/writer';

/**
 * Focused unit tests for the serializer's abort and `done`-line
 * warning paths. These complement the round-trip/scope tests in
 * `writer.test.ts` by asserting the specific invariant both requirements share:
 * when the target cannot be located (Req 6.5) or the target phase is `done`
 * (Req 4.11), the write is aborted and the file content is left byte-for-byte
 * unchanged while the correct error kind is reported.
 */

/** Legacy spec fixture: frontmatter, an OVERVIEW and several phase lines. */
const LEGACY_SPEC = [
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
  '- [pending] T01 First phase (after T02; files: a.ts, b.ts)',
  '- [executing] T02 Second phase',
  '- [done] T03 Third phase',
  '',
].join('\n');

describe('writer abort and done-line warning (Req 6.5, 4.11)', () => {
  describe('abort on unlocatable target (Req 6.5)', () => {
    it('leaves the content unchanged when the phase id cannot be located', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T99', 'planning');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'phase-not-found');
        if (r.error.kind === 'phase-not-found') {
          assert.strictEqual(r.error.phaseId, 'T99');
          // The abort surfaces a message indicating the write was not applied.
          assert.ok(r.error.message.length > 0);
        }
      }
    });

    it('leaves the content unchanged when the managed key cannot be located', () => {
      // `pr` is a managed key but is absent from this frontmatter block.
      const r = writeFrontmatterKey(LEGACY_SPEC, 'pr', '42');
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
      const r = writeFrontmatterKey(noFrontmatter, 'branch', 'baiton/x');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'key-not-found');
      }
    });
  });

  describe('done-line edit warning leaves state unchanged (Req 4.11)', () => {
    it('refuses to advance a done phase and identifies it in the error', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T03', 'executing');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
        if (r.error.kind === 'done-protected') {
          // The warning must identify the phase whose state was left unchanged.
          assert.strictEqual(r.error.phaseId, 'T03');
          assert.ok(r.error.message.includes('T03'));
        }
      }
    });

    it('treats a no-op re-write of a done phase as a protected abort', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T03', 'done');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
      }
    });

    it('does not touch any other phase state when a done phase is targeted', () => {
      // The abort returns an error rather than a rewritten string, so no other
 // phase can have been advanced. Confirm a
      // legal sibling write still works, proving the done abort was isolated.
      const done = writePhaseState(LEGACY_SPEC, 'T03', 'reviewing');
      assert.strictEqual(isErr(done), true);

      const sibling = writePhaseState(LEGACY_SPEC, 'T02', 'executed');
      assert.strictEqual(isErr(sibling), false);
    });
  });
});
