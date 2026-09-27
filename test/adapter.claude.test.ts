import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ID_PREFIX,
  CLAUDE_MODELS,
  CLAUDE_REQUIRED_MODEL,
  ClaudeAdapter,
  ClaudeCatalogReader,
  ClaudeFeedFetcher,
  CLAUDE_CATALOG_SURFACE,
  claudeModelsFromCatalog,
  claudeModelsFromFeed,
  claudeSystemPromptFlags,
} from '../src/adapter/claude';
import { createAdapterRegistry, AskRelayDescriptor } from '../src/adapter';
import {
  AGENT_BINARY,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  capabilitiesToCatalogFetch,
} from '../src/adapter/adapter';
import type {
  AgentCapabilities,
  DiscoveryContext,
  LaunchRequest,
} from '../src/adapter/adapter';
import type { FeedProvider, ModelsDevFeed } from '../src/orchestrator/modelsDev';
import { parseModelsDevFeed } from '../src/orchestrator/modelsDev';
import { err, isOk, ok } from '../src/model/result';
import type { Result } from '../src/model/result';
import {
  ACCEPT_EDITS_MODE,
  CLAUDE_RELAY_HOOK_MATCHER,
  CLAUDE_RELAY_HOOK_SCRIPT,
  CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS,
  DEFAULT_PERMISSION_MODE,
  PermissionMode,
  READ_ONLY_ALLOWED_TOOLS,
  READ_ONLY_ROLES,
  claudeRelayFlags,
  permissionFlags,
  shellQuote,
} from '../src/adapter/permissions';
import {
  RelayResponse,
  askRelayDescriptor,
  parseAsk,
  writeResponse,
} from '../src/engine/askRelay';
import { roleProfile } from '../src/adapter/roleProfile';
import { Role, ROLES } from '../src/model/role';
import { defaultConfig } from '../src/config/defaultConfig';

