import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  OPENCODE_GO_AUTH_PROVIDER_KEYS,
  OPENCODE_GO_USAGE_URL,
  type OpencodeGoUsageSeams,
  createOpencodeGoUsageReader,
  extractOpencodeGoCredential,
  parseOpencodeGoUsage,
} from '../src/usage/opencode';
import type { UsageReading } from '../src/usage/model';
import type { UsageReadContext } from '../src/usage/usageService';
import { UsageService } from '../src/usage/usageService';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'opencode', name), 'utf8');
const ENDPOINT_JSON = fixture('endpoint-usage.json');
const AUTH_JSON = fixture('auth.json');
const TOKEN = 'sk-fakeOpencodeKey123456';

const NOW = Date.parse('2026-10-09T12:00:00Z');

function ctx(over: Partial<UsageReadContext> = {}): UsageReadContext {
  return { signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 5000, ...over };
}

interface Calls {
  auth: number;
  fetch: Array<{ url: string; headers: Record<string, string> }>;
  logs: string[];
}

function seams(over: Partial<OpencodeGoUsageSeams> = {}): { s: OpencodeGoUsageSeams; calls: Calls } {
  const calls: Calls = { auth: 0, fetch: [], logs: [] };
  const s: OpencodeGoUsageSeams = {
    readAuthFile: async () => (calls.auth++, AUTH_JSON),
    fetchJson: async (url, { headers }) => (
      calls.fetch.push({ url, headers }),
      { status: 200, body: JSON.parse(ENDPOINT_JSON) as unknown }
    ),
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { s, calls };
}

function reasonOf(r: UsageReading): string {
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.tool, 'opencode-go');
  assert.ok(r.status === 'unavailable' && r.reason.length > 0);
  return r.status === 'unavailable' ? r.reason : '';
}

describe('opencode-go usage parsers', () => {
  it('maps each limit of the endpoint body to a window with the provider percent and reset', () => {
    const { windows, tier } = parseOpencodeGoUsage(JSON.parse(ENDPOINT_JSON), NOW);
    assert.deepStrictEqual(
      windows.map((w) => [w.id, w.label, w.provenance, w.usedPercent]),
      [
        ['five-hour', '5-hour', 'provider-reported', 0],
        ['weekly', 'Weekly', 'provider-reported', 1],
        ['monthly', 'Monthly', 'provider-reported', 11],
      ],
    );
    assert.strictEqual(windows[0].resetsAt, Date.parse('2026-10-09T22:28:06.000Z'));
    assert.strictEqual(windows[1].resetsAt, Date.parse('2026-10-12T00:00:00.000Z'));
    assert.strictEqual(tier, undefined);
  });

  it('accepts the JSON text', () => {
    assert.strictEqual(parseOpencodeGoUsage(ENDPOINT_JSON, NOW).windows.length, 3);
  });

  it('gives a window no percent when the source has none: such a limit gets no window', () => {
    const r = parseOpencodeGoUsage({ usage: { weekly: { status: 'ok', used: 3, limit: 10 }, monthly: { percent: 5 } } }, NOW);
    assert.deepStrictEqual(r.windows.map((w) => w.id), ['monthly']);
    assert.strictEqual(r.windows[0].resetsAt, undefined);
    assert.strictEqual(r.windows[0].raw, undefined);
  });

  it('slugs an unknown limit name and de-duplicates by id', () => {
    const r = parseOpencodeGoUsage(
      { usage: { 'Daily Cap': { percent: 2 }, 'daily-cap': { percent: 9 }, rolling: { percent: 1 }, ROLLING: { percent: 3 } } },
      NOW,
    );
    assert.deepStrictEqual(r.windows.map((w) => [w.id, w.usedPercent]), [['daily-cap', 2], ['five-hour', 1]]);
  });

  it('is total on garbage', () => {
    for (const g of [undefined, 42, '{', '[]', '', null, { usage: null }, { usage: { weekly: null } }, { usage: { weekly: { percent: 'x' } } }]) {
      assert.deepStrictEqual(parseOpencodeGoUsage(g, NOW), { windows: [] });
    }
  });

  it('extracts the credential for api and oauth logins, and undefined otherwise', () => {
    assert.strictEqual(extractOpencodeGoCredential(AUTH_JSON), TOKEN);
    assert.strictEqual(extractOpencodeGoCredential('{"opencode":{"type":"oauth","access":"acc-token-1","refresh":"r"}}'), 'acc-token-1');
    assert.strictEqual(extractOpencodeGoCredential('{"opencode":{"type":"wellknown"}}'), undefined);
    assert.strictEqual(extractOpencodeGoCredential('{"other":{"type":"api","key":"k"}}'), undefined);
    for (const g of ['', '{', '[]', 'null', '42', '{"opencode-go":"x"}']) {
      assert.strictEqual(extractOpencodeGoCredential(g), undefined);
    }
    assert.deepStrictEqual([...OPENCODE_GO_AUTH_PROVIDER_KEYS], ['opencode-go', 'opencode']);
  });
});

