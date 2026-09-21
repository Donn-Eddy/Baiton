import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ASK_FILE_SUFFIX,
  ASK_RELAY_VERSION,
  RESPONSE_FILE_SUFFIX,
  askFilePath,
  askIdFromFileName,
  asksDirFor,
  ensureAsksDir,
  listPendingAskIds,
  parseAsk,
  parseResponse,
  responseFilePath,
  responseFromAnswer,
  serializeAsk,
  serializeResponse,
  toInterventionRequest,
  writeResponse,
  describeAskRelayError,
} from '../src/engine/askRelay';
import { launchStage } from '../src/engine/launcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter/adapter';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { InterventionAnswer } from '../src/orchestrator/interventions';

/**
 * Pins the ask-relay file protocol: path helpers, id extraction, ask/response
 * parsing + validation, serialization round-trips, the intervention bridge in
 * both directions, the fs helpers, and the launcher's relay plumbing.
 */

class StubTerminalHost implements TerminalHost {
  created: CreateTerminalOptions[] = [];
  createTerminal(options: CreateTerminalOptions): HostTerminal {
    this.created.push(options);
    return { sendText: () => {}, dispose: () => {}, show: () => {} };
  }
}

function adapterThat(launch: (req: LaunchRequest) => LaunchSpec): Adapter {
  return {
    id: 'antigravity',
    acceptsSessionId: false,
    probe: async (): Promise<ProbeResult> => ({ version: '1', ok: true }),
    launch,
    attach: () => ({ shellPath: 'agy', shellArgs: [] }),
  };
}

function permissionAsk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ASK_RELAY_VERSION,
    id: 'ask-1',
    runId: 'run-1',
    agent: 'claude',
    kind: 'permission',
    prompt: 'Allow Bash?',
    tool: 'Bash',
    args: '{"command":"npm test"}',
    detail: 'runs the test suite',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function questionAsk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ASK_RELAY_VERSION,
    id: 'ask-2',
    runId: 'run-1',
    agent: 'claude',
    kind: 'question',
    prompt: 'Which base?',
    options: [
      { id: 'main', label: 'main' },
      { id: 'develop', label: 'develop', detail: 'integration branch' },
    ],
    allowFreeText: true,
    ...overrides,
  };
}

describe('ask-relay path helpers', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-askrelay-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('asksDirFor nests under .baiton/runs/<run-id>/asks', () => {
    const dir = asksDirFor(root, 'run-1');
    assert.ok(dir.endsWith(path.join('.baiton', 'runs', 'run-1', 'asks')));
    assert.ok(path.isAbsolute(dir));
  });

  it('askFilePath and responseFilePath produce the documented suffixes', () => {
    const dir = asksDirFor(root, 'run-1');
    assert.strictEqual(path.basename(askFilePath(dir, 'a1')), `a1${ASK_FILE_SUFFIX}`);
    assert.strictEqual(ASK_FILE_SUFFIX, '.json');
    assert.strictEqual(
      path.basename(responseFilePath(dir, 'a1')),
      `a1${RESPONSE_FILE_SUFFIX}`,
    );
    assert.strictEqual(RESPONSE_FILE_SUFFIX, '.response.json');
  });
});

describe('askIdFromFileName', () => {
  it('extracts the id from a plain ask file name', () => {
    assert.strictEqual(askIdFromFileName('a1.json'), 'a1');
  });

  it('never mistakes a response file for an ask (response suffix checked first)', () => {
    assert.strictEqual(askIdFromFileName('a1.response.json'), undefined);
  });

  it('rejects non-json names, empty ids, separators and traversal', () => {
    assert.strictEqual(askIdFromFileName('notes.txt'), undefined);
    assert.strictEqual(askIdFromFileName('.json'), undefined);
    assert.strictEqual(askIdFromFileName('../x.json'), undefined);
    assert.strictEqual(askIdFromFileName('sub/x.json'), undefined);
  });
});