/**
 * Task 9.3 — focused unit tests for the Claude adapter's probe shape and its
 * continue-flag / read-only-fallback launch branches. These complement the
 * per-role permission-table property test in `adapter.launch.property.test.ts`
 * by pinning the concrete contracts the design calls out:
 *
 * - the probe returns a `{version, ok, reason?}` shape and, when it cannot run
 *   the CLI, reports `ok: false` with a non-empty reason (Requirements 14.2,
 *   14.3, 14.4);
 * - a first attempt (no prior session) launches without the continue flag,
 *   while a resume prepends `-c` as the leading argument (Requirements 13.2,
 *   13.3);
 * - the read-only `acceptEdits` fallback arg set is emitted for read-only roles
 *   exactly when `PermissionMode.readOnlyFallbackToAcceptEdits` is true, and is
 *   otherwise the scoped `Write(...)` allow-list (Requirement 15.7);
 * - `--append-system-prompt` carries the role profile's prose policy on both
 *   launch and attach, for every role.
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

describe('ClaudeAdapter probe shape (Req 14.2, 14.3, 14.4)', () => {
  it('reports ok:false with a non-empty reason and empty version when the CLI is missing', async () => {
    // Drive the probe against an empty PATH so the `claude` binary cannot be
    // resolved. This exercises the real failure path without depending on a
    // real `claude` install (Req 14.4: a non-empty reason must be returned).
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const adapter = new ClaudeAdapter();
      const result = await adapter.probe();

      // Shape contract (Req 14.3): a version string and a boolean ok.
      assert.strictEqual(typeof result.version, 'string');
      assert.strictEqual(typeof result.ok, 'boolean');

      // The missing binary is not usable.
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.version, '');

      // Req 14.4: ok:false carries a non-empty explanation.
      assert.strictEqual(typeof result.reason, 'string');
      assert.ok(
        (result.reason as string).length > 0,
        `expected a non-empty reason, got ${JSON.stringify(result.reason)}`,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('returns a value conforming to the ProbeResult shape regardless of outcome', async () => {
    // Whatever the host state, probe() must resolve to the documented shape:
    // { version: string, ok: boolean, reason?: string } and never reject
    // (Req 14.2/14.3 — the probe runs before every stage and reports readiness).
    const adapter = new ClaudeAdapter();
    const result = await adapter.probe();

    assert.strictEqual(typeof result.version, 'string');
    assert.strictEqual(typeof result.ok, 'boolean');
    if (result.ok) {
      // A usable CLI reports a version and omits the reason.
      assert.ok(result.version.length > 0);
      assert.strictEqual(result.reason, undefined);
    } else {
      // An unusable CLI must explain why (Req 14.4).
      assert.strictEqual(typeof result.reason, 'string');
      assert.ok((result.reason as string).length > 0);
    }
  });
});

describe('ClaudeAdapter session-id / continue-flag branches (Req 3.1, 3.2, 13.2, 13.3)', () => {
  const adapter = new ClaudeAdapter();

  it('prepends --session-id on a fresh launch (Req 3.1)', () => {
    const spec = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['--session-id', 'session-xyz']);
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--resume'));
  });

  it('falls back to the continue flag on resume with no prior Session_Id (Req 3.2, 13.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: undefined }));
    assert.strictEqual(
      spec.shellArgs[0],
      '-c',
      `resume without a session id must lead with -c: ${JSON.stringify(spec.shellArgs)}`,
    );
    assert.strictEqual(spec.shellArgs.filter((a) => a === '-c').length, 1);
    assert.ok(!spec.shellArgs.includes('--session-id'));
    assert.ok(!spec.shellArgs.includes('--resume'));
  });

  it('prepends --resume <id> on resume with a prior Session_Id (Req 3.2)', () => {
    const spec = adapter.launch(req({ resume: true, resumeSessionId: 'prior-session' }));
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['--resume', 'prior-session']);
    assert.ok(!spec.shellArgs.includes('-c'));
    assert.ok(!spec.shellArgs.includes('--session-id'));
  });

  it('keeps the fresh and no-session-id-resume branches otherwise identical', () => {
    const fresh = adapter.launch(req({ resume: false, sessionId: 'session-xyz' }));
    const resumed = adapter.launch(req({ resume: true, resumeSessionId: undefined }));

    // Dropping the leading --session-id pair / -c yields the same tail.
    assert.deepStrictEqual(fresh.shellArgs.slice(2), resumed.shellArgs.slice(1));
  });
});

describe('ClaudeAdapter attach() (Req 3.3, 3.4)', () => {
  const adapter = new ClaudeAdapter();

  it('builds --resume <id> with no prompt, plus permission flags and the run-dir grant', () => {
    const spec = adapter.attach({ role: 'executor', runId: 'run-9', sessionId: 'session-42' });

    assert.strictEqual(spec.shellPath, 'claude');
    assert.deepStrictEqual(spec.shellArgs.slice(0, 2), ['--resume', 'session-42']);
    assert.ok(
      findPair(spec.shellArgs, '--permission-mode', ACCEPT_EDITS_MODE) >= 0,
      `expected executor's permission-mode row: ${JSON.stringify(spec.shellArgs)}`,
    );
    assert.ok(
      findPair(spec.shellArgs, '--add-dir', '.baiton/runs/run-9/') >= 0,
      `expected the per-run write grant: ${JSON.stringify(spec.shellArgs)}`,
    );
    // No prompt is appended.
    assert.ok(!spec.shellArgs.includes('--model'));
  });

  it('uses the role-specific permission row, e.g. the read-only allow-list for planner', () => {
    const spec = adapter.attach({ role: 'planner', runId: 'run-1', sessionId: 'session-1' });
    assert.ok(findPair(spec.shellArgs, '--allowedTools', READ_ONLY_ALLOWED_TOOLS) >= 0);
  });
});

describe('ClaudeAdapter role permission table', () => {
  it('treats the spec writer as a read-only role', () => {
    assert.ok(
      (READ_ONLY_ROLES as readonly string[]).includes('spec-writer'),
      'spec-writer must be read-only: it writes only its result file',
    );
  });

  it('launches the spec writer with the read-only allow-list', () => {
    const spec = new ClaudeAdapter().launch({
      role: 'spec-writer',
      model: 'claude-sonnet-5',
      prompt: 'Read /repo/.baiton/runs/draft-1/brief.md and do what it says.',
      runId: 'draft-1',
      resume: false,
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    assert.ok(findPair(spec.shellArgs, '--allowedTools', READ_ONLY_ALLOWED_TOOLS) >= 0);
  });
});

describe('ClaudeAdapter read-only acceptEdits fallback (Req 15.7)', () => {
  const fallbackMode: PermissionMode = { readOnlyFallbackToAcceptEdits: true };

  for (const role of READ_ONLY_ROLES) {
    it(`emits the acceptEdits fallback arg set for read-only role ${role} when the flip is on`, () => {
      const adapter = new ClaudeAdapter(fallbackMode);
      const spec = adapter.launch(req({ role }));

      // The fallback swaps the scoped Write(...) allow-list for accept-edits.
      assert.ok(
        findPair(spec.shellArgs, '--permission-mode', ACCEPT_EDITS_MODE) >= 0,
        `expected --permission-mode ${ACCEPT_EDITS_MODE} for ${role}: ${JSON.stringify(spec.shellArgs)}`,
      );
      // And it does NOT hand the role the read-only allow-list.
      assert.ok(
        findPair(spec.shellArgs, '--allowedTools', READ_ONLY_ALLOWED_TOOLS) < 0,
        `fallback must not emit the read-only allow-list for ${role}: ${JSON.stringify(spec.shellArgs)}`,
      );
      assert.ok(!spec.shellArgs.includes('--allowedTools'));
    });

    it(`emits the scoped Write(...) allow-list for read-only role ${role} when the flip is off`, () => {
      const adapter = new ClaudeAdapter(DEFAULT_PERMISSION_MODE);
      const spec = adapter.launch(req({ role }));

      // Default mode uses the scoped allow-list, not accept-edits.
      assert.ok(
        findPair(spec.shellArgs, '--allowedTools', READ_ONLY_ALLOWED_TOOLS) >= 0,
        `expected the read-only allow-list for ${role}: ${JSON.stringify(spec.shellArgs)}`,
      );
      assert.ok(
        !spec.shellArgs.includes('--permission-mode'),
        `default read-only mode must not use --permission-mode for ${role}: ${JSON.stringify(spec.shellArgs)}`,
      );
    });
  }

  it('does not affect the executor, which always launches in acceptEdits mode', () => {
    // The fallback flip is a read-only-role concern; the executor's
    // accept-edits row is unchanged whether the flip is on or off (Req 15.3).
    const on = new ClaudeAdapter(fallbackMode).launch(req({ role: 'executor' }));
    const off = new ClaudeAdapter(DEFAULT_PERMISSION_MODE).launch(req({ role: 'executor' }));
    assert.deepStrictEqual(on.shellArgs, off.shellArgs);
    assert.ok(findPair(on.shellArgs, '--permission-mode', ACCEPT_EDITS_MODE) >= 0);
  });

  it('does not affect the reviewer, whose allow-list is unchanged by the flip', () => {
    // The reviewer is not a read-only role, so the flip must not touch its row.
    const reviewer: Role = 'reviewer';
    const on = new ClaudeAdapter(fallbackMode).launch(req({ role: reviewer }));
    const off = new ClaudeAdapter(DEFAULT_PERMISSION_MODE).launch(req({ role: reviewer }));
    assert.deepStrictEqual(on.shellArgs, off.shellArgs);
    assert.ok(on.shellArgs.includes('--allowedTools'));
  });
});

describe('ClaudeAdapter --append-system-prompt carries the role profile', () => {
  const adapter = new ClaudeAdapter();

  for (const role of ROLES) {
    it(`carries ${role}'s profile prompt on launch and attach`, () => {
      const expected = roleProfile(role).systemPrompt;
      assert.deepStrictEqual(claudeSystemPromptFlags(role), ['--append-system-prompt', expected]);

      const launchSpec = adapter.launch(req({ role }));
      assert.ok(
        findPair(launchSpec.shellArgs, '--append-system-prompt', expected) >= 0,
        `expected ${role}'s profile prompt on launch: ${JSON.stringify(launchSpec.shellArgs)}`,
      );
      assert.strictEqual(launchSpec.shellArgs.filter((a) => a === '--append-system-prompt').length, 1);

      const attachSpec = adapter.attach({ role, runId: 'run-1', sessionId: 's-1' });
      assert.ok(
        findPair(attachSpec.shellArgs, '--append-system-prompt', expected) >= 0,
        `expected ${role}'s profile prompt on attach: ${JSON.stringify(attachSpec.shellArgs)}`,
      );
      assert.strictEqual(attachSpec.shellArgs.filter((a) => a === '--append-system-prompt').length, 1);
    });
  }

  // The prompt text is variadic-adjacent and contains spaces and backticks;
  // it must land before the `--` end-of-options marker so the CLI does not
  // swallow the initial user prompt as another flag value.
  it('places the flag before the -- separator, leaving the prompt last', () => {
    const request = req();
    const args = adapter.launch(request).shellArgs;
    const sep = args.indexOf('--');
    assert.ok(sep > 0, `expected a -- separator: ${JSON.stringify(args)}`);
    assert.ok(args.indexOf('--append-system-prompt') < sep);
    assert.strictEqual(args[args.length - 1], request.prompt);
    assert.strictEqual(args[sep + 1], request.prompt);
  });

  it('is unaffected by the readOnlyFallbackToAcceptEdits flip', () => {
    const on = new ClaudeAdapter({ readOnlyFallbackToAcceptEdits: true }).launch(req({ role: 'planner' }));
    const off = new ClaudeAdapter(DEFAULT_PERMISSION_MODE).launch(req({ role: 'planner' }));
    const expected = roleProfile('planner').systemPrompt;
    assert.ok(findPair(on.shellArgs, '--append-system-prompt', expected) >= 0);
    assert.ok(findPair(off.shellArgs, '--append-system-prompt', expected) >= 0);
  });
});

describe('default claude-only config is unchanged by the multi-agent wiring', () => {
  it('selects claude for every role in the default config', () => {
    const config = defaultConfig();
    for (const role of ROLES) {
      assert.strictEqual(config.roles[role].agent, 'claude', `role ${role} must default to claude`);
    }
  });

  it("resolves every default-config role's agent to the claude adapter via the registry", () => {
    const registry = createAdapterRegistry();
    const config = defaultConfig();
    for (const role of ROLES) {
      const adapter = registry.get(config.roles[role].agent);
      assert.ok(adapter, `expected an adapter for role ${role}'s agent ${config.roles[role].agent}`);
      assert.strictEqual(adapter!.id, 'claude');
    }
  });

  it('produces argv through the registry identical to a directly constructed ClaudeAdapter, for every role, fresh and resumed', () => {
    const registry = createAdapterRegistry();
    const direct = new ClaudeAdapter();

    for (const role of ROLES) {
      const freshReq = req({ role, resume: false, sessionId: 'session-fresh' });
      assert.deepStrictEqual(
        registry.require('claude').launch(freshReq),
        direct.launch(freshReq),
        `fresh launch argv diverged for role ${role}`,
      );

      const resumeReq = req({ role, resume: true, resumeSessionId: 'session-prior' });
      assert.deepStrictEqual(
        registry.require('claude').launch(resumeReq),
        direct.launch(resumeReq),
        `resume launch argv diverged for role ${role}`,
      );

      const attachArgs = { role, runId: 'run-attach', sessionId: 'session-attach' };
      assert.deepStrictEqual(
        registry.require('claude').attach(attachArgs),
        direct.attach(attachArgs),
        `attach argv diverged for role ${role}`,
      );
    }
  });

  it('pins the claude adapter shellPath to AGENT_BINARY.claude on both launch and attach', () => {
    const adapter = new ClaudeAdapter();
    const launchSpec = adapter.launch(req());
    const attachSpec = adapter.attach({ role: 'executor', runId: 'run-1', sessionId: 'session-1' });

    assert.strictEqual(launchSpec.shellPath, AGENT_BINARY.claude);
    assert.strictEqual(attachSpec.shellPath, AGENT_BINARY.claude);
  });
});

describe('ClaudeAdapter ask-relay hook wiring', function () {
  this.timeout(10_000);

  const adapter = new ClaudeAdapter();
  // Built with the real producer so the test cannot drift from the relay core.
  const relay = askRelayDescriptor('/repo', 'run-123');

  const noRelayArgs = adapter.launch(req()).shellArgs;
  const relayArgs = adapter.launch(req({ relay })).shellArgs;

  /** Index of the `--settings` value, or -1. */
  function settingsValueIndex(args: string[]): number {
    const flag = args.indexOf('--settings');
    return flag === -1 ? -1 : flag + 1;
  }

  it('with no relay the argv is unchanged (no --settings anywhere)', () => {
    assert.deepStrictEqual(adapter.launch(req()).shellArgs, adapter.launch(req({ relay: undefined })).shellArgs);
    assert.ok(!noRelayArgs.includes('--settings'));
  });

  it('with a file-v1 relay emits exactly one --settings pair before --, prompt still last', () => {
    const flag = relayArgs.indexOf('--settings');
    assert.ok(flag > 0, `expected --settings: ${JSON.stringify(relayArgs)}`);
    assert.strictEqual(relayArgs.filter((a) => a === '--settings').length, 1);
    const sep = relayArgs.indexOf('--');
    assert.ok(flag < sep, `--settings must precede the -- separator: ${JSON.stringify(relayArgs)}`);
    assert.strictEqual(relayArgs[relayArgs.length - 1], req().prompt);
    assert.strictEqual(relayArgs[sep + 1], req().prompt);
  });

  it('dropping the --settings pair from the relay argv yields the no-relay argv', () => {
    const value = settingsValueIndex(relayArgs);
    assert.ok(value > 0);
    const stripped = [...relayArgs.slice(0, value - 1), ...relayArgs.slice(value + 1)];
    assert.deepStrictEqual(stripped, noRelayArgs);
  });

  it('the --settings value parses as JSON with the verified hook shape', () => {
    const value = settingsValueIndex(relayArgs);
    const settings = JSON.parse(relayArgs[value]) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; timeout: number }[] }[] };
    };
    const group = settings.hooks.PreToolUse[0];
    assert.strictEqual(group.matcher, CLAUDE_RELAY_HOOK_MATCHER);
    assert.strictEqual(group.hooks.length, 1);
    assert.strictEqual(group.hooks[0].type, 'command');
    assert.strictEqual(group.hooks[0].timeout, CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS);
  });

  it('the hook command names dir, suffixes and run id, each single-quoted', () => {
    const value = settingsValueIndex(relayArgs);
    const settings = JSON.parse(relayArgs[value]) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(command.includes(shellQuote(relay.dir)), `missing dir: ${command}`);
    assert.ok(command.includes(shellQuote(relay.askSuffix)), `missing askSuffix: ${command}`);
    assert.ok(command.includes(shellQuote(relay.responseSuffix)), `missing responseSuffix: ${command}`);
    assert.ok(command.includes(shellQuote(relay.runId)), `missing runId: ${command}`);
    // The script is wrapped in single quotes, so it can never contain one.
    assert.ok(!CLAUDE_RELAY_HOOK_SCRIPT.includes("'"), 'the hook script must contain no single quote');
  });

  it('a descriptor with an unrecognized protocol emits no --settings', () => {
    const unknown = { ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor;
    assert.deepStrictEqual(claudeRelayFlags(unknown), []);
    assert.ok(!adapter.launch(req({ relay: unknown })).shellArgs.includes('--settings'));
  });

  it('per-role permission rows are unaffected by the relay', () => {
    for (const role of ROLES) {
      const plain = adapter.launch(req({ role })).shellArgs;
      const relayed = adapter.launch(req({ role, relay })).shellArgs;
      const expected = permissionFlags(role);
      assert.deepStrictEqual(
        relayed.filter((a) => expected.includes(a)),
        expected,
        `relay argv must keep role ${role}'s permission row: ${JSON.stringify(relayed)}`,
      );
      assert.deepStrictEqual(plain.filter((a) => expected.includes(a)), expected);
    }
  });

  /**
   * Round-trip behaviour of the emitted script: the ask file it writes parses
   * through `parseAsk` (wire shape unchanged), and its stdout decision follows
   * the response file — approve→allow, deny→deny, nothing before
   * expiry→ask. Mirrors the emitted hook command's argv order: asks dir,
   * ask suffix, response suffix, run id, deadline in ms.
   */
  function runHook(
    deadlineFreeText: { askSuffix: string; responseSuffix: string; runId: string; deadlineMs: number },
    respond?: (asksDir: string) => void,
  ): Promise<{ stdout: string; asksDir: string }> {
    const asksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-relay-'));
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(
        process.execPath,
        [
          '-e',
          CLAUDE_RELAY_HOOK_SCRIPT,
          asksDir,
          deadlineFreeText.askSuffix,
          deadlineFreeText.responseSuffix,
          deadlineFreeText.runId,
          String(deadlineFreeText.deadlineMs),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`hook exited ${code}: ${stdout}`));
          return;
        }
        if (signal !== null) {
          reject(new Error(`hook was terminated by ${signal}`));
          return;
        }
        resolve({ stdout, asksDir });
      });
      // Feed the same PreToolUse event shape the probe observed on stdin.
      child.stdin!.write(
        JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      );
      child.stdin!.end();
      if (respond !== undefined) {
        const watcher = setInterval(() => {
          try {
            const asks = fs
              .readdirSync(asksDir)
              .filter((f) => f.endsWith(deadlineFreeText.askSuffix))
              .filter((f) => !f.endsWith(deadlineFreeText.responseSuffix + '.tmp'));
            if (asks.length > 0) {
              clearInterval(watcher);
              respond(asksDir);
            }
          } catch {
            // Not yet readable; try again on the next tick.
          }
        }, 20);
      }
    });
  }

  /** Read the hook's ask dir and answer its one ask with the given decision. */
  function parseAndRespond(asksDir: string, decision: 'approve' | 'deny', reason?: string): void {
    const askFile = fs
      .readdirSync(asksDir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.response.json') && !f.endsWith('.tmp'))[0];
    assert.ok(askFile !== undefined, `expected an ask file in ${asksDir}`);
    const parsed = parseAsk(fs.readFileSync(path.join(asksDir, askFile), 'utf8'));
    assert.ok(parsed.ok, `the hook's ask must parse: ${parsed.ok ? '' : parsed.error.message}`);
    const response: RelayResponse = { version: 1, id: parsed.ok ? parsed.value.id : '', decision, reason };
    writeResponse(asksDir, response);
  }

  it('the emitted script writes an ask parseAsk accepts and answers approve with allow', () => {
    return runHook({ askSuffix: '.json', responseSuffix: '.response.json', runId: 'run-123', deadlineMs: 8000 }, (asksDir) => {
      parseAndRespond(asksDir, 'approve', 'probe verifier');
    }).then(({ stdout }) => {
      const decision = JSON.parse(stdout).hookSpecificOutput;
      assert.strictEqual(decision.permissionDecision, 'allow');
      assert.strictEqual(decision.permissionDecisionReason, 'probe verifier');
    });
  });

  it('a deny response yields permissionDecision deny', () => {
    return runHook({ askSuffix: '.json', responseSuffix: '.response.json', runId: 'run-123', deadlineMs: 8000 }, (asksDir) => {
      parseAndRespond(asksDir, 'deny', 'no');
    }).then(({ stdout }) => {
      const decision = JSON.parse(stdout).hookSpecificOutput;
      assert.strictEqual(decision.permissionDecision, 'deny');
      assert.strictEqual(decision.permissionDecisionReason, 'no');
    });
  });

  it('no response before the deadline yields permissionDecision ask', () => {
    return runHook({ askSuffix: '.json', responseSuffix: '.response.json', runId: 'run-123', deadlineMs: 800 }).then(
      ({ stdout, asksDir }) => {
        const decision = JSON.parse(stdout).hookSpecificOutput;
        assert.strictEqual(decision.permissionDecision, 'ask');
        assert.ok(decision.permissionDecisionReason.includes('timed out'));
        // Nothing is silently allowed, and the ask file remains for forensics.
        assert.ok(
          fs.readdirSync(asksDir).some((f) => f.endsWith('.json') && !f.endsWith('.response.json')),
          'an unrelayed ask still leaves its ask file on disk',
        );
      },
    );
  }).timeout(4000);
});

