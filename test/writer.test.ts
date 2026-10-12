import * as assert from 'assert';
import { approvalHash } from '../src/model/hash';
import { parsePlan } from '../src/model/parser';
import { isErr, isOk } from '../src/model/result';
import { writeFrontmatterKey, writePhaseState } from '../src/model/writer';

/** Legacy spec fixture: frontmatter, an OVERVIEW and several phase lines. */
const LEGACY_SPEC = [
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
  '- [pending] T01 First phase (after T02; files: a.ts, b.ts)',
  '- [executing] T02 Second phase',
  '- [done] T03 Third phase',
  '',
].join('\n');

describe('writer', () => {
  describe('writePhaseState', () => {
    it('edits a plan phase state box and rejects a legacy id prefix', () => {
      const plan = [
        '## Endstate',
        'A usable result.',
        '# PHASES',
        '- [pending] P01 First phase',
      ].join('\n');
      const written = writePhaseState(plan, 'P01', 'planning', 'plan');
      assert.ok(isOk(written));
      if (isOk(written)) {
        assert.strictEqual(written.value, plan.replace('[pending]', '[planning]'));
      }
      const wrongKind = writePhaseState(plan, 'T01', 'planning', 'plan');
      assert.ok(isErr(wrongKind));
      if (isErr(wrongKind)) {
        assert.strictEqual(wrongKind.error.kind, 'phase-not-found');
      }
    });

    it('rewrites only the target phase state box, leaving every other byte identical', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T01', 'planning');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        const expected = LEGACY_SPEC.replace(
          '- [pending] T01 First phase',
          '- [planning] T01 First phase',
        );
        assert.strictEqual(r.value, expected);
      }
    });

    it('preserves the id, title and hints on the edited line', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T01', 'executed');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        assert.ok(
          r.value.includes(
            '- [executed] T01 First phase (after T02; files: a.ts, b.ts)',
          ),
        );
      }
    });

    it('preserves a repo hint byte-for-byte and leaves the approval hash unchanged', () => {
      const plan = ['# PHASES', '- [pending] P01 Do it (after P00; repo: packages/api)'].join('\n');
      const beforeHash = approvalHash(parsePlan(plan));
      const written = writePhaseState(plan, 'P01', 'planning', 'plan');
      assert.ok(isOk(written));
      if (isOk(written)) {
        assert.strictEqual(written.value, plan.replace('[pending]', '[planning]'));
        assert.strictEqual(parsePlan(written.value).phases[0].repo, 'packages/api');
        assert.strictEqual(approvalHash(parsePlan(written.value)), beforeHash);
      }
    });

    it('aborts with phase-not-found when the id is absent', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T99', 'planning');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'phase-not-found');
      }
    });

    it('refuses to change a done phase and reports done-protected', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T03', 'executing');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
        if (r.error.kind === 'done-protected') {
          assert.strictEqual(r.error.phaseId, 'T03');
        }
      }
    });

    it('leaves a done phase unchanged even when the requested state is done', () => {
      const r = writePhaseState(LEGACY_SPEC, 'T03', 'done');
      assert.strictEqual(isErr(r), true);
      if (isErr(r)) {
        assert.strictEqual(r.error.kind, 'done-protected');
      }
    });
  });

  describe('writeFrontmatterKey', () => {
    it('writes a managed key value, leaving every other byte identical', () => {
      const r = writeFrontmatterKey(LEGACY_SPEC, 'branch', 'baiton/my-feature');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        const expected = LEGACY_SPEC.replace(
          'branch:',
          'branch: baiton/my-feature',
        );
        assert.strictEqual(r.value, expected);
      }
    });

    it('overwrites an existing managed value in place', () => {
      const withStatus = writeFrontmatterKey(LEGACY_SPEC, 'status', 'approved');
      assert.strictEqual(isOk(withStatus), true);
      if (isOk(withStatus)) {
        assert.ok(withStatus.value.includes('status: approved'));
        assert.ok(!withStatus.value.includes('status: draft'));
      }
    });

    it('does not touch a non-managed key that shares a value shape', () => {
      const r = writeFrontmatterKey(LEGACY_SPEC, 'status', 'approved');
      assert.strictEqual(isOk(r), true);
      if (isOk(r)) {
        // The user-owned `title` key is untouched.
        assert.ok(r.value.includes('title: My Feature'));
      }
    });

    it('aborts with key-not-found when the managed key is absent', () => {
      const r = writeFrontmatterKey(LEGACY_SPEC, 'pr', '42');
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
