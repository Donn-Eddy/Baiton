import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  type CodexUsageProcess,
  type CodexUsageSeams,
  CODEX_USAGE_INITIALIZE_ID,
  CODEX_USAGE_RATE_LIMITS_ID,
  CODEX_USAGE_RATE_LIMITS_METHOD,
  createCodexUsageReader,
  extractCodexCredential,
  parseCodexAppServerRateLimits,
  parseCodexRolloutRateLimits,
  parseCodexWhamUsage,
} from '../src/usage/codex';
import type { UsageReadContext } from '../src/usage/usageService';
import { UsageService } from '../src/usage/usageService';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'codex', name), 'utf8');
const APP_RESULT: unknown = JSON.parse(fixture('app-server-result.json'));
const ROLLOUT = fixture('rollout.jsonl');
const WHAM: unknown = JSON.parse(fixture('wham.json'));

const TOKEN = 'eyJhbGciOi.fakepayload.sig';
const API_KEY = 'sk-testABCDEFGHIJKL';
const AUTH = JSON.stringify({ tokens: { access_token: TOKEN, account_id: 'acct-1' } });

interface Fake {
  spawn: () => CodexUsageProcess;
  writes: string[];
  spawns: () => number;
  kills: () => number;
  ends: () => number;
  api: { reply(m: unknown): void; error(e: unknown): void; exit(): void };
}

function fakeServer(onLine: (msg: Record<string, unknown>, reply: (m: unknown) => void) => void): Fake {
  const writes: string[] = [];
  const out: Array<(c: Buffer | string) => void> = [];
  const errs: Array<(...a: unknown[]) => void> = [];
  const exits: Array<(...a: unknown[]) => void> = [];
  let spawns = 0;
  let kills = 0;
  let ends = 0;
  const reply = (m: unknown): void => {
    setImmediate(() => out.forEach((l) => l(`${JSON.stringify(m)}\n`)));
  };
  const child: CodexUsageProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        onLine(JSON.parse(chunk) as Record<string, unknown>, reply);
        return true;
      },
      end() {
        ends++;
      },
    },
    stdout: { on: (_e, l) => (out.push(l), child) },
    on(e, l) {
      if (e === 'error') errs.push(l);
      else exits.push(l);
      return child;
    },
    kill() {
      kills++;
      return true;
    },
  };
  return {
    spawn: () => (spawns++, child),
    writes,
    spawns: () => spawns,
    kills: () => kills,
    ends: () => ends,
    api: {
      reply,
      error: (e) => setImmediate(() => errs.forEach((l) => l(e))),
      exit: () => setImmediate(() => exits.forEach((l) => l(1))),
    },
  };
}

const happy = (result: unknown = APP_RESULT): Fake =>
  fakeServer((msg, reply) => {
    if (msg.id === CODEX_USAGE_INITIALIZE_ID) reply({ id: 1, result: {} });
    else if (msg.id === CODEX_USAGE_RATE_LIMITS_ID) reply({ id: 2, result });
  });

const rpcFail = (): Fake =>
  fakeServer((msg, reply) => {
    if (msg.id === 1) reply({ id: 1, result: {} });
    else if (msg.id === 2) reply({ id: 2, error: { code: -32601, message: 'method not found' } });
  });

const NOW = Date.parse('2026-09-28T06:00:00Z');
function ctx(over: Partial<UsageReadContext> = {}): UsageReadContext {
  return { signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 1000, ...over };
}