describe('claudeModelsFromFeed (model-selector-refresh T04)', () => {
  // test/fixtures/modelsDev.sample.json is read untyped (fs + JSON.parse, not
  // resolveJsonModule import) like test/modelsDev.test.ts does.
  const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8');

  /** Parse untyped feed JSON, failing loudly; narrows to the parsed feed. */
  function requireFeed(raw: unknown): ModelsDevFeed {
    const result = parseModelsDevFeed(raw);
    if (!isOk(result)) {
      throw new Error(`feed failed to parse: ${result.error}`);
    }
    return result.value;
  }

  /** A synthetic FeedProvider with the given feed-order models. */
  function providerOf(id: string, models: { id: string; name?: string }[]): FeedProvider {
    return {
      id,
      name: id,
      env: [],
      models: models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: false,
        toolCall: false,
        attachment: false,
      })),
    };
  }

  const fixtureFeed = requireFeed(JSON.parse(fixtureText));

  it('yields the fixture claude ids in feed order, including claude-haiku-4-5 (absent from the curated list)', () => {
    const entries = claudeModelsFromFeed(fixtureFeed);
    assert.deepStrictEqual(
      entries.map((entry) => entry.id),
      ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    );
    assert.ok(
      // The curated id is the dated 'claude-haiku-4-5-20251001'; the feed's
      // undated 'claude-haiku-4-5' is not in the curated table.
      !(CLAUDE_MODELS as readonly string[]).includes('claude-haiku-4-5'),
      'claude-haiku-4-5 must be absent from the curated CLAUDE_MODELS so this proves discovery adds it',
    );
  });

  it('carries provider: anthropic and the fixture names as labels on every fixture entry', () => {
    const entries = claudeModelsFromFeed(fixtureFeed);
    assert.deepStrictEqual(entries.map((entry) => entry.provider), [
      ANTHROPIC_PROVIDER_ID,
      ANTHROPIC_PROVIDER_ID,
      ANTHROPIC_PROVIDER_ID,
    ]);
    assert.deepStrictEqual(
      entries.map((entry) => entry.label),
      ['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
    );
    for (const entry of entries) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'efforts'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'defaultEffort'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'custom'), false);
    }
  });

  it('an entry whose name equals its id carries NO label own key', () => {
    const entries = claudeModelsFromFeed([providerOf('anthropic', [{ id: 'claude-sonnet-5' }])]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entries[0], 'label'), false);
  });

  it('drops non-claude- ids of the anthropic provider and Claude-looking ids of other providers', () => {
    const feed: ModelsDevFeed = [
      providerOf('anthropic', [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'some-other-model' }]),
      providerOf('opencode', [{ id: 'claude-sonnet-5', name: 'impostor' }, { id: 'anthropic/claude-sonnet-5' }]),
    ];
    assert.deepStrictEqual(
      claudeModelsFromFeed(feed).map((entry) => entry.id),
      ['claude-sonnet-5'],
    );
    // The fixture's opencode zen model is claude-prefixed too and must not leak.
    const fixtureIds = claudeModelsFromFeed(fixtureFeed).map((entry) => entry.id);
    assert.ok(!fixtureIds.some((id) => id.endsWith('-zen')));
  });

  it('a feed with no anthropic provider, and an anthropic provider with no models, both yield []', () => {
    assert.deepStrictEqual(claudeModelsFromFeed([providerOf('google', [{ id: 'gemini-x' }])]), []);
    assert.deepStrictEqual(claudeModelsFromFeed([providerOf('anthropic', [])]), []);
  });

  it('a duplicated id in an array-shaped provider block is emitted once (first occurrence wins)', () => {
    const feed = requireFeed({
      anthropic: {
        id: 'anthropic',
        models: [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 duplicate' },
        ],
      },
    });
    const entries = claudeModelsFromFeed(feed);
    assert.deepStrictEqual(
      entries.map((entry) => entry.id),
      ['claude-sonnet-5'],
    );
    assert.strictEqual(entries[0].label, 'Claude Sonnet 5');
  });

  it('provider id matching is case/whitespace tolerant', () => {
    const entries = claudeModelsFromFeed([providerOf('Anthropic ', [{ id: 'claude-sonnet-5' }])]);
    assert.deepStrictEqual(
      entries.map((entry) => entry.id),
      ['claude-sonnet-5'],
    );
  });

  it('trims blank model ids and keeps the CLAUDE_MODEL_ID_PREFIX contract', () => {
    const feed = requireFeed({
      anthropic: {
        id: 'anthropic',
        models: [{ id: '  claude-sonnet-5  ', name: 'Claude Sonnet 5' }, { id: '   ', name: 'blank' }],
      },
    });
    assert.deepStrictEqual(
      claudeModelsFromFeed(feed).map((entry) => entry.id),
      ['claude-sonnet-5'],
    );
    assert.strictEqual(CLAUDE_MODEL_ID_PREFIX, 'claude-');
  });
});

