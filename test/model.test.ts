import * as assert from 'assert';
import {
  ok,
  err,
  isOk,
  isErr,
  TODO_STATES,
  isTodoState,
  STAGES,
  isStage,
  ROLES,
  isRole,
  MANAGED_KEYS,
  isManagedKey,
} from '../src/model';

describe('shared types', () => {
  describe('Result', () => {
    it('constructs and narrows a success result', () => {
      const r = ok<number, string>(42);
      assert.strictEqual(isOk(r), true);
      assert.strictEqual(isErr(r), false);
      if (isOk(r)) {
        assert.strictEqual(r.value, 42);
      }
    });

    it('constructs and narrows a failure result', () => {
      const r = err<string, number>('boom');
      assert.strictEqual(isErr(r), true);
      assert.strictEqual(isOk(r), false);
      if (isErr(r)) {
        assert.strictEqual(r.error, 'boom');
      }
    });
  });

  describe('TodoState', () => {
    it('recognizes every known state', () => {
      for (const s of TODO_STATES) {
        assert.strictEqual(isTodoState(s), true);
      }
    });

    it('rejects an unknown state', () => {
      assert.strictEqual(isTodoState('bogus'), false);
    });
  });

  describe('Stage', () => {
    it('recognizes every known stage', () => {
      for (const s of STAGES) {
        assert.strictEqual(isStage(s), true);
      }
    });

    it('rejects an unknown stage', () => {
      assert.strictEqual(isStage('deploy'), false);
    });
  });

  describe('Role', () => {
    it('recognizes every known role', () => {
      for (const r of ROLES) {
        assert.strictEqual(isRole(r), true);
      }
    });

    it('rejects an unknown role', () => {
      assert.strictEqual(isRole('admin'), false);
    });
  });

  describe('ManagedKey', () => {
    it('recognizes every managed key', () => {
      for (const k of MANAGED_KEYS) {
        assert.strictEqual(isManagedKey(k), true);
      }
    });

    it('rejects a non-managed key', () => {
      assert.strictEqual(isManagedKey('name'), false);
    });
  });
});
