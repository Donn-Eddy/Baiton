import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  OpencodeAdapter,
  OPENCODE_CONFIG_ENV,
  OPENCODE_MODELS_ARGS,
  OPENCODE_SERVER_ENV_VAR,
  isOpencodeSessionId,
  mergeOpencodeModelSources,
  opencodeAgentFlags,
  opencodeConfigEnv,
  opencodeModelsFromApi,
  opencodeModelsFromCliOutput,
  opencodeModelsFromVerboseOutput,
  parseOpencodeServerUrl,
} from '../src/adapter/opencode';
import type {
  OpencodeAdapterOptions,
  OpencodeAgentDefinition,
  OpencodeModelsCli,
  OpencodeServerStarter,
} from '../src/adapter/opencode';
import type { AskRelayDescriptor, DiscoveryContext, LaunchRequest } from '../src/adapter/adapter';
import {
  AGENT_BINARY,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  capabilitiesToCatalogFetch,
} from '../src/adapter/adapter';
import type { FeedFetch, FeedResponse } from '../src/orchestrator/modelsDev';
import { createApiLog } from '../src/orchestrator/apiLog';
import type { ApiFailureEntry, ApiLog } from '../src/orchestrator/apiLog';
import { roleProfile } from '../src/adapter/roleProfile';
import { ROLES } from '../src/model/role';
import { askRelayDescriptor } from '../src/engine/askRelay';

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
 * - the session-id mapping: opencode mints its own `ses_…` ids, so a fresh
 *   launch tags the session with Baiton's Session_Id via `--title`,
 *   `resolveSessionId()` maps that title back to the minted id, and `-s` is
 *   never given an unresolved Baiton id (opencode exits 1 with "Session not
 *   found" on one, which is what broke every execute retry).
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

  it('fresh launch leads with run, has no -s/-c, and carries req.sessionId as --title (Req 3.1)', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    assert.strictEqual(spec.shellPath, AGENT_BINARY.opencode);
    assert.strictEqual(spec.shellArgs[0], 'run');
    assert.ok(!spec.shellArgs.includes('-s'));
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
    assert.ok(findPair(spec.shellArgs, '--title', 'session-xyz') >= 0);
    assert.strictEqual(spec.shellArgs.filter((a) => a === '--title').length, 1);
  });

  it('fresh launch with an empty sessionId emits no --title', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: '' }));
    assert.ok(!spec.shellArgs.includes('--title'));
  });

  it('resume with a resolved opencode id leads run -s <id> and no --title (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'ses_prior' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 3), ['run', '-s', 'ses_prior']);
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--title'));
  });

  it('resume with an unresolved Baiton Session_Id falls back to run -c, never -s', () => {
    const spec = adapter.launch(
      req({ resume: true, resumeSessionId: 'd7dbb6f8-9168-4620-9e59-ddaa5bb15bd4' }),
    );
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['run', '-c']);
    assert.ok(!spec.shellArgs.includes('-s'));
    assert.ok(!spec.shellArgs.includes('d7dbb6f8-9168-4620-9e59-ddaa5bb15bd4'));
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
    // fresh: run --title <id> ...; resumed: run -c ...
    assert.deepStrictEqual(fresh.shellArgs.slice(3), resumed.shellArgs.slice(2));
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
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'ses_42' });

    assert.deepStrictEqual(spec.shellArgs, ['run', '-s', 'ses_42', '--agent', 'baiton-executor', '-i']);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.opencode);

    assert.strictEqual(spec.shellArgs.length, 6);
    assert.ok(!spec.shellArgs.includes('-m'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('run-9'));
    assert.ok(!spec.shellArgs.includes('--add-dir'));
  });

  it('uses the role-specific Baiton agent for a read-only role', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'ses_1' });
    assert.ok(findPair(spec.shellArgs, '--agent', 'baiton-planner') >= 0);
  });

  it('degrades an unresolved Baiton Session_Id to -c rather than emitting -s', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });
    assert.deepStrictEqual(spec.shellArgs, ['run', '-c', '--agent', 'baiton-executor', '-i']);
  });
});

