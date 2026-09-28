import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AntigravityAdapter,
  ANTIGRAVITY_PLAN_MODE,
  ANTIGRAVITY_ACCEPT_EDITS_MODE,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_EFFORT_VOCABULARY,
  ANTIGRAVITY_MODELS_ARGS,
  antigravityModelsFromCliOutput,
  ANTIGRAVITY_HOOK_ALLOW_GRANTS,
  ANTIGRAVITY_SKIP_PERMISSIONS_FLAG,
  ANTIGRAVITY_RELAY_HOOK_NAME,
  ANTIGRAVITY_RELAY_HOOK_SCRIPT,
  ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS,
  ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS,
  antigravityAskRelayHookCommand,
  antigravityAskRelayHooks,
  antigravityRelayHooksPath,
  antigravityModeFlags,
  antigravityModelFlags,
} from '../src/adapter/antigravity';
import type { AskRelayDescriptor, DiscoveryContext, LaunchRequest } from '../src/adapter/adapter';
import { AGENT_BINARY, AdapterLaunchError, DEFAULT_DISCOVERY_TIMEOUT_MS } from '../src/adapter/adapter';
import { isReadOnlyRole, shellQuote } from '../src/adapter/permissions';
import { ROLES } from '../src/model/role';
import { askRelayDescriptor, parseAsk } from '../src/engine/askRelay';

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
 * - one documented degrade: `req.sessionId` is ignored on a fresh launch;
 * - the native ask relay: the launcher-written `hooks.json`, the guarded
 *   `--dangerously-skip-permissions`, and the hook script's deny degrade;
 * - model discovery: the pure `agy models` parser (family grouping from the
 *   `low|medium|high|max` id suffixes, fixed ids, labels, totality) and
 *   `discoverModels`'s never-reject / never-fall-back-to-the-curated-table
 *   contract, always through an injected `runModelsCli` so no test spawns the
 *   real `agy`.
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

/**
 * The native antigravity ask relay, as probed in README.md, "Harness ask
 * relay (per-adapter probe findings)" (`agy` 1.2.8, 2026-09-22): a
 * `PreToolUse` hook in `.baiton/runs/<run-id>/.agents/hooks.json` that the
 * LAUNCHER writes (`relayFiles()` only computes it — the adapter stays pure),
 * loaded because the absolute run directory is an `--add-dir` workspace, and
 * made the sole permission authority with `--dangerously-skip-permissions`
 * because the hook's `allow` cannot grant on its own. The flag is guarded:
 * it is never emitted unless the launcher has promised the hook file.
 */
