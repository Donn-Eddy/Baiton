import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexAdapter,
  CODEX_MODELS,
  CODEX_EFFORTS,
  CODEX_READ_ONLY_SANDBOX,
  CODEX_WORKSPACE_WRITE_SANDBOX,
  CODEX_ASK_FOR_APPROVAL,
  CODEX_EFFORT_CONFIG_KEY,
  CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY,
  CODEX_APP_SERVER_SUBCOMMAND,
  CODEX_APP_SERVER_INITIALIZE_METHOD,
  CODEX_APP_SERVER_INITIALIZED_NOTIFICATION,
  CODEX_APP_SERVER_MODEL_LIST_METHOD,
  CODEX_APP_SERVER_INITIALIZE_ID,
  CODEX_APP_SERVER_MODEL_LIST_ID,
  CODEX_APP_SERVER_CLIENT_INFO,
  codexModelsFromAppServer,
  codexPermissionFlags,
  codexEffortFlags,
  codexSystemPromptFlags,
  tomlQuote,
  CODEX_BYPASS_HOOK_TRUST_FLAG,
  CODEX_RELAY_HOOK_DEADLINE_SECONDS,
  CODEX_RELAY_HOOK_MATCHER,
  CODEX_RELAY_HOOK_SCRIPT,
  CODEX_RELAY_HOOK_TIMEOUT_SECONDS,
  codexAskRelayHookCommand,
  codexAskRelayHookConfig,
  codexRelayFlags,
} from '../src/adapter/codex';
import type { CodexAppServerProcess, CodexAppServerSpawner } from '../src/adapter/codex';
import type { AgentCapabilities, AskRelayDescriptor, DiscoveryContext, LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY, DEFAULT_DISCOVERY_TIMEOUT_MS, capabilitiesToCatalogFetch } from '../src/adapter/adapter';
import { createAdapterRegistry } from '../src/adapter/index';
import { roleProfile } from '../src/adapter/roleProfile';
import { ROLES } from '../src/model/role';
import { askRelayDescriptor, parseAsk } from '../src/engine/askRelay';
import { shellQuote } from '../src/adapter/permissions';

/**
 * This file mirrors test/adapter.antigravity.test.ts (itself mirrored from
 * test/adapter.claude.test.ts) for the codex CLI and pins:
 *
 * - the probe `{version, ok, reason?}` contract, including the non-empty
 *   reason on failure (Req 14.2-14.4);
 * - the fresh vs `codex resume <id>` vs `codex resume --last` launch branches
 *   (Req 3.1, 3.2, 13.2, 13.3);
 * - attach()'s no-prompt reopen (Req 3.3, 3.4);
 * - the `--sandbox`/`--ask-for-approval` mapping — role-independent by
 *   Decision 2 — and the per-run `--add-dir` grant (Req 15.1-15.4);
 * - `-c developer_instructions="..."` carrying the role profile's prose policy,
 *   and the TOML quoting that survives quotes and newlines in it;
 * - the codex-specific degrades: `req.sessionId` dropped on a fresh launch,
 *   the `--config model_reasoning_effort=<effort>` effort degrade, the
 *   interactive form (not `codex exec`), and the prompt dropped on the
 *   `resume --last` branch;
 * - the native ask relay: the `--dangerously-bypass-hook-trust` + inline
 *   `-c hooks.PermissionRequest=[…]` argv and the hook script's fallback to
 *   codex's own prompt;
 * - the `codex app-server` discovery handshake (T05): the three-message
 *   JSON-RPC framing over JSONL, the tolerant `codexModelsFromAppServer`
 *   payload parser, and the never-reject capability mapping of
 *   `discoverModels` (every failure path resolves `undefined` and the fake
 *   child is always killed).
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
    assert.ok(!spec.shellArgs.includes('--continue'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
    assert.ok(!spec.shellArgs.includes('exec'));
    assert.ok(!spec.shellArgs.includes('session-xyz'));
  });

  it('resume with a prior Session_Id leads `resume <id>` (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['resume', 'prior-session']);
    assert.ok(!spec.shellArgs.includes('--last'));
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
      '-c',
      `${CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY}=${tomlQuote(roleProfile('executor').systemPrompt)}`,
    ]);
    assert.strictEqual(spec.shellPath, AGENT_BINARY.codex);
    assert.strictEqual(spec.shellArgs.length, 10);

    assert.ok(!spec.shellArgs.includes('--'));
    assert.ok(!spec.shellArgs.includes('Read brief.md and do what it says.'));
    assert.ok(!spec.shellArgs.includes('--model'));
    assert.ok(!spec.shellArgs.includes('--config'));
    assert.ok(!spec.shellArgs.includes('--last'));
  });

  it('uses the workspace-write sandbox and run-dir grant for a read-only role too (Decision 2)', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--sandbox', CODEX_WORKSPACE_WRITE_SANDBOX) >= 0);
    assert.ok(!spec.shellArgs.includes(CODEX_READ_ONLY_SANDBOX));
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

  // Decision 2: `--sandbox read-only` is a whole-session sandbox that blocks
  // the run-dir result write every role must perform, so every role — the
  // read-only ones included — runs `workspace-write`, and the no-edit rule is
  // carried by developer_instructions plus the brief plus the post-run reset.
  for (const role of ROLES) {
    it(`maps role ${role} to workspace-write plus on-request approval for launch and attach`, () => {
      const expectedSandbox = CODEX_WORKSPACE_WRITE_SANDBOX;

      const launchSpec = new CodexAdapter().launch(req({ role }));
      assert.ok(findPair(launchSpec.shellArgs, '--sandbox', expectedSandbox) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--sandbox').length, 1);
      // codex differs from claude/agy: the approval flag is role-independent.
      assert.ok(findPair(launchSpec.shellArgs, '--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0);
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--ask-for-approval').length, 1);

      assert.ok(!launchSpec.shellArgs.includes(CODEX_READ_ONLY_SANDBOX));

      const attachSpec = new CodexAdapter().attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(findPair(attachSpec.shellArgs, '--sandbox', expectedSandbox) >= 0);
      assert.ok(!attachSpec.shellArgs.includes(CODEX_READ_ONLY_SANDBOX));
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--sandbox').length, 1);
      assert.ok(findPair(attachSpec.shellArgs, '--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0);
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--ask-for-approval').length, 1);
    });
  }

  it('codexPermissionFlags returns the workspace-write sandbox flags for planner too', () => {
    assert.deepStrictEqual(codexPermissionFlags('planner'), [
      '--sandbox',
      'workspace-write',
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

/**
 * `discoverSessionId` recovers the session id codex minted for a run, which is
 * the only id `codex resume <id>` accepts (Baiton's pre-assigned one is ignored
 * on a fresh launch — degrade 1 in the adapter's doc comment).
 *
 * The fixture is a temp `$CODEX_HOME` holding a rollout transcript in codex's
 * real layout: `sessions/<YYYY>/<MM>/<DD>/rollout-<ISO time>-<uuid>.jsonl`,
 * whose first line is the `session_meta` record (`payload.id`, `payload.cwd`)
 * and whose following lines carry the initial prompt naming the run's brief.
 * A file counts only when it was modified at/after the launch, its `cwd` is the
 * workspace, and its opening lines mention the run id.
 */
