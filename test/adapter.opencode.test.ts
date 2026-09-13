import * as assert from 'assert';
import { OpencodeAdapter, OPENCODE_PLAN_AGENT, OPENCODE_BUILD_AGENT, opencodeAgentFlags } from '../src/adapter/opencode';
import type { LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import { isReadOnlyRole } from '../src/adapter/permissions';
import { ROLES } from '../src/model/role';

/**
 * This file mirrors test/adapter.claude.test.ts for the opencode CLI and pins:
 *
 * - the probe `{version, ok, reason?}` contract, including the non-empty
 *   reason on failure (Req 14.2-14.4);
 * - the fresh-vs-resume `-s`/`-c` branches behind the leading `run` subcommand
 *   (Req 13.2, 13.3);
 * - attach()'s no-prompt reopen (Req 3.3, 3.4);
 * - two documented degrades from the claude adapter: no run-dir grant (no
 *   `--add-dir`, Req 15.4 is unenforceable here) and `req.sessionId` being
 *   ignored on a fresh launch.
 */

/** Build a launch request with sensible defaults, overridable per test. */
function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    role: 'executor',
    model: 'anthropic/claude-sonnet-5',
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

describe('OpencodeAdapter probe shape (Req 14.2, 14.3, 14.4)', () => {
  it('reports ok:false with a non-empty reason and empty version when the CLI is missing', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const adapter = new OpencodeAdapter();
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
        (result.reason as string).includes(AGENT_BINARY.opencode),
        `expected the reason to name the opencode binary: ${JSON.stringify(result.reason)}`,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('returns a value conforming to the ProbeResult shape regardless of outcome', async () => {
    const adapter = new OpencodeAdapter();
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

describe('OpencodeAdapter launch session branches (Req 3.1, 3.2, 13.2, 13.3)', () => {
  const adapter = new OpencodeAdapter();

  it('fresh launch leads with run, has no -s/-c, and drops req.sessionId (Req 3.1)', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    assert.strictEqual(spec.shellPath, AGENT_BINARY.opencode);
    assert.strictEqual(spec.shellArgs[0], 'run');
    assert.ok(!spec.shellArgs.includes('-s'));
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('session-xyz'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
  });

  it('resume with a prior Session_Id leads run -s <id> (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 3), ['run', '-s', 'prior-session']);
    assert.ok(!spec.shellArgs.includes('-c'));
  });

  it('resume with no prior Session_Id falls back to run -c (Req 3.2, 13.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['run', '-c']);
    assert.strictEqual(spec.shellArgs.filter((a) => a === '-c').length, 1);
    assert.ok(!spec.shellArgs.includes('-s'));
  });

  it('resume with an empty-string prior Session_Id behaves as no prior id', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: '' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['run', '-c']);
  });

  it('keeps the fresh and no-session-id-resume branches otherwise identical', () => {
    const fresh = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    const resumed = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.deepStrictEqual(fresh.shellArgs.slice(1), resumed.shellArgs.slice(2));
  });

  it('passes the model through verbatim and appends --variant only when effort is set', () => {
    const withEffort = adapter.launch(req({ effort: 'high' }));
    assert.ok(findPair(withEffort.shellArgs, '-m', 'anthropic/claude-sonnet-5') >= 0);
    assert.ok(findPair(withEffort.shellArgs, '--variant', 'high') >= 0);

    const withoutEffort = adapter.launch(req({ effort: undefined }));
    assert.ok(!withoutEffort.shellArgs.includes('--variant'));
  });

  it('appends the prompt as a bare trailing positional behind -i, with no -- separator', () => {
    const request = req();
    const spec = adapter.launch(request);
    const args = spec.shellArgs;
    assert.strictEqual(args[args.length - 1], request.prompt);
    assert.strictEqual(args[args.length - 2], '-i');
    assert.ok(!args.includes('--'));
  });
});

describe('OpencodeAdapter attach() (Req 3.3, 3.4)', () => {
  const adapter = new OpencodeAdapter();

  it('builds run -s <id> --agent <profile> -i with no prompt, model, or run id', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });

    assert.deepStrictEqual(spec.shellArgs, ['run', '-s', 'session-42', '--agent', OPENCODE_BUILD_AGENT, '-i']);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.opencode);

    assert.strictEqual(spec.shellArgs.length, 6);
    assert.ok(!spec.shellArgs.includes('-m'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('run-9'));
    assert.ok(!spec.shellArgs.includes('--add-dir'));
  });

  it('uses the plan profile for a read-only role', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--agent', OPENCODE_PLAN_AGENT) >= 0);
  });
});

describe('OpencodeAdapter role -> --agent profile mapping', () => {
  const adapter = new OpencodeAdapter();

  it('pins the profile constants', () => {
    assert.strictEqual(OPENCODE_PLAN_AGENT, 'plan');
    assert.strictEqual(OPENCODE_BUILD_AGENT, 'build');
  });

  for (const role of ROLES) {
    it(`maps role ${role} to the expected --agent profile for launch and attach`, () => {
      const expected = isReadOnlyRole(role) ? OPENCODE_PLAN_AGENT : OPENCODE_BUILD_AGENT;

      const launchSpec = adapter.launch(req({ role }));
      assert.ok(findPair(launchSpec.shellArgs, '--agent', expected) >= 0);

      const attachSpec = adapter.attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(findPair(attachSpec.shellArgs, '--agent', expected) >= 0);
    });
  }

  it('opencodeAgentFlags returns the plan profile for a read-only role', () => {
    assert.deepStrictEqual(opencodeAgentFlags('planner'), ['--agent', OPENCODE_PLAN_AGENT]);
  });

  it('opencodeAgentFlags returns the build profile for the executor', () => {
    assert.deepStrictEqual(opencodeAgentFlags('executor'), ['--agent', OPENCODE_BUILD_AGENT]);
  });
});

// opencode has no `--add-dir` flag and no granular allow-list, so Requirement
// 15.4's per-run write scoping is UNENFORCED for opencode roles and is
// conveyed only by the brief. This block asserts today's true behaviour so
// the gap stays visible; update it (do not delete it) if opencode ever gains
// the flag.
describe('OpencodeAdapter documented degrades (no run-dir grant, no claude permission flags)', () => {
  const adapter = new OpencodeAdapter();
  const forbidden = ['--add-dir', '.baiton/runs/run-777/', '--allowedTools', '--permission-mode', '--auto'];

  for (const role of ROLES) {
    it(`omits claude-only permission flags for role ${role} on launch`, () => {
      const spec = adapter.launch(req({ role, runId: 'run-777' }));
      for (const flag of forbidden) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });

    it(`omits claude-only permission flags for role ${role} on attach`, () => {
      const spec = adapter.attach({ role, runId: 'run-777', sessionId: 's-1' });
      for (const flag of forbidden) {
        assert.ok(!spec.shellArgs.includes(flag), `did not expect ${flag} in ${JSON.stringify(spec.shellArgs)}`);
      }
    });
  }
});
