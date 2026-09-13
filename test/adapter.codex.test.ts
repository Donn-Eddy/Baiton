import * as assert from 'assert';
import {
  CodexAdapter,
  CODEX_READ_ONLY_SANDBOX,
  CODEX_WORKSPACE_WRITE_SANDBOX,
  CODEX_ASK_FOR_APPROVAL,
  CODEX_EFFORT_CONFIG_KEY,
  codexPermissionFlags,
  codexEffortFlags,
} from '../src/adapter/codex';
import type { LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import { isReadOnlyRole } from '../src/adapter/permissions';
import { ROLES } from '../src/model/role';

/**
 * This file mirrors test/adapter.antigravity.test.ts (itself mirrored from
 * test/adapter.claude.test.ts) for the codex CLI and pins:
 *
 * - the probe `{version, ok, reason?}` contract, including the non-empty
 *   reason on failure (Req 14.2-14.4);
 * - the fresh vs `codex resume <id>` vs `codex resume --last` launch branches
 *   (Req 3.1, 3.2, 13.2, 13.3);
 * - attach()'s no-prompt reopen (Req 3.3, 3.4);
 * - the `--sandbox`/`--ask-for-approval` per-role permission mapping and the
 *   per-run `--add-dir` grant (Req 15.1-15.4);
 * - the codex-specific degrades: `req.sessionId` dropped on a fresh launch,
 *   the `--config model_reasoning_effort=<effort>` effort degrade, the
 *   interactive form (not `codex exec`), and the prompt dropped on the
 *   `resume --last` branch.
 */

/** Build a launch request with sensible defaults, overridable per test. */
function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    role: 'executor',
    model: 'sonnet',
    prompt: 'Read brief.md and do what it says.',
    runId: 'run-123',
    resume: false,
    sessionId: 'session-abc',
    ...overrides,
  };
}

/** Find the index of an adjacent (flag, value) pair, or -1 when absent. */
function findPair(args: string[], flag: string, value: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) {
      return i;
    }
  }
  return -1;
}

describe('CodexAdapter probe shape (Req 14.2, 14.3, 14.4)', () => {
  it('reports ok:false with a non-empty reason and empty version when the CLI is missing', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const adapter = new CodexAdapter();
      const result = await adapter.probe();

      assert.strictEqual(typeof result.version, 'string');
      assert.strictEqual(typeof result.ok, 'boolean');

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.version, '');

      assert.strictEqual(typeof result.reason, 'string');
      assert.ok(
        (result.reason as string).length > 0,
        `expected a non-empty reason, got ${JSON.stringify(result.reason)}`,
      );
      assert.ok(
        (result.reason as string).includes(AGENT_BINARY.codex),
        `expected the reason to name the codex binary: ${JSON.stringify(result.reason)}`,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // codex prints a prefixed version string (e.g. "codex-cli 0.154.0") and the
  // adapter keeps the whole trimmed stdout, so no format assertion is made
  // here beyond non-emptiness — asserting content would be machine-dependent.
  it('returns a value conforming to the ProbeResult shape regardless of outcome', async () => {
    const adapter = new CodexAdapter();
    const result = await adapter.probe();

    assert.strictEqual(typeof result.version, 'string');
    assert.strictEqual(typeof result.ok, 'boolean');
    if (result.ok) {
      assert.ok(result.version.length > 0);
      assert.strictEqual(result.reason, undefined);
    } else {
      assert.strictEqual(typeof result.reason, 'string');
      assert.ok((result.reason as string).length > 0);
    }
  });
});

describe('CodexAdapter launch session branches (Req 3.1, 3.2, 13.2, 13.3)', () => {
  const adapter = new CodexAdapter();

  it('fresh launch has no resume subcommand, starts at --model, and drops req.sessionId (Req 3.1)', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    assert.strictEqual(spec.shellPath, AGENT_BINARY.codex);
    assert.strictEqual(spec.shellArgs[0], '--model');
    assert.ok(!spec.shellArgs.includes('resume'));
    assert.ok(!spec.shellArgs.includes('--last'));
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--continue'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
    assert.ok(!spec.shellArgs.includes('exec'));
    assert.ok(!spec.shellArgs.includes('session-xyz'));
  });

  it('resume with a prior Session_Id leads `resume <id>` (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['resume', 'prior-session']);
    assert.ok(!spec.shellArgs.includes('--last'));
    assert.ok(!spec.shellArgs.includes('-c'));
  });

  it('resume with no prior Session_Id falls back to `resume --last` (Req 3.2, 13.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['resume', '--last']);
    assert.strictEqual(spec.shellArgs.filter((a) => a === 'resume').length, 1);
  });

  it('resume with an empty-string prior Session_Id behaves as no prior id', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: '' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['resume', '--last']);
  });

  it('keeps the fresh and resume-with-id tails otherwise identical', () => {
    const fresh = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    const resumedWithId = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(fresh.shellArgs, resumedWithId.shellArgs.slice(2));
  });

  it('appends the prompt after a defensive `--` separator on fresh and resume-with-id launches', () => {
    const request = req();
    const fresh = adapter.launch(request);
    assert.deepStrictEqual(fresh.shellArgs.slice(-2), ['--', request.prompt]);

    const resumedWithId = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(resumedWithId.shellArgs.slice(-2), ['--', request.prompt]);
  });

  // A trailing positional after `resume --last` binds to SESSION_ID, not
  // PROMPT, so the adapter deliberately drops the prompt on this branch
  // rather than silently mistargeting a resume at a session that doesn't
  // exist.
  it('drops the prompt on the `resume --last` branch', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.ok(!spec.shellArgs.includes('--'));
    assert.ok(!spec.shellArgs.includes(req().prompt));
  });

  it('passes the model through verbatim and adds --config model_reasoning_effort=<effort> only when set', () => {
    const withEffort = adapter.launch(req({ effort: 'high' }));
    assert.ok(findPair(withEffort.shellArgs, '--model', 'sonnet') >= 0);
    assert.ok(findPair(withEffort.shellArgs, '--config', `${CODEX_EFFORT_CONFIG_KEY}=high`) >= 0);

    const withoutEffort = adapter.launch(req({ effort: undefined }));
    assert.ok(!withoutEffort.shellArgs.includes('--config'));

    const withEmptyEffort = adapter.launch(req({ effort: '' }));
    assert.ok(!withEmptyEffort.shellArgs.includes('--config'));
  });
});