describe('AntigravityAdapter native ask relay (probe findings, agy 1.2.8)', () => {
  const adapter = new AntigravityAdapter();
  const relay = askRelayDescriptor('/repo', 'run-123');
  const hooksPath = antigravityRelayHooksPath('run-123');
  const relayed = (overrides: Partial<LaunchRequest> = {}): LaunchRequest =>
    req({ relay, relayFiles: [hooksPath], ...overrides });

  it('pins the probe outcome: the hook allow does not grant, so the relay needs skip-permissions', () => {
    assert.strictEqual(ANTIGRAVITY_HOOK_ALLOW_GRANTS, false);
    assert.strictEqual(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG, '--dangerously-skip-permissions');
  });

  it('relayFiles returns exactly the run-dir hooks.json, relative to the workspace root', () => {
    const files = adapter.relayFiles(relay);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, '.baiton/runs/run-123/.agents/hooks.json');
    assert.ok(files[0].path.startsWith('.baiton/runs/run-123/'), 'the file stays inside the run dir');
  });

  it('relayFiles content is one named PreToolUse hook matching every tool', () => {
    const [file] = adapter.relayFiles(relay);
    const parsed = JSON.parse(file.content) as Record<
      string,
      { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] }
    >;
    assert.deepStrictEqual(Object.keys(parsed), [ANTIGRAVITY_RELAY_HOOK_NAME]);
    const groups = parsed[ANTIGRAVITY_RELAY_HOOK_NAME].PreToolUse;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].matcher, '*');
    assert.strictEqual(groups[0].hooks.length, 1);
    const handler = groups[0].hooks[0];
    assert.strictEqual(handler.type, 'command');
    assert.strictEqual(handler.timeout, ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS);
    assert.strictEqual(handler.command, antigravityAskRelayHookCommand(relay));
    assert.deepStrictEqual(parsed, antigravityAskRelayHooks(relay));
  });

  it('the hook command runs the script with node -e and passes every parameter shell-quoted as argv', () => {
    const command = antigravityAskRelayHookCommand(relay);
    assert.ok(command.startsWith(`node -e ${shellQuote(ANTIGRAVITY_RELAY_HOOK_SCRIPT)} `));
    assert.ok(command.includes(shellQuote(relay.dir)), `missing dir: ${command}`);
    assert.ok(command.includes(shellQuote(relay.askSuffix)), `missing askSuffix: ${command}`);
    assert.ok(command.includes(shellQuote(relay.responseSuffix)), `missing responseSuffix: ${command}`);
    assert.ok(command.includes(shellQuote(relay.runId)), `missing runId: ${command}`);
    assert.ok(command.endsWith(` ${ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS * 1000}`));
    assert.ok(ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS < ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS);
    // The script is wrapped in single quotes, so it can never contain one.
    assert.ok(!ANTIGRAVITY_RELAY_HOOK_SCRIPT.includes("'"), 'the hook script must contain no single quote');
  });

  it('relayFiles returns nothing for an unknown protocol', () => {
    const future = { ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor;
    assert.deepStrictEqual(adapter.relayFiles(future), []);
  });

  it('a relay launch adds the absolute run dir and skip-permissions before the prompt', () => {
    const args = adapter.launch(relayed()).shellArgs;
    const plain = adapter.launch(req()).shellArgs;
    const prompt = args.indexOf('--prompt-interactive');
    assert.ok(findPair(args, '--add-dir', '.baiton/runs/run-123/') >= 0, 'the relative grant is kept');
    const abs = findPair(args, '--add-dir', '/repo/.baiton/runs/run-123');
    assert.ok(abs >= 0 && abs < prompt, `absolute run dir before the prompt: ${JSON.stringify(args)}`);
    const skip = args.indexOf(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    assert.ok(skip >= 0 && skip < prompt, `skip-permissions before the prompt: ${JSON.stringify(args)}`);
    // Nothing else changes.
    assert.deepStrictEqual(
      args.filter((a, i) => a !== ANTIGRAVITY_SKIP_PERMISSIONS_FLAG && i !== abs && i !== abs + 1),
      plain,
    );
  });

  it('never emits skip-permissions without a relay', () => {
    for (const role of ROLES) {
      assert.ok(!adapter.launch(req({ role })).shellArgs.includes(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG));
      assert.ok(!adapter.launch(req({ role, relay: undefined })).shellArgs.includes(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG));
    }
  });

  it('refuses a relay launch whose hook file the launcher did not promise to write', () => {
    assert.throws(() => adapter.launch(req({ relay })), AdapterLaunchError);
    assert.throws(() => adapter.launch(req({ relay, relayFiles: [] })), AdapterLaunchError);
    assert.throws(
      () => adapter.launch(req({ relay, relayFiles: ['.baiton/runs/other/.agents/hooks.json'] })),
      AdapterLaunchError,
    );
  });

  it('refuses a relay whose descriptor does not name this run under an absolute .baiton/runs dir', () => {
    const otherRun = askRelayDescriptor('/repo', 'run-999');
    assert.throws(() => adapter.launch(relayed({ relay: otherRun })), AdapterLaunchError);
    const relative = { ...relay, dir: '.baiton/runs/run-123/asks' };
    assert.throws(() => adapter.launch(relayed({ relay: relative })), AdapterLaunchError);
    const elsewhere = { ...relay, dir: '/tmp/somewhere/asks' };
    assert.throws(() => adapter.launch(relayed({ relay: elsewhere })), AdapterLaunchError);
  });

  it('ignores an unknown protocol: the launch is byte-identical to no relay', () => {
    const future = { ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor;
    assert.deepStrictEqual(adapter.launch(req({ relay: future })), adapter.launch(req()));
  });

  it('keeps every role on its own --mode and carries no env layer', () => {
    for (const role of ROLES) {
      const spec = adapter.launch(relayed({ role }));
      assert.strictEqual(spec.env, undefined);
      const mode = spec.shellArgs[spec.shellArgs.indexOf('--mode') + 1];
      assert.strictEqual(mode, isReadOnlyRole(role) ? ANTIGRAVITY_PLAN_MODE : ANTIGRAVITY_ACCEPT_EDITS_MODE);
      assert.ok(!spec.shellArgs.includes('--sandbox'));
      assert.ok(!spec.shellArgs.join(' ').includes('hooks.json'), 'the hook path never reaches the argv');
    }
  });

  it('carries the relay on both resume branches', () => {
    for (const resume of [{ resumeSessionId: 'sess-real' }, { resumeSessionId: undefined }]) {
      const args = adapter.launch(relayed({ resume: true, ...resume })).shellArgs;
      assert.ok(args.includes(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG));
    }
  });

  it('attach() installs no relay and never emits skip-permissions', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-777', sessionId: 'sess-1' });
    assert.ok(!spec.shellArgs.includes(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG));
    assert.ok(!spec.shellArgs.join(' ').includes('hooks.json'));
  });

  /**
   * Round-trip behaviour of the emitted script, fed the stdin event shape the
   * probe observed (`{toolCall:{name, args}, …}`): the ask it writes parses
   * through `parseAsk`, and its stdout follows the response — approve→allow,
   * anything else→deny — and every failure degrades to deny, never allow.
   * Argv order mirrors the hook command: asks dir, ask suffix, response
   * suffix, run id, deadline in ms.
   */
  function runHook(
    stdin: string,
    deadlineMs: number,
    respond?: (asksDir: string, askFile: string) => void,
  ): Promise<{ stdout: string; code: number | null; asksDir: string }> {
    const asksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-agy-relay-'));
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(
        process.execPath,
        ['-e', ANTIGRAVITY_RELAY_HOOK_SCRIPT, asksDir, '.json', '.response.json', 'run-123', String(deadlineMs)],
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

  const event = JSON.stringify({
    conversationId: 'c-1',
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'echo baiton-probe', Cwd: '/repo' } },
  });

  function answer(decision: 'approve' | 'deny', reason?: string) {
    return (asksDir: string, askFile: string): void => {
      const raw = fs.readFileSync(path.join(asksDir, askFile), 'utf8');
      const parsed = parseAsk(raw);
      assert.ok(parsed.ok, `the ask parses: ${parsed.ok ? '' : parsed.error.message}`);
      if (parsed.ok) {
        assert.strictEqual(parsed.value.agent, 'antigravity');
        assert.strictEqual(parsed.value.kind, 'permission');
        assert.strictEqual(parsed.value.runId, 'run-123');
        assert.strictEqual(parsed.value.tool, 'run_command');
        assert.deepStrictEqual(JSON.parse(parsed.value.args ?? '{}'), {
          CommandLine: 'echo baiton-probe',
          Cwd: '/repo',
        });
        fs.writeFileSync(
          path.join(asksDir, parsed.value.id + '.response.json'),
          JSON.stringify({ version: 1, id: parsed.value.id, decision, ...(reason ? { reason } : {}) }),
        );
      }
    };
  }

  it('writes a parseAsk-valid ask and prints allow on approve', async () => {
    const { stdout, code, asksDir } = await runHook(event, 10_000, answer('approve'));
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), { decision: 'allow' });
  });

  it('prints deny with the reason on a deny response', async () => {
    const { stdout, code, asksDir } = await runHook(event, 10_000, answer('deny', 'not today'));
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), { decision: 'deny', reason: 'not today' });
  });

  it('degrades to deny (not allow) when no answer arrives before the deadline', async () => {
    const { stdout, code, asksDir } = await runHook(event, 300);
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    const out = JSON.parse(stdout) as { decision: string; reason: string };
    assert.strictEqual(out.decision, 'deny');
    assert.ok(/timed out/.test(out.reason));
  });

  it('degrades to deny on an unparseable event, writing no ask', async () => {
    const { stdout, code, asksDir } = await runHook('not json', 10_000);
    const written = fs.readdirSync(asksDir);
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.strictEqual((JSON.parse(stdout) as { decision: string }).decision, 'deny');
    assert.deepStrictEqual(written, []);
  });

  it('denies outright, without asking, any tool call that names an .agents hooks.json', async () => {
    const tamper = JSON.stringify({
      toolCall: {
        name: 'write_to_file',
        args: { TargetFile: '/repo/.baiton/runs/run-123/.agents/hooks.json', CodeContent: '{}' },
      },
    });
    const { stdout, code, asksDir } = await runHook(tamper, 10_000);
    const written = fs.readdirSync(asksDir);
    fs.rmSync(asksDir, { recursive: true, force: true });
    assert.strictEqual(code, 0);
    assert.strictEqual((JSON.parse(stdout) as { decision: string }).decision, 'deny');
    assert.deepStrictEqual(written, []);
  });
});