describe('parseAsk', () => {
  it('round-trips a full valid permission ask through serializeAsk unchanged', () => {
    const raw = serializeAsk(permissionAsk() as never);
    const parsed = parseAsk(raw);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepStrictEqual(parsed.value, {
        version: ASK_RELAY_VERSION,
        id: 'ask-1',
        runId: 'run-1',
        agent: 'claude',
        kind: 'permission',
        prompt: 'Allow Bash?',
        tool: 'Bash',
        args: '{"command":"npm test"}',
        detail: 'runs the test suite',
        createdAt: '2026-09-20T00:00:00.000Z',
      });
    }
  });

  it('drops unknown extra fields from the parsed value', () => {
    const raw = JSON.stringify(permissionAsk({ sneaky: 'harness data', nested: { x: 1 } }));
    const parsed = parseAsk(raw);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.strictEqual('sneaky' in parsed.value, false);
      assert.strictEqual('nested' in parsed.value, false);
      assert.deepStrictEqual(Object.keys(parsed.value).sort(), [
        'agent',
        'args',
        'createdAt',
        'detail',
        'id',
        'kind',
        'prompt',
        'runId',
        'tool',
        'version',
      ]);
    }
  });

  it('yields malformed-json for unparseable text', () => {
    const parsed = parseAsk('{not json');
    assert.ok(!parsed.ok);
    if (!parsed.ok) {
      assert.strictEqual(parsed.error.kind, 'malformed-json');
      assert.ok(/ask is not well-formed JSON/.test(describeAskRelayError(parsed.error)));
    }
  });

  const invalidCases: { name: string; overrides: Record<string, unknown>; field: string }[] = [
    { name: 'version mismatch', overrides: { version: 2 }, field: 'version' },
    { name: 'blank id', overrides: { id: '  ' }, field: 'id' },
    { name: 'missing runId', overrides: { runId: undefined }, field: 'runId' },
    { name: 'missing agent', overrides: { agent: undefined }, field: 'agent' },
    { name: 'bad kind', overrides: { kind: 'confirm' }, field: 'kind' },
    { name: 'permission without tool', overrides: { tool: undefined }, field: 'tool' },
    { name: 'non-string args', overrides: { args: 42 }, field: 'args' },
    {
      name: 'malformed options entry',
      overrides: { kind: 'question', options: [{ id: 'x' }], allowFreeText: undefined },
      field: 'options',
    },
  ];

  for (const { name, overrides, field } of invalidCases) {
    it(`rejects ${name} as invalid, naming the field`, () => {
      const raw = JSON.stringify(permissionAsk(overrides));
      const parsed = parseAsk(raw);
      assert.ok(!parsed.ok);
      if (!parsed.ok) {
        assert.strictEqual(parsed.error.kind, 'invalid');
        assert.ok(
          parsed.error.message.includes(field),
          `expected message "${parsed.error.message}" to name "${field}"`,
        );
      }
    });
  }
});

describe('parseResponse', () => {
  it('round-trips a valid approve response', () => {
    const response = {
      version: ASK_RELAY_VERSION,
      id: 'ask-1',
      decision: 'approve' as const,
      answer: 'main',
      respondedAt: '2026-09-20T00:00:01.000Z',
    };
    const parsed = parseResponse(serializeResponse(response));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepStrictEqual(parsed.value, response);
    }
  });

  it('round-trips a valid deny response with a reason', () => {
    const response = {
      version: ASK_RELAY_VERSION,
      id: 'ask-1',
      decision: 'deny' as const,
      reason: 'too risky',
    };
    const parsed = parseResponse(serializeResponse(response));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepStrictEqual(parsed.value, response);
    }
  });

  it('rejects a decision outside approve|deny as invalid', () => {
    const raw = JSON.stringify({
      version: ASK_RELAY_VERSION,
      id: 'ask-1',
      decision: 'maybe',
    });
    const parsed = parseResponse(raw);
    assert.ok(!parsed.ok);
    if (!parsed.ok) {
      assert.strictEqual(parsed.error.kind, 'invalid');
      assert.ok(parsed.error.message.includes('decision'));
    }
  });

  it('rejects a wrong version as invalid', () => {
    const raw = JSON.stringify({ version: 99, id: 'ask-1', decision: 'approve' });
    const parsed = parseResponse(raw);
    assert.ok(!parsed.ok);
    if (!parsed.ok) {
      assert.strictEqual(parsed.error.kind, 'invalid');
      assert.ok(parsed.error.message.includes('version'));
    }
  });

  it('yields malformed-json for unparseable text', () => {
    const parsed = parseResponse(']]]');
    assert.ok(!parsed.ok);
    if (!parsed.ok) {
      assert.strictEqual(parsed.error.kind, 'malformed-json');
    }
  });
});