describe('OpencodeAdapter resolveSessionId() (Baiton Session_Id -> opencode ses_ id)', () => {
  const rows = [
    { id: 'ses_aaa', title: 'Reading and executing brief.md instructions' },
    { id: 'ses_bbb', title: 'd7dbb6f8-9168-4620-9e59-ddaa5bb15bd4' },
  ];

  it('recognises opencode ids by their ses_ prefix', () => {
    assert.ok(isOpencodeSessionId('ses_f5fb5e0c5ffezf0xx6jW6VMFSr'));
    assert.ok(!isOpencodeSessionId('d7dbb6f8-9168-4620-9e59-ddaa5bb15bd4'));
    assert.ok(!isOpencodeSessionId(undefined));
    assert.ok(!isOpencodeSessionId(''));
  });

  it('maps a Baiton Session_Id to the id of the session titled with it, listing in the given cwd', async () => {
    const seen: string[] = [];
    const adapter = new OpencodeAdapter(async (cwd) => {
      seen.push(cwd);
      return rows;
    });
    const id = await adapter.resolveSessionId('d7dbb6f8-9168-4620-9e59-ddaa5bb15bd4', '/ws');
    assert.strictEqual(id, 'ses_bbb');
    assert.deepStrictEqual(seen, ['/ws']);
  });

  it('resolves undefined when no session carries the id', async () => {
    const adapter = new OpencodeAdapter(async () => rows);
    assert.strictEqual(await adapter.resolveSessionId('unknown-id', '/ws'), undefined);
  });

  it('returns an opencode id unchanged without listing', async () => {
    const adapter = new OpencodeAdapter(async () => {
      throw new Error('must not list');
    });
    assert.strictEqual(await adapter.resolveSessionId('ses_zzz', '/ws'), 'ses_zzz');
  });

  it('resolves undefined instead of throwing when the listing fails', async () => {
    const adapter = new OpencodeAdapter(async () => {
      throw new Error('opencode not found');
    });
    assert.strictEqual(await adapter.resolveSessionId('some-id', '/ws'), undefined);
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

/**
 * The probe recorded in README.md, "Harness ask relay (per-adapter probe
 * findings)" (opencode 1.18.30, 2026-09-20), found no relay this adapter can
 * install: the one surface that can intercept a tool call is a plugin's
 * `tool.execute.before` hook, and opencode loads plugins only from files
 * (`file://` path, npm module, or `.opencode/plugin/<name>.js`) — a `data:`
 * URL carrying the source inline is silently ignored. `launch()` is pure and
 * writes nothing, so no wiring is emitted and the generic fallback covers
 * opencode's asks.
 *
 * These tests pin that outcome rather than merely describing it: a future
 * native relay makes them fail, which forces the decision to be revisited
 * deliberately instead of drifting in.
 */
describe('OpencodeAdapter ask-relay wiring (probe findings)', () => {
  const adapter = new OpencodeAdapter();
  const relay = askRelayDescriptor('/repo', 'run-123');

  it('ignores the relay descriptor entirely: the whole launch spec is byte-identical', () => {
    // Decisive negative: opencode ships no native relay (README "Harness ask
    // relay (per-adapter probe findings)"; adapter doc comment, point 3).
    assert.deepStrictEqual(adapter.launch(req({ relay })), adapter.launch(req()));
  });

  it('treats an explicitly undefined relay the same as an absent one', () => {
    assert.deepStrictEqual(adapter.launch(req({ relay: undefined })), adapter.launch(req()));
  });

  it('never lets a relay reach the argv, and emits no forbidden flag', () => {
    const withRelay = adapter.launch(req({ relay }));
    assert.deepStrictEqual(withRelay.shellArgs, adapter.launch(req()).shellArgs);
    for (const flag of ['--add-dir', '--allowedTools', '--permission-mode', '--settings', '--auto']) {
      assert.ok(
        !withRelay.shellArgs.includes(flag),
        `did not expect ${flag} in ${JSON.stringify(withRelay.shellArgs)}`,
      );
    }
    const joined = withRelay.shellArgs.join(' ');
    assert.ok(!joined.includes(relay.dir), 'the asks directory must not leak into the argv');
    assert.ok(!joined.includes('plugin'), 'no plugin registration is emitted');
  });

  it('carries no relay in the env either: the config layer is unchanged', () => {
    assert.deepStrictEqual(
      adapter.launch(req({ relay })).env,
      opencodeConfigEnv('executor', 'run-123'),
    );
  });

  it('attach() installs no relay (it takes no descriptor at all)', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-777', sessionId: 'ses_1' });
    assert.deepStrictEqual(spec.env, opencodeConfigEnv('planner', 'run-777'));
  });

  for (const role of ROLES) {
    it(`leaves the baiton-${role} permission block untouched with a relay present`, () => {
      const withRelay = adapter.launch(req({ role, relay }));
      const without = adapter.launch(req({ role }));
      const agentName = roleProfile(role).agentName;
      assert.deepStrictEqual(
        agentDefinition(withRelay.env as Record<string, string>, agentName).permission,
        agentDefinition(without.env as Record<string, string>, agentName).permission,
      );
    });
  }

  it('is unaffected by an unknown protocol, exactly as it is by file-v1', () => {
    const future = { ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor;
    assert.deepStrictEqual(adapter.launch(req({ relay: future })), adapter.launch(req()));
  });
});

/**
 * Model discovery (model-selector-refresh T06). The parsers are pure, so they
 * are pinned directly; `discoverModels` is driven through the three injected
 * seams (`startServer`, `fetchModels`, `runModelsCli`) so no `opencode serve`
 * child is ever spawned and no socket is ever opened by this file.
 */
describe('opencodeModelsFromApi (model-selector-refresh T06)', () => {
  it('reads a bare array of strings', () => {
    assert.deepStrictEqual(opencodeModelsFromApi(['anthropic/claude-sonnet-5', 'openai/gpt-6']), [
      { id: 'anthropic/claude-sonnet-5', provider: 'anthropic' },
      { id: 'openai/gpt-6', provider: 'openai' },
    ]);
  });

  it('reads a bare array of objects with id/name', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi([{ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }]),
      [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' }],
    );
  });

  it('reads a providers array of buckets and prefixes the provider id', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi({
        providers: [
          { id: 'anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
        ],
      }),
      [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' }],
    );
  });

  it('reads a `models` array and an `items` array', () => {
    assert.deepStrictEqual(opencodeModelsFromApi({ models: ['a/b'] }), [
      { id: 'a/b', provider: 'a' },
    ]);
    assert.deepStrictEqual(opencodeModelsFromApi({ items: ['c/d'] }), [
      { id: 'c/d', provider: 'c' },
    ]);
  });

  it('reads a provider-keyed map under `providers`, with models as an array', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi({ providers: { openai: { models: [{ id: 'gpt-6' }] } } }),
      [{ id: 'openai/gpt-6', provider: 'openai' }],
    );
  });

  it('reads a provider-keyed map whose models are themselves a map keyed by model id', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi({
        providers: { openai: { models: { 'gpt-6': { name: 'GPT-6' } } } },
      }),
      [{ id: 'openai/gpt-6', label: 'GPT-6', provider: 'openai' }],
    );
  });

  it('reads a provider-keyed map at the top level (no providers wrapper)', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi({
        anthropic: { models: { 'claude-sonnet-5': {} } },
        openai: { models: ['gpt-6'] },
      }),
      [
        { id: 'anthropic/claude-sonnet-5', provider: 'anthropic' },
        { id: 'openai/gpt-6', provider: 'openai' },
      ],
    );
  });

  it('never double-prefixes an id that already contains a slash', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi({ providers: { openai: { models: ['openai/gpt-6'] } } }),
      [{ id: 'openai/gpt-6', provider: 'openai' }],
    );
  });

  it('omits a label equal to the emitted id', () => {
    assert.deepStrictEqual(opencodeModelsFromApi([{ id: 'a/b', name: 'a/b' }]), [
      { id: 'a/b', provider: 'a' },
    ]);
  });

  it('collapses duplicates first-wins and skips blank/idless items', () => {
    assert.deepStrictEqual(
      opencodeModelsFromApi([
        { id: 'a/b', name: 'First' },
        { id: 'a/b', name: 'Second' },
        '   ',
        {},
        42,
        null,
      ]),
      [{ id: 'a/b', label: 'First', provider: 'a' }],
    );
  });

  it('returns [] for every unrecognised payload', () => {
    for (const payload of [null, undefined, 42, 'gpt', {}, { models: 'nope' }, true]) {
      assert.deepStrictEqual(opencodeModelsFromApi(payload), []);
    }
  });

  it('never emits efforts or defaultEffort (opencode effort is free-text --variant)', () => {
    const entries = opencodeModelsFromApi({
      providers: { openai: { models: [{ id: 'gpt-6', supportedReasoningEfforts: ['low'] }] } },
    });
    assert.strictEqual(entries.length, 1);
    assert.ok(!('efforts' in entries[0]!));
    assert.ok(!('defaultEffort' in entries[0]!));
  });

  it('is pure: the input is untouched', () => {
    const payload = { providers: { openai: { models: [{ id: 'gpt-6', name: 'GPT-6' }] } } };
    const pristine = JSON.parse(JSON.stringify(payload));
    opencodeModelsFromApi(payload);
    assert.deepStrictEqual(payload, pristine);
  });
});