/** The checked-in `agy models` listing the discovery suites read. */
const AGY_MODELS_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'agyModels.sample.txt'), 'utf8');

/** A discovery context with sensible defaults, overridable per test. */
function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return { timeoutMs: 1_000, ...overrides };
}

describe('antigravityModelsFromCliOutput (codex-opencode-dropdown-fix T04)', () => {
  const entries = antigravityModelsFromCliOutput(AGY_MODELS_FIXTURE);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  it('groups sibling suffixed ids into one family carrying its levels in listing order', () => {
    for (const family of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']) {
      assert.deepStrictEqual([...(byId.get(family)?.efforts ?? [])], ['low', 'medium', 'high'], family);
    }
    assert.deepStrictEqual([...(byId.get('gemini-3.1-pro')?.efforts ?? [])], ['low', 'high']);
    for (const member of ['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-3.1-pro-low']) {
      assert.strictEqual(byId.has(member), false, member);
    }
  });

  it('takes the family label from its first member with the trailing level parenthesis removed', () => {
    assert.strictEqual(byId.get('gemini-3.8-flash')?.label, 'Gemini 3.8 Flash');
    assert.strictEqual(byId.get('gemini-3.7-flash')?.label, 'Gemini 3.7 Flash');
    assert.strictEqual(byId.get('gemini-3.6-flash')?.label, 'Gemini 3.6 Flash');
    assert.strictEqual(byId.get('gemini-3.1-pro')?.label, 'Gemini 3.1 Pro');
  });

  it('keeps a fixed id as its own entry with no efforts, and a lone suffix forms no family', () => {
    for (const fixed of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
      assert.deepStrictEqual([...(byId.get(fixed)?.efforts ?? ['missing'])], [], fixed);
    }
    assert.strictEqual(byId.has('gpt-oss-120b'), false);
    // An unrelated trailing parenthesis is NOT a level, so it stays.
    assert.strictEqual(byId.get('claude-opus-4-6-thinking')?.label, 'Claude Opus 4.6 (Thinking)');
  });

  it('reproduces the curated ANTIGRAVITY_MODELS table exactly (drift guard)', () => {
    assert.deepStrictEqual(
      entries.map((entry) => entry.id),
      Object.keys(ANTIGRAVITY_MODELS),
    );
    for (const entry of entries) {
      assert.deepStrictEqual([...(entry.efforts ?? [])], ANTIGRAVITY_MODELS[entry.id], entry.id);
    }
    const union: string[] = [];
    for (const entry of entries) {
      for (const effort of entry.efforts ?? []) {
        if (!union.includes(effort)) {
          union.push(effort);
        }
      }
    }
    assert.deepStrictEqual(union, [...ANTIGRAVITY_EFFORTS]);
  });

  it('carries no defaultEffort, provider or custom key', () => {
    for (const entry of entries) {
      for (const key of ['defaultEffort', 'provider', 'custom']) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, key), false, `${entry.id}.${key}`);
      }
    }
  });

  it('strips ANSI escapes around ids and labels', () => {
    const coloured = AGY_MODELS_FIXTURE.split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `\u001B[32m${line}\u001B[0m`)
      .join('\n');
    assert.deepStrictEqual(antigravityModelsFromCliOutput(coloured), entries);
  });

  it('ignores blank, whitespace-only, bulleted and duplicate lines', () => {
    const noisy =
      '\n   \n' +
      AGY_MODELS_FIXTURE.split('\n')
        .filter((line) => line.length > 0)
        .map((line, index) => (index === 0 ? `  * ${line}\n${line}` : line))
        .join('\n') +
      '\n\n';
    assert.deepStrictEqual(antigravityModelsFromCliOutput(noisy), entries);
  });

  it('omits the label own key for a line with no tab', () => {
    const [entry] = antigravityModelsFromCliOutput('some-model\n');
    assert.strictEqual(entry?.id, 'some-model');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry ?? {}, 'label'), false);
  });

  it('yields [] for empty, blank-only and prose-only output', () => {
    assert.deepStrictEqual(antigravityModelsFromCliOutput(''), []);
    assert.deepStrictEqual(antigravityModelsFromCliOutput('\n\n'), []);
    assert.deepStrictEqual(
      antigravityModelsFromCliOutput('Loading models, please wait...\nyou are not signed in\n'),
      [],
    );
  });

  it('never throws on adversarial input', () => {
    // A bare `-low` loses its leading dash to the bullet/marker strip, so it is
    // an unsuffixed id (`low`) rather than a zero-length stem.
    assert.deepStrictEqual(
      antigravityModelsFromCliOutput('-low\n').map((entry) => entry.id),
      ['low'],
    );
    // A zero-length stem reached without the bullet strip is skipped as a family.
    assert.deepStrictEqual(
      antigravityModelsFromCliOutput('x\t-low\nn-low\tN (Low)\nn-high\tN (High)\n').map((entry) => entry.id),
      ['x', 'n'],
    );
    assert.deepStrictEqual(
      antigravityModelsFromCliOutput('weird-1-max\tWeird 1 (Max)\n').map((entry) => entry.id),
      ['weird-1-max'],
    );
    const withMax = antigravityModelsFromCliOutput('m-low\tM (Low)\nm-max\tM (Max)\n');
    assert.deepStrictEqual(withMax, [{ id: 'm', label: 'M', efforts: ['low', 'max'] }]);
    assert.deepStrictEqual(antigravityModelsFromCliOutput('\t\t\n'), []);
    // A stem that is also listed bare: the family entry wins, emitted once.
    assert.deepStrictEqual(
      antigravityModelsFromCliOutput('m\tM\nm-low\tM (Low)\nm-high\tM (High)\n').map((entry) => entry.id),
      ['m'],
    );
  });
});

