import * as assert from 'assert';
import {
  AntigravityAdapter,
  ANTIGRAVITY_PLAN_MODE,
  ANTIGRAVITY_ACCEPT_EDITS_MODE,
  ANTIGRAVITY_MODELS,
  antigravityModeFlags,
  antigravityModelFlags,
} from '../src/adapter/antigravity';
import type { LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY, AdapterLaunchError } from '../src/adapter/adapter';
import { isReadOnlyRole } from '../src/adapter/permissions';
import { ROLES } from '../src/model/role';

/**
 * This file mirrors test/adapter.claude.test.ts for the antigravity (`agy`)
 * CLI and pins:
 *
 * - the probe `{version, ok, reason?}` contract, including the non-empty
 *   reason on failure (Req 14.2-14.4);
 * - the fresh vs `--conversation <id>` vs `-c` launch branches (Req 3.1, 3.2,
 *   13.2, 13.3);
 * - attach()'s no-prompt reopen (Req 3.3, 3.4);
 * - the `--mode plan|accept-edits` per-role permission mapping and the
 *   per-run `--add-dir` grant that agy — unlike opencode — does support
 *   (Req 15.1-15.4);
 * - one documented degrade: `req.sessionId` is ignored on a fresh launch.
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

describe('AntigravityAdapter probe shape (Req 14.2, 14.3, 14.4)', () => {
  it('reports ok:false with a non-empty reason and empty version when the CLI is missing', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const adapter = new AntigravityAdapter();
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
        (result.reason as string).includes(AGENT_BINARY.antigravity),
        `expected the reason to name the antigravity binary: ${JSON.stringify(result.reason)}`,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('returns a value conforming to the ProbeResult shape regardless of outcome', async () => {
    const adapter = new AntigravityAdapter();
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

describe('AntigravityAdapter launch session branches (Req 3.1, 3.2, 13.2, 13.3)', () => {
  const adapter = new AntigravityAdapter();

  it('fresh launch has no leading subcommand, starts at --model, and drops req.sessionId (Req 3.1)', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    // agy, not the agent id `antigravity`.
    assert.strictEqual(spec.shellPath, AGENT_BINARY.antigravity);
    assert.strictEqual(spec.shellArgs[0], '--model');
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--conversation'));
    assert.ok(!spec.shellArgs.includes('session-xyz'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
  });

  it('resume with a prior Session_Id leads --conversation <id> (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['--conversation', 'prior-session']);
    assert.ok(!spec.shellArgs.includes('-c'));
  });

  it('resume with no prior Session_Id falls back to -c (Req 3.2, 13.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.strictEqual(spec.shellArgs[0], '-c');
    assert.strictEqual(spec.shellArgs.filter((a) => a === '-c').length, 1);
    assert.ok(!spec.shellArgs.includes('--conversation'));
  });

  it('resume with an empty-string prior Session_Id behaves as no prior id', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: '' }));
    assert.strictEqual(spec.shellArgs[0], '-c');
    assert.ok(!spec.shellArgs.includes('--conversation'));
  });

  it('keeps the fresh and no-session-id-resume branches otherwise identical', () => {
    const fresh = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    const resumed = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    // Unlike claude/opencode, agy's fresh branch prepends nothing at all, so
    // the fresh array is compared whole against the resumed tail.
    assert.deepStrictEqual(fresh.shellArgs, resumed.shellArgs.slice(1));
  });

  it('passes an uncatalogued model through verbatim and appends --effort only when set', () => {
    const withEffort = adapter.launch(req({ effort: 'high' }));
    assert.ok(findPair(withEffort.shellArgs, '--model', 'sonnet') >= 0);
    assert.ok(findPair(withEffort.shellArgs, '--effort', 'high') >= 0);

    const withoutEffort = adapter.launch(req({ effort: undefined }));
    assert.ok(!withoutEffort.shellArgs.includes('--effort'));

    const withEmptyEffort = adapter.launch(req({ effort: '' }));
    assert.ok(!withEmptyEffort.shellArgs.includes('--effort'));
  });

  it('folds a bare Gemini family plus effort into the suffixed --model id (no --effort flag)', () => {
    const spec = adapter.launch(req({ model: 'gemini-3.8-flash', effort: 'medium' }));
    assert.ok(findPair(spec.shellArgs, '--model', 'gemini-3.8-flash-medium') >= 0);
    assert.ok(!spec.shellArgs.includes('--effort'));
    assert.ok(!spec.shellArgs.includes('gemini-3.8-flash'));
  });

  it('refuses a launch agy is known to reject, before building any argv', () => {
    assert.throws(
      () => adapter.launch(req({ model: 'gemini-3.1-pro', effort: 'medium' })),
      AdapterLaunchError,
    );
  });

  it('appends the prompt as the value of a trailing --prompt-interactive flag, with no -- separator', () => {
    const request = req();
    const spec = adapter.launch(request);
    const args = spec.shellArgs;
    assert.strictEqual(args[args.length - 1], request.prompt);
    assert.strictEqual(args[args.length - 2], '--prompt-interactive');
    assert.ok(!args.includes('--'));
  });
});

describe('AntigravityAdapter attach() (Req 3.3, 3.4)', () => {
  const adapter = new AntigravityAdapter();

  it('builds --conversation <id> --mode <mode> --add-dir <run-dir> with no prompt', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });

    assert.deepStrictEqual(spec.shellArgs, [
      '--conversation',
      'session-42',
      '--mode',
      ANTIGRAVITY_ACCEPT_EDITS_MODE,
      '--add-dir',
      '.baiton/runs/run-9/',
    ]);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.antigravity);

    assert.strictEqual(spec.shellArgs.length, 6);
    assert.ok(!spec.shellArgs.includes('--prompt-interactive'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('-c'));
  });

  it('uses the plan mode and run-dir grant for a read-only role', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--mode', ANTIGRAVITY_PLAN_MODE) >= 0);
    assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-1/') >= 0);
  });
});

describe('AntigravityAdapter role -> --mode permission mapping (Req 15.1-15.3)', () => {
  it('pins the mode constants', () => {
    assert.strictEqual(ANTIGRAVITY_PLAN_MODE, 'plan');
    assert.strictEqual(ANTIGRAVITY_ACCEPT_EDITS_MODE, 'accept-edits');
    // agy's hyphenated accept-edits is a DIFFERENT string from claude's
    // camelCase acceptEdits (permissions.ts's ACCEPT_EDITS_MODE); mixing them
    // up is the single most plausible copy-paste defect in this file.
    assert.notStrictEqual(ANTIGRAVITY_ACCEPT_EDITS_MODE, 'acceptEdits');
  });

  for (const role of ROLES) {
    it(`maps role ${role} to the expected --mode value for launch and attach`, () => {
      const expected = isReadOnlyRole(role) ? ANTIGRAVITY_PLAN_MODE : ANTIGRAVITY_ACCEPT_EDITS_MODE;

      const launchSpec = new AntigravityAdapter().launch(req({ role }));
      assert.ok(findPair(launchSpec.shellArgs, '--mode', expected) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--mode').length, 1);

      const attachSpec = new AntigravityAdapter().attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(findPair(attachSpec.shellArgs, '--mode', expected) >= 0);
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--mode').length, 1);
    });
  }

  it('antigravityModeFlags returns the plan mode for a read-only role', () => {
    assert.deepStrictEqual(antigravityModeFlags('planner'), ['--mode', ANTIGRAVITY_PLAN_MODE]);
  });

  it('antigravityModeFlags returns the accept-edits mode for the executor', () => {
    assert.deepStrictEqual(antigravityModeFlags('executor'), ['--mode', ANTIGRAVITY_ACCEPT_EDITS_MODE]);
  });

  // Unlike opencode, agy supports --add-dir, so Requirement 15.4's per-run
  // write scoping IS emitted here and must be asserted present, not absent.
  const forbidden = [
    '--dangerously-skip-permissions',
    '--allowedTools',
    '--permission-mode',
    '--agent',
    '--auto',
    '--sandbox',
  ];

  for (const role of ROLES) {
    it(`grants the per-run --add-dir and omits claude/opencode-only flags for role ${role} on launch`, () => {
      const spec = new AntigravityAdapter().launch(req({ role, runId: 'run-777' }));
      assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-777/') >= 0);
      for (const flag of forbidden) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });

    it(`grants the per-run --add-dir and omits claude/opencode-only flags for role ${role} on attach`, () => {
      const spec = new AntigravityAdapter().attach({ role, runId: 'run-777', sessionId: 's-1' });
      assert.ok(findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-777/') >= 0);
      for (const flag of forbidden) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });
  }
});

describe('antigravityModelFlags model-aware effort mapping (agy v1.2.2 catalogue)', () => {
  it('maps every catalogued Gemini family + each offered effort to the suffixed id', () => {
    for (const [family, efforts] of Object.entries(ANTIGRAVITY_MODELS)) {
      for (const effort of efforts) {
        assert.deepStrictEqual(antigravityModelFlags(family, effort), ['--model', `${family}-${effort}`]);
      }
    }
  });

  it('rejects a bare Gemini family with no effort, naming the options', () => {
    for (const effort of [undefined, '']) {
      assert.throws(
        () => antigravityModelFlags('gemini-3.8-flash', effort),
        (e: unknown) =>
          e instanceof AdapterLaunchError &&
          /requires an effort/.test(e.message) &&
          /low, medium, high/.test(e.message),
      );
    }
  });

  it('rejects an effort the family does not offer (gemini-3.1-pro has no medium)', () => {
    assert.throws(
      () => antigravityModelFlags('gemini-3.1-pro', 'medium'),
      (e: unknown) =>
        e instanceof AdapterLaunchError && /does not offer effort "medium"/.test(e.message),
    );
    assert.deepStrictEqual(antigravityModelFlags('gemini-3.1-pro', 'high'), ['--model', 'gemini-3.1-pro-high']);
  });

  it('passes an already-suffixed Gemini id through when the effort agrees or is unset', () => {
    assert.deepStrictEqual(antigravityModelFlags('gemini-3.8-flash-medium', 'medium'), ['--model', 'gemini-3.8-flash-medium']);
    assert.deepStrictEqual(antigravityModelFlags('gemini-3.8-flash-medium', undefined), ['--model', 'gemini-3.8-flash-medium']);
    assert.deepStrictEqual(antigravityModelFlags('gemini-3.8-flash-medium', ''), ['--model', 'gemini-3.8-flash-medium']);
  });

  it('rejects a suffixed Gemini id whose suffix contradicts the configured effort', () => {
    assert.throws(
      () => antigravityModelFlags('gemini-3.8-flash-medium', 'high'),
      (e: unknown) => e instanceof AdapterLaunchError && /conflicts/.test(e.message),
    );
  });

  it('drops the effort for fixed ids agy takes no --effort for (Claude, GPT-OSS)', () => {
    for (const fixed of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
      assert.deepStrictEqual(antigravityModelFlags(fixed, 'medium'), ['--model', fixed]);
      assert.deepStrictEqual(antigravityModelFlags(fixed, undefined), ['--model', fixed]);
    }
  });

  it('passes an uncatalogued id through verbatim with --effort so a newer agy can validate it', () => {
    assert.deepStrictEqual(antigravityModelFlags('gemini-4.0-ultra', 'high'), ['--model', 'gemini-4.0-ultra', '--effort', 'high']);
    assert.deepStrictEqual(antigravityModelFlags('gemini-4.0-ultra', undefined), ['--model', 'gemini-4.0-ultra']);
  });

  it('never emits --effort for a catalogued model', () => {
    for (const [family, efforts] of Object.entries(ANTIGRAVITY_MODELS)) {
      const probe = efforts.length > 0 ? efforts[0] : 'medium';
      assert.ok(!antigravityModelFlags(family, probe).includes('--effort'));
    }
  });
});
