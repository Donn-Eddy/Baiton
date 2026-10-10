import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { UsageViewController } from '../src/activation/usageViewController';
import type { UsageViewWebview } from '../src/activation/usageViewController';
import { USAGE_TOOL_IDS, okReading, unavailableReading } from '../src/usage/model';
import type { UsageReading, UsageToolId } from '../src/usage/model';
import type { UsageHostToWebview } from '../src/usage/protocol';
import { UsageService, normaliseRefreshIntervalSeconds } from '../src/usage/usageService';
import type { UsageReadContext, UsageReader, UsageTimer } from '../src/usage/usageService';

class RecordingWebview implements UsageViewWebview {
  messages: UsageHostToWebview[] = [];
  private handler?: (msg: unknown) => void | Promise<void>;
  post(msg: UsageHostToWebview): void {
    this.messages.push(msg);
  }
  onMessage(handler: (msg: unknown) => void | Promise<void>): void {
    this.handler = handler;
  }
  async send(raw: unknown): Promise<void> {
    if (!this.handler) throw new Error('RecordingWebview: no handler registered.');
    await this.handler(raw);
  }
}

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
  fireTimeouts(): void {
    const pending = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const fn of pending) fn();
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

function okFor(tool: UsageToolId, detail = 'fake'): UsageReading {
  return okReading(
    tool,
    { mechanism: 'cli-server', detail, provenance: 'provider-reported', readAt: 1 },
    [{ id: 'five-hour', label: '5-hour', usedPercent: 40, provenance: 'provider-reported' }],
  );
}