describe('AntigravityAdapter.discoverModels (codex-opencode-dropdown-fix T04)', () => {
  it('spawns plain `agy models` with no undocumented flag', () => {
    assert.deepStrictEqual([...ANTIGRAVITY_MODELS_ARGS], ['models']);
    assert.deepStrictEqual([...ANTIGRAVITY_EFFORT_VOCABULARY], ['low', 'medium', 'high', 'max']);
  });

  it('turns the fixture listing into capabilities with per-family efforts and no provenance', async () => {
    const adapter = new AntigravityAdapter({ runModelsCli: async () => AGY_MODELS_FIXTURE });
    const caps = await adapter.discoverModels(ctx());
    assert.ok(caps !== undefined);
    assert.deepStrictEqual([...caps.models], Object.keys(ANTIGRAVITY_MODELS));
    assert.deepStrictEqual([...caps.efforts], ['low', 'medium', 'high']);
    assert.deepStrictEqual(
      (caps.modelEntries ?? []).map((entry) => [entry.id, [...(entry.efforts ?? [])]]),
      Object.entries(ANTIGRAVITY_MODELS).map(([id, efforts]) => [id, [...efforts]]),
    );
    for (const key of ['source', 'stale', 'staleReason', 'fetchedAt', 'modelLink']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(caps, key), false, key);
    }
  });

  it('never inspects the exit code: stdout from a failed run still yields the entries', async () => {
    // The seam resolves stdout regardless of how the process exited, so a
    // non-zero exit with a good listing must still be parsed (agy exits 0 even
    // on an error, so the code carries no signal at all).
    const adapter = new AntigravityAdapter({ runModelsCli: async () => AGY_MODELS_FIXTURE });
    const caps = await adapter.discoverModels(ctx());
    assert.deepStrictEqual([...(caps?.models ?? [])], Object.keys(ANTIGRAVITY_MODELS));
  });

  it('resolves undefined — never the curated table — for no output, empty output and prose', async () => {
    for (const stdout of [undefined, '', 'agy: not signed in\n']) {
      const adapter = new AntigravityAdapter({ runModelsCli: async () => stdout });
      assert.strictEqual(await adapter.discoverModels(ctx()), undefined, String(stdout));
    }
  });

  it('resolves undefined when the runner rejects or throws synchronously', async () => {
    const rejecting = new AntigravityAdapter({ runModelsCli: async () => Promise.reject(new Error('boom')) });
    assert.strictEqual(await rejecting.discoverModels(ctx()), undefined);
    const throwing = new AntigravityAdapter({
      runModelsCli: () => {
        throw new Error('boom');
      },
    });
    assert.strictEqual(await throwing.discoverModels(ctx()), undefined);
  });

  it('spawns nothing for an already-aborted signal', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = new AntigravityAdapter({
      runModelsCli: async () => {
        calls += 1;
        return AGY_MODELS_FIXTURE;
      },
    });
    assert.strictEqual(await adapter.discoverModels(ctx({ signal: controller.signal })), undefined);
    assert.strictEqual(calls, 0);
  });

  it('resolves undefined when the signal aborts while the runner is pending', async () => {
    const controller = new AbortController();
    const adapter = new AntigravityAdapter({
      runModelsCli: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(AGY_MODELS_FIXTURE), 5_000).unref?.();
        }),
    });
    const pending = adapter.discoverModels(ctx({ signal: controller.signal }));
    controller.abort();
    assert.strictEqual(await pending, undefined);
  });

  it('resolves undefined on a timeout without hanging', async () => {
    const adapter = new AntigravityAdapter({
      runModelsCli: () => new Promise<string>(() => undefined),
    });
    assert.strictEqual(await adapter.discoverModels(ctx({ timeoutMs: 20 })), undefined);
  });

  it('passes ctx.cwd through and clamps the timeout to DEFAULT_DISCOVERY_TIMEOUT_MS', async () => {
    const seen: { cwd?: string; timeoutMs: number }[] = [];
    const adapter = new AntigravityAdapter({
      runModelsCli: async (options) => {
        seen.push(options);
        return AGY_MODELS_FIXTURE;
      },
    });
    await adapter.discoverModels(ctx({ cwd: '/repo', timeoutMs: 10 * DEFAULT_DISCOVERY_TIMEOUT_MS }));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.cwd, '/repo');
    assert.ok((seen[0]?.timeoutMs ?? 0) <= DEFAULT_DISCOVERY_TIMEOUT_MS);
  });
});