describe('CodexAdapter attach() (Req 3.3, 3.4)', () => {
  const adapter = new CodexAdapter();

  it('builds resume <id> --sandbox <mode> --ask-for-approval on-request --add-dir <run-dir> with no prompt', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });

    assert.deepStrictEqual(spec.shellArgs, [
      'resume',
      'session-42',
      '--sandbox',
      CODEX_WORKSPACE_WRITE_SANDBOX,
      '--ask-for-approval',
      CODEX_ASK_FOR_APPROVAL,
      '--add-dir',
      '.baiton/runs/run-9/',
    ]);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.codex);
    assert.strictEqual(spec.shellArgs.length, 8);

    assert.ok(!spec.shellArgs.includes('--'));
    assert.ok(!spec.shellArgs.includes('Read brief.md and do what it says.'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('--config'));
    assert.ok(!spec.shellArgs.includes('--last'));
    assert.ok(!spec.shellArgs.includes('-c'));
  });

  it('uses the read-only sandbox and run-dir grant for a read-only role', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--sandbox', CODEX_READ_ONLY_SANDBOX) >= 0);
    assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-1/') >= 0);
  });
});

describe('CodexAdapter role -> sandbox/approval permission mapping (Req 15.1-15.4)', () => {
  it('pins the sandbox/approval/config constants', () => {
    assert.strictEqual(CODEX_READ_ONLY_SANDBOX, 'read-only');
    assert.strictEqual(CODEX_WORKSPACE_WRITE_SANDBOX, 'workspace-write');
    assert.strictEqual(CODEX_ASK_FOR_APPROVAL, 'on-request');
    assert.strictEqual(CODEX_EFFORT_CONFIG_KEY, 'model_reasoning_effort');

    // Copy-paste defects this file exists to catch.
    assert.notStrictEqual(CODEX_READ_ONLY_SANDBOX, 'danger-full-access');
    assert.notStrictEqual(CODEX_WORKSPACE_WRITE_SANDBOX, 'danger-full-access');
    assert.notStrictEqual(CODEX_WORKSPACE_WRITE_SANDBOX, 'acceptEdits');
    assert.notStrictEqual(CODEX_WORKSPACE_WRITE_SANDBOX, 'accept-edits');
  });

  for (const role of ROLES) {
    it(`maps role ${role} to the expected --sandbox/--ask-for-approval values for launch and attach`, () => {
      const expectedSandbox = isReadOnlyRole(role) ? CODEX_READ_ONLY_SANDBOX : CODEX_WORKSPACE_WRITE_SANDBOX;

      const launchSpec = new CodexAdapter().launch(req({ role }));
      assert.ok(findPair(launchSpec.shellArgs, '--sandbox', expectedSandbox) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--sandbox').length, 1);
      // codex differs from claude/agy: the approval flag is role-independent.
      assert.ok(findPair(launchSpec.shellArgs, '--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--ask-for-approval').length, 1);

      const attachSpec = new CodexAdapter().attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(findPair(attachSpec.shellArgs, '--sandbox', expectedSandbox) >= 0);
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--sandbox').length, 1);
      assert.ok(findPair(attachSpec.shellArgs, '--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0);
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--ask-for-approval').length, 1);
    });
  }

  it('codexPermissionFlags returns the read-only sandbox flags for planner', () => {
    assert.deepStrictEqual(codexPermissionFlags('planner'), [
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('codexPermissionFlags returns the workspace-write sandbox flags for executor', () => {
    assert.deepStrictEqual(codexPermissionFlags('executor'), [
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('codexEffortFlags builds the --config pair when effort is set, and [] otherwise', () => {
    assert.deepStrictEqual(codexEffortFlags('medium'), ['--config', 'model_reasoning_effort=medium']);
    assert.deepStrictEqual(codexEffortFlags(undefined), []);
    assert.deepStrictEqual(codexEffortFlags(''), []);
  });

  const forbiddenFlags = [
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--approve-for-me',
    '--permission-mode',
    '--allowedTools',
    '--mode',
    '--agent',
    '--auto',
    '--dangerously-skip-permissions',
    '--prompt-interactive',
    '--variant',
    '--effort',
  ];
  const forbiddenValues = ['danger-full-access', 'never'];

  for (const role of ROLES) {
    it(`grants the per-run --add-dir and omits forbidden flags/values for role ${role} on launch`, () => {
      const spec = new CodexAdapter().launch(req({ role, runId: 'run-777' }));
      assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-777/') >= 0);
      for (const flag of forbiddenFlags) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
      for (const value of forbiddenValues) {
        assert.ok(!spec.shellArgs.includes(value), `did not expect ${value} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });

    it(`grants the per-run --add-dir and omits forbidden flags/values for role ${role} on attach`, () => {
      const spec = new CodexAdapter().attach({ role, runId: 'run-777', sessionId: 's-1' });
      assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-777/') >= 0);
      for (const flag of forbiddenFlags) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
      for (const value of forbiddenValues) {
        assert.ok(!spec.shellArgs.includes(value), `did not expect ${value} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });
  }
});