describe('UsageViewController (first-party-usage T08)', () => {
  let web: RecordingWebview;
  let timer: FakeTimer;
  let calls: Record<string, number>;
  let ctxs: UsageReadContext[];
  let trusted: boolean;
  let configured: unknown;
  let logs: string[];
  let behave: (tool: UsageToolId, ctx: UsageReadContext) => Promise<UsageReading>;
  let service: UsageService;
  let controller: UsageViewController;

  const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  const states = () => web.messages.filter((m) => m.type === 'state') as Extract<UsageHostToWebview, { type: 'state' }>[];
  const readings = () => web.messages.filter((m) => m.type === 'readings') as Extract<UsageHostToWebview, { type: 'readings' }>[];

  beforeEach(() => {
    web = new RecordingWebview();
    timer = new FakeTimer();
    calls = {};
    ctxs = [];
    trusted = true;
    configured = 120;
    logs = [];
    behave = async (tool) => okFor(tool);
    const readers: Partial<Record<UsageToolId, UsageReader>> = {};
    for (const tool of USAGE_TOOL_IDS) {
      readers[tool] = (ctx) => {
        calls[tool] = (calls[tool] ?? 0) + 1;
        ctxs.push(ctx);
        return behave(tool, ctx);
      };
    }
    service = new UsageService({ readers, now: () => 1000, timer, isTrusted: () => trusted });
    controller = new UsageViewController({
      webview: web,
      service,
      getRefreshIntervalSeconds: () => configured,
      isTrusted: () => trusted,
      now: () => 1000,
      log: (m) => logs.push(m),
    });
  });

  afterEach(() => controller.dispose());

  it('reads, polls and posts nothing before the view is expanded', async () => {
    controller.start();
    await flush();
    assert.strictEqual(total(), 0);
    assert.strictEqual(timer.setIntervalCalls.length, 0);
    assert.strictEqual(web.messages.length, 0);
  });

  it('ready while hidden posts state then readings without reading', async () => {
    controller.start();
    await web.send({ type: 'ready' });
    await flush();
    assert.deepStrictEqual(web.messages.map((m) => m.type), ['state', 'readings']);
    assert.strictEqual(readings()[0].rows.length, 4);
    assert.ok(readings()[0].rows.every((r) => r.reading === undefined));
    assert.strictEqual(total(), 0);
  });

  it('reads once and starts polling when it becomes visible', async () => {
    controller.start();
    controller.setVisible(true);
    await flush();
    for (const tool of USAGE_TOOL_IDS) assert.strictEqual(calls[tool], 1);
    assert.deepStrictEqual(timer.setIntervalCalls, [normaliseRefreshIntervalSeconds(configured) * 1000]);
    const last = readings()[readings().length - 1];
    assert.ok(last.rows.every((r) => r.reading?.status === 'ok'));
    const flags = states().map((s) => s.state.refreshing);
    assert.ok(flags.indexOf(true) !== -1 && flags.indexOf(true) < flags.lastIndexOf(false));
    assert.strictEqual(flags[flags.length - 1], false);
  });

  it('coalesces overlapping refreshes', async () => {
    const gates: Array<(r: UsageReading) => void> = [];
    behave = (tool) => new Promise<UsageReading>((res) => gates.push(() => res(okFor(tool))));
    controller.start();
    controller.setVisible(true);
    const p = controller.refresh();
    const q = web.send({ type: 'refresh' });
    await flush();
    for (const tool of USAGE_TOOL_IDS) assert.strictEqual(calls[tool], 1);
    gates.forEach((g) => g(okFor('claude')));
    await Promise.all([p, q]);
    await flush();
    for (const tool of USAGE_TOOL_IDS) assert.strictEqual(calls[tool], 1);
    assert.strictEqual(states()[states().length - 1].state.refreshing, false);
  });

  it('polls on the interval and stops when hidden', async () => {
    controller.start();
    controller.setVisible(true);
    await flush();
    timer.fireIntervals();
    await flush();
    assert.strictEqual(calls.claude, 2);
    controller.setVisible(false);
    assert.strictEqual(timer.pendingIntervals(), 0);
    timer.fireIntervals();
    await flush();
    assert.strictEqual(calls.claude, 2);
    controller.setVisible(true);
    await flush();
    assert.strictEqual(calls.claude, 3);
    assert.strictEqual(timer.pendingIntervals(), 1);
  });

  it('surfaces stale on timeout and unavailable on rejection', async () => {
    controller.start();
    controller.setVisible(true);
    await flush();
    behave = (tool) => (tool === 'claude' ? new Promise<UsageReading>(() => undefined) : Promise.reject(new Error('boom')));
    const p = controller.refresh();
    await flush();
    timer.fireTimeouts();
    await p;
    await flush();
    const rows = readings()[readings().length - 1].rows;
    const claude = rows.find((r) => r.tool === 'claude')!.reading!;
    assert.strictEqual(claude.status, 'stale');
    assert.ok(claude.status === 'stale' && claude.reason.length > 0);
    assert.strictEqual(rows.find((r) => r.tool === 'codex')!.reading!.status, 'stale');
  });

  it('shows unavailable with a reason when there is no prior good read', async () => {
    behave = () => Promise.reject(new Error('boom'));
    controller.start();
    await controller.refresh();
    const r = readings()[readings().length - 1].rows[0].reading!;
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(r.status === 'unavailable' && r.reason.length > 0);
  });

  it('honours restricted mode and re-reads when trust is granted', async () => {
    trusted = false;
    controller.start();
    controller.setVisible(true);
    await flush();
    assert.strictEqual(states()[states().length - 1].state.trusted, false);
    assert.ok(ctxs.length > 0 && ctxs.every((c) => c.trusted === false));
    const before = ctxs.length;
    trusted = true;
    controller.notifyTrustChanged();
    await flush();
    assert.strictEqual(states()[states().length - 1].state.trusted, true);
    assert.ok(ctxs.length > before);
    assert.ok(ctxs.slice(before).every((c) => c.trusted === true));
  });

  it('never posts credential strings', async () => {
    behave = async (tool) =>
      tool === 'claude'
        ? okReading(tool, { mechanism: 'cli-server', detail: 'GET with Bearer abc.def.ghi-SECRET123456', provenance: 'provider-reported', readAt: 1 },
            [{ id: 'w', label: 'W', usedPercent: 1, provenance: 'provider-reported' }])
        : unavailableReading(tool, 'failed: access_token=SECRETVALUE987654321 rejected', 1);
    controller.start();
    await controller.refresh();
    const text = JSON.stringify(web.messages);
    assert.ok(text.includes('claude'));
    assert.ok(!text.includes('abc.def.ghi-SECRET123456'));
    assert.ok(!text.includes('SECRETVALUE987654321'));
  });

  it('restarts polling when the interval changes', async () => {
    controller.start();
    controller.setVisible(true);
    await flush();
    configured = 600;
    controller.notifyIntervalChanged();
    assert.deepStrictEqual(timer.setIntervalCalls, [120_000, 600_000]);
    assert.strictEqual(timer.pendingIntervals(), 1);
    const s = states()[states().length - 1].state;
    assert.strictEqual(s.refreshIntervalSeconds, 600);
  });

  it('posts nothing after dispose', async () => {
    const gates: Array<() => void> = [];
    behave = (tool) => new Promise<UsageReading>((res) => gates.push(() => res(okFor(tool))));
    controller.start();
    controller.setVisible(true);
    await flush();
    controller.dispose();
    assert.strictEqual(timer.pendingIntervals(), 0);
    const count = web.messages.length;
    gates.forEach((g) => g());
    await flush();
    timer.fireIntervals();
    await controller.refresh();
    await web.send({ type: 'ready' });
    await web.send({ type: 'refresh' });
    controller.notifyTrustChanged();
    controller.notifyIntervalChanged();
    await flush();
    assert.strictEqual(web.messages.length, count);
    assert.doesNotThrow(() => controller.dispose());
  });

  it('start() twice subscribes once', async () => {
    controller.start();
    controller.start();
    await service.refreshTool('claude');
    assert.strictEqual(readings().length, 1);
  });

  it('logs and ignores unrecognised messages', async () => {
    controller.start();
    await web.send({ type: 'nope' });
    await web.send(null);
    assert.strictEqual(web.messages.length, 0);
    assert.strictEqual(logs.filter((l) => l.includes('unrecognised message type')).length, 2);
  });

  it('is host-free', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'activation', 'usageViewController.ts'), 'utf8');
    assert.ok(!/from 'vscode'/.test(text));
  });
});
