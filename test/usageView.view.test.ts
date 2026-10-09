import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { USAGE_TOOL_IDS, okReading, unavailableReading } from '../src/usage/model';
import type { UsageToolId } from '../src/usage/model';
import type { UsageReader, UsageReadContext, UsageTimer } from '../src/usage/usageService';

/**
 * Unit tests for the Usage WebviewView glue (spec first-party-usage, todo T10),
 * run host-free through `vscodeLoader.mjs` and `vscodeFake.mjs`.
 */

type UsageViewModule = typeof import('../src/activation/usageView');
let mod: UsageViewModule;

class FakeTimer implements UsageTimer {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, { fn: () => void; ms: number }>();
  setIntervalCalls: number[] = [];
  setTimeout(fn: () => void): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, fn);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    this.setIntervalCalls.push(ms);
    const id = this.nextId++;
    this.intervals.set(id, { fn, ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  fireIntervals(): void {
    for (const { fn } of [...this.intervals.values()]) fn();
  }
  pendingIntervals(): number {
    return this.intervals.size;
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function makeView(visible = true) {
  const posted: Array<{ type?: string; [k: string]: unknown }> = [];
  const messageListeners: Array<(m: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const visibilityListeners: Array<() => void> = [];
  const webview = {
    options: {} as { enableScripts?: boolean; localResourceRoots?: readonly { fsPath: string }[] },
    html: '',
    cspSource: 'vscode-webview-resource:',
    asWebviewUri: (uri: { fsPath?: string; path?: string }) => ({ toString: () => `vscode-resource://${uri.path ?? uri.fsPath}` }),
    postMessage: async (m: never) => {
      posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l: (m: unknown) => void) => {
      messageListeners.push(l);
      return { dispose() {} };
    },
  };
  const view = {
    visible,
    webview,
    onDidDispose: (l: () => void) => {
      disposeListeners.push(l);
      return { dispose() {} };
    },
    onDidChangeVisibility: (l: () => void) => {
      visibilityListeners.push(l);
      return { dispose() {} };
    },
  };
  return {
    view,
    webview,
    posted,
    send: (m: unknown) => messageListeners.forEach((l) => l(m)),
    setVisible: (v: boolean) => {
      view.visible = v;
      visibilityListeners.forEach((l) => l());
    },
    disposeView: () => disposeListeners.forEach((l) => l()),
  };
}

interface Harness {
  disposable: { dispose(): void };
  provider: { resolveWebviewView(v: never): void };
  timer: FakeTimer;
  calls: Record<string, number>;
  ctxs: UsageReadContext[];
  seamsCreated: Array<{ isTrusted(): boolean }>;
  executed: string[];
  commands: Map<string, () => unknown>;
  fake: {
    workspace: { isTrusted: boolean; trustListeners: Array<() => void>; configListeners: Array<(e: { affectsConfiguration(s: string): boolean }) => void>; configured: unknown };
  };
  readersCreated: number;
  hold: { release?: () => void; pending: boolean };
}

const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;

function setup(opts: { trusted?: boolean; focusRejects?: boolean; hold?: boolean } = {}): Harness {
  const timer = new FakeTimer();
  const calls: Record<string, number> = {};
  const ctxs: UsageReadContext[] = [];
  const h = {
    timer,
    calls,
    ctxs,
    seamsCreated: [] as Array<{ isTrusted(): boolean }>,
    executed: [] as string[],
    commands: new Map<string, () => unknown>(),
    readersCreated: 0,
    hold: { pending: false } as { release?: () => void; pending: boolean },
  } as unknown as Harness;
  const ws = { isTrusted: opts.trusted ?? true, trustListeners: [] as Array<() => void>, configListeners: [] as Array<(e: { affectsConfiguration(s: string): boolean }) => void>, configured: undefined as unknown };
  h.fake = { workspace: ws };
  const fake = {
    window: {
      registerWebviewViewProvider: (id: string, provider: unknown, options: unknown) => {
        (h as { registered?: unknown }).registered = { id, options };
        h.provider = provider as Harness['provider'];
        return { dispose() {} };
      },
    },
    commands: {
      executeCommand: async (c: string) => {
        h.executed.push(c);
        if (opts.focusRejects) throw new Error('no such view');
      },
      registerCommand: (id: string, cb: () => unknown) => {
        h.commands.set(id, cb);
        return { dispose() { h.commands.delete(id); } };
      },
    },
    workspace: {
      get isTrusted() {
        return ws.isTrusted;
      },
      getConfiguration: () => ({ get: () => ws.configured }),
      onDidGrantWorkspaceTrust: (l: () => void) => {
        ws.trustListeners.push(l);
        return { dispose() {} };
      },
      onDidChangeConfiguration: (l: (e: { affectsConfiguration(s: string): boolean }) => void) => {
        ws.configListeners.push(l);
        return { dispose() {} };
      },
    },
  };
  (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;
  h.disposable = mod.registerUsageView({
    extensionUri,
    log: () => {},
    resolveExecutable: () => undefined,
    now: () => 1000,
    timer,
    createSeams: (o) => {
      h.seamsCreated.push(o);
      return {};
    },
    createReaders: () => {
      h.readersCreated++;
      const readers = {} as Record<UsageToolId, UsageReader>;
      for (const tool of USAGE_TOOL_IDS) {
        readers[tool] = async (ctx) => {
          calls[tool] = (calls[tool] ?? 0) + 1;
          ctxs.push(ctx);
          if (opts.hold) {
            await new Promise<void>((r) => {
              h.hold.pending = true;
              h.hold.release = r;
            });
          }
          return ctx.trusted
            ? okReading(tool, { mechanism: 'cli-server', detail: 'x', provenance: 'provider-reported', readAt: 1 }, [{ id: 'w', label: 'w', usedPercent: 10, provenance: 'provider-reported' }])
            : unavailableReading(tool, 'Restricted Mode', 1);
        };
      }
      return readers;
    },
  });
  return h;
}

const total = (h: Harness) => Object.values(h.calls).reduce((a, b) => a + b, 0);

describe('Usage view glue (first-party-usage T10)', () => {
  before(async () => {
    const root = process.cwd();
    register(pathToFileURL(join(root, 'test', 'fixtures', 'vscodeLoader.mjs')).href, pathToFileURL(join(root, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    mod = await import('../src/activation/usageView');
  });

  afterEach(() => {
    delete (globalThis as { __vscodeFake?: unknown }).__vscodeFake;
  });

  it('ids line up with package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const ids = (pkg.contributes.views.baiton as Array<{ id: string }>).map((v) => v.id);
    assert.strictEqual(mod.USAGE_VIEW_ID, 'baiton.usageView');
    assert.strictEqual(ids.indexOf(mod.USAGE_VIEW_ID), ids.indexOf('baiton.configPanel') - 1);
    assert.ok(ids.includes(mod.USAGE_VIEW_ID));
    assert.strictEqual(mod.USAGE_VIEW_FOCUS_COMMAND, 'baiton.usageView.focus');
    const cmds = (pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command);
    assert.ok(cmds.includes(mod.USAGE_REFRESH_COMMAND));
  });

  it('registers the provider and command and creates nothing before the view is expanded', () => {
    const h = setup();
    const reg = (h as unknown as { registered: { id: string; options: unknown } }).registered;
    assert.strictEqual(reg.id, mod.USAGE_VIEW_ID);
    assert.deepStrictEqual(reg.options, mod.UsageViewProvider.registration);
    assert.ok(h.commands.has(mod.USAGE_REFRESH_COMMAND));
    assert.strictEqual(h.seamsCreated.length, 0);
    assert.strictEqual(h.readersCreated, 0);
    assert.strictEqual(total(h), 0);
    assert.deepStrictEqual(h.timer.setIntervalCalls, []);
    h.disposable.dispose();
  });

  it('resolveWebviewView renders a nonce-bound shell limited to media/', () => {
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = {};
    const provider = new mod.UsageViewProvider(extensionUri);
    const a = makeView();
    const b = makeView();
    provider.resolveWebviewView(a.view as never);
    provider.resolveWebviewView(b.view as never);
    assert.strictEqual(a.webview.options.enableScripts, true);
    assert.strictEqual(a.webview.options.localResourceRoots?.length, 1);
    assert.ok(a.webview.options.localResourceRoots?.[0].fsPath.endsWith('media'));
    for (const ph of ['${nonce}', '${cspSource}', '${baseUri}']) assert.ok(!a.webview.html.includes(ph), ph);
    const n1 = /script-src 'nonce-([0-9a-f]+)'/.exec(a.webview.html);
    const n2 = /script-src 'nonce-([0-9a-f]+)'/.exec(b.webview.html);
    assert.ok(n1 && n2);
    assert.notStrictEqual(n1[1], n2[1]);
    assert.ok(!/<script[^>]+src="https?:/i.test(a.webview.html));
    provider.dispose();
  });

  it('resolving a visible view reads every tool once, polls at the default interval, and answers ready', async () => {
    const h = setup();
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    assert.strictEqual(h.seamsCreated.length, 1);
    assert.strictEqual(h.readersCreated, 1);
    for (const t of USAGE_TOOL_IDS) assert.strictEqual(h.calls[t], 1);
    assert.deepStrictEqual(h.timer.setIntervalCalls, [300000]);
    v.send({ type: 'ready' });
    await flush();
    const readings = v.posted.filter((m) => m.type === 'readings');
    assert.ok(v.posted.some((m) => m.type === 'state'));
    assert.strictEqual((readings[readings.length - 1].rows as unknown[]).length, 4);
    h.disposable.dispose();
  });

  it('stops polling when hidden and restarts and re-reads when shown', async () => {
    const h = setup();
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    assert.strictEqual(h.timer.pendingIntervals(), 1);
    v.setVisible(false);
    assert.strictEqual(h.timer.pendingIntervals(), 0);
    v.setVisible(true);
    await flush();
    assert.strictEqual(h.timer.pendingIntervals(), 1);
    assert.strictEqual(h.calls.claude, 2);
    h.disposable.dispose();
  });

  it('disposing the view tears the controller down and a re-resolve builds a fresh service', async () => {
    const h = setup();
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    v.disposeView();
    assert.strictEqual(h.timer.pendingIntervals(), 0);
    const before = total(h);
    h.timer.fireIntervals();
    await h.commands.get(mod.USAGE_REFRESH_COMMAND)?.();
    await flush();
    assert.strictEqual(total(h), before);
    const v2 = makeView(true);
    h.provider.resolveWebviewView(v2.view as never);
    await flush();
    assert.strictEqual(h.readersCreated, 2);
    assert.strictEqual(h.timer.pendingIntervals(), 1);
    h.disposable.dispose();
  });

  it('the refresh command only reveals the view before it exists, and shares in-flight reads afterwards', async () => {
    const h = setup({ hold: true });
    await h.commands.get(mod.USAGE_REFRESH_COMMAND)?.();
    assert.deepStrictEqual(h.executed, ['baiton.usageView.focus']);
    assert.strictEqual(total(h), 0);

    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    for (const t of USAGE_TOOL_IDS) assert.strictEqual(h.calls[t], 1);
    const cmd = h.commands.get(mod.USAGE_REFRESH_COMMAND)?.();
    v.send({ type: 'refresh' });
    await flush();
    for (const t of USAGE_TOOL_IDS) assert.strictEqual(h.calls[t], 1, 'shared in-flight read');
    h.hold.release?.();
    h.disposable.dispose();
    void cmd;
  });

  it('contains a rejected focus command', async () => {
    const h = setup({ focusRejects: true });
    await assert.doesNotReject(async () => h.commands.get(mod.USAGE_REFRESH_COMMAND)?.());
    h.disposable.dispose();
  });

  it('Restricted Mode reads untrusted, and granting trust re-reads trusted', async () => {
    const h = setup({ trusted: false });
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    assert.strictEqual(h.seamsCreated[0].isTrusted(), false);
    assert.ok(h.ctxs.length > 0 && h.ctxs.every((c) => c.trusted === false));
    h.fake.workspace.isTrusted = true;
    h.ctxs.length = 0;
    h.fake.workspace.trustListeners.forEach((l) => l());
    await flush();
    assert.ok(h.ctxs.length > 0 && h.ctxs.every((c) => c.trusted === true));
    assert.strictEqual(h.seamsCreated[0].isTrusted(), true);
    assert.ok(v.posted.some((m) => m.type === 'state' && (m.state as { trusted?: boolean } | undefined)?.trusted === true));
    h.disposable.dispose();
  });

  it('restarts polling when the interval setting changes and ignores other keys', async () => {
    const h = setup();
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    h.fake.workspace.configured = 60;
    h.fake.workspace.configListeners.forEach((l) => l({ affectsConfiguration: () => false }));
    assert.deepStrictEqual(h.timer.setIntervalCalls, [300000]);
    h.fake.workspace.configListeners.forEach((l) =>
      l({ affectsConfiguration: (s) => s === 'baiton.usage.refreshIntervalSeconds' }),
    );
    assert.deepStrictEqual(h.timer.setIntervalCalls, [300000, 60000]);
    h.disposable.dispose();
  });

  it('disposing the registration leaves no interval', async () => {
    const h = setup();
    const v = makeView(true);
    h.provider.resolveWebviewView(v.view as never);
    await flush();
    h.disposable.dispose();
    assert.strictEqual(h.timer.pendingIntervals(), 0);
  });
});