describe('opencode-go usage reader', () => {
  it('reads the endpoint with the stored key as the only Authorization header', async () => {
    const { s, calls } = seams();
    const r = await createOpencodeGoUsageReader(s)(ctx());
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.tool, 'opencode-go');
    if (r.status !== 'ok') return;
    assert.strictEqual(r.source.mechanism, 'provider-endpoint');
    assert.strictEqual(r.source.provenance, 'provider-reported');
    assert.strictEqual(r.source.readAt, NOW);
    assert.ok(r.source.detail.length > 0);
    assert.strictEqual(r.windows.length, 3);
    assert.strictEqual(calls.fetch.length, 1);
    assert.strictEqual(calls.fetch[0].url, OPENCODE_GO_USAGE_URL);
    assert.deepStrictEqual(calls.fetch[0].headers, { Authorization: `Bearer ${TOKEN}` });
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });

  it('a non-2xx status is unavailable with the status', async () => {
    const { s } = seams({ fetchJson: async () => ({ status: 401, body: {} }) });
    assert.ok(reasonOf(await createOpencodeGoUsageReader(s)(ctx())).includes('HTTP 401'));
  });

  it('an empty or unparseable body is unavailable with a specific reason', async () => {
    for (const body of [{}, 'nope', null]) {
      const { s } = seams({ fetchJson: async () => ({ status: 200, body }) });
      const r = await createOpencodeGoUsageReader(s)(ctx());
      assert.ok(reasonOf(r).includes('no OpenCode Go usage windows'));
      assert.ok(!('windows' in r));
    }
  });

  it('no stored login is unavailable and makes no request', async () => {
    const { s, calls } = seams({ readAuthFile: async () => undefined });
    assert.ok(reasonOf(await createOpencodeGoUsageReader(s)(ctx())).includes('no stored OpenCode login'));
    assert.strictEqual(calls.fetch.length, 0);
  });

  it('no seams wired is unavailable "not wired" with no windows key', async () => {
    const r = await createOpencodeGoUsageReader({})(ctx());
    assert.ok(reasonOf(r).includes('not wired'));
    assert.ok(!('windows' in r));
  });

  it('an already-aborted signal is unavailable and calls no seam', async () => {
    const ac = new AbortController();
    ac.abort();
    const { s, calls } = seams();
    reasonOf(await createOpencodeGoUsageReader(s)(ctx({ signal: ac.signal })));
    assert.strictEqual(calls.auth, 0);
    assert.strictEqual(calls.fetch.length, 0);
  });

  it('never throws: throwing seams are unavailable', async () => {
    const a = seams({ readAuthFile: async () => Promise.reject(new Error('disk')) });
    reasonOf(await createOpencodeGoUsageReader(a.s)(ctx()));
    const b = seams({ fetchJson: () => { throw new Error('sync boom'); } });
    reasonOf(await createOpencodeGoUsageReader(b.s)(ctx()));
    const c = seams({ log: () => { throw new Error('log'); } });
    reasonOf(await createOpencodeGoUsageReader({ ...c.s, readAuthFile: async () => undefined })(ctx()));
  });

  it('Restricted Mode never reads the login or fetches', async () => {
    const { s, calls } = seams();
    const r = await createOpencodeGoUsageReader(s)(ctx({ trusted: false }));
    assert.ok(reasonOf(r).includes('Restricted Mode'));
    assert.strictEqual(calls.auth, 0);
    assert.strictEqual(calls.fetch.length, 0);
  });

  it('redacts a token in a thrown error, in the reason and in logs', async () => {
    const { s, calls } = seams({ fetchJson: async () => Promise.reject(new Error(`boom Bearer ${TOKEN}`)) });
    const r = await createOpencodeGoUsageReader(s)(ctx());
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.ok(calls.logs.length > 0);
    assert.ok(calls.logs.every((l) => !l.includes(TOKEN)));
  });

  it('construction is inert: no seam runs until the reader is invoked', () => {
    const { s, calls } = seams();
    const reader = createOpencodeGoUsageReader(s);
    new UsageService({ readers: { 'opencode-go': reader }, isTrusted: () => true });
    assert.strictEqual(calls.auth, 0);
    assert.strictEqual(calls.fetch.length, 0);
  });
});

describe('opencode-go usage through UsageService', () => {
  it('refresh yields ok, a failing second read keeps it stale with the reason', async () => {
    let fail = false;
    const reader = createOpencodeGoUsageReader({
      readAuthFile: async () => AUTH_JSON,
      fetchJson: async () => ({ status: fail ? 500 : 200, body: JSON.parse(ENDPOINT_JSON) as unknown }),
    });
    const svc = new UsageService({ readers: { 'opencode-go': reader }, isTrusted: () => true });
    await svc.refreshTool('opencode-go');
    assert.strictEqual(svc.get('opencode-go')?.status, 'ok');
    fail = true;
    await svc.refreshTool('opencode-go');
    const stale = svc.get('opencode-go');
    assert.strictEqual(stale?.status, 'stale');
    assert.ok(stale?.status === 'stale' && stale.reason.includes('HTTP 500'));
  });

  it('coalesces two concurrent refreshes into one request', async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const reader = createOpencodeGoUsageReader({
      readAuthFile: async () => AUTH_JSON,
      fetchJson: async () => (n++, await gate, { status: 200, body: JSON.parse(ENDPOINT_JSON) as unknown }),
    });
    const svc = new UsageService({ readers: { 'opencode-go': reader }, isTrusted: () => true });
    const a = svc.refreshTool('opencode-go');
    const b = svc.refreshTool('opencode-go');
    release();
    await Promise.all([a, b]);
    assert.strictEqual(n, 1);
  });

  it('a never-resolving request settles as unavailable "timed out" under a fake timer', async () => {
    let fire: () => void = () => undefined;
    const timer = {
      setTimeout: (fn: () => void) => ((fire = fn), 1),
      clearTimeout: () => undefined,
      setInterval: () => 2,
      clearInterval: () => undefined,
    };
    const reader = createOpencodeGoUsageReader({
      readAuthFile: async () => AUTH_JSON,
      fetchJson: () => new Promise(() => undefined),
    });
    const svc = new UsageService({ readers: { 'opencode-go': reader }, isTrusted: () => true, timer, timeoutMs: 50 });
    const p = svc.refreshTool('opencode-go');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fire();
    assert.ok(reasonOf(await p).includes('timed out'));
  });
});
