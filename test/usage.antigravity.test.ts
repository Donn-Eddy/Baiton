import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  ANTIGRAVITY_USAGE_BIN,
  ANTIGRAVITY_USAGE_CLI_ARGS,
  type AntigravityUsageSeams,
  createAntigravityUsageReader,
  parseAntigravityCliUsage,
} from '../src/usage/antigravity';
import type { UsageReading } from '../src/usage/model';
import type { UsageReadContext } from '../src/usage/usageService';
import { UsageService } from '../src/usage/usageService';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'antigravity', name), 'utf8');
const CLI_JSON = fixture('cli-usage.json');
const CLI_TEXT = fixture('cli-usage.txt');

const NOW = Date.parse('2026-10-09T12:00:00Z');

function ctx(over: Partial<UsageReadContext> = {}): UsageReadContext {
  return { signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 5000, ...over };
}

interface Calls {
  cli: Array<{ args: readonly string[]; timeoutMs: number }>;
  logs: string[];
}

function seams(over: Partial<AntigravityUsageSeams> = {}): { s: AntigravityUsageSeams; calls: Calls } {
  const calls: Calls = { cli: [], logs: [] };
  const s: AntigravityUsageSeams = {
    runCli: async (args, _signal, timeoutMs) => (calls.cli.push({ args, timeoutMs }), { code: 0, stdout: CLI_JSON }),
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { s, calls };
}

function reasonOf(r: UsageReading): string {
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.tool, 'antigravity');
  assert.ok(r.status === 'unavailable' && r.reason.length > 0);
  return r.status === 'unavailable' ? r.reason : '';
}

describe('antigravity usage parsers', () => {
  it('maps each bucket of the /usage JSON to a window with (1 - fraction) * 100', () => {
    const { windows } = parseAntigravityCliUsage(CLI_JSON);
    assert.deepStrictEqual(
      windows.map((w) => [w.id, w.label, w.provenance]),
      [
        ['gemini-weekly', 'Gemini Models — Weekly', 'provider-reported'],
        ['gemini-5h', 'Gemini Models — Five Hour', 'provider-reported'],
        ['3p-weekly', 'Claude and GPT models — Weekly', 'provider-reported'],
        ['3p-5h', 'Claude and GPT models — Five Hour', 'provider-reported'],
      ],
    );
    assert.strictEqual(windows[0].resetsAt, Date.parse('2026-10-15T00:53:08Z'));
    assert.ok(windows.every((w) => typeof w.resetsAt === 'number'));
    assert.ok(Math.abs(windows[0].usedPercent! - (1 - 0.9929834604263306) * 100) < 1e-9);
    assert.strictEqual(windows[1].usedPercent, 0);
    assert.strictEqual(windows[3].usedPercent, 0);
    assert.ok(windows.every((w) => w.scope === undefined));
  });

  it('parses the plain tab-separated text with the rounded percent', () => {
    const { windows } = parseAntigravityCliUsage(CLI_TEXT);
    assert.deepStrictEqual(
      windows.map((w) => [w.id, w.usedPercent]),
      [
        ['gemini-models-weekly', 1],
        ['gemini-models-five-hour', 0],
        ['claude-and-gpt-models-weekly', 0],
        ['claude-and-gpt-models-five-hour', 0],
      ],
    );
    assert.strictEqual(windows[0].resetsAt, Date.parse('2026-10-15T00:53:08Z'));
  });

  it('falls back to the JSON response text when the structured groups are missing', () => {
    const { windows } = parseAntigravityCliUsage(JSON.stringify({ response: CLI_TEXT }));
    assert.strictEqual(windows.length, 4);
  });

  it('gives no window to a bucket without a fraction (never invents 0 or 100)', () => {
    const body = JSON.stringify({
      command: { data: { groups: [{ name: 'G', buckets: [{ id: 'a', name: 'Weekly Limit Remaining', reset_time: '2026-10-15T00:00:00Z' }, { id: 'b', remaining_fraction: 0.25 }] }] } },
    });
    const { windows } = parseAntigravityCliUsage(body);
    assert.deepStrictEqual(windows.map((w) => [w.id, w.usedPercent]), [['b', 75]]);
  });

  it('de-duplicates by id', () => {
    const bucket = { id: 'a', name: 'Weekly Limit Remaining', remaining_fraction: 0.5 };
    const body = JSON.stringify({ command: { data: { groups: [{ name: 'G', buckets: [bucket, bucket] }] } } });
    assert.strictEqual(parseAntigravityCliUsage(body).windows.length, 1);
  });

  it('is total on garbage', () => {
    for (const input of [undefined, 42, '{', '[]', '', '{"command":null}', '{"command":{"data":{"groups":null}}}', 'a\tb\tc'] as unknown[]) {
      assert.deepStrictEqual(parseAntigravityCliUsage(input as string), { windows: [] });
    }
  });
});