describe('CodexAdapter.discoverSessionId (Req 3.2)', () => {
  const SESSION_ID = '01a0add4-6a1c-7151-82ba-d01d7f8ff33d';
  const RUN_ID = 'demo-T11-execute-2-1758061574000';

  let codexHome: string;
  let workspace: string;
  let savedCodexHome: string | undefined;
  let launchedAt: number;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-codex-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-codex-ws-'));
    process.env.CODEX_HOME = codexHome;
    launchedAt = Date.now();
  });

  afterEach(() => {
    if (savedCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** The `sessions/YYYY/MM/DD` directory codex would file a run launched at `at` under. */
  function dayDir(at: number): string {
    const day = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return path.join(
      codexHome,
      'sessions',
      String(day.getFullYear()),
      pad(day.getMonth() + 1),
      pad(day.getDate()),
    );
  }

  /** Write one rollout transcript; returns its path. */
  function writeRollout(options: {
    id?: string;
    cwd?: string;
    runId?: string;
    firstLine?: string;
    mtime?: number;
    at?: number;
  }): string {
    const at = options.at ?? launchedAt;
    const dir = dayDir(at);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-16T22-26-14-${options.id ?? SESSION_ID}.jsonl`);
    const meta =
      options.firstLine ??
      JSON.stringify({
        type: 'session_meta',
        payload: { id: options.id ?? SESSION_ID, cwd: options.cwd ?? workspace },
      });
    const briefPath = path.join(
      options.cwd ?? workspace,
      '.baiton',
      'runs',
      options.runId ?? RUN_ID,
      'brief.md',
    );
    const turn = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Read ${briefPath} and do what it says.` }],
      },
    });
    fs.writeFileSync(file, `${meta}\n${turn}\n`, 'utf8');
    const mtime = (options.mtime ?? at) / 1000;
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  /** Run discovery against the fixture for the run under test. */
  function discover(overrides: Partial<{ runId: string; workspaceRoot: string }> = {}): Promise<string | undefined> {
    return new CodexAdapter().discoverSessionId({
      runId: overrides.runId ?? RUN_ID,
      workspaceRoot: overrides.workspaceRoot ?? workspace,
      launchedAt,
    });
  }

  it('returns the session id of the rollout whose cwd and run id match', async () => {
    writeRollout({});
    assert.strictEqual(await discover(), SESSION_ID);
  });

  it('tolerates a non-canonical workspace path (compares resolved paths)', async () => {
    writeRollout({});
    assert.strictEqual(
      await discover({ workspaceRoot: path.join(workspace, 'sub', '..') }),
      SESSION_ID,
    );
  });

  it('ignores a session recorded for another cwd', async () => {
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-codex-other-'));
    try {
      writeRollout({ cwd: otherCwd });
      assert.strictEqual(await discover(), undefined);
    } finally {
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it('ignores a session whose file predates the launch', async () => {
    // Two days back: outside both the mtime window and the scanned date dirs.
    const old = launchedAt - 2 * 24 * 60 * 60 * 1000;
    writeRollout({ at: old, mtime: old });
    assert.strictEqual(await discover(), undefined);
  });

  it('ignores a session whose mtime is before the launch window', async () => {
    writeRollout({ mtime: launchedAt - 10 * 60 * 1000 });
    assert.strictEqual(await discover(), undefined);
  });

  it('ignores a rollout whose first line is malformed or not a session_meta', async () => {
    writeRollout({ firstLine: '{not json' });
    assert.strictEqual(await discover(), undefined);

    fs.rmSync(path.join(codexHome, 'sessions'), { recursive: true, force: true });
    writeRollout({ firstLine: JSON.stringify({ type: 'turn_context', payload: { id: SESSION_ID } }) });
    assert.strictEqual(await discover(), undefined);
  });

  it('ignores a session for a different run in the same workspace', async () => {
    writeRollout({ runId: 'demo-T11-execute-1-1758000000000' });
    assert.strictEqual(await discover(), undefined);
  });

  it('returns undefined when CODEX_HOME holds no sessions at all', async () => {
    assert.strictEqual(await discover(), undefined);
  });
});

describe('CodexAdapter TOML quoting of developer_instructions', () => {
  it('wraps a plain value in double quotes', () => {
    assert.strictEqual(tomlQuote('hello'), '"hello"');
    assert.strictEqual(tomlQuote(''), '""');
  });

  it('escapes double quotes', () => {
    assert.strictEqual(tomlQuote('say "hi"'), '"say \\"hi\\""');
  });

  it('escapes backslashes, and does so before quotes so the escape is not double-escaped', () => {
    assert.strictEqual(tomlQuote('a\\b'), '"a\\\\b"');
    assert.strictEqual(tomlQuote('a\\"b'), '"a\\\\\\"b"');
  });

  it('encodes newlines as \\n rather than emitting a literal line break', () => {
    const quoted = tomlQuote('line one\nline two');
    assert.strictEqual(quoted, '"line one\\nline two"');
    assert.ok(!quoted.includes('\n'), 'a basic TOML string must not contain a raw newline');
  });

  it('round-trips a value containing both a quote and a newline through JSON.parse', () => {
    // A basic TOML string and a JSON string share this escape grammar, so
    // JSON.parse is a faithful decoder for what codex will read back.
    const value = 'Write "result.json".\nThen stop. C:\\tmp';
    assert.strictEqual(JSON.parse(tomlQuote(value)), value);
  });

  it('round-trips every role profile prompt', () => {
    for (const role of ROLES) {
      const prompt = roleProfile(role).systemPrompt;
      assert.strictEqual(JSON.parse(tomlQuote(prompt)), prompt, `role ${role} prompt did not round-trip`);
    }
  });
});

describe('CodexAdapter -c developer_instructions carries the role profile', () => {
  const adapter = new CodexAdapter();

  it('pins the config key', () => {
    assert.strictEqual(CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY, 'developer_instructions');
  });

  for (const role of ROLES) {
    it(`carries ${role}'s profile prompt, TOML-quoted, on launch and attach`, () => {
      const expected = `${CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY}=${tomlQuote(roleProfile(role).systemPrompt)}`;
      assert.deepStrictEqual(codexSystemPromptFlags(role), ['-c', expected]);

      const launchSpec = adapter.launch(req({ role }));
      assert.ok(
        findPair(launchSpec.shellArgs, '-c', expected) >= 0,
        `expected ${role}'s developer_instructions on launch: ${JSON.stringify(launchSpec.shellArgs)}`,
      );
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '-c').length, 1);

      const attachSpec = adapter.attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(
        findPair(attachSpec.shellArgs, '-c', expected) >= 0,
        `expected ${role}'s developer_instructions on attach: ${JSON.stringify(attachSpec.shellArgs)}`,
      );
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '-c').length, 1);
    });
  }

  // The value half of `-c key=value` is parsed as TOML, so the quoting must
  // survive all the way onto argv; an unquoted prompt would parse as a bare
  // key and be silently taken as a literal string or rejected.
  it('emits the value already quoted on argv, before the -- prompt separator', () => {
    const request = req();
    const args = adapter.launch(request).shellArgs;
    const idx = args.indexOf('-c');
    assert.ok(idx >= 0);
    const value = args[idx + 1];
    assert.ok(value.startsWith('developer_instructions="'));
    assert.ok(value.endsWith('"'));

    const sep = args.indexOf('--');
    assert.ok(idx < sep, `developer_instructions must precede the -- separator: ${JSON.stringify(args)}`);
    assert.strictEqual(args[args.length - 1], request.prompt);
  });

  it('is dropped along with the rest of the prompt-bearing tail on no branch: resume --last still carries it', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.ok(spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--'));
  });
});