describe('opencodeModelsFromCliOutput (model-selector-refresh T06)', () => {
  it('reads a realistic multi-line listing in order', () => {
    const stdout = [
      'Available models:',
      '',
      '  anthropic/claude-sonnet-5   Claude Sonnet 5 (recommended)',
      '  \u001B[1manthropic/claude-opus-5\u001B[0m',
      '  * openai/gpt-6',
      '  • google/gemini-3-pro',
      '',
    ].join('\n');

    assert.deepStrictEqual(
      opencodeModelsFromCliOutput(stdout).map((entry) => entry.id),
      [
        'anthropic/claude-sonnet-5',
        'anthropic/claude-opus-5',
        'openai/gpt-6',
        'google/gemini-3-pro',
      ],
    );
  });

  it('sets provider from the id half before the slash', () => {
    assert.deepStrictEqual(opencodeModelsFromCliOutput('openai/gpt-6\n'), [
      { id: 'openai/gpt-6', provider: 'openai' },
    ]);
  });

  it('drops tokens that are not provider/model', () => {
    const stdout = ['Models', 'gpt-6', 'a/b/c', 'https://opencode.ai/docs', 'ok/fine'].join('\n');
    assert.deepStrictEqual(
      opencodeModelsFromCliOutput(stdout).map((entry) => entry.id),
      ['ok/fine'],
    );
  });

  it('collapses duplicates and returns [] for empty output', () => {
    assert.deepStrictEqual(
      opencodeModelsFromCliOutput('a/b\na/b\n').map((entry) => entry.id),
      ['a/b'],
    );
    assert.deepStrictEqual(opencodeModelsFromCliOutput(''), []);
  });
});

/** The checked-in `opencode models --verbose` listing both parser suites read. */
const VERBOSE_FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'opencodeModelsVerbose.sample.txt'),
  'utf8',
);

/** The fixture's ids in listing order (the duplicate collapses to one entry). */
const VERBOSE_IDS = [
  'anthropic/claude-sonnet-5',
  'openai/gpt-6',
  'google/gemini-3-pro',
  'zed/weird-1',
  'local/llama-4',
  'broken/model-1',
  'last/no-detail',
];