describe('toInterventionRequest', () => {
  it('maps a permission ask to a permission request with agent, tool, args and detail', () => {
    const parsed = parseAsk(JSON.stringify(permissionAsk()));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepStrictEqual(toInterventionRequest(parsed.value), {
        kind: 'permission',
        prompt: 'Allow Bash?',
        agent: 'claude',
        tool: 'Bash',
        args: '{"command":"npm test"}',
        detail: 'runs the test suite',
      });
    }
  });

  it('maps a question ask to a question request with options and allowFreeText, and no tool', () => {
    const parsed = parseAsk(JSON.stringify(questionAsk()));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      const request = toInterventionRequest(parsed.value);
      assert.deepStrictEqual(request, {
        kind: 'question',
        prompt: 'Which base?',
        options: [
          { id: 'main', label: 'main' },
          { id: 'develop', label: 'develop', detail: 'integration branch' },
        ],
        allowFreeText: true,
      });
      assert.strictEqual('tool' in request, false);
    }
  });
});

describe('responseFromAnswer', () => {
  const ask = {
    version: ASK_RELAY_VERSION,
    id: 'ask-1',
    runId: 'run-1',
    agent: 'claude',
    kind: 'permission' as const,
    prompt: 'Allow Bash?',
    tool: 'Bash',
  };

  it('maps approved to an approve decision with no answer or reason', () => {
    const answer: InterventionAnswer = { kind: 'approved' };
    const response = responseFromAnswer(ask, answer);
    assert.deepStrictEqual(response, { version: ASK_RELAY_VERSION, id: 'ask-1', decision: 'approve' });
    assert.strictEqual('respondedAt' in response, false);
  });

  it('maps declined with a reason to a deny carrying that reason', () => {
    const answer: InterventionAnswer = { kind: 'declined', reason: 'not today' };
    const response = responseFromAnswer(ask, answer);
    assert.strictEqual(response.decision, 'deny');
    assert.strictEqual(response.reason, 'not today');
  });

  it('maps declined without a reason to a deny with the bare fallback reason', () => {
    const answer: InterventionAnswer = { kind: 'declined' };
    const response = responseFromAnswer(ask, answer);
    assert.strictEqual(response.decision, 'deny');
    assert.strictEqual(response.reason, 'declined');
  });

  it('maps an option answer to an approve carrying the option id', () => {
    const answer: InterventionAnswer = { kind: 'option', optionId: 'develop' };
    const response = responseFromAnswer(ask, answer);
    assert.strictEqual(response.decision, 'approve');
    assert.strictEqual(response.answer, 'develop');
    assert.strictEqual('reason' in response, false);
  });

  it('maps a text answer to an approve carrying the text', () => {
    const answer: InterventionAnswer = { kind: 'text', text: 'main, please' };
    const response = responseFromAnswer(ask, answer);
    assert.strictEqual(response.decision, 'approve');
    assert.strictEqual(response.answer, 'main, please');
  });

  it('stamps respondedAt only when the caller passes it', () => {
    const answer: InterventionAnswer = { kind: 'approved' };
    const without = responseFromAnswer(ask, answer);
    assert.strictEqual('respondedAt' in without, false);
    const withStamp = responseFromAnswer(ask, answer, '2026-09-20T00:00:01.000Z');
    assert.strictEqual(withStamp.respondedAt, '2026-09-20T00:00:01.000Z');
  });
});