describe('codex usage parsers', () => {
  it('maps app-server primary and secondary windows', () => {
    const r = parseCodexAppServerRateLimits(APP_RESULT);
    assert.strictEqual(r.tier, 'plus');
    assert.deepStrictEqual(
      r.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.provenance]),
      [
        ['five-hour', '5-hour', 42, 1791535100000, 'provider-reported'],
        ['weekly', 'Weekly', 7, 1792121900000, 'provider-reported'],
      ],
    );
  });

  it('skips null windows, non-numeric percents and garbage', () => {
    const r = parseCodexAppServerRateLimits({
      rateLimits: { primary: null, secondary: { usedPercent: 'x', windowDurationMins: 60, resetsAt: 1 } },
    });
    assert.deepStrictEqual(r.windows, []);
    for (const g of [null, 5, 'x', [], undefined, { rateLimits: 3 }]) {
      assert.deepStrictEqual(parseCodexAppServerRateLimits(g).windows, []);
    }
  });

  it('labels unusual window lengths and extra limit buckets', () => {
    const r = parseCodexAppServerRateLimits({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 120 } },
      rateLimitsByLimitId: { other: { limitName: 'Spark', primary: { usedPercent: 9, windowDurationMins: 1440 } } },
    });
    assert.strictEqual(r.windows[0].label, '2h');
    assert.strictEqual(r.windows[0].resetsAt, undefined);
    assert.strictEqual(r.windows[1].label, '1d (Spark)');
    assert.strictEqual(r.windows[1].scope?.model, 'Spark');
  });

  it('rollout: takes the last token_count, ignores bad lines, drops reset windows', () => {
    const noisy = `${ROLLOUT}\nnot json\n{"payload":{"type":"token_count"}}\n`;
    const live = parseCodexRolloutRateLimits(noisy, 1790000000000);
    assert.deepStrictEqual(live.windows.map((w) => w.usedPercent), [2, 1]);
    assert.strictEqual(live.tier, 'plus');
    assert.strictEqual(live.snapshotAt, Date.parse('2026-09-28T05:18:57.676Z'));
    // After the 5h reset only the weekly window survives; nothing becomes 0%.
    const later = parseCodexRolloutRateLimits(noisy, 1790590626000 + 1);
    assert.deepStrictEqual(later.windows.map((w) => w.id), ['weekly']);
    assert.deepStrictEqual(parseCodexRolloutRateLimits('junk', NOW).windows, []);
  });

  it('rollout: resets_in_seconds is relative to the line timestamp', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-28T05:00:00.000Z',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 600 } } },
    });
    const r = parseCodexRolloutRateLimits(line, Date.parse('2026-09-28T05:01:00Z'));
    assert.strictEqual(r.windows[0].resetsAt, Date.parse('2026-09-28T05:10:00Z'));
  });

  it('parses wham usage', () => {
    const r = parseCodexWhamUsage(WHAM, NOW);
    assert.strictEqual(r.tier, 'plus');
    assert.deepStrictEqual(r.windows.map((w) => [w.id, w.usedPercent, w.resetsAt]), [
      ['five-hour', 12, 1791535100000],
      ['weekly', 3, 1792121900000],
    ]);
    assert.deepStrictEqual(parseCodexWhamUsage('x').windows, []);
  });

  it('extracts credentials', () => {
    assert.deepStrictEqual(extractCodexCredential(AUTH), { accessToken: TOKEN, accountId: 'acct-1' });
    assert.deepStrictEqual(extractCodexCredential(JSON.stringify({ OPENAI_API_KEY: API_KEY })), { apiKeyOnly: true });
    assert.strictEqual(extractCodexCredential('{bad'), undefined);
    assert.strictEqual(extractCodexCredential('{}'), undefined);
  });
});