describe('antigravity usage reader', () => {
  it('reads the CLI route: ok, cli-command, provider-reported, fixed argv', async () => {
    const { s, calls } = seams();
    const r = await createAntigravityUsageReader(s)(ctx());
    assert.strictEqual(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.strictEqual(r.source.mechanism, 'cli-command');
    assert.strictEqual(r.source.provenance, 'provider-reported');
    assert.strictEqual(r.windows.length, 4);
    assert.strictEqual(r.tier, undefined);
    assert.deepStrictEqual(calls.cli[0].args, ['-p', '/usage', '--output-format', 'json']);
    assert.strictEqual(calls.cli[0].timeoutMs, 5000);
  });

  it('clamps a fraction outside 0..1 after okReading', async () => {
    const stdout = JSON.stringify({
      command: { data: { groups: [{ name: 'G', buckets: [{ id: 'a', remaining_fraction: 1.5 }, { id: 'b', remaining_fraction: -0.5 }] }] } },
    });
    const r = await createAntigravityUsageReader({ runCli: async () => ({ code: 0, stdout }) })(ctx());
    assert.strictEqual(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.deepStrictEqual(r.windows.map((w) => w.usedPercent), [0, 100]);
  });

  it('caps the CLI budget at 15s', async () => {
    const { s, calls } = seams();
    await createAntigravityUsageReader(s)(ctx({ timeoutMs: 120_000 }));
    assert.strictEqual(calls.cli[0].timeoutMs, 15_000);
  });

  it('ENOENT reports that agy was not found on PATH', async () => {
    const { s } = seams({ runCli: async () => Promise.reject({ code: 'ENOENT' }) });
    assert.ok(reasonOf(await createAntigravityUsageReader(s)(ctx())).includes('agy was not found on PATH'));
  });

  it('empty stdout with exit 0 is unavailable with a specific reason', async () => {
    const { s } = seams({ runCli: async () => ({ code: 0, stdout: '' }) });
    assert.ok(reasonOf(await createAntigravityUsageReader(s)(ctx())).includes('no usage windows'));
  });

  it('unavailable with no seams wired', async () => {
    const r = await createAntigravityUsageReader({})(ctx());
    assert.ok(reasonOf(r).includes('not wired'));
    assert.ok(!('windows' in r));
  });

  it('keeps the same binary name as the adapter and a stable argv', () => {
    assert.strictEqual(ANTIGRAVITY_USAGE_BIN, 'agy');
    assert.deepStrictEqual([...ANTIGRAVITY_USAGE_CLI_ARGS], ['-p', '/usage', '--output-format', 'json']);
  });

  it('an already-aborted signal is unavailable and calls no seam', async () => {
    const ac = new AbortController();
    ac.abort();
    const { s, calls } = seams();
    reasonOf(await createAntigravityUsageReader(s)(ctx({ signal: ac.signal })));
    assert.strictEqual(calls.cli.length, 0);
  });

  it('restricted mode still reads the local CLI command (no credentials are involved)', async () => {
    const { s } = seams();
    const r = await createAntigravityUsageReader(s)(ctx({ trusted: false }));
    assert.strictEqual(r.status, 'ok');
  });

  it('redacts a token embedded in a CLI error, in the reason and in logs', async () => {
    const token = 'ya29.fakeTokenABCDEFGH';
    const { s, calls } = seams({ runCli: async () => Promise.reject(new Error(`boom Bearer ${token}`)) });
    const r = await createAntigravityUsageReader(s)(ctx());
    assert.ok(!JSON.stringify(r).includes(token));
    assert.ok(calls.logs.length > 0);
    assert.ok(calls.logs.every((l) => !l.includes(token)));
  });

  it('construction is inert: no seam runs until the reader is invoked', () => {
    const { s, calls } = seams();
    const reader = createAntigravityUsageReader(s);
    new UsageService({ readers: { antigravity: reader }, isTrusted: () => true });
    assert.strictEqual(calls.cli.length, 0);
  });
});

describe('antigravity usage through UsageService', () => {
  it('refresh yields ok, a failing second read keeps it stale with the reason', async () => {
    let fail = false;
    const reader = createAntigravityUsageReader({
      runCli: async () => (fail ? { code: 0, stdout: '' } : { code: 0, stdout: CLI_JSON }),
    });
    const svc = new UsageService({ readers: { antigravity: reader }, isTrusted: () => true });
    await svc.refreshTool('antigravity');
    assert.strictEqual(svc.get('antigravity')?.status, 'ok');
    fail = true;
    await svc.refreshTool('antigravity');
    const stale = svc.get('antigravity');
    assert.strictEqual(stale?.status, 'stale');
    assert.ok(stale?.status === 'stale' && stale.reason.includes('no usage windows'));
  });

  it('coalesces two concurrent refreshes into one CLI call', async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const reader = createAntigravityUsageReader({
      runCli: async () => (n++, await gate, { code: 0, stdout: CLI_JSON }),
    });
    const svc = new UsageService({ readers: { antigravity: reader }, isTrusted: () => true });
    const a = svc.refreshTool('antigravity');
    const b = svc.refreshTool('antigravity');
    release();
    await Promise.all([a, b]);
    assert.strictEqual(n, 1);
  });

  it('a never-resolving CLI settles as unavailable "timed out" under a fake timer', async () => {
    let fire: () => void = () => undefined;
    const timer = {
      setTimeout: (fn: () => void) => ((fire = fn), 1),
      clearTimeout: () => undefined,
      setInterval: () => 2,
      clearInterval: () => undefined,
    };
    const reader = createAntigravityUsageReader({ runCli: () => new Promise(() => undefined) });
    const svc = new UsageService({ readers: { antigravity: reader }, isTrusted: () => true, timer, timeoutMs: 50 });
    const p = svc.refreshTool('antigravity');
    await Promise.resolve();
    await Promise.resolve();
    fire();
    const r = await p;
    assert.ok(reasonOf(r).includes('timed out'));
  });
});