/**
 * The native ask relay (README.md, "Harness ask relay (per-adapter probe
 * findings)", codex-cli 0.155.1, 2026-09-22): a `file-v1` relay adds
 * `--dangerously-bypass-hook-trust` plus an inline
 * `-c hooks.PermissionRequest=[…]` command hook, and nothing else. Probed
 * interactively, the hook's `decision.behavior` replaces codex's own approval
 * prompt, while a missing decision, a crash or a timeout falls back to it.
 */
describe('CodexAdapter native ask relay (probe findings, codex 0.155.1)', () => {
  const adapter = new CodexAdapter();
  const relay = askRelayDescriptor('/repo', 'run-123');

  /**
   * Minimal TOML basic-string reader for the tests: read the `"…"` string
   * starting at `from`, undoing `\\`, `\"` and `\n`, and return it with the
   * index just past its closing quote.
   */
  function readTomlString(text: string, from: number): { value: string; end: number } {
    assert.strictEqual(text[from], '"', `expected a TOML string at ${from}`);
    let value = '';
    let i = from + 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const next = text[i + 1];
        value += next === 'n' ? '\n' : next;
        i += 2;
      } else {
        value += text[i];
        i += 1;
      }
    }
    assert.ok(i < text.length, 'unterminated TOML string');
    return { value, end: i + 1 };
  }

  it('pins the hook constants', () => {
    assert.strictEqual(CODEX_BYPASS_HOOK_TRUST_FLAG, '--dangerously-bypass-hook-trust');
    assert.strictEqual(CODEX_RELAY_HOOK_TIMEOUT_SECONDS, 600);
    assert.strictEqual(CODEX_RELAY_HOOK_MATCHER, '*');
    assert.ok(CODEX_RELAY_HOOK_DEADLINE_SECONDS < CODEX_RELAY_HOOK_TIMEOUT_SECONDS);
  });

  it('emits no relay flags without a relay, or for an unknown protocol', () => {
    assert.deepStrictEqual(codexRelayFlags(), []);
    assert.deepStrictEqual(codexRelayFlags(undefined), []);
    const future = { ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor;
    assert.deepStrictEqual(codexRelayFlags(future), []);
    assert.deepStrictEqual(adapter.launch(req({ relay: future })), adapter.launch(req()));
    assert.deepStrictEqual(adapter.launch(req({ relay: undefined })), adapter.launch(req()));
    for (const role of ROLES) {
      assert.ok(!adapter.launch(req({ role })).shellArgs.includes(CODEX_BYPASS_HOOK_TRUST_FLAG));
    }
  });

  it('a relay launch adds exactly the bypass flag and the -c hook pair, before the -- prompt', () => {
    const args = adapter.launch(req({ relay })).shellArgs;
    const plain = adapter.launch(req()).shellArgs;
    assert.deepStrictEqual(codexRelayFlags(relay), [
      CODEX_BYPASS_HOOK_TRUST_FLAG,
      '-c',
      codexAskRelayHookConfig(relay),
    ]);
    const bypass = args.indexOf(CODEX_BYPASS_HOOK_TRUST_FLAG);
    const sep = args.indexOf('--');
    assert.ok(bypass >= 0 && bypass < sep, `bypass before the prompt: ${JSON.stringify(args)}`);
    assert.deepStrictEqual(args.slice(bypass, bypass + 3), codexRelayFlags(relay));
    // Nothing else changes: removing the three relay args yields the plain launch.
    assert.deepStrictEqual([...args.slice(0, bypass), ...args.slice(bypass + 3)], plain);
    assert.strictEqual(adapter.launch(req({ relay })).env, undefined);
  });

  it('the -c value is the probed PermissionRequest shape and its command round-trips through TOML', () => {
    const value = codexAskRelayHookConfig(relay);
    const prefix = 'hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command=';
    assert.ok(value.startsWith(prefix), value.slice(0, 120));
    const { value: command, end } = readTomlString(value, prefix.length);
    assert.strictEqual(command, codexAskRelayHookCommand(relay));
    assert.strictEqual(value.slice(end), `,timeout=${CODEX_RELAY_HOOK_TIMEOUT_SECONDS}}]}]`);
    assert.ok(!value.includes('\n'), 'the -c value is a single line');
  });

  it('the hook command runs the script with node -e and passes every parameter shell-quoted as argv', () => {
    const command = codexAskRelayHookCommand(relay);
    assert.ok(command.startsWith(`node -e ${shellQuote(CODEX_RELAY_HOOK_SCRIPT)} `));
    for (const part of [relay.dir, relay.askSuffix, relay.responseSuffix, relay.runId]) {
      assert.ok(command.includes(shellQuote(part)), `missing ${part}: ${command}`);
    }
    assert.ok(command.endsWith(` ${CODEX_RELAY_HOOK_DEADLINE_SECONDS * 1000}`));
    assert.ok(!CODEX_RELAY_HOOK_SCRIPT.includes("'"), 'the hook script must contain no single quote');
  });

  it('never emits a decision field that makes codex fail closed, nor a policy-bypassing flag', () => {
    for (const reserved of ['interrupt', 'updatedInput', 'updatedPermissions']) {
      assert.ok(!CODEX_RELAY_HOOK_SCRIPT.includes(reserved), `the script must not mention ${reserved}`);
    }
    for (const role of ROLES) {
      const args = adapter.launch(req({ role, relay })).shellArgs;
      for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--approve-for-me']) {
        assert.ok(!args.includes(flag), `did not expect ${flag} for ${role}`);
      }
      assert.ok(findPair(args, '--sandbox', CODEX_WORKSPACE_WRITE_SANDBOX) >= 0, 'the sandbox stays the floor');
      assert.ok(findPair(args, '--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0, 'on-request stays the floor');
      assert.ok(!args.join(' ').includes('hooks.PreToolUse'), 'the relay hooks PermissionRequest, not PreToolUse');
    }
  });

  it('carries the relay on both resume branches, and resume --last still drops the prompt', () => {
    const withId = adapter.launch(req({ resume: true, resumeSessionId: 'sess-real', relay })).shellArgs;
    assert.ok(withId.includes(CODEX_BYPASS_HOOK_TRUST_FLAG));
    assert.ok(withId.indexOf(CODEX_BYPASS_HOOK_TRUST_FLAG) < withId.indexOf('--'));

    const last = adapter.launch(req({ resume: true, resumeSessionId: undefined, relay })).shellArgs;
    assert.ok(last.includes(CODEX_BYPASS_HOOK_TRUST_FLAG));
    assert.ok(!last.includes('--'));
    assert.ok(!last.includes(req().prompt));
  });

  it('attach() installs no relay (no attach caller passes one)', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-777', sessionId: 'sess-1' });
    assert.ok(!spec.shellArgs.includes(CODEX_BYPASS_HOOK_TRUST_FLAG));
    assert.ok(!spec.shellArgs.join(' ').includes('hooks.'));
  });

  /**
   * Round-trip behaviour of the emitted script, fed the stdin event shape the
   * probe observed (`{hook_event_name:"PermissionRequest", tool_name,
   * tool_input:{command, description}, …}`): the ask it writes parses through
   * `parseAsk`, and its stdout follows the response — approve→allow,
   * anything else→deny with the reason — while every failure prints the
   * event with no decision, which codex answers with its own prompt. Argv
   * order mirrors the hook command.
   */
  function runHook(
    stdin: string,
    deadlineMs: number,
    respond?: (asksDir: string, askFile: string) => void,
  ): Promise<{ stdout: string; code: number | null; asksDir: string }> {
    const asksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-codex-relay-'));
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(
        process.execPath,
        ['-e', CODEX_RELAY_HOOK_SCRIPT, asksDir, '.json', '.response.json', 'run-123', String(deadlineMs)],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ stdout, code, asksDir }));
      child.stdin!.write(stdin);
      child.stdin!.end();
      if (respond !== undefined) {
        const watcher = setInterval(() => {
          const asks = fs.readdirSync(asksDir).filter((f) => f.endsWith('.json') && !f.endsWith('.response.json'));
          if (asks.length > 0) {
            clearInterval(watcher);
            respond(asksDir, asks[0]);
          }
        }, 20);
      }
    });
  }

  const toolInput = {
    command: 'touch /outside/marker',
    description: 'Allow creating the marker outside the sandbox?',
  };
  const event = JSON.stringify({
    session_id: 's-1',
    turn_id: 't-1',
    cwd: '/repo',
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: toolInput,
  });

  function answer(decision: 'approve' | 'deny', reason?: string) {
    return (asksDir: string, askFile: string): void => {
      const parsed = parseAsk(fs.readFileSync(path.join(asksDir, askFile), 'utf8'));
      assert.ok(parsed.ok, `the ask parses: ${parsed.ok ? '' : parsed.error.message}`);
      if (parsed.ok) {
        assert.strictEqual(parsed.value.agent, 'codex');
        assert.strictEqual(parsed.value.kind, 'permission');
        assert.strictEqual(parsed.value.runId, 'run-123');
        assert.strictEqual(parsed.value.tool, 'Bash');
        assert.strictEqual(parsed.value.detail, toolInput.description);
        assert.deepStrictEqual(JSON.parse(parsed.value.args ?? '{}'), toolInput);
        fs.writeFileSync(
          path.join(asksDir, parsed.value.id + '.response.json'),
          JSON.stringify({ version: 1, id: parsed.value.id, decision, ...(reason ? { reason } : {}) }),
        );
      }
    };
  }

  const noDecision = { hookSpecificOutput: { hookEventName: 'PermissionRequest' } };

  it('writes a parseAsk-valid ask (description as detail) and prints allow on approve', async () => {
    const { stdout, code, asksDir } = await runHook(event, 10_000, answer('approve'));
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', message: 'approved in Baiton' },
      },
    });
  });

  it('prints deny with the reason as the message on a deny response', async () => {
    const { stdout, code, asksDir } = await runHook(event, 10_000, answer('deny', 'not today'));
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'not today' },
      },
    });
  });

  it('falls back to codex own prompt (no decision, never allow) when no answer arrives before the deadline', async () => {
    const { stdout, code, asksDir } = await runHook(event, 300);
    const written = fs.readdirSync(asksDir);
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), noDecision);
    assert.strictEqual(written.length, 1, 'the ask was written before the wait');
  });

  it('falls back to codex own prompt on an unparseable event, writing no ask', async () => {
    const { stdout, code, asksDir } = await runHook('not json', 10_000);
    const written = fs.readdirSync(asksDir);
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), noDecision);
    assert.deepStrictEqual(written, []);
  });

  it('omits detail when the tool input carries no description', async () => {
    const bare = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    let detail: string | undefined = 'unset';
    const { stdout, asksDir } = await runHook(bare, 10_000, (dir, file) => {
      const parsed = parseAsk(fs.readFileSync(path.join(dir, file), 'utf8'));
      assert.ok(parsed.ok);
      if (parsed.ok) {
        detail = parsed.value.detail;
        fs.writeFileSync(
          path.join(dir, parsed.value.id + '.response.json'),
          JSON.stringify({ version: 1, id: parsed.value.id, decision: 'approve' }),
        );
      }
    });
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(detail, undefined);
    assert.strictEqual(
      (JSON.parse(stdout) as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision
        .behavior,
      'allow',
    );
  });
});

