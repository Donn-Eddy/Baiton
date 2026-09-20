import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeAdapter, claudeSystemPromptFlags } from '../src/adapter/claude';
import { createAdapterRegistry, AskRelayDescriptor } from '../src/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import type { LaunchRequest } from '../src/adapter/adapter';
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
