import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchStage } from '../src/engine/launcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter/adapter';
import { AdapterLaunchError } from '../src/adapter/adapter';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';

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

function adapterThat(launch: (req: LaunchRequest) => LaunchSpec): Adapter {
  return {
    id: 'antigravity',
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
