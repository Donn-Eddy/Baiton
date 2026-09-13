import * as assert from 'assert';
import {
  OpencodeAdapter,
  OPENCODE_CONFIG_ENV,
  opencodeAgentFlags,
  opencodeConfigEnv,
} from '../src/adapter/opencode';
import type { OpencodeAgentDefinition } from '../src/adapter/opencode';
import type { LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import { roleProfile } from '../src/adapter/roleProfile';
import { ROLES } from '../src/model/role';

/**
 * This file mirrors test/adapter.claude.test.ts for the opencode CLI and pins:
 *
 * - the probe `{version, ok, reason?}` contract, including the non-empty
 *   reason on failure (Req 14.2-14.4);
 * - the fresh-vs-resume `-s`/`-c` branches behind the leading `run` subcommand
 *   (Req 13.2, 13.3);
 * - attach()'s no-prompt reopen (Req 3.3, 3.4);
 * - the whole per-role policy (Req 15.1-15.4), which opencode gets as an
 *   inline `OPENCODE_CONFIG_CONTENT` env layer defining one Baiton-owned
 *   custom agent rather than as command-line flags;
 * - the one remaining documented degrade from the claude adapter:
 *   `req.sessionId` is ignored on a fresh launch.
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

  it('builds run -s <id> --agent baiton-<role> -i with no prompt, model, or run id', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });

    assert.deepStrictEqual(spec.shellArgs, ['run', '-s', 'session-42', '--agent', 'baiton-executor', '-i']);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.opencode);

    assert.strictEqual(spec.shellArgs.length, 6);
    assert.ok(!spec.shellArgs.includes('-m'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('run-9'));
    assert.ok(!spec.shellArgs.includes('--add-dir'));
  });

  it('uses the role-specific Baiton agent for a read-only role', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--agent', 'baiton-planner') >= 0);
  });
});

describe('OpencodeAdapter role -> --agent baiton-<role> mapping (Decision 4)', () => {
  const adapter = new OpencodeAdapter();

  // opencode's built-in `plan` agent is never used: `plan` is a NAME its
  // SessionReminders keys on to inject an unconditional read-only reminder
  // (v1.18.30 session/reminders.ts, `agent.name === "plan"`), which overrode
  // the run-dir write grant and stopped the planner writing result.json. Every
  // Baiton agent name is prefixed so it can never match that condition.
  it('never names opencode built-in profiles', () => {
    for (const role of ROLES) {
      const flags = opencodeAgentFlags(role);
      assert.strictEqual(flags[0], '--agent');
      assert.notStrictEqual(flags[1], 'plan');
      assert.notStrictEqual(flags[1], 'build');
      assert.ok(flags[1].startsWith('baiton-'), `agent name must be Baiton-owned: ${flags[1]}`);
    }
  });

  for (const role of ROLES) {
    it(`maps role ${role} to --agent ${roleProfile(role).agentName} on launch and attach`, () => {
      const expected = roleProfile(role).agentName;
      assert.deepStrictEqual(opencodeAgentFlags(role), ['--agent', expected]);

      const launchSpec = adapter.launch(req({ role }));
      assert.ok(findPair(launchSpec.shellArgs, '--agent', expected) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--agent').length, 1);

      const attachSpec = adapter.attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(findPair(attachSpec.shellArgs, '--agent', expected) >= 0);
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--agent').length, 1);
    });
  }
});

/** Parse the single custom agent out of a spec's `OPENCODE_CONFIG_CONTENT`. */
function agentDefinition(
  env: Record<string, string> | undefined,
  agentName: string,
): OpencodeAgentDefinition {
  assert.ok(env !== undefined, 'expected an env on the LaunchSpec');
  const parsed = JSON.parse((env as Record<string, string>)[OPENCODE_CONFIG_ENV]) as {
    agent: Record<string, OpencodeAgentDefinition>;
  };
  assert.deepStrictEqual(
    Object.keys(parsed.agent),
    [agentName],
    'exactly one agent must be defined, keyed by the profile agent name',
  );
  return parsed.agent[agentName];
}

describe('OpencodeAdapter custom-agent config via OPENCODE_CONFIG_CONTENT (Req 15.1-15.4)', () => {
  const adapter = new OpencodeAdapter();

  for (const role of ROLES) {
    it(`launch() for role ${role} defines one agent carrying the profile prompt and description`, () => {
      const profile = roleProfile(role);
      const spec = adapter.launch(req({ role, runId: 'run-777' }));

      assert.ok(spec.env !== undefined);
      assert.deepStrictEqual(Object.keys(spec.env as Record<string, string>), [OPENCODE_CONFIG_ENV]);

      const agent = agentDefinition(spec.env, profile.agentName);
      assert.strictEqual(agent.prompt, profile.systemPrompt);
      assert.strictEqual(agent.description, profile.description);
      assert.strictEqual(agent.mode, 'primary');
    });

    it(`launch() for role ${role} translates the profile's edit and bash rules`, () => {
      const profile = roleProfile(role);
      const spec = adapter.launch(req({ role, runId: 'run-777' }));
      const agent = agentDefinition(spec.env, profile.agentName);

      if (profile.write === 'workspace') {
        assert.deepStrictEqual(agent.permission.edit, { '*': 'allow' });
      } else {
        // Deny everything, then re-allow the run dir; the more specific glob wins.
        assert.deepStrictEqual(agent.permission.edit, {
          '*': 'deny',
          '.baiton/runs/run-777/*': 'allow',
        });
      }

      if (profile.shell) {
        // No bash block at all: opencode's own default (allow) applies.
        assert.strictEqual(agent.permission.bash, undefined, `role ${role} must not pin bash`);
      } else {
        assert.deepStrictEqual(agent.permission.bash, { '*': 'deny' });
      }
    });
  }

  it('attach() emits exactly the same config as launch() for the same role and run', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-777', sessionId: 's-1' });
    assert.deepStrictEqual(spec.env, adapter.launch(req({ role: 'planner', runId: 'run-777' })).env);
  });

  it('uses a workspace-relative run-dir pattern containing the run id verbatim', () => {
    const agent = agentDefinition(opencodeConfigEnv('planner', 'run-abc'), 'baiton-planner');
    const pattern = Object.keys(agent.permission.edit).filter((k) => k !== '*')[0];
    assert.ok(!pattern.startsWith('/'), `expected a relative pattern, got ${pattern}`);
    assert.ok(pattern.includes('run-abc'));
    assert.strictEqual(pattern, '.baiton/runs/run-abc/*');
  });

  it('pins the env var name and the full config shape for the planner', () => {
    assert.strictEqual(OPENCODE_CONFIG_ENV, 'OPENCODE_CONFIG_CONTENT');
    assert.deepStrictEqual(JSON.parse(opencodeConfigEnv('planner', 'r1')[OPENCODE_CONFIG_ENV]), {
      agent: {
        'baiton-planner': {
          description: roleProfile('planner').description,
          mode: 'primary',
          prompt: roleProfile('planner').systemPrompt,
          permission: {
            edit: { '*': 'deny', '.baiton/runs/r1/*': 'allow' },
            bash: { '*': 'deny' },
          },
        },
      },
    });
  });

  it('is pure: same inputs deep-equal, different run ids differ', () => {
    assert.deepStrictEqual(opencodeConfigEnv('planner', 'run-1'), opencodeConfigEnv('planner', 'run-1'));
    assert.notDeepStrictEqual(opencodeConfigEnv('planner', 'run-1'), opencodeConfigEnv('planner', 'run-2'));
    assert.notDeepStrictEqual(opencodeConfigEnv('planner', 'run-1'), opencodeConfigEnv('executor', 'run-1'));
  });
});

// The per-role policy reaches opencode through the environment (see the block
// above), never through claude's command-line permission flags. This block
// asserts that the argv stays free of those flags and of `--auto`, which would
// auto-approve everything rather than scope to the run dir.
describe('OpencodeAdapter documented degrades (no claude permission flags, no --auto)', () => {
  const adapter = new OpencodeAdapter();
  const forbidden = [
    '--add-dir',
    '.baiton/runs/run-777/',
    '--allowedTools',
    '--permission-mode',
    '--append-system-prompt',
    '--auto',
  ];

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