/**
 * The `model/list` payload parser (model-selector-refresh T05) is pure and
 * total, and deliberately tolerant of the loosely-pinned `codex app-server`
 * response shape: an unrecognised field is ignored rather than failing the
 * whole refresh, so it degrades to `[]`/fewer fields instead of throwing.
 */
describe('codexModelsFromAppServer (model-selector-refresh T05)', () => {
  it('parses the {models:[…]} shape with ids, labels, per-model efforts and defaults', () => {
    const entries = codexModelsFromAppServer({
      models: [
        {
          id: 'gpt-6-astra',
          displayName: 'GPT-6 Astra',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-5-codex',
          supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
          defaultReasoningEffort: 'low',
        },
      ],
    });
    assert.deepStrictEqual(entries, [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      { id: 'gpt-5-codex', efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'low' },
    ]);
  });

  it('parses an {items:[…]} object and a bare array too', () => {
    assert.deepStrictEqual(
      codexModelsFromAppServer({ items: [{ id: 'a' }, 'b'] }),
      [{ id: 'a' }, { id: 'b' }],
    );
    assert.deepStrictEqual(
      codexModelsFromAppServer([{ id: ' a ' }, { model: ' m ' }, { slug: ' s ' }]),
      [{ id: 'a' }, { id: 'm' }, { id: 's' }],
    );
  });

  it('trims ids, skips blank and unusable items (numbers, null, no-id objects)', () => {
    assert.deepStrictEqual(
      codexModelsFromAppServer({ models: ['  a  ', '   ', { id: ' \t ' }, { name: 'no id here' }, 42, null, { id: 'b' }] }),
      [{ id: 'a' }, { id: 'b' }],
    );
  });

  it('a duplicate id keeps the first entry (including its label)', () => {
    assert.deepStrictEqual(
      codexModelsFromAppServer({ models: [{ id: 'a', name: 'First' }, { id: ' a ', name: 'Second' }] }),
      [{ id: 'a', label: 'First' }],
    );
  });

  it('displayName/name become label ONLY when they differ from the id', () => {
    assert.deepStrictEqual(
      codexModelsFromAppServer({
        models: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b-nice' }, { id: 'c', displayName: 'c' }, { id: 'd' }],
      }),
      [{ id: 'a' }, { id: 'b', label: 'b-nice' }, { id: 'c' }, { id: 'd' }],
    );
  });

  it('supports string and object elements of supportedReasoningEfforts, dropping blanks/dups and keeping order', () => {
    const entries = codexModelsFromAppServer({
      models: [
        { id: 'strings', supportedReasoningEfforts: [' medium ', '', 'high', 'low', 'medium', 'none', 'xhigh'] },
        { id: 'objects', supportedReasoningEfforts: [{ effort: 'low' }, { id: 'medium' }, { name: 'high ' }, { effort: '  ' }, { effort: 'low' }, {}] },
        { id: 'empty', supportedReasoningEfforts: [] },
        { id: 'missing' },
      ],
    });
    assert.deepStrictEqual(entries, [
      { id: 'strings', efforts: ['medium', 'high', 'low', 'none', 'xhigh'] },
      { id: 'objects', efforts: ['low', 'medium', 'high'] },
      { id: 'empty' },
      { id: 'missing' },
    ]);
  });

  it('drops a defaultEffort absent from a non-empty efforts list; keeps it when efforts are empty/absent/membership-holding', () => {
    const entries = codexModelsFromAppServer({
      models: [
        { id: 'drop', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'high' },
        { id: 'keep', defaultReasoningEffort: 'low' },
        { id: 'alias', supportedReasoningEfforts: [], defaultEffort: 'high' },
        { id: 'member', supportedReasoningEfforts: ['low', 'high'], defaultEffort: ' high ' },
      ],
    });
    assert.deepStrictEqual(entries, [
      { id: 'drop', efforts: ['low'] },
      { id: 'keep', defaultEffort: 'low' },
      { id: 'alias', defaultEffort: 'high' },
      { id: 'member', efforts: ['low', 'high'], defaultEffort: 'high' },
    ]);
  });

  it('yields [] for unrecognised payloads: undefined, null, number, string, empty object, non-array models', () => {
    assert.deepStrictEqual(codexModelsFromAppServer(undefined), []);
    assert.deepStrictEqual(codexModelsFromAppServer(null), []);
    assert.deepStrictEqual(codexModelsFromAppServer(42), []);
    assert.deepStrictEqual(codexModelsFromAppServer('x'), []);
    assert.deepStrictEqual(codexModelsFromAppServer({}), []);
    assert.deepStrictEqual(codexModelsFromAppServer({ models: 'nope' }), []);
  });

  it('never writes an own undefined key on any entry', () => {
    const entries = codexModelsFromAppServer({
      models: [
        { id: 'a', name: 'a', supportedReasoningEfforts: [], defaultEffort: undefined },
        { id: 'b', displayName: 'B' },
        'c',
      ],
    });
    assert.strictEqual(entries.length, 3);
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        assert.ok(Object.prototype.hasOwnProperty.call(entry, key));
        assert.notStrictEqual(
          (entry as unknown as Record<string, unknown>)[key],
          undefined,
          `own key ${key} must never carry an undefined value`,
        );
      }
    }
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entries[0], 'label'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entries[0], 'efforts'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entries[0], 'defaultEffort'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entries[1], 'defaultEffort'), false);
  });

  it('never mutates the payload it parses (frozen and snapshot-checked)', () => {
    const payload = {
      models: [
        { id: 'a', name: 'A', supportedReasoningEfforts: ['low', 'low'], defaultReasoningEffort: 'medium' },
        'b',
      ],
    };
    const before = JSON.stringify(payload);
    // 'medium' is not a member of the model's non-empty ['low'] list, so the
    // parser drops the defaultEffort the response tried to select.
    assert.deepStrictEqual(codexModelsFromAppServer(payload), [
      { id: 'a', label: 'A', efforts: ['low'] },
      { id: 'b' },
    ]);
    assert.strictEqual(JSON.stringify(payload), before);

    const frozen = Object.freeze({
      models: Object.freeze([Object.freeze({ id: 'c', displayName: Object.freeze(['C']), name: 'c' })]),
    });
    assert.deepStrictEqual(codexModelsFromAppServer(frozen), [{ id: 'c' }]);
  });
});

