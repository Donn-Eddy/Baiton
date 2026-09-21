import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchStage } from '../src/engine/launcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult, AgentId } from '../src/adapter/adapter';
import { AdapterLaunchError } from '../src/adapter/adapter';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import { ASK_RELAY_SECTION_HEADING, ASK_RELAY_NO_SELF_APPROVE_INSTRUCTION } from '../src/engine/roleInstructions';
import { asksDirFor, parseAsk, parseResponse } from '../src/engine/askRelay';
import { buildBrief } from '../src/engine/brief';

/**
 * Pins the launcher's handling of an adapter that refuses a request: the
 * refusal surfaces as a `launch-args` error, and neither the run directory,
 * the Brief, nor a terminal is created (Req 11.5 spirit: no partial state).
 */

class StubTerminalHost implements TerminalHost {
  created: CreateTerminalOptions[] = [];
  createTerminal(options: CreateTerminalOptions): HostTerminal {
    this.created.push(options);
    return { sendText: () => {}, dispose: () => {}, show: () => {} };
  }
}

function adapterThat(launch: (req: LaunchRequest) => LaunchSpec, id: string = 'antigravity'): Adapter {
  return {
    id: id as AgentId,
    acceptsSessionId: false,
    probe: async (): Promise<ProbeResult> => ({ version: '1', ok: true }),
    launch,
    attach: () => ({ shellPath: 'agy', shellArgs: [] }),
  };
}

describe('launchStage adapter refusal (launch-args)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-launcher-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const input = (workspaceRoot: string) => ({
    workspaceRoot,
    runId: 'run-1',
    stage: 'plan' as const,
    role: 'planner' as const,
    model: 'gemini-3.1-pro',
    effort: 'medium',
    resume: false,
    sessionId: 'sess',
  });

  it('turns AdapterLaunchError into a launch-args error with the adapter message, creating nothing', () => {
    const host = new StubTerminalHost();
    const adapter = adapterThat(() => {
      throw new AdapterLaunchError('agy model "gemini-3.1-pro" does not offer effort "medium"');
    });
    const result = launchStage(input(root), { adapter, terminalHost: host });
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'launch-args');
      assert.ok(/does not offer effort/.test(result.error.message));
    }
    assert.strictEqual(host.created.length, 0);
    assert.ok(!fs.existsSync(path.join(root, '.baiton', 'runs', 'run-1')));
  });

  it('rethrows any other adapter throw as a bug', () => {
    const host = new StubTerminalHost();
    const adapter = adapterThat(() => {
      throw new TypeError('boom');
    });
    assert.throws(() => launchStage(input(root), { adapter, terminalHost: host }), TypeError);
    assert.strictEqual(host.created.length, 0);
  });

  it('still writes the brief and creates the terminal when the adapter accepts', () => {
    const host = new StubTerminalHost();
    const adapter = adapterThat(() => ({ shellPath: 'agy', shellArgs: ['--model', 'x'] }));
    const result = launchStage(input(root), { adapter, terminalHost: host });
    assert.ok(result.ok);
    assert.strictEqual(host.created.length, 1);
    assert.ok(fs.existsSync(path.join(root, '.baiton', 'runs', 'run-1', 'brief.md')));
  });
});

/**
 * The config-driven ask-relay fallback: adapters with a verified native relay
 * (claude) keep the byte-identical previous Brief and wire their own hook,
 * while adapters without one (antigravity, and any unknown agent id) get the
 * 'Asking for permission or a decision' section in their Brief, in the fixed
 * section order, with wire examples that parse.
 */
