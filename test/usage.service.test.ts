import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  USAGE_TOOL_IDS,
  type UsageReading,
  type UsageToolId,
  okReading,
  readingAgeMs,
} from '../src/usage/model';
import {
  type UsageReadContext,
  type UsageReader,
  type UsageServiceOptions,
  type UsageTimer,
  UsageService,
  normaliseRefreshIntervalSeconds,
  redactSecrets,
} from '../src/usage/usageService';

class FakeTimer implements UsageTimer {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, { fn: () => void; ms: number }>();
  setIntervalCalls: number[] = [];
  setTimeoutCalls = 0;

  setTimeout(fn: () => void): unknown {
    this.setTimeoutCalls++;
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okFor(tool: UsageToolId, readAt: number): UsageReading {
  return okReading(
    tool,
    { mechanism: 'cli-server', detail: 'fake', provenance: 'provider-reported', readAt },
    [{ id: 'five-hour', label: '5-hour', usedPercent: 40, provenance: 'provider-reported' }],
  );
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

let t = 1000;
const now = () => t;

function readersFor(fn: (tool: UsageToolId, ctx: UsageReadContext) => Promise<UsageReading>): Record<UsageToolId, UsageReader> {
  const out = {} as Record<UsageToolId, UsageReader>;
  for (const tool of USAGE_TOOL_IDS) out[tool] = (ctx) => fn(tool, ctx);
  return out;
}

function make(
  readers: UsageServiceOptions['readers'],
  extra: Partial<UsageServiceOptions> = {},
): { service: UsageService; timer: FakeTimer } {
  const timer = new FakeTimer();
  const service = new UsageService({ readers, now, timer, ...extra });
  return { service, timer };
}

describe('UsageService', () => {
  beforeEach(() => {
    t = 1000;
  });

  it('does nothing before the first refresh', async () => {
    let calls = 0;
    const { service, timer } = make(readersFor(async (tool) => { calls++; return okFor(tool, t); }));
    assert.strictEqual(calls, 0);
    assert.strictEqual(timer.setTimeoutCalls, 0);
    assert.strictEqual(timer.setIntervalCalls.length, 0);
    assert.deepStrictEqual(service.snapshot(), []);
    service.startPolling(60);
    await flush();
    assert.strictEqual(calls, 0);
    timer.fireIntervals();
    await flush();
    assert.strictEqual(calls, USAGE_TOOL_IDS.length);
    service.dispose();
  });

  it('reads every tool once on refresh', async () => {
    const seen: UsageReadContext[] = [];
    const counts: Record<string, number> = {};
    const { service } = make(readersFor(async (tool, ctx) => {
      seen.push(ctx);
      counts[tool] = (counts[tool] ?? 0) + 1;
      return okFor(tool, t);
    }), { timeoutMs: 4321 });
    const result = await service.refresh();
    assert.deepStrictEqual(result.map((r) => r.tool), [...USAGE_TOOL_IDS]);
    assert.ok(result.every((r) => r.status === 'ok'));
    for (const tool of USAGE_TOOL_IDS) assert.strictEqual(counts[tool], 1);
    assert.ok(seen.every((c) => c.timeoutMs === 4321 && c.now === now));
    service.dispose();
  });

  it('reports a missing reader as unavailable', async () => {
    const { service } = make({});
    const r = await service.refreshTool('codex');
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(r.status === 'unavailable' && r.reason.includes('Codex'));
  });

  it('keeps the reader reason and mechanism when unavailable with no prior reading', async () => {
    const { service } = make({
      claude: async () => ({ tool: 'claude', status: 'unavailable', reason: 'not logged in', checkedAt: 1, mechanism: 'cli-command' }),
    });
    const r = await service.refreshTool('claude');
    assert.deepStrictEqual(r, { tool: 'claude', status: 'unavailable', reason: 'not logged in', checkedAt: 1000, mechanism: 'cli-command' });
  });

  it('turns a failure after a good read into a stale reading', async () => {
    let mode: 'ok' | 'fail' | 'unavailable' = 'ok';
    const { service } = make({
      codex: async () => {
        if (mode === 'fail') throw new Error('boom');
        if (mode === 'unavailable') return { tool: 'codex', status: 'unavailable', reason: 'gone', checkedAt: 0 };
        return okFor('codex', t);
      },
    });
    await service.refreshTool('codex');
    t = 61000;
    mode = 'fail';
    const stale = await service.refreshTool('codex');
    assert.strictEqual(stale.status, 'stale');
    if (stale.status !== 'stale') return;
    assert.strictEqual(stale.reason, 'boom');
    assert.strictEqual(stale.failedAt, 61000);
    assert.strictEqual(stale.source.readAt, 1000);
    assert.strictEqual(readingAgeMs(stale, 61000), 60000);
    assert.strictEqual(stale.windows.length, 1);
    t = 90000;
    const again = await service.refreshTool('codex');
    assert.ok(again.status === 'stale' && again.source.readAt === 1000 && again.failedAt === 90000);
    mode = 'unavailable';
    const viaUnavailable = await service.refreshTool('codex');
    assert.ok(viaUnavailable.status === 'stale' && viaUnavailable.reason === 'gone');
  });

  it('coalesces overlapping reads per tool', async () => {
    const d = deferred<UsageReading>();
    let calls = 0;
    const { service } = make({ codex: () => { calls++; return d.promise; } });
    const a = service.refreshTool('codex');
    const b = service.refreshTool('codex');
    const c = service.refresh(['codex']);
    await flush();
    assert.strictEqual(calls, 1);
    d.resolve(okFor('codex', t));
    const [ra, rb] = await Promise.all([a, b]);
    await c;
    assert.strictEqual(ra, rb);
    assert.strictEqual(calls, 1);
    const d2 = deferred<UsageReading>();
    d2.resolve(okFor('codex', t));
    const again = service.refreshTool('codex');
    await again;
    assert.strictEqual(calls, 2);
  });

  it('times out a hung reader, aborts its signal and ignores a late result', async () => {
    const hung = deferred<UsageReading>();
    let signal: AbortSignal | undefined;
    const { service, timer } = make({ codex: (ctx) => { signal = ctx.signal; return hung.promise; } });
    const p = service.refreshTool('codex');
    await flush();
    timer.fireTimeouts();
    const r = await p;
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(r.status === 'unavailable' && /timed out/.test(r.reason));
    assert.ok(signal?.aborted);
    hung.resolve(okFor('codex', t));
    await flush();
    assert.strictEqual(service.get('codex'), r);

    // with a prior good reading
    let first = true;
    const hung2 = deferred<UsageReading>();
    const s2 = make({ codex: async () => (first ? okFor('codex', t) : hung2.promise) });
    await s2.service.refreshTool('codex');
    first = false;
    const p2 = s2.service.refreshTool('codex');
    await flush();
    s2.timer.fireTimeouts();
    const r2 = await p2;
    assert.ok(r2.status === 'stale' && /timed out/.test(r2.reason));
  });

  it('never throws on misbehaving readers or listeners', async () => {
    const bad: UsageServiceOptions['readers'] = {
      claude: () => { throw new Error('sync'); },
      codex: () => Promise.reject(42),
      antigravity: () => Promise.reject(undefined),
      'opencode-go': async () => null as unknown as UsageReading,
    };
    const { service } = make(bad);
    service.onDidChange(() => { throw new Error('listener'); });
    const result = await service.refresh();
    assert.strictEqual(result.length, 4);
    for (const r of result) {
      assert.strictEqual(r.status, 'unavailable');
      assert.ok(r.status === 'unavailable' && r.reason.length > 0);
    }
    const { service: s2 } = make({
      claude: async () => okFor('codex', t),
      codex: async () => ({ tool: 'codex', status: 'ok', windows: [], source: { mechanism: 'cli-files', detail: 'x', provenance: 'provider-reported', readAt: 1 } }),
    });
    const r2 = await s2.refresh(['claude', 'codex']);
    assert.ok(r2.every((r) => r.status === 'unavailable'));
  });

  it('passes the trusted flag fail-closed', async () => {
    const seen: boolean[] = [];
    const readers = { claude: async (ctx: UsageReadContext) => { seen.push(ctx.trusted); return okFor('claude', t); } };
    await make(readers, { isTrusted: () => false }).service.refreshTool('claude');
    await make(readers, { isTrusted: () => true }).service.refreshTool('claude');
    await make(readers, { isTrusted: () => { throw new Error('x'); } }).service.refreshTool('claude');
    await make(readers).service.refreshTool('claude');
    assert.deepStrictEqual(seen, [false, true, false, false]);
  });

  it('keeps credentials out of readings and logs', async () => {
    const logs: string[] = [];
    const smuggled = { ...okFor('codex', t), token: 'sk-SMUGGLEDSECRET999' } as unknown as UsageReading;
    const detailed = okReading('antigravity', { mechanism: 'cli-files', detail: 'read access_token=xyz123 ok', provenance: 'provider-reported', readAt: 5 },
      [{ id: 'w', label: 'W', provenance: 'provider-reported', usedPercent: 1 }]);
    const { service } = make({
      claude: async () => { throw new Error('401 for Bearer abc.def-123 token=sk-ant-SECRETSECRET123 eyJhbGciOi.eyJzdWIi.sig'); },
      codex: async () => smuggled,
      antigravity: async () => detailed,
      'opencode-go': async () => ({ tool: 'opencode-go', status: 'unavailable', reason: 'bad refresh_token: "r3fr3sh"', checkedAt: 0 }),
    }, { log: (m) => logs.push(m) });
    service.onDidChange(() => { throw new Error('leak sk-ant-LOGSECRET123456'); });
    await service.refresh();
    const json = JSON.stringify(service.snapshot());
    for (const secret of ['abc.def-123', 'SECRETSECRET123', 'eyJhbGciOi', 'SMUGGLEDSECRET', 'xyz123', 'r3fr3sh']) {
      assert.ok(!json.includes(secret), `leaked ${secret}`);
    }
    assert.ok(json.includes('[redacted]'));
    assert.ok(!('token' in (service.get('codex') as object)));
    assert.ok(!logs.join('\n').includes('LOGSECRET'));
    assert.ok(logs.length > 0);
  });

  it('redactSecrets masks each pattern and leaves ordinary text alone', () => {
    assert.strictEqual(redactSecrets('Bearer abc123'), 'Bearer [redacted]');
    assert.ok(!redactSecrets('eyJhbGciOi.eyJzdWIi.sig').includes('eyJ'));
    for (const s of ['sk-ant-abcdef123', 'ya29.abcdefg', 'ghp_abcdefgh', 'xoxb-abcdefgh']) {
      assert.strictEqual(redactSecrets(`k ${s}`), 'k [redacted]');
    }
    assert.strictEqual(redactSecrets('{"api_key":"hunter22"}'), '{"api_key":"[redacted]"}');
    assert.ok(!redactSecrets('x ' + 'A'.repeat(40)).includes('AAAA'));
    assert.strictEqual(redactSecrets('5-hour window resets at 12:00'), '5-hour window resets at 12:00');
    assert.strictEqual(redactSecrets(undefined as unknown as string), '');
  });

  it('polls on an interval without reading immediately', async () => {
    let calls = 0;
    const { service, timer } = make(readersFor(async (tool) => { calls++; return okFor(tool, t); }));
    service.startPolling(60);
    assert.deepStrictEqual(timer.setIntervalCalls, [60000]);
    assert.ok(service.isPolling);
    service.startPolling(60);
    assert.strictEqual(timer.pendingIntervals(), 1);
    assert.strictEqual(calls, 0);
    timer.fireIntervals();
    await flush();
    assert.strictEqual(calls, 4);
    service.stopPolling();
    assert.strictEqual(timer.pendingIntervals(), 0);
    assert.ok(!service.isPolling);
    for (const v of [undefined, NaN, 'x']) assert.strictEqual(normaliseRefreshIntervalSeconds(v), 300);
    assert.strictEqual(normaliseRefreshIntervalSeconds(1), 30);
    assert.strictEqual(normaliseRefreshIntervalSeconds(1e9), 86400);
    assert.strictEqual(normaliseRefreshIntervalSeconds(90.4), 90);
  });

  it('dispose stops polling, aborts reads and silences listeners', async () => {
    const d = deferred<UsageReading>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const { service, timer } = make({ codex: (ctx) => { calls++; signal = ctx.signal; return d.promise; } });
    let emitted = 0;
    service.onDidChange(() => { emitted++; });
    service.startPolling(60);
    const p = service.refreshTool('codex');
    await flush();
    service.dispose();
    service.dispose();
    assert.strictEqual(timer.pendingIntervals(), 0);
    assert.ok(signal?.aborted);
    d.resolve(okFor('codex', t));
    const r = await p;
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(emitted, 0);
    assert.strictEqual(service.get('codex'), undefined);
    const later = await service.refreshTool('codex');
    assert.strictEqual(later.status, 'unavailable');
    assert.strictEqual(calls, 1);
    service.startPolling(60);
    assert.strictEqual(timer.pendingIntervals(), 0);
  });

  it('notifies listeners with ordered snapshots until unsubscribed', async () => {
    const { service } = make(readersFor(async (tool) => okFor(tool, t)));
    const snaps: UsageToolId[][] = [];
    const sub = service.onDidChange((s) => snaps.push(s.map((r) => r.tool)));
    await service.refreshTool('codex');
    await service.refreshTool('claude');
    assert.deepStrictEqual(snaps, [['codex'], ['claude', 'codex']]);
    sub.dispose();
    await service.refreshTool('antigravity');
    assert.strictEqual(snaps.length, 2);
  });

  it('stays host-free', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'usageService.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b|require\(/.test(l));
    for (const line of imports) {
      assert.ok(/from '\.\/model'/.test(line), `unexpected import: ${line}`);
    }
    assert.ok(!/vscode/.test(imports.join('\n')));
  });
});