describe('opencodeModelsFromVerboseOutput (codex-opencode-dropdown-fix T03)', () => {
  const entries = opencodeModelsFromVerboseOutput(VERBOSE_FIXTURE);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  it('reads every id in listing order with its provider', () => {
    assert.deepStrictEqual(
      entries.map((entry) => entry.id),
      VERBOSE_IDS,
    );
    assert.deepStrictEqual(
      entries.map((entry) => entry.provider),
      ['anthropic', 'openai', 'google', 'zed', 'local', 'broken', 'last'],
    );
  });

  it('takes label from name, and omits it when name equals the bare model id', () => {
    assert.strictEqual(byId.get('anthropic/claude-sonnet-5')?.label, 'Claude Sonnet 5');
    assert.strictEqual(byId.get('openai/gpt-6')?.label, 'GPT-6');
    assert.ok(!('label' in (byId.get('local/llama-4') ?? {})));
  });

  it('turns the variants keys into per-model efforts, in object order', () => {
    assert.deepStrictEqual(byId.get('anthropic/claude-sonnet-5')?.efforts, ['low', 'high', 'max']);
    assert.deepStrictEqual(byId.get('google/gemini-3-pro')?.efforts, ['none', 'thinking']);
    assert.deepStrictEqual(byId.get('zed/weird-1')?.efforts, ['minimal']);
  });

  it('omits the efforts key entirely for {} variants, an unparseable block and a detail-less id', () => {
    for (const id of ['openai/gpt-6', 'local/llama-4', 'broken/model-1', 'last/no-detail']) {
      assert.ok(!('efforts' in (byId.get(id) ?? {})), `${id} must carry no efforts key`);
    }
  });

  it('degrades an unparseable block and a detail-less id to a plain { id, provider } entry', () => {
    assert.deepStrictEqual(byId.get('broken/model-1'), {
      id: 'broken/model-1',
      provider: 'broken',
    });
    assert.deepStrictEqual(byId.get('last/no-detail'), {
      id: 'last/no-detail',
      provider: 'last',
    });
  });

  it('never emits defaultEffort (opencode marks no default variant)', () => {
    for (const entry of entries) {
      assert.ok(!('defaultEffort' in entry), `${entry.id} must carry no defaultEffort`);
    }
  });

  it('parses a model whose name contains braces without swallowing the next entry', () => {
    assert.strictEqual(byId.get('zed/weird-1')?.label, 'Weird {model} name');
    // The entry after the brace-carrying one survived.
    assert.ok(byId.has('local/llama-4'));
  });

  it('keeps the first occurrence of a duplicate id', () => {
    assert.strictEqual(byId.get('openai/gpt-6')?.label, 'GPT-6');
    assert.strictEqual(entries.filter((entry) => entry.id === 'openai/gpt-6').length, 1);
  });

  it('returns [] for empty and prose-only input', () => {
    assert.deepStrictEqual(opencodeModelsFromVerboseOutput(''), []);
    assert.deepStrictEqual(
      opencodeModelsFromVerboseOutput('no models configured\nrun `opencode auth login`\n'),
      [],
    );
  });

  it('yields exactly the bare-listing parser ids on a listing with no JSON blocks', () => {
    const bare = [
      'Available models:',
      '',
      '  anthropic/claude-sonnet-5   Claude Sonnet 5 (recommended)',
      '  \u001B[1manthropic/claude-opus-5\u001B[0m',
      '  * openai/gpt-6',
      '  • google/gemini-3-pro',
      '',
    ].join('\n');

    assert.deepStrictEqual(
      opencodeModelsFromVerboseOutput(bare).map((entry) => entry.id),
      opencodeModelsFromCliOutput(bare).map((entry) => entry.id),
    );
    assert.deepStrictEqual(opencodeModelsFromVerboseOutput(bare), opencodeModelsFromCliOutput(bare));
  });
});

describe('mergeOpencodeModelSources (model-selector-refresh T06)', () => {
  const api = [{ id: 'a/b', label: 'A B' }, { id: 'c/d' }];
  const cli = [{ id: 'c/d', provider: 'c' }, { id: 'e/f', provider: 'e' }];

  it('keeps the API order first and appends only CLI-only ids', () => {
    assert.deepStrictEqual(mergeOpencodeModelSources(api, cli), [
      { id: 'a/b', label: 'A B' },
      { id: 'c/d' },
      { id: 'e/f', provider: 'e' },
    ]);
  });

  it('falls back to the CLI verbatim with no API entries', () => {
    assert.deepStrictEqual(mergeOpencodeModelSources([], cli), cli);
  });

  it('keeps the API verbatim with no CLI entries', () => {
    assert.deepStrictEqual(mergeOpencodeModelSources(api, []), api);
  });

  it('mutates neither input', () => {
    const apiCopy = JSON.parse(JSON.stringify(api));
    const cliCopy = JSON.parse(JSON.stringify(cli));
    mergeOpencodeModelSources(api, cli);
    assert.deepStrictEqual(api, apiCopy);
    assert.deepStrictEqual(cli, cliCopy);
  });
});