describe('claudeModelsFromCatalog (T02)', () => {
  // test/fixtures/claudeModelCatalog.sample.json is read untyped (fs +
  // JSON.parse, not a resolveJsonModule import) like the models.dev fixture.
  const catalogJson: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'claudeModelCatalog.sample.json'), 'utf8'),
  );

  /** `catalogJson` with `mutate` applied to a structural clone. */
  function mutated(mutate: (doc: Record<string, unknown>) => void): unknown {
    const clone = JSON.parse(JSON.stringify(catalogJson)) as Record<string, unknown>;
    mutate(clone);
    return clone;
  }

  it('yields the fixture ids in main file order, then overflow file order', () => {
    assert.deepStrictEqual(
      claudeModelsFromCatalog(catalogJson).map((entry) => entry.id),
      [
        'claude-opus-5-5',
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-7',
        'claude-label-equals-id',
      ],
    );
  });

  it('takes labels from name, with no label own key when name equals the id', () => {
    const byId = new Map(claudeModelsFromCatalog(catalogJson).map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get('claude-opus-5-5')?.label, 'Opus 5.5');
    assert.strictEqual(byId.get('claude-sonnet-5')?.label, 'Sonnet 5');
    assert.strictEqual(byId.get('claude-opus-4-7')?.label, 'Opus 4.7');
    const equal = byId.get('claude-label-equals-id');
    assert.ok(equal !== undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(equal, 'label'), false);
  });

  it('carries per-model efforts in effort_options order and the Default-badged defaultEffort', () => {
    const byId = new Map(claudeModelsFromCatalog(catalogJson).map((entry) => [entry.id, entry]));
    assert.deepStrictEqual([...(byId.get('claude-opus-5-5')?.efforts ?? [])], [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    assert.strictEqual(byId.get('claude-opus-5-5')?.defaultEffort, 'medium');
    assert.deepStrictEqual([...(byId.get('claude-opus-4-7')?.efforts ?? [])], ['low', 'high']);
    assert.strictEqual(byId.get('claude-opus-4-7')?.defaultEffort, 'high');
    assert.deepStrictEqual([...(byId.get('claude-sonnet-5')?.efforts ?? [])], ['low', 'high']);
    assert.strictEqual(byId.get('claude-sonnet-5')?.defaultEffort, 'high');
  });

  it('a thinking.type: none model carries an OWN empty efforts array and no defaultEffort', () => {
    const entry = claudeModelsFromCatalog(catalogJson).find((e) => e.id === 'claude-haiku-4-5-20251001');
    assert.ok(entry !== undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'efforts'), true);
    assert.deepStrictEqual([...(entry.efforts ?? ['unset'])], []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'defaultEffort'), false);
    // Same for a model carrying no `thinking` at all.
    const none = claudeModelsFromCatalog(catalogJson).find((e) => e.id === 'claude-label-equals-id');
    assert.ok(none !== undefined);
    assert.deepStrictEqual([...(none.efforts ?? ['unset'])], []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(none, 'defaultEffort'), false);
  });

  it('emits no provider, custom, source, stale or fetchedAt own key on any entry', () => {
    for (const entry of claudeModelsFromCatalog(catalogJson)) {
      for (const key of ['provider', 'custom', 'source', 'stale', 'fetchedAt']) {
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(entry, key),
          false,
          `${entry.id} must carry no own ${key} key`,
        );
      }
    }
  });

  it('a duplicate id is emitted once, the main occurrence winning over the overflow one', () => {
    const entries = claudeModelsFromCatalog(catalogJson).filter((e) => e.id === 'claude-sonnet-5');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].label, 'Sonnet 5');
  });

  it('drops non-claude- ids and blank ids', () => {
    const ids = claudeModelsFromCatalog(catalogJson).map((entry) => entry.id);
    assert.ok(!ids.includes('gpt-5'));
    assert.ok(ids.every((id) => id.trim().length > 0));
  });

  it('yields [] for every unusable input shape', () => {
    for (const input of [undefined, null, 42, 'x', [], {}]) {
      assert.deepStrictEqual(claudeModelsFromCatalog(input), [], `expected [] for ${JSON.stringify(input)}`);
    }
    assert.strictEqual(CLAUDE_CATALOG_SURFACE, 'cc');
    // A non-'cc' surface, and a missing one, are never accepted.
    assert.deepStrictEqual(
      claudeModelsFromCatalog(mutated((doc) => {
        (doc['catalog'] as Record<string, unknown>)['surface'] = 'web';
      })),
      [],
    );
    assert.deepStrictEqual(
      claudeModelsFromCatalog(mutated((doc) => {
        delete (doc['catalog'] as Record<string, unknown>)['surface'];
      })),
      [],
    );
    // No catalog.config.models, and a non-array models.
    assert.deepStrictEqual(
      claudeModelsFromCatalog(mutated((doc) => {
        (doc['catalog'] as Record<string, unknown>)['config'] = { id: 'cc' };
      })),
      [],
    );
    assert.deepStrictEqual(
      claudeModelsFromCatalog(mutated((doc) => {
        (doc['catalog'] as Record<string, unknown>)['config'] = { id: 'cc', models: 'nope' };
      })),
      [],
    );
    // A models array with no claude- id at all.
    assert.deepStrictEqual(
      claudeModelsFromCatalog(mutated((doc) => {
        (doc['catalog'] as Record<string, unknown>)['config'] = {
          id: 'cc',
          models: [{ id: 'gpt-5', section: 'main' }, { id: 'gemini-x', section: 'overflow' }],
        };
      })),
      [],
    );
  });

  it('tolerates a missing version and a missing catalog.state', () => {
    const entries = claudeModelsFromCatalog(mutated((doc) => {
      delete doc['version'];
      delete (doc['catalog'] as Record<string, unknown>)['state'];
    }));
    assert.deepStrictEqual(entries.map((entry) => entry.id)[0], 'claude-opus-5-5');
    assert.strictEqual(entries.length, 5);
  });

  it('still parses a catalog whose staleAt is in the past (staleAt is never honoured)', () => {
    const entries = claudeModelsFromCatalog(mutated((doc) => {
      doc['staleAt'] = 1;
      doc['fetchedAt'] = 0;
    }));
    assert.strictEqual(entries.length, 5);
  });

  it('never throws for a deeply malformed doc', () => {
    assert.deepStrictEqual(
      claudeModelsFromCatalog({
        catalog: { surface: 'cc', config: { models: [null, 1, { id: 5 }, { id: 'claude-x', thinking: 'nope' }] } },
      }),
      [{ id: 'claude-x', efforts: [] }],
    );
  });
});

