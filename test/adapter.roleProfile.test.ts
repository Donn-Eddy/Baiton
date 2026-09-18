import * as assert from 'assert';
import {
  ROLE_PROFILES,
  RESULT_FILE_SENTENCE,
  roleProfile,
  runDirPattern,
} from '../src/adapter/roleProfile';
import { isReadOnlyRole, READ_ONLY_ROLES } from '../src/adapter/permissions';
import { ROLES, Role } from '../src/model/role';

/**
 * The role-profile table is the single source of truth every adapter
 * translates, so a defect here is a defect in all four adapters at once. This
 * file pins the table's invariants rather than its prose: the naming scheme,
 * which roles have shell and workspace write, the shared result-file sentence,
 * and — the one that is easy to break silently — that deriving
 * `isReadOnlyRole` from the table still yields exactly the historical set.
 */

describe('RoleProfile table completeness and naming (Decision 4)', () => {
  it('defines a profile for every role, keyed by that role', () => {
    for (const role of ROLES) {
      const profile = roleProfile(role);
      assert.ok(profile, `no profile for role ${role}`);
      assert.strictEqual(profile.role, role, `profile for ${role} is self-inconsistent`);
    }
    assert.deepStrictEqual(Object.keys(ROLE_PROFILES).sort(), [...ROLES].sort());
  });

  it('names every agent baiton-<role>', () => {
    for (const role of ROLES) {
      assert.strictEqual(roleProfile(role).agentName, `baiton-${role}`);
    }
  });

  it('gives every profile a non-empty, distinct description', () => {
    const seen = new Set<string>();
    for (const role of ROLES) {
      const { description } = roleProfile(role);
      assert.ok(description.length > 0, `role ${role} has no description`);
      assert.ok(!seen.has(description), `duplicate description: ${description}`);
      seen.add(description);
    }
  });
});

describe('RoleProfile capability table (Decision 1)', () => {
  it('gives exactly the executor workspace write scope', () => {
    const workspace = ROLES.filter((r) => roleProfile(r).write === 'workspace');
    assert.deepStrictEqual(workspace, ['executor' as Role]);
  });

  it('gives exactly the executor and the reviewer shell', () => {
    const withShell = ROLES.filter((r) => roleProfile(r).shell);
    assert.deepStrictEqual([...withShell].sort(), ['executor', 'reviewer']);
  });

  it('scopes every other role to its run dir with no shell', () => {
    for (const role of ['spec-writer', 'planner', 'plan-reviewer', 'pr-writer'] as Role[]) {
      const profile = roleProfile(role);
      assert.strictEqual(profile.write, 'run-dir', `${role} must be run-dir scoped`);
      assert.strictEqual(profile.shell, false, `${role} must not have shell`);
    }
  });
});

describe('RoleProfile system prompts', () => {
  it('ends every system prompt with the shared result-file sentence', () => {
    for (const role of ROLES) {
      const { systemPrompt } = roleProfile(role);
      assert.ok(
        systemPrompt.endsWith(RESULT_FILE_SENTENCE),
        `role ${role}'s prompt does not end with RESULT_FILE_SENTENCE: ${systemPrompt}`,
      );
      // The sentence is appended, not the whole prompt.
      assert.ok(systemPrompt.length > RESULT_FILE_SENTENCE.length, `role ${role} has no role fragment`);
    }
  });

  it('names Baiton and the role in every prompt fragment', () => {
    for (const role of ROLES) {
      assert.ok(roleProfile(role).systemPrompt.startsWith("You are Baiton's "), `role ${role}`);
    }
  });

  it('states the no-shell rule for exactly the roles without shell', () => {
    for (const role of ROLES) {
      const profile = roleProfile(role);
      const saysNoShell = profile.systemPrompt.includes('must not run shell commands');
      assert.strictEqual(
        saysNoShell,
        !profile.shell,
        `role ${role}: prompt and shell bit disagree`,
      );
    }
  });

  it('keeps the executor no-git rule in the executor prompt (Req 17.5)', () => {
    assert.ok(roleProfile('executor').systemPrompt.includes('Do not commit, stash, or change branches'));
  });
});

describe('isReadOnlyRole derived from the profile table', () => {
  it('matches the historical read-only set exactly', () => {
    assert.deepStrictEqual([...READ_ONLY_ROLES].sort(), [
      'plan-reviewer',
      'planner',
      'pr-writer',
      'spec-writer',
    ]);
  });

  it('is write === run-dir && shell === false for every role', () => {
    for (const role of ROLES) {
      const profile = roleProfile(role);
      assert.strictEqual(
        isReadOnlyRole(role),
        profile.write === 'run-dir' && profile.shell === false,
        `isReadOnlyRole(${role}) diverged from the profile`,
      );
    }
  });

  it('excludes the reviewer, which is run-dir scoped but has shell', () => {
    assert.strictEqual(isReadOnlyRole('reviewer'), false);
    assert.strictEqual(roleProfile('reviewer').write, 'run-dir');
  });

  it('excludes the executor', () => {
    assert.strictEqual(isReadOnlyRole('executor'), false);
  });
});

describe('runDirPattern', () => {
  it('builds the workspace-relative run dir with a trailing slash', () => {
    assert.strictEqual(runDirPattern('run-123'), '.baiton/runs/run-123/');
  });

  it('is relative, carries the run id verbatim, and is pure', () => {
    const pattern = runDirPattern('abc');
    assert.ok(!pattern.startsWith('/'), `expected a relative pattern, got ${pattern}`);
    assert.ok(pattern.includes('abc'));
    assert.strictEqual(runDirPattern('abc'), pattern);
    assert.notStrictEqual(runDirPattern('def'), pattern);
  });
});