describe('parseOpencodeServerUrl (model-selector-refresh T06)', () => {
  it('extracts the ephemeral URL from a realistic serve banner', () => {
    assert.strictEqual(
      parseOpencodeServerUrl('opencode server listening on http://127.0.0.1:52341\n'),
      'http://127.0.0.1:52341',
    );
  });

  it('strips a trailing slash', () => {
    assert.strictEqual(parseOpencodeServerUrl('url: http://127.0.0.1:52341/'), 'http://127.0.0.1:52341');
  });

  it('returns undefined when no URL appeared', () => {
    assert.strictEqual(parseOpencodeServerUrl('starting server...\n'), undefined);
  });
});

describe('OpencodeAdapter.discoverModels (model-selector-refresh T06)', () => {
  /** A provider-keyed `/api/model` payload the happy path answers with. */
  const API_PAYLOAD = {
    providers: {
      anthropic: { models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
      openai: { models: ['gpt-6'] },
    },
  };

  /** A BARE `opencode models` listing (no JSON blocks, so no variants). */
  const CLI_STDOUT = ['anthropic/claude-sonnet-5', 'google/gemini-3-pro'].join('\n');

  /** Build a DiscoveryContext with sensible defaults overridable per test. */
  function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
    return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides };
  }

  /** A starter recording its calls and disposals; resolves the given base URL. */
  function fakeServer(baseUrl: string | null = 'http://127.0.0.1:52341') {
    const calls: Array<{ cwd?: string; timeoutMs: number }> = [];
    const disposals: string[] = [];
    const starter: OpencodeServerStarter = async (options) => {
      calls.push({ cwd: options.cwd, timeoutMs: options.timeoutMs });
      if (baseUrl === null) {
        return undefined;
      }
      return {
        baseUrl,
        dispose: () => {
          disposals.push(baseUrl);
        },
      };
    };
    return { starter, calls, disposals };
  }

  /** A `FeedFetch` recording its URLs and answering with a structural FeedResponse. */
  function fakeFetch(handler: (url: string) => Promise<FeedResponse> | FeedResponse) {
    const urls: string[] = [];
    const fetch: FeedFetch = async (url) => {
      urls.push(url);
      return handler(url);
    };
    return { fetch, urls };
  }

  /** A body-carrying 200 response. */
  function okResponse(body: string): FeedResponse {
    return { ok: true, status: 200, text: async () => body };
  }

  /** A CLI runner recording its calls and resolving `stdout`. */
  function fakeCli(stdout: string | undefined) {
    const calls: Array<{ cwd?: string; timeoutMs: number }> = [];
    const runModelsCli: OpencodeModelsCli = async (options) => {
      calls.push({ cwd: options.cwd, timeoutMs: options.timeoutMs });
      return stdout;
    };
    return { runModelsCli, calls };
  }

  const savedEnv = process.env[OPENCODE_SERVER_ENV_VAR];

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[OPENCODE_SERVER_ENV_VAR];
    } else {
      process.env[OPENCODE_SERVER_ENV_VAR] = savedEnv;
    }
  });

  it('pins the primary argv as `opencode models --verbose`', () => {
    assert.deepStrictEqual([...OPENCODE_MODELS_ARGS], ['models', '--verbose']);
  });

  it('returns the verbose CLI listing with per-model efforts and labels, starting no server', async () => {
    const server = fakeServer();
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const cli = fakeCli(VERBOSE_FIXTURE);
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fetcher.fetch,
      runModelsCli: cli.runModelsCli,
    });

    const caps = await adapter.discoverModels(ctx({ cwd: '/ws' }));

    assert.ok(caps !== undefined);
    assert.deepStrictEqual(caps.models, VERBOSE_IDS);
    assert.deepStrictEqual(caps.efforts, ['low', 'high', 'max', 'none', 'thinking', 'minimal']);
    assert.strictEqual(caps.modelEntries?.[0]?.label, 'Claude Sonnet 5');
    assert.deepStrictEqual(caps.modelEntries?.[0]?.efforts, ['low', 'high', 'max']);
    // The primary path starts no server and makes no request.
    assert.deepStrictEqual(server.calls, []);
    assert.deepStrictEqual(fetcher.urls, []);
    assert.strictEqual(cli.calls[0]?.cwd, '/ws');
  });

  it('yields empty capability-level efforts on a bare listing with no variants', async () => {
    const adapter = new OpencodeAdapter(undefined, {
      startServer: fakeServer().starter,
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli(CLI_STDOUT).runModelsCli,
    });

    const caps = await adapter.discoverModels(ctx());
    assert.deepStrictEqual(caps?.models, ['anthropic/claude-sonnet-5', 'google/gemini-3-pro']);
    assert.deepStrictEqual(caps?.efforts, []);
  });

  it('starts no server and makes no request when the CLI succeeds', async () => {
    const server = fakeServer();
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fetcher.fetch,
      runModelsCli: fakeCli(VERBOSE_FIXTURE).runModelsCli,
    });

    await adapter.discoverModels(ctx());
    assert.deepStrictEqual(server.calls, []);
    assert.deepStrictEqual(server.disposals, []);
    assert.deepStrictEqual(fetcher.urls, []);
  });

  const cliMisses: Array<[string, OpencodeModelsCli]> = [
    ['the binary is unavailable', async () => undefined],
    ['stdout is empty', async () => ''],
    ['stdout is prose only', async () => 'no models configured\n'],
    [
      'the runner rejects',
      async () => {
        throw new Error('ENOENT');
      },
    ],
  ];

  for (const [label, runModelsCli] of cliMisses) {
    it(`falls back to /api/model when ${label}`, async () => {
      const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
      const adapter = new OpencodeAdapter(undefined, {
        startServer: fakeServer().starter,
        fetchModels: fetcher.fetch,
        runModelsCli,
      });

      const caps = await adapter.discoverModels(ctx());
      assert.deepStrictEqual(fetcher.urls, ['http://127.0.0.1:52341/api/model']);
      assert.deepStrictEqual(caps?.models, ['anthropic/claude-sonnet-5', 'openai/gpt-6']);
      assert.deepStrictEqual(caps?.efforts, []);
      assert.strictEqual(caps?.modelEntries?.[0]?.label, 'Claude Sonnet 5');
    });
  }

  it('never requests /provider or /config/providers', async () => {
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const adapter = new OpencodeAdapter(undefined, {
      startServer: fakeServer().starter,
      fetchModels: fetcher.fetch,
      runModelsCli: fakeCli(undefined).runModelsCli,
    });

    await adapter.discoverModels(ctx());
    assert.ok(fetcher.urls.length > 0);
    for (const url of fetcher.urls) {
      assert.ok(url.endsWith('/api/model'), `unexpected URL ${url}`);
      assert.ok(!url.includes('/provider'), `key-bearing URL ${url}`);
      assert.ok(!url.includes('/config/providers'), `key-bearing URL ${url}`);
    }
  });

  it('stamps no provenance and no modelLink (CatalogStore/overlayCapabilities own those)', async () => {
    const server = fakeServer();
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });

    const caps = await adapter.discoverModels(ctx());
    assert.ok(caps !== undefined);
    for (const key of ['source', 'stale', 'staleReason', 'fetchedAt', 'modelLink']) {
      assert.ok(!(key in caps), `${key} must not be an own key`);
    }
  });

  it('disposes the started server exactly once on success', async () => {
    const server = fakeServer();
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });
    await adapter.discoverModels(ctx());
    assert.deepStrictEqual(server.disposals, ['http://127.0.0.1:52341']);
  });

  it('disposes the started server exactly once on fetch failure and on abort', async () => {
    const failing = fakeServer();
    const failingAdapter = new OpencodeAdapter(undefined, {
      startServer: failing.starter,
      fetchModels: async () => {
        throw new Error('ECONNREFUSED');
      },
      runModelsCli: fakeCli(undefined).runModelsCli,
    });
    await failingAdapter.discoverModels(ctx());
    assert.strictEqual(failing.disposals.length, 1);

    const aborting = fakeServer();
    const controller = new AbortController();
    const abortingAdapter = new OpencodeAdapter(undefined, {
      startServer: async (options) => {
        const handle = await aborting.starter(options);
        controller.abort();
        return handle;
      },
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });
    assert.strictEqual(await abortingAdapter.discoverModels(ctx({ signal: controller.signal })), undefined);
    assert.strictEqual(aborting.disposals.length, 1);
  });

  it('never spawns when serverBaseUrl is given, and never kills that server', async () => {
    const server = fakeServer();
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fetcher.fetch,
      runModelsCli: fakeCli('').runModelsCli,
      serverBaseUrl: 'http://127.0.0.1:4096',
    });

    await adapter.discoverModels(ctx());
    assert.deepStrictEqual(server.calls, []);
    assert.deepStrictEqual(server.disposals, []);
    assert.deepStrictEqual(fetcher.urls, ['http://127.0.0.1:4096/api/model']);
  });

  it('never spawns when OPENCODE_SERVER holds an http URL', async () => {
    process.env[OPENCODE_SERVER_ENV_VAR] = 'http://127.0.0.1:7777';
    const server = fakeServer();
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fetcher.fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });

    await adapter.discoverModels(ctx());
    assert.deepStrictEqual(server.calls, []);
    assert.deepStrictEqual(server.disposals, []);
    assert.deepStrictEqual(fetcher.urls, ['http://127.0.0.1:7777/api/model']);
  });

  it('ignores a non-http OPENCODE_SERVER value and starts a server instead', async () => {
    process.env[OPENCODE_SERVER_ENV_VAR] = 'not-a-url';
    const server = fakeServer();
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });

    await adapter.discoverModels(ctx());
    assert.strictEqual(server.calls.length, 1);
  });

  const apiFailures: Array<[string, Partial<OpencodeAdapterOptions>]> = [
    ['the starter resolves undefined', { startServer: fakeServer(null).starter }],
    [
      'fetch rejects',
      {
        fetchModels: async () => {
          throw new Error('socket hang up');
        },
      },
    ],
    [
      'the server answers HTTP 500',
      { fetchModels: async () => ({ ok: false, status: 500, text: async () => '' }) },
    ],
    [
      'text() rejects',
      {
        fetchModels: async () => ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error('stream closed');
          },
        }),
      },
    ],
    ['the body is not JSON', { fetchModels: fakeFetch(() => okResponse('<html>nope')).fetch }],
    [
      'the body parses to an unrecognised shape',
      { fetchModels: fakeFetch(() => okResponse('{"nope":1}')).fetch },
    ],
  ];

  for (const [label, options] of apiFailures) {
    it(`resolves undefined when the CLI yielded nothing and ${label}`, async () => {
      const adapter = new OpencodeAdapter(undefined, {
        startServer: fakeServer().starter,
        fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
        runModelsCli: fakeCli(undefined).runModelsCli,
        ...options,
      });

      assert.strictEqual(await adapter.discoverModels(ctx()), undefined);
    });
  }

  it('resolves undefined (never the curated list) when both sources are empty', async () => {
    const adapter = new OpencodeAdapter(undefined, {
      startServer: fakeServer(null).starter,
      fetchModels: fakeFetch(() => okResponse('{}')).fetch,
      runModelsCli: fakeCli('no models configured').runModelsCli,
    });
    assert.strictEqual(await adapter.discoverModels(ctx()), undefined);
  });

  it('makes no call at all when ctx.signal is already aborted', async () => {
    const server = fakeServer();
    const fetcher = fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD)));
    const cli = fakeCli(CLI_STDOUT);
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: fetcher.fetch,
      runModelsCli: cli.runModelsCli,
    });
    const controller = new AbortController();
    controller.abort();

    assert.strictEqual(await adapter.discoverModels(ctx({ signal: controller.signal })), undefined);
    assert.deepStrictEqual(server.calls, []);
    assert.deepStrictEqual(fetcher.urls, []);
    assert.deepStrictEqual(cli.calls, []);
  });

  it('resolves undefined when the abort lands while the fetch is in flight', async () => {
    const server = fakeServer();
    const controller = new AbortController();
    const adapter = new OpencodeAdapter(undefined, {
      startServer: server.starter,
      fetchModels: async () => {
        controller.abort();
        throw new Error('aborted');
      },
      runModelsCli: fakeCli('').runModelsCli,
    });

    assert.strictEqual(await adapter.discoverModels(ctx({ signal: controller.signal })), undefined);
    assert.strictEqual(server.disposals.length, 1);
  });

  it('resolves undefined rather than rejecting when the starter throws synchronously', async () => {
    const adapter = new OpencodeAdapter(undefined, {
      startServer: () => {
        throw new Error('spawn exploded');
      },
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });
    assert.strictEqual(await adapter.discoverModels(ctx()), undefined);
  });

  it('resolves undefined rather than rejecting when the CLI runner rejects', async () => {
    const adapter = new OpencodeAdapter(undefined, {
      startServer: fakeServer(null).starter,
      fetchModels: fakeFetch(() => okResponse('{}')).fetch,
      runModelsCli: async () => {
        throw new Error('ENOENT');
      },
    });
    assert.strictEqual(await adapter.discoverModels(ctx()), undefined);
  });

  it('clamps a budget larger than the default and replaces a non-positive one', async () => {
    for (const timeoutMs of [DEFAULT_DISCOVERY_TIMEOUT_MS * 10, 0, -5]) {
      const server = fakeServer();
      const cli = fakeCli('');
      const adapter = new OpencodeAdapter(undefined, {
        startServer: server.starter,
        fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
        runModelsCli: cli.runModelsCli,
      });

      await adapter.discoverModels(ctx({ timeoutMs }));
      assert.ok(
        (server.calls[0]?.timeoutMs ?? 0) > 0 &&
          (server.calls[0]?.timeoutMs ?? 0) <= DEFAULT_DISCOVERY_TIMEOUT_MS,
        `starter budget out of range for timeoutMs=${timeoutMs}`,
      );
      assert.ok(
        (cli.calls[0]?.timeoutMs ?? 0) > 0 &&
          (cli.calls[0]?.timeoutMs ?? 0) <= DEFAULT_DISCOVERY_TIMEOUT_MS,
        `CLI budget out of range for timeoutMs=${timeoutMs}`,
      );
    }
  });

  it('round-trips through capabilitiesToCatalogFetch with no efforts key', async () => {
    const adapter = new OpencodeAdapter(undefined, {
      startServer: fakeServer().starter,
      fetchModels: fakeFetch(() => okResponse(JSON.stringify(API_PAYLOAD))).fetch,
      runModelsCli: fakeCli(undefined).runModelsCli,
    });

    const caps = await adapter.discoverModels(ctx());
    const fetched = capabilitiesToCatalogFetch(caps!);
    assert.deepStrictEqual(
      fetched.models.map((entry) => entry.id),
      ['anthropic/claude-sonnet-5', 'openai/gpt-6'],
    );
    assert.ok(!('efforts' in fetched));
  });

  it('leaves launch() byte-identical whether or not discovery options were passed', () => {
    const plain = new OpencodeAdapter();
    const withDiscovery = new OpencodeAdapter(undefined, {
      startServer: fakeServer().starter,
      fetchModels: fakeFetch(() => okResponse('{}')).fetch,
      runModelsCli: fakeCli('').runModelsCli,
    });

    assert.deepStrictEqual(withDiscovery.launch(req()), plain.launch(req()));
    assert.deepStrictEqual(
      withDiscovery.attach({ role: 'planner', runId: 'run-9', sessionId: 'ses_1' }),
      plain.attach({ role: 'planner', runId: 'run-9', sessionId: 'ses_1' }),
    );
  });

  it('still resolves session ids through the positional listSessions parameter', async () => {
    const adapter = new OpencodeAdapter(async () => [{ id: 'ses_abc', title: 'session-abc' }], {
      startServer: fakeServer().starter,
    });
    assert.strictEqual(await adapter.resolveSessionId('session-abc', '/ws'), 'ses_abc');
  });
});