/**
 * `discoverModels` (model-selector-refresh T05) drives one fake
 * `codex app-server` child (injected via `new CodexAdapter({ spawnAppServer
 * })`, the `fakeFetcher` pattern of test/adapter.claude.test.ts): no
 * `child_process` monkey-patching, no real spawn. It pins the JSONL framing,
 * the three-message handshake, the per-model effort mapping and union, the
 * never-reject contract on every failure path, and the always-kill teardown.
 */
describe('CodexAdapter.discoverModels (model-selector-refresh T05)', () => {
  /** The `model/list` result the happy script answers with. */
  const DISCOVERED_RESULT = {
    models: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5-codex',
        supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'low',
      },
    ],
  };

  /** Build a DiscoveryContext with sensible defaults overridable per test. */
  function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
    return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides };
  }

  /** The emit surface a test script drives against the running fake. */
  interface FakeApi {
    stdout(chunk: string | Buffer): void;
    reply(message: unknown): void;
    error(error: unknown): void;
    exit(code: number | null): void;
    close(code: number | null): void;
  }

  /** The script callbacks a fake app-server exposes to each test. */
  type AppServerScript = {
    onLine?: (line: unknown, api: FakeApi) => void;
    onSpawn?: (api: FakeApi) => void;
  };

  /**
   * Build the fake spawner/child over plain listener arrays: `stdin.write`
   * records the chunk into `writes` and hands each parsed line to
   * `script.onLine`; `api.*` deliveries reach the adapter asynchronously
   * (`setImmediate`), so the adapter's promise wiring is exercised.
   */
  function fakeAppServer(script: AppServerScript): {
    spawner: CodexAppServerSpawner;
    calls: Array<{ cwd?: string }>;
    writes: string[];
    api: FakeApi;
    kills: () => number;
  } {
    const calls: Array<{ cwd?: string }> = [];
    const writes: string[] = [];
    const stdoutListeners: Array<(chunk: Buffer | string) => void> = [];
    const stderrListeners: Array<(chunk: Buffer | string) => void> = [];
    const errorListeners: Array<(...args: unknown[]) => void> = [];
    const exitListeners: Array<(...args: unknown[]) => void> = [];
    const closeListeners: Array<(...args: unknown[]) => void> = [];
    let killCount = 0;

    const api: FakeApi = {
      stdout(chunk: string | Buffer): void {
        setImmediate(() => {
          for (const listener of stdoutListeners) {
            listener(chunk);
          }
        });
      },
      reply(message: unknown): void {
        api.stdout(`${JSON.stringify(message)}\n`);
      },
      error(error: unknown): void {
        setImmediate(() => {
          for (const listener of errorListeners) {
            listener(error);
          }
        });
      },
      exit(code: number | null): void {
        setImmediate(() => {
          for (const listener of exitListeners) {
            listener(code, null);
          }
        });
      },
      close(code: number | null): void {
        setImmediate(() => {
          for (const listener of closeListeners) {
            listener(code, null);
          }
        });
      },
    };

    const child: CodexAppServerProcess = {
      stdin: {
        write(chunk: string): unknown {
          writes.push(chunk);
          for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
              continue;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              continue;
            }
            script.onLine?.(parsed, api);
          }
          return true;
        },
        end(): unknown {
          return undefined;
        },
      },
      stdout: {
        on(event: 'data', listener: (chunk: Buffer | string) => void): unknown {
          if (event === 'data') {
            stdoutListeners.push(listener);
          }
          return child;
        },
      },
      stderr: {
        on(event: 'data', listener: (chunk: Buffer | string) => void): unknown {
          if (event === 'data') {
            stderrListeners.push(listener);
          }
          return child;
        },
      },
      on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown {
        if (event === 'error') {
          errorListeners.push(listener);
        } else if (event === 'exit') {
          exitListeners.push(listener);
        } else {
          closeListeners.push(listener);
        }
        return child;
      },
      kill(): unknown {
        killCount += 1;
        return true;
      },
    };

    return {
      spawner: (options) => {
        calls.push({ cwd: options?.cwd });
        setImmediate(() => script.onSpawn?.(api));
        return child;
      },
      calls,
      writes,
      api,
      kills: () => killCount,
    };
  }

  /**
   * The default happy script: answers `initialize` with `{}` and
   * `model/list` with {@link DISCOVERED_RESULT}; the `initialized`
   * notification (no id) is recorded via `writes` and never answered.
   */
  function happyScript(): AppServerScript {
    return {
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
        } else if (message.id === CODEX_APP_SERVER_MODEL_LIST_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, result: DISCOVERED_RESULT });
        }
      },
    };
  }

  /** The writes of a fake handle, each asserted newline-terminated and parsed. */
  function parsedWrites(fake: { writes: string[] }): unknown[] {
    return fake.writes.map((chunk) => {
      assert.ok(
        chunk.endsWith('\n'),
        `every written chunk must be newline-terminated: ${JSON.stringify(chunk)}`,
      );
      return JSON.parse(chunk) as unknown;
    });
  }

  it('happy path: resolves ids with per-model efforts, the union efforts, and the exact three-message handshake', async () => {
    const fake = fakeAppServer(happyScript());
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx());
    assert.ok(caps !== undefined, 'a good handshake must resolve capabilities');
    assert.deepStrictEqual([...caps.models], ['gpt-6-astra', 'gpt-5-codex']);
    assert.ok(caps.modelEntries !== undefined && caps.modelEntries.length === 2);
    assert.deepStrictEqual([...caps.modelEntries], [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      { id: 'gpt-5-codex', efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'low' },
    ]);
    // The first-seen union of the returned levels.
    assert.deepStrictEqual([...caps.efforts], ['low', 'medium', 'high', 'xhigh', 'minimal']);
    for (const key of ['source', 'stale', 'staleReason', 'fetchedAt', 'modelLink']) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(caps, key),
        false,
        `capabilities must carry no own ${key} key`,
      );
    }
    assert.deepStrictEqual(parsedWrites(fake), [
      { jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, method: CODEX_APP_SERVER_INITIALIZE_METHOD, params: { clientInfo: CODEX_APP_SERVER_CLIENT_INFO } },
      { jsonrpc: '2.0', method: CODEX_APP_SERVER_INITIALIZED_NOTIFICATION, params: {} },
      { jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, method: CODEX_APP_SERVER_MODEL_LIST_METHOD, params: {} },
    ]);
    assert.ok(fake.kills() >= 1);
    // A late exit after the settlement is a no-op: the result must not change.
    fake.api.exit(0);
    assert.deepStrictEqual([...caps.models], ['gpt-6-astra', 'gpt-5-codex']);
  });

  it('capabilitiesToCatalogFetch round-trips the ids and the union efforts', async () => {
    const fake = fakeAppServer(happyScript());
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx());
    assert.ok(caps !== undefined);
    const fetch = capabilitiesToCatalogFetch(caps);
    assert.deepStrictEqual(fetch.models.map((entry) => entry.id), ['gpt-6-astra', 'gpt-5-codex']);
    assert.deepStrictEqual([...(fetch.efforts ?? [])], ['low', 'medium', 'high', 'xhigh', 'minimal']);
  });

  it('models with no supportedReasoningEfforts fall the capability efforts back to CODEX_EFFORTS', async () => {
    const fake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
        } else if (message.id === CODEX_APP_SERVER_MODEL_LIST_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, result: { models: [{ id: 'm-a' }, { id: 'm-b' }] } });
        }
      },
    });
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx());
    assert.ok(caps !== undefined);
    assert.deepStrictEqual([...caps.efforts], [...CODEX_EFFORTS]);
    assert.deepStrictEqual([...caps.models], ['m-a', 'm-b']);
    assert.notDeepStrictEqual([...caps.models], [...CODEX_MODELS]);
  });

  it('forwards ctx.cwd to the spawner', async () => {
    const fake = fakeAppServer(happyScript());
    await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx({ cwd: '/repo/workspace' }));
    assert.deepStrictEqual(fake.calls, [{ cwd: '/repo/workspace' }]);
  });

  it('reframes split chunks (one as a Buffer), blank lines, non-JSON lines, notifications and unknown-id requests', async () => {
    const modelListReply = {
      jsonrpc: '2.0',
      id: CODEX_APP_SERVER_MODEL_LIST_ID,
      result: { models: [{ id: 'gpt-6-astra' }, 'gpt-5-codex'] },
    };
    const replyLine = `${JSON.stringify(modelListReply)}\n`;
    const splitAt = 24; // deliberately cuts the JSON mid-line
    const fake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
        }
        // The model/list request is NOT answered here: its response arrives
        // as the split raw chunks queued from onSpawn.
      },
      onSpawn(api) {
        api.stdout('\n');
        api.stdout('not json\n');
        api.stdout(`${JSON.stringify({ jsonrpc: '2.0', method: 'server/progress', params: {} })}\n`);
        api.stdout(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping', params: {} })}\n`);
        api.stdout(Buffer.from(replyLine.slice(0, splitAt)));
        api.stdout(replyLine.slice(splitAt));
        api.stdout('   \n');
      },
    });
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx());
    assert.ok(caps !== undefined, 'the split model/list response must still resolve');
    assert.deepStrictEqual([...caps.models], ['gpt-6-astra', 'gpt-5-codex']);
    // No reply for the notification or the unknown-id request: exactly three writes.
    assert.strictEqual(fake.writes.length, 3);
  });

  it('an initialize JSON-RPC error resolves undefined, writes no model/list request, and kills the child', async () => {
    const fake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, error: { code: -32600, message: 'bad' } });
        }
      },
    });
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx());
    assert.strictEqual(caps, undefined);
    assert.strictEqual(fake.writes.length, 1);
    assert.ok(fake.kills() >= 1);
  });

  it('a model/list JSON-RPC error resolves undefined, kills the child, and logs a non-empty reason', async () => {
    const logs: string[] = [];
    const fake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
        } else if (message.id === CODEX_APP_SERVER_MODEL_LIST_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, error: { code: -32000, message: 'nope' } });
        }
      },
    });
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(
      ctx({ log: (message) => logs.push(message) }),
    );
    assert.strictEqual(caps, undefined);
    assert.ok(fake.kills() >= 1);
    assert.ok(logs.length > 0 && logs.every((message) => message.length > 0), `expected logged reasons: ${JSON.stringify(logs)}`);
  });

  it('a missing binary (ENOENT error) resolves undefined and logs that codex app-server was not found on PATH', async () => {
    const logs: string[] = [];
    const fake = fakeAppServer({
      onSpawn(api) {
        api.error(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
      },
    });
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(
      ctx({ log: (message) => logs.push(message) }),
    );
    assert.strictEqual(caps, undefined);
    assert.ok(fake.kills() >= 1);
    assert.ok(
      logs.includes(`${AGENT_BINARY.codex} ${CODEX_APP_SERVER_SUBCOMMAND} was not found on PATH`),
      `expected the PATH-missing reason, got ${JSON.stringify(logs)}`,
    );
  });

  it('an early exit (and separately an early close) resolves undefined without rejecting', async () => {
    const exitFake = fakeAppServer({ onSpawn: (api) => api.exit(1) });
    assert.strictEqual(
      await new CodexAdapter({ spawnAppServer: exitFake.spawner }).discoverModels(ctx()),
      undefined,
    );
    assert.ok(exitFake.kills() >= 1);

    const closeFake = fakeAppServer({ onSpawn: (api) => api.close(0) });
    assert.strictEqual(
      await new CodexAdapter({ spawnAppServer: closeFake.spawner }).discoverModels(ctx()),
      undefined,
    );
    assert.ok(closeFake.kills() >= 1);
  });

  it('a never-replying child times out (killed exactly once) and logs the timeout reason', async () => {
    const logs: string[] = [];
    const fake = fakeAppServer({}); // onSpawn/onLine both absent: nothing ever replies
    const caps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(
      ctx({ timeoutMs: 30, log: (message) => logs.push(message) }),
    );
    assert.strictEqual(caps, undefined);
    assert.strictEqual(fake.kills(), 1);
    assert.ok(
      logs.some((message) => message.includes(`${AGENT_BINARY.codex} ${CODEX_APP_SERVER_SUBCOMMAND} timed out after 30ms`)),
      `expected the timeout reason, got ${JSON.stringify(logs)}`,
    );
  });

  it('the timeout clamp: timeoutMs 0 still spawns and succeeds; timeoutMs 60_000 does not break an immediate reply', async () => {
    // 0 must clamp UP to DEFAULT_DISCOVERY_TIMEOUT_MS rather than race a 0ms
    // timer against the responses.
    const zeroFake = fakeAppServer(happyScript());
    const zeroCaps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: zeroFake.spawner }).discoverModels(
      ctx({ timeoutMs: 0 }),
    );
    assert.ok(zeroCaps !== undefined, 'timeoutMs 0 must clamp up to the default and still succeed');
    assert.strictEqual(zeroFake.calls.length, 1);
    assert.ok(zeroFake.kills() >= 1);

    // 60_000 is capped by the DEFAULT_DISCOVERY_TIMEOUT_MS ceiling; the
    // ceiling itself cannot be observed without an 8s wait, so pin the
    // clamped timer by an immediate reply still succeeding with kills, not a
    // timeout kill-failure.
    const fastFake = fakeAppServer(happyScript());
    const fastCaps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: fastFake.spawner }).discoverModels(
      ctx({ timeoutMs: 60_000 }),
    );
    assert.ok(fastCaps !== undefined);
    assert.ok(fastFake.kills() >= 1);
  });

  it('an already-aborted signal spawns no process; a mid-flight abort resolves undefined and kills the child', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const alreadyFake = fakeAppServer(happyScript());
    const alreadyCaps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: alreadyFake.spawner }).discoverModels(
      ctx({ signal: stopped.signal }),
    );
    assert.strictEqual(alreadyCaps, undefined);
    assert.strictEqual(alreadyFake.calls.length, 0, 'an aborted refresh must start no process');

    const midflight = new AbortController();
    const midFake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
          setImmediate(() => midflight.abort());
        }
        // Never answers model/list: the abort lands mid-handshake.
      },
    });
    const midCaps: AgentCapabilities | undefined = await new CodexAdapter({ spawnAppServer: midFake.spawner }).discoverModels(
      ctx({ signal: midflight.signal }),
    );
    assert.strictEqual(midCaps, undefined);
    assert.strictEqual(midFake.writes.length, 3, 'initialize, initialized and model/list were already written');
    assert.ok(midFake.kills() >= 1);
  });

  it('a synchronously-throwing spawner and a throwing stdin.write both resolve undefined', async () => {
    const throwingSpawner: CodexAppServerSpawner = () => {
      throw new Error('spawn refused');
    };
    assert.strictEqual(
      await new CodexAdapter({ spawnAppServer: throwingSpawner }).discoverModels(ctx({ timeoutMs: 30 })),
      undefined,
    );

    const brokenChild: CodexAppServerProcess = {
      stdin: {
        write(): unknown {
          throw new Error('EPIPE');
        },
        end(): unknown {
          return undefined;
        },
      },
      stdout: {
        on(): unknown {
          return undefined;
        },
      },
      on(): unknown {
        return undefined;
      },
      kill(): unknown {
        return undefined;
      },
    };
    const brokenSpawner: CodexAppServerSpawner = () => brokenChild;
    assert.strictEqual(
      await new CodexAdapter({ spawnAppServer: brokenSpawner }).discoverModels(ctx({ timeoutMs: 30 })),
      undefined,
    );
  });

  it('an empty discovered list resolves undefined so agentCapabilities() keeps the curated CODEX_MODELS list', async () => {
    const fake = fakeAppServer({
      onLine(line, api) {
        const message = line as { id?: unknown };
        if (message.id === CODEX_APP_SERVER_INITIALIZE_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_INITIALIZE_ID, result: {} });
        } else if (message.id === CODEX_APP_SERVER_MODEL_LIST_ID) {
          api.reply({ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, result: { models: [] } });
        }
      },
    });
    assert.strictEqual(
      await new CodexAdapter({ spawnAppServer: fake.spawner }).discoverModels(ctx()),
      undefined,
    );
  });

  it('the registry wires discoverModels for codex (not antigravity), and the no-arg constructor still works', () => {
    assert.strictEqual(typeof createAdapterRegistry().require('codex').discoverModels, 'function');
    assert.strictEqual(createAdapterRegistry().require('antigravity').discoverModels, undefined);

    // The additive, optional constructor parameter keeps every no-arg call
    // site (src/adapter/index.ts, the launch property test, engineFacade
    // resume) compiling and behaving identically.
    const adapter = new CodexAdapter();
    const launchSpec = adapter.launch(req({ model: 'gpt-6-astra' }));
    assert.strictEqual(launchSpec.shellPath, AGENT_BINARY.codex);
    assert.ok(findPair(launchSpec.shellArgs, '--model', 'gpt-6-astra') >= 0);
    assert.ok(findPair(launchSpec.shellArgs, '--sandbox', CODEX_WORKSPACE_WRITE_SANDBOX) >= 0);
    const attachSpec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });
    assert.strictEqual(attachSpec.shellPath, AGENT_BINARY.codex);
    assert.strictEqual(attachSpec.shellArgs[0], 'resume');
  });
});