describe('ClaudeAdapter.discoverModels (model-selector-refresh T04)', () => {
  /** The parsed checked-in fixture feed. */
  const fixtureFeed: ModelsDevFeed = (() => {
    const result = parseModelsDevFeed(
      JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8')),
    );
    assert.strictEqual(result.ok, true, 'the checked-in fixture feed must parse');
    return (result as { value: ModelsDevFeed }).value;
  })();

  /** Build a DiscoveryContext with sensible defaults overridable per test. */
  function ctx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
    return { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS, ...overrides };
  }

  /** A recording fake fetcher resolving the fixed result; returns it plus the recorded calls. */
  function fakeFetcher(result: Result<ModelsDevFeed, string>): {
    fetcher: ClaudeFeedFetcher;
    calls: { timeoutMs: number }[];
  } {
    const calls: { timeoutMs: number }[] = [];
    const fetcher: ClaudeFeedFetcher = async (options) => {
      calls.push({ timeoutMs: options.timeoutMs });
      return result;
    };
    return { fetcher, calls };
  }

  /**
   * A ClaudeAdapter with the local-catalog leg switched OFF (T02). Mandatory for
   * every feed-path assertion in this describe: the default reader reads the
   * developer's real `~/.claude/cache/model-catalog`, which would make these
   * expectations machine-dependent.
   */
  function feedOnlyAdapter(mode: PermissionMode, fetchFeed: ClaudeFeedFetcher): ClaudeAdapter {
    return new ClaudeAdapter(mode, { fetchFeed, readLocalCatalog: async () => undefined });
  }

  it('with ctx.feed resolves the fixture models with no network call and no provenance keys', async () => {
    const { fetcher, calls } = fakeFetcher(ok(fixtureFeed));
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fetcher);
    const caps = await adapter.discoverModels(ctx({ feed: fixtureFeed }));

    assert.ok(caps !== undefined, 'a good feed must resolve capabilities');
    assert.deepStrictEqual([...caps.models], ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    assert.deepStrictEqual([...caps.efforts], [...CLAUDE_EFFORTS]);
    assert.ok(caps.modelEntries !== undefined && caps.modelEntries.length === 3);
    assert.deepStrictEqual(
      caps.modelEntries.map((entry) => entry.id),
      ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    );
    for (const key of ['source', 'stale', 'staleReason', 'fetchedAt', 'modelLink']) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(caps, key),
        false,
        `capabilities must carry no own ${key} key`,
      );
    }
    assert.strictEqual(calls.length, 0, 'ctx.feed must make the fetcher never be called');
  });

  it('capabilitiesToCatalogFetch round-trips the resolved capabilities into the CatalogFetch shape', async () => {
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fakeFetcher(ok(fixtureFeed)).fetcher);
    const caps = (await adapter.discoverModels(ctx({ feed: fixtureFeed }))) as AgentCapabilities;
    const entries = caps.modelEntries as readonly { id: string; provider?: string; label?: string }[];
    const roundTripped = capabilitiesToCatalogFetch(caps);
    assert.deepStrictEqual(
      roundTripped.models.map((entry) => entry.id),
      entries.map((entry) => entry.id),
    );
    assert.deepStrictEqual(roundTripped.efforts, [...CLAUDE_EFFORTS]);
  });

  it('without ctx.feed the injected fetcher is called exactly once with the clamped timeoutMs', async () => {
    const { fetcher, calls } = fakeFetcher(ok(fixtureFeed));
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fetcher);
    const caps = await adapter.discoverModels(ctx());
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
    assert.deepStrictEqual([...(caps as AgentCapabilities).models], [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);

    const narrow = fakeFetcher(ok(fixtureFeed));
    await feedOnlyAdapter(DEFAULT_PERMISSION_MODE, narrow.fetcher).discoverModels(ctx({ timeoutMs: 25 }));
    assert.strictEqual(narrow.calls.length, 1);
    assert.strictEqual(narrow.calls[0].timeoutMs, 25);

    const wide = fakeFetcher(ok(fixtureFeed));
    await feedOnlyAdapter(DEFAULT_PERMISSION_MODE, wide.fetcher).discoverModels(ctx({ timeoutMs: 60_000 }));
    assert.strictEqual(wide.calls.length, 1);
    assert.strictEqual(wide.calls[0].timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
  });

  it('a failed fetch resolves undefined and the error message reaches the log sink', async () => {
    const logged: string[] = [];
    const { fetcher } = fakeFetcher(err('models.dev request timed out after 10ms'));
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fetcher);
    const caps = await adapter.discoverModels(ctx({ log: (message) => logged.push(message) }));
    assert.strictEqual(caps, undefined);
    assert.ok(
      logged.some((message) => message.includes('models.dev request timed out after 10ms')),
      `expected the fetch error in the log sink: ${JSON.stringify(logged)}`,
    );
  });

  it('a throwing fetcher, and one returning a rejected promise, both resolve undefined (never throw)', async () => {
    const throwing = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, (() => {
      throw new Error('boom');
    }) as unknown as ClaudeFeedFetcher);
    assert.strictEqual(await throwing.discoverModels(ctx()), undefined);

    const rejecting = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, async () => {
      throw new Error('rejected');
    });
    assert.strictEqual(await rejecting.discoverModels(ctx()), undefined);
  });

  it('a feed without anthropic, and an anthropic block of only non-claude- ids, resolve undefined', async () => {
    const noAnthropicFeed: ModelsDevFeed = [
      { id: 'google', name: 'google', env: [], models: [{ id: 'gemini-x', name: 'Gemini X', reasoning: false, toolCall: false, attachment: false }] },
    ];
    const noClaudeFeed: ModelsDevFeed = [
      { id: 'anthropic', name: 'anthropic', env: [], models: [{ id: 'some-other-model', name: 'o', reasoning: false, toolCall: false, attachment: false }] },
    ];
    const a = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fakeFetcher(ok(noAnthropicFeed)).fetcher);
    assert.strictEqual(await a.discoverModels(ctx()), undefined);
    const b = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fakeFetcher(ok(noClaudeFeed)).fetcher);
    assert.strictEqual(await b.discoverModels(ctx()), undefined);
  });

  it('an already-aborted signal resolves undefined and never calls the fetcher', async () => {
    const { fetcher, calls } = fakeFetcher(ok(fixtureFeed));
    const controller = new AbortController();
    controller.abort();
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fetcher);
    const caps = await adapter.discoverModels(ctx({ signal: controller.signal }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(calls.length, 0);
  });

  it('a never-settling fetch plus a mid-flight abort resolves undefined promptly', async () => {
    const never = () => new Promise<{ ok: true; value: ModelsDevFeed }>(() => undefined);
    const controller = new AbortController();
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, never as unknown as ClaudeFeedFetcher);
    setTimeout(() => controller.abort(), 0);
    const started = Date.now();
    const caps = await adapter.discoverModels(ctx({ signal: controller.signal }));
    assert.strictEqual(caps, undefined);
    assert.ok(Date.now() - started < 2000, 'the aborted call must not hang until the timeout');
  });

  it('a feed omitting claude-sonnet-5 still ends with CLAUDE_REQUIRED_MODEL, exactly once and equal to CLAUDE_MODELS[0]', async () => {
    const feed: ModelsDevFeed = [
      { id: 'anthropic', name: 'anthropic', env: [], models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: false, toolCall: false, attachment: false }] },
    ];
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, fakeFetcher(ok(feed)).fetcher);
    const caps = (await adapter.discoverModels(ctx({ feed }))) as AgentCapabilities;
    assert.ok(caps !== undefined);
    assert.strictEqual([...caps.models].filter((id) => id === CLAUDE_REQUIRED_MODEL).length, 1);
    assert.strictEqual(caps.models[caps.models.length - 1], CLAUDE_REQUIRED_MODEL);
    assert.strictEqual(CLAUDE_REQUIRED_MODEL, CLAUDE_MODELS[0]);
    const appended = caps.modelEntries![caps.modelEntries!.length - 1];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(appended, 'custom'), false);
  });

  it('a fetcher that aborts the ctx signal synchronously and never settles resolves undefined promptly', async () => {
    // Regression (T04 review): the abort can complete INSIDE the fetch call,
    // before raceAbort subscribes — no abort event ever fires then, so the
    // race must check signal.aborted itself instead of hanging forever.
    const controller = new AbortController();
    const abortAndHang = (): Promise<Result<ModelsDevFeed, string>> => {
      controller.abort();
      return new Promise(() => undefined);
    };
    const adapter = feedOnlyAdapter(DEFAULT_PERMISSION_MODE, abortAndHang);
    const started = Date.now();
    const caps = await adapter.discoverModels(ctx({ signal: controller.signal }));
    assert.strictEqual(caps, undefined);
    assert.ok(Date.now() - started < 2000, 'the synchronously-aborted race must not hang until the timeout');
  });

  // ---- T02: the local model catalog takes precedence over the feed ----

  /** The checked-in local-catalog fixture, read untyped. */
  const catalogJson: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'claudeModelCatalog.sample.json'), 'utf8'),
  );

  /** The fixture catalog's expected ids in parser order. */
  const catalogIds = [
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-7',
    'claude-label-equals-id',
  ];

  /** An adapter with an injected catalog reader and a recording fetcher. */
  function catalogAdapter(
    readLocalCatalog: ClaudeCatalogReader,
    feedResult: Result<ModelsDevFeed, string> = ok(fixtureFeed),
  ): { adapter: ClaudeAdapter; calls: { timeoutMs: number }[] } {
    const { fetcher, calls } = fakeFetcher(feedResult);
    return {
      adapter: new ClaudeAdapter(DEFAULT_PERMISSION_MODE, { fetchFeed: fetcher, readLocalCatalog }),
      calls,
    };
  }

  it('a usable local catalog wins: its entries resolve, the fetcher is never called and ctx.feed is ignored', async () => {
    const { adapter, calls } = catalogAdapter(async () => catalogJson);
    const caps = await adapter.discoverModels(ctx({ feed: fixtureFeed }));

    assert.ok(caps !== undefined, 'a usable catalog must resolve capabilities');
    // claude-sonnet-5 is already in the catalog, so nothing is appended.
    assert.deepStrictEqual([...caps.models], catalogIds);
    assert.strictEqual([...caps.models].filter((id) => id === CLAUDE_REQUIRED_MODEL).length, 1);
    assert.strictEqual(calls.length, 0, 'the catalog leg must never call the feed fetcher');

    const byId = new Map((caps.modelEntries ?? []).map((entry) => [entry.id, entry]));
    assert.deepStrictEqual([...(byId.get('claude-opus-5-5')?.efforts ?? [])], [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    assert.strictEqual(byId.get('claude-opus-5-5')?.defaultEffort, 'medium');
    assert.deepStrictEqual([...(byId.get('claude-haiku-4-5-20251001')?.efforts ?? ['unset'])], []);
    // The capability-level list is the ordered first-seen union of the entries'.
    assert.deepStrictEqual([...caps.efforts], ['low', 'medium', 'high', 'xhigh', 'max']);
    for (const key of ['source', 'stale', 'staleReason', 'fetchedAt', 'modelLink']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(caps, key), false);
    }
  });

  it('a missing, malformed or empty catalog falls back to the feed with capability-level CLAUDE_EFFORTS', async () => {
    const readers: [string, ClaudeCatalogReader][] = [
      ['missing', async () => undefined],
      ['malformed', async () => ({ catalog: { surface: 'web' } })],
      ['empty cc doc', async () => ({ version: 2, catalog: { surface: 'cc', config: { models: [] } } })],
    ];
    for (const [label, readLocalCatalog] of readers) {
      const { adapter, calls } = catalogAdapter(readLocalCatalog);
      const caps = await adapter.discoverModels(ctx());
      assert.ok(caps !== undefined, `${label} must fall back to the feed`);
      assert.deepStrictEqual([...caps.models], ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
      assert.deepStrictEqual([...caps.efforts], [...CLAUDE_EFFORTS]);
      assert.strictEqual(calls.length, 1, `${label} must reach the feed exactly once`);
    }
  });

  it('a reader that throws synchronously, and one returning a rejected promise, both fall back to the feed', async () => {
    const throwing = catalogAdapter((() => {
      throw new Error('catalog boom');
    }) as unknown as ClaudeCatalogReader);
    const thrown = await throwing.adapter.discoverModels(ctx());
    assert.deepStrictEqual([...(thrown as AgentCapabilities).models], [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    assert.strictEqual(throwing.calls.length, 1);

    const rejecting = catalogAdapter(async () => {
      throw new Error('catalog rejected');
    });
    const rejected = await rejecting.adapter.discoverModels(ctx());
    assert.deepStrictEqual([...(rejected as AgentCapabilities).models], [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    assert.strictEqual(rejecting.calls.length, 1);
  });

  it('both legs unusable resolves undefined and the feed error still reaches ctx.log', async () => {
    const logged: string[] = [];
    const { adapter } = catalogAdapter(async () => undefined, err('models.dev request failed'));
    const caps = await adapter.discoverModels(ctx({ log: (message) => logged.push(message) }));
    assert.strictEqual(caps, undefined);
    assert.ok(
      logged.some((message) => message.includes('models.dev request failed')),
      `expected the fetch error in the log sink: ${JSON.stringify(logged)}`,
    );
  });

  it('a never-settling reader plus a mid-flight abort resolves undefined promptly and never calls the fetcher', async () => {
    const controller = new AbortController();
    const { adapter, calls } = catalogAdapter(() => new Promise<unknown>(() => undefined));
    setTimeout(() => controller.abort(), 0);
    const started = Date.now();
    const caps = await adapter.discoverModels(ctx({ signal: controller.signal }));
    assert.strictEqual(caps, undefined);
    assert.strictEqual(calls.length, 0, 'the aborted catalog leg must not go on to the feed');
    assert.ok(Date.now() - started < 2000, 'the aborted call must not hang until the timeout');
  });

  it('a never-settling reader under ctx.timeoutMs 25 times out and falls through to the feed', async () => {
    const { adapter, calls } = catalogAdapter(() => new Promise<unknown>(() => undefined));
    const started = Date.now();
    const caps = await adapter.discoverModels(ctx({ timeoutMs: 25 }));
    // The implemented contract: the timed-out catalog leg is treated as "no
    // catalog", so discovery falls through to the feed rather than giving up.
    assert.deepStrictEqual([...(caps as AgentCapabilities).models], [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].timeoutMs, 25);
    assert.ok(Date.now() - started < 2000, 'the timed-out reader must settle inside the timebox');
  });

  it('an already-aborted signal resolves undefined without invoking the reader or the fetcher', async () => {
    let readerCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const { adapter, calls } = catalogAdapter(async () => {
      readerCalls += 1;
      return catalogJson;
    });
    assert.strictEqual(await adapter.discoverModels(ctx({ signal: controller.signal })), undefined);
    assert.strictEqual(readerCalls, 0);
    assert.strictEqual(calls.length, 0);
  });

  it('a catalog omitting claude-sonnet-5 appends CLAUDE_REQUIRED_MODEL last, exactly once, with no custom key', async () => {
    const doc = JSON.parse(JSON.stringify(catalogJson)) as Record<string, unknown>;
    const config = (doc['catalog'] as Record<string, unknown>)['config'] as Record<string, unknown>;
    config['models'] = (config['models'] as Record<string, unknown>[]).filter(
      (model) => model['id'] !== 'claude-sonnet-5',
    );
    const { adapter } = catalogAdapter(async () => doc);
    const caps = (await adapter.discoverModels(ctx())) as AgentCapabilities;
    assert.ok(caps !== undefined);
    assert.ok(caps.models.includes(CLAUDE_REQUIRED_MODEL), 'the required model must be present');
    assert.strictEqual([...caps.models].filter((id) => id === CLAUDE_REQUIRED_MODEL).length, 1);
    assert.strictEqual(caps.models[caps.models.length - 1], CLAUDE_REQUIRED_MODEL);
    const appended = caps.modelEntries![caps.modelEntries!.length - 1];
    assert.strictEqual(appended.id, CLAUDE_REQUIRED_MODEL);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(appended, 'custom'), false);
  });

  it('the curated claude tables are the CLI\'s real ids and effort vocabulary', () => {
    assert.deepStrictEqual(
      [...CLAUDE_MODELS],
      ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
    );
    assert.deepStrictEqual([...CLAUDE_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.strictEqual(CLAUDE_REQUIRED_MODEL, CLAUDE_MODELS[0]);
    assert.ok(!(CLAUDE_MODELS as readonly string[]).includes('claude-haiku-5'), 'claude-haiku-5 is not a CLI id');
    assert.ok(!(CLAUDE_MODELS as readonly string[]).includes('claude-opus-5'), 'claude-opus-5 is not curated');
  });

  it('the registry wires discoverModels for claude only, and the old constructor forms still compile', () => {
    assert.strictEqual(typeof createAdapterRegistry().require('claude').discoverModels, 'function');
    assert.strictEqual(typeof createAdapterRegistry().require('antigravity').discoverModels, 'undefined');
    // Additive-parameter compile guarantees: both older call sites construct.
    const defaultsOnly = new ClaudeAdapter();
    const modeOnly = new ClaudeAdapter(DEFAULT_PERMISSION_MODE);
    assert.strictEqual(defaultsOnly.launch(req()).shellPath, modeOnly.launch(req()).shellPath);
  });
});