describe('OpencodeAdapter /api/model API failure log (api-error-log T08)', () => {
  const BASE_URL = 'http://127.0.0.1:4096';
  const API_PAYLOAD = { providers: { anthropic: { models: [{ id: 'claude-sonnet-5' }] } } };

  function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
    return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides };
  }

  function recordingLog(): { log: ApiLog; entries: ApiFailureEntry[] } {
    const entries: ApiFailureEntry[] = [];
    return {
      log: {
        failure: (e) => {
          entries.push(e);
        },
      },
      entries,
    };
  }

  function okResponse(body: string): FeedResponse {
    return { ok: true, status: 200, text: async () => body };
  }

  function adapterWith(fetchModels: FeedFetch, stdout: string | undefined = undefined): OpencodeAdapter {
    return new OpencodeAdapter(undefined, {
      fetchModels,
      serverBaseUrl: BASE_URL,
      runModelsCli: async () => stdout,
    });
  }

  const savedEnv = process.env[OPENCODE_SERVER_ENV_VAR];

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[OPENCODE_SERVER_ENV_VAR];
    } else {
      process.env[OPENCODE_SERVER_ENV_VAR] = savedEnv;
    }
  });

  it('logs a non-2xx response with status, URL and body excerpt', async () => {
    const { log, entries } = recordingLog();
    const adapter = adapterWith(async () => ({ ok: false, status: 503, text: async () => 'upstream down' }));
    const caps = await adapter.discoverModels(ctx({ apiLog: log }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.surface, 'opencode');
    assert.strictEqual(entries[0]?.operation, 'model list');
    assert.strictEqual(entries[0]?.kind, 'http-status');
    assert.strictEqual(entries[0]?.status, 503);
    assert.strictEqual(entries[0]?.target, `${BASE_URL}/api/model`);
    assert.ok(entries[0]?.bodyExcerpt?.includes('upstream down'));
  });

  it('logs a request failure as a connection failure', async () => {
    const { log, entries } = recordingLog();
    const adapter = adapterWith(async () => {
      throw new Error('ECONNREFUSED');
    });
    const caps = await adapter.discoverModels(ctx({ apiLog: log }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.kind, 'connection');
    assert.strictEqual(entries[0]?.target, `${BASE_URL}/api/model`);
    assert.ok(entries[0]?.message.includes('ECONNREFUSED'));
  });

  it('logs the local timeout as a timeout failure', async () => {
    const { log, entries } = recordingLog();
    const adapter = adapterWith(
      (_url, init) =>
        new Promise<FeedResponse>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const caps = await adapter.discoverModels(ctx({ apiLog: log, timeoutMs: 30 }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.kind, 'timeout');
  });

  it('logs unparseable JSON as a malformed response', async () => {
    const { log, entries } = recordingLog();
    const caps = await adapterWith(async () => okResponse('not json{')).discoverModels(ctx({ apiLog: log }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.kind, 'malformed-response');
  });

  it('logs nothing on a successful /api/model call', async () => {
    const { log, entries } = recordingLog();
    const caps = await adapterWith(async () => okResponse(JSON.stringify(API_PAYLOAD))).discoverModels(
      ctx({ apiLog: log }),
    );
    assert.ok(caps !== undefined);
    assert.strictEqual(entries.length, 0);
  });

  it('logs nothing when the CLI primary path succeeds', async () => {
    const { log, entries } = recordingLog();
    const adapter = adapterWith(async () => {
      throw new Error('must not be requested');
    }, VERBOSE_FIXTURE);
    const caps = await adapter.discoverModels(ctx({ apiLog: log }));
    assert.ok(caps !== undefined);
    assert.strictEqual(entries.length, 0);
  });

  it('logs nothing when the caller aborts mid-request', async () => {
    const { log, entries } = recordingLog();
    const controller = new AbortController();
    const adapter = adapterWith(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const caps = await adapter.discoverModels(ctx({ apiLog: log, signal: controller.signal }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(entries.length, 0);
  });

  it('records a secret-bearing body, which createApiLog redacts', async () => {
    const lines: string[] = [];
    const adapter = adapterWith(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Authorization: Bearer sk-abcdefghijklmnopqrstuv',
    }));
    await adapter.discoverModels(ctx({ apiLog: createApiLog((line) => lines.push(line)) }));
    assert.strictEqual(lines.length, 1);
    assert.ok(!lines[0]?.includes('sk-abcdefghijklmnopqrstuv'));
  });

  it('still resolves undefined without throwing when ctx has no apiLog', async () => {
    const adapter = adapterWith(async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.strictEqual(await adapter.discoverModels(ctx()), undefined);
  });
});