describe('ask-relay fs helpers', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-askrelay-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ensureAsksDir creates the directory and is idempotent', () => {
    const dir = ensureAsksDir(root, 'run-1');
    assert.ok(fs.statSync(dir).isDirectory());
    const again = ensureAsksDir(root, 'run-1');
    assert.strictEqual(again, dir);
    assert.ok(fs.statSync(again).isDirectory());
  });

  it('writeResponse writes parseable JSON at responseFilePath and leaves no .tmp behind', () => {
    const dir = ensureAsksDir(root, 'run-1');
    const response = {
      version: ASK_RELAY_VERSION,
      id: 'ask-1',
      decision: 'approve' as const,
    };
    const file = writeResponse(dir, response);
    assert.strictEqual(file, responseFilePath(dir, 'ask-1'));
    const parsed = parseResponse(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.strictEqual(parsed.value.decision, 'approve');
    }
    assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
  });

  it('listPendingAskIds returns ids with an ask but no response, sorted', () => {
    const dir = ensureAsksDir(root, 'run-1');
    fs.writeFileSync(askFilePath(dir, 'b2'), JSON.stringify(permissionAsk({ id: 'b2' })), 'utf8');
    fs.writeFileSync(askFilePath(dir, 'a1'), JSON.stringify(permissionAsk({ id: 'a1' })), 'utf8');
    fs.writeFileSync(askFilePath(dir, 'c3'), JSON.stringify(permissionAsk({ id: 'c3' })), 'utf8');
    // c3 already answered; a stray response without an ask and a non-ask file are ignored.
    fs.writeFileSync(
      responseFilePath(dir, 'c3'),
      JSON.stringify({ version: ASK_RELAY_VERSION, id: 'c3', decision: 'deny' }),
      'utf8',
    );
    fs.writeFileSync(responseFilePath(dir, 'ghost'), '{}', 'utf8');
    fs.writeFileSync(dir + '/notes.txt', 'x', 'utf8');
    assert.deepStrictEqual(listPendingAskIds(dir), ['a1', 'b2']);
  });

  it('listPendingAskIds returns [] for a missing directory', () => {
    assert.deepStrictEqual(listPendingAskIds(path.join(root, 'nope', 'asks')), []);
  });
});

describe('launchStage relay plumbing', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-askrelay-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const input = (workspaceRoot: string, extra: Record<string, unknown> = {}) => ({
    workspaceRoot,
    runId: 'run-1',
    stage: 'plan' as const,
    role: 'planner' as const,
    model: 'gemini-3.1-pro',
    effort: 'medium',
    resume: false,
    sessionId: 'sess',
    ...extra,
  });

  it('with relayAsks: true the adapter receives the descriptor, the dir exists, and the output carries it', () => {
    const host = new StubTerminalHost();
    const seen: LaunchRequest[] = [];
    const adapter = adapterThat((req) => {
      seen.push(req);
      return { shellPath: 'agy', shellArgs: ['--model', 'x'] };
    });
    const result = launchStage(input(root, { relayAsks: true }), { adapter, terminalHost: host });
    assert.ok(result.ok);
    if (result.ok) {
      const asksDir = asksDirFor(root, 'run-1');
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(seen[0].relay, {
        protocol: 'file-v1',
        dir: asksDir,
        askSuffix: '.json',
        responseSuffix: '.response.json',
        runId: 'run-1',
      });
      assert.ok(fs.statSync(asksDir).isDirectory());
      assert.deepStrictEqual(result.value.relay, seen[0].relay);
    }
  });

  it('with the flag omitted the launch is unchanged: no relay, no asks directory', () => {
    const host = new StubTerminalHost();
    const seen: LaunchRequest[] = [];
    const adapter = adapterThat((req) => {
      seen.push(req);
      return { shellPath: 'agy', shellArgs: ['--model', 'x'] };
    });
    const result = launchStage(input(root), { adapter, terminalHost: host });
    assert.ok(result.ok);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].relay, undefined);
    assert.ok(result.ok);
    if (result.ok) {
      assert.strictEqual(result.value.relay, undefined);
      assert.strictEqual('relay' in result.value, false);
    }
    assert.ok(!fs.existsSync(asksDirFor(root, 'run-1')));
  });
});