describe('launchStage config-driven ask-relay fallback', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-launcher-relay-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const input = (workspaceRoot: string, relayAsks?: boolean, briefContext?: string) => ({
    workspaceRoot,
    runId: 'run-1',
    stage: 'plan' as const,
    role: 'planner' as const,
    model: 'gemini-3.1-pro',
    effort: 'medium',
    resume: false,
    sessionId: 'sess',
    ...(relayAsks !== undefined ? { relayAsks } : {}),
    ...(briefContext !== undefined ? { briefContext } : {}),
  });

  const briefPath = (workspaceRoot: string): string =>
    path.join(workspaceRoot, '.baiton', 'runs', 'run-1', 'brief.md');

  const launchWith = (adapter: Adapter, i: ReturnType<typeof input>) => {
    const host = new StubTerminalHost();
    const result = launchStage(i, { adapter, terminalHost: host });
    assert.ok(result.ok);
    return { host, result: result.ok ? result.value : undefined };
  };

  it('writes the ask-relay section into a fallback adapter brief when relayAsks is set', () => {
    const adapter = adapterThat(() => ({ shellPath: 'agy', shellArgs: [] }), 'antigravity');
    const { result } = launchWith(adapter, input(root, true));
    const brief = fs.readFileSync(briefPath(root), 'utf8');

    assert.ok(brief.includes(ASK_RELAY_SECTION_HEADING), 'brief carries the relay section heading');
    assert.ok(brief.includes(asksDirFor(root, 'run-1')), 'brief names the absolute asks directory');
    assert.ok(brief.includes('.response.json'), 'brief names the response suffix');
    assert.ok(brief.includes('"runId": "run-1"'), 'brief example carries the run id');
    assert.ok(brief.includes('"agent": "antigravity"'), 'brief example carries the agent id');
    assert.ok(
      brief.includes(ASK_RELAY_NO_SELF_APPROVE_INSTRUCTION),
      'brief carries the no-self-approve instruction verbatim',
    );
    assert.strictEqual(result?.askRelayKind, 'config-driven');
  });

  it('keeps the section order: role, optional context, relay, result path, schema, stop', () => {
    const adapter = adapterThat(() => ({ shellPath: 'agy', shellArgs: [] }), 'antigravity');
    launchWith(adapter, input(root, true, '## Todo\n\nT01 do the thing.'));
    const brief = fs.readFileSync(briefPath(root), 'utf8');

    const roleIdx = brief.indexOf('# Role');
    const contextIdx = brief.indexOf('# Context');
    const relayIdx = brief.indexOf(ASK_RELAY_SECTION_HEADING);
    const resultIdx = brief.indexOf('# Result file');
    const schemaIdx = brief.indexOf('# Result schema');
    const stopIdx = brief.indexOf('# When you are done');

    assert.ok(roleIdx >= 0 && contextIdx >= 0 && relayIdx >= 0);
    assert.ok(roleIdx < contextIdx, 'role before context');
    assert.ok(contextIdx < relayIdx, 'context before the relay heading');
    assert.ok(relayIdx < resultIdx, 'relay heading before the result path');
    assert.ok(resultIdx < schemaIdx, 'result path before the schema');
    assert.ok(schemaIdx < stopIdx, 'schema before the stop instruction');
  });

  it('emits fenced JSON blocks that the ask-relay parsers accept', () => {
    const adapter = adapterThat(() => ({ shellPath: 'agy', shellArgs: [] }), 'antigravity');
    launchWith(adapter, input(root, true));
    const brief = fs.readFileSync(briefPath(root), 'utf8');

    const afterHeading = brief.slice(brief.indexOf(ASK_RELAY_SECTION_HEADING));
    const fences = [...afterHeading.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    assert.ok(fences.length >= 2, 'the relay section carries two fenced json blocks');

    const ask = parseAsk(fences[0]);
    assert.ok(ask.ok, `the example ask parses: ${ask.ok ? '' : ask.error.message}`);
    const response = parseResponse(fences[1]);
    assert.ok(
      response.ok,
      `the example response parses: ${response.ok ? '' : response.error.message}`,
    );
  });

  it('does not touch a native adapter brief and still hands it the relay descriptor', () => {
    let lastRequest: LaunchRequest | undefined;
    const launch = (req: LaunchRequest): LaunchSpec => {
      lastRequest = req;
      return { shellPath: 'claude', shellArgs: ['--settings', '{}'] };
    };

    const withoutFlag = launchWith(adapterThat(launch, 'claude'), input(root));
    const briefWithout = fs.readFileSync(briefPath(root), 'utf8');

    const withFlag = launchWith(adapterThat(launch, 'claude'), input(root, true));
    const briefWith = fs.readFileSync(briefPath(root), 'utf8');

    assert.strictEqual(briefWith, briefWithout, 'claude brief is byte-identical with and without relayAsks');
    assert.ok(!briefWith.includes(ASK_RELAY_SECTION_HEADING), 'no relay heading in a claude brief');
    assert.strictEqual(withFlag.result?.askRelayKind, 'native');
    assert.ok(withFlag.result?.relay !== undefined, 'claude still receives the relay descriptor');
    assert.ok(lastRequest?.relay !== undefined, 'the adapter launch request carried the relay');
    assert.ok(withoutFlag.result?.relay === undefined, 'no relay descriptor without the flag');
  });

  it('leaves a fallback-adapter launch byte-identical when relayAsks is omitted', () => {
    const adapter = adapterThat(() => ({ shellPath: 'agy', shellArgs: [] }), 'antigravity');
    const withoutFlag = launchWith(adapter, input(root));
    const briefWithout = fs.readFileSync(briefPath(root), 'utf8');

    assert.ok(!briefWithout.includes(ASK_RELAY_SECTION_HEADING), 'no relay heading without the flag');
    assert.strictEqual(withoutFlag.result?.askRelayKind, undefined);
    assert.ok(
      !fs.existsSync(path.join(root, '.baiton', 'runs', 'run-1', 'asks')),
      'no asks directory without the flag',
    );

    // Byte-identical to the pre-change text: exactly what the pure brief
    // writer composes for the same input, with no relay section anywhere.
    const expected = buildBrief({
      stage: 'plan',
      role: 'planner',
      resultPath: path.join(root, '.baiton', 'runs', 'run-1', 'result.json'),
      context: undefined,
    });
    assert.strictEqual(briefWithout, expected);
  });

  it('treats an unknown agent id conservatively as config-driven', () => {
    const adapter = adapterThat(() => ({ shellPath: 'future', shellArgs: [] }), 'future-cli' as unknown as AgentId);
    const { result } = launchWith(adapter, input(root, true));
    const brief = fs.readFileSync(briefPath(root), 'utf8');

    assert.ok(brief.includes(ASK_RELAY_SECTION_HEADING), 'the relay section is present (conservative default)');
    assert.strictEqual(result?.askRelayKind, 'config-driven');
  });
});