describe('codex usage reader', () => {
  it('app-server happy path', async () => {
    const fake = happy();
    const reading = await createCodexUsageReader({ spawnAppServer: fake.spawn })(ctx());
    assert.strictEqual(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.strictEqual(reading.source.mechanism, 'cli-server');
    assert.strictEqual(reading.source.provenance, 'provider-reported');
    assert.strictEqual(reading.tier, 'plus');
    assert.deepStrictEqual(fake.writes.map((w) => JSON.parse(w)), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'baiton', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: CODEX_USAGE_RATE_LIMITS_METHOD, params: {} },
    ]);
    assert.ok(fake.kills() >= 1 && fake.ends() >= 1);
  });

  it('a JSON-RPC error falls through to the rollout file', async () => {
    const fake = rpcFail();
    const reading = await createCodexUsageReader({
      spawnAppServer: fake.spawn,
      readLatestRollout: async () => ROLLOUT,
    })(ctx({ now: () => 1790000000000 }));
    assert.strictEqual(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.strictEqual(reading.source.mechanism, 'cli-files');
    assert.strictEqual(reading.source.readAt, Date.parse('2026-09-28T05:18:57.676Z'));
    assert.ok(fake.kills() >= 1);
  });

  it('every seam failing gives an unavailable reason naming each mechanism', async () => {
    const reading = await createCodexUsageReader({
      spawnAppServer: () => {
        throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      },
      readLatestRollout: async () => undefined,
      readAuthFile: async () => AUTH,
      fetchJson: async () => ({ status: 403, body: {} }),
    })(ctx());
    assert.strictEqual(reading.status, 'unavailable');
    if (reading.status !== 'unavailable') return;
    assert.ok(/not found on PATH/.test(reading.reason), reading.reason);
    assert.ok(/session log/.test(reading.reason), reading.reason);
    assert.ok(/HTTP 403/.test(reading.reason), reading.reason);
    assert.strictEqual(reading.mechanism, 'provider-endpoint');
    const none = await createCodexUsageReader({})(ctx());
    assert.strictEqual(none.status, 'unavailable');
  });

  it('wham fallback succeeds with a bearer header only in fetchJson', async () => {
    const seen: Array<Record<string, string>> = [];
    const logs: string[] = [];
    const reading = await createCodexUsageReader({
      readAuthFile: async () => AUTH,
      fetchJson: async (_u, init) => {
        seen.push(init.headers);
        return { status: 200, body: WHAM };
      },
      log: (m) => logs.push(m),
    })(ctx());
    assert.strictEqual(reading.status, 'ok');
    if (reading.status !== 'ok') return;
    assert.strictEqual(reading.source.mechanism, 'provider-endpoint');
    assert.strictEqual(seen[0].Authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(seen[0]['ChatGPT-Account-Id'], 'acct-1');
    assert.ok(!JSON.stringify(reading).includes(TOKEN));
    assert.ok(!logs.join('\n').includes(TOKEN));
  });

  it('API-key-only login gives an honest reason', async () => {
    const reading = await createCodexUsageReader({
      readAuthFile: async () => JSON.stringify({ OPENAI_API_KEY: API_KEY }),
      fetchJson: async () => ({ status: 200, body: WHAM }),
    })(ctx());
    assert.strictEqual(reading.status, 'unavailable');
    if (reading.status === 'unavailable') assert.ok(/API key/.test(reading.reason));
  });

  it('Restricted Mode never touches credential seams', async () => {
    let calls = 0;
    const seams: CodexUsageSeams = {
      readAuthFile: async () => (calls++, AUTH),
      fetchJson: async () => (calls++, { status: 200, body: WHAM }),
    };
    const reading = await createCodexUsageReader(seams)(ctx({ trusted: false }));
    assert.strictEqual(calls, 0);
    assert.strictEqual(reading.status, 'unavailable');
    if (reading.status === 'unavailable') assert.ok(/Restricted Mode/.test(reading.reason));
  });

  it('never leaks the token from a rejection or a 401', async () => {
    const logs: string[] = [];
    for (const fetchJson of [
      async (): Promise<{ status: number; body: unknown }> => {
        throw new Error(`request failed Authorization: Bearer ${TOKEN} key ${API_KEY}`);
      },
      async (): Promise<{ status: number; body: unknown }> => ({ status: 401, body: { token: TOKEN } }),
    ]) {
      const reading = await createCodexUsageReader({
        readAuthFile: async () => AUTH,
        fetchJson,
        log: (m) => logs.push(m),
      })(ctx());
      assert.strictEqual(reading.status, 'unavailable');
      const dump = JSON.stringify(reading);
      assert.ok(!dump.includes(TOKEN) && !dump.includes('fakepayload') && !dump.includes(API_KEY), dump);
    }
    const all = logs.join('\n');
    assert.ok(!all.includes(TOKEN) && !all.includes(API_KEY));
  });

  it('a pre-aborted signal spawns nothing', async () => {
    const fake = happy();
    const ac = new AbortController();
    ac.abort();
    const reading = await createCodexUsageReader({ spawnAppServer: fake.spawn })(ctx({ signal: ac.signal }));
    assert.strictEqual(reading.status, 'unavailable');
    assert.strictEqual(fake.spawns(), 0);
  });

  it('aborting mid-read kills the child and settles', async () => {
    const fake = fakeServer(() => undefined); // never replies
    const ac = new AbortController();
    const pending = createCodexUsageReader({ spawnAppServer: fake.spawn })(ctx({ signal: ac.signal }));
    setImmediate(() => ac.abort());
    const reading = await pending;
    assert.strictEqual(reading.status, 'unavailable');
    assert.ok(fake.kills() >= 1 && fake.ends() >= 1);
  });

  it('times out on a silent child', async () => {
    const fake = fakeServer(() => undefined);
    const reading = await createCodexUsageReader({ spawnAppServer: fake.spawn })(ctx({ timeoutMs: 20 }));
    assert.strictEqual(reading.status, 'unavailable');
    if (reading.status === 'unavailable') assert.ok(/timed out/.test(reading.reason));
    assert.ok(fake.kills() >= 1);
  });

  it('child exit before the reply and spawn errors settle unavailable', async () => {
    const exiting = fakeServer(() => undefined);
    const p = createCodexUsageReader({ spawnAppServer: exiting.spawn })(ctx());
    setImmediate(() => exiting.api.exit());
    assert.strictEqual((await p).status, 'unavailable');
    const erroring = fakeServer(() => undefined);
    const q = createCodexUsageReader({ spawnAppServer: erroring.spawn })(ctx());
    setImmediate(() => erroring.api.error(Object.assign(new Error('x'), { code: 'ENOENT' })));
    const r = await q;
    assert.ok(r.status === 'unavailable' && /not found on PATH/.test(r.reason));
  });

  it('construction does not spawn or read', async () => {
    let touched = 0;
    const reader = createCodexUsageReader({
      spawnAppServer: () => (touched++, happy().spawn()),
      readLatestRollout: async () => (touched++, undefined),
      readAuthFile: async () => (touched++, undefined),
    });
    assert.strictEqual(touched, 0);
    await reader(ctx());
    assert.ok(touched > 0);
  });
});

describe('codex usage module shape', () => {
  it('is host-free and fits the UsageService contract', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'codex.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import\b|\} from )/.test(l) && /from|import/.test(l));
    for (const line of imports.filter((l) => /from '/.test(l))) {
      assert.ok(/from '\.\/(model|usageService)';/.test(line), line);
    }
    for (const banned of ['vscode', 'child_process', "'fs'", "'os'", "'path'"]) {
      assert.ok(!src.includes(banned), banned);
    }
    const fake = happy();
    const service = new UsageService({
      readers: { codex: createCodexUsageReader({ spawnAppServer: fake.spawn }) },
      isTrusted: () => true,
    });
    try {
      await service.refresh();
      const reading = service.snapshot().find((r) => r.tool === 'codex');
      assert.strictEqual(reading?.status, 'ok');
    } finally {
      service.dispose();
    }
  });
});
