import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_UNAVAILABLE_REASON,
  USAGE_REASON_MAX_CHARS,
  USAGE_TOOL_IDS,
  USAGE_TOOL_LABELS,
  type OkUsageReading,
  type UsageReading,
  type UsageSource,
  type UsageToolId,
  type UsageWindow,
  barPercent,
  isBaitonDerived,
  isUsageToolId,
  normalisePercent,
  normaliseReason,
  okReading,
  readingAgeMs,
  remainingPercent,
  sortReadings,
  staleReading,
  unavailableReading,
} from '../src/usage/model';

const source: UsageSource = { mechanism: 'cli-server', detail: 'codex app-server', provenance: 'provider-reported', readAt: 1000 };
const win: UsageWindow = { id: 'five-hour', label: '5-hour', usedPercent: 40, resetsAt: 5000, provenance: 'provider-reported' };

function ok(): OkUsageReading {
  const r = okReading('codex', source, [win], 'Pro');
  assert.strictEqual(r.status, 'ok');
  return r as OkUsageReading;
}

function keys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keys(v, out);
    }
  }
  return out;
}

describe('usage model', () => {
  it('defines tool ids, labels and guards', () => {
    assert.deepStrictEqual([...USAGE_TOOL_IDS], ['claude', 'codex', 'antigravity', 'opencode-go']);
    assert.deepStrictEqual(USAGE_TOOL_LABELS, {
      claude: 'Claude Code',
      codex: 'Codex',
      antigravity: 'Antigravity',
      'opencode-go': 'OpenCode Go',
    });
    for (const id of USAGE_TOOL_IDS) assert.strictEqual(isUsageToolId(id), true);
    for (const bad of ['opencode', '', 42, undefined]) assert.strictEqual(isUsageToolId(bad), false);
  });

  it('sortReadings orders without mutating', () => {
    const shuffled = (['opencode-go', 'claude', 'antigravity', 'codex'] as UsageToolId[]).map((t) => unavailableReading(t, 'x', 1));
    const copy = [...shuffled];
    assert.deepStrictEqual(sortReadings(shuffled).map((r) => r.tool), [...USAGE_TOOL_IDS]);
    assert.deepStrictEqual(shuffled, copy);
  });

  it('normaliseReason', () => {
    for (const v of ['', '   ', undefined, 7]) assert.strictEqual(normaliseReason(v), DEFAULT_UNAVAILABLE_REASON);
    assert.strictEqual(normaliseReason('a\n  b'), 'a b');
    const long = normaliseReason('x'.repeat(1000));
    assert.strictEqual(long.length, USAGE_REASON_MAX_CHARS);
    assert.ok(long.endsWith('…'));
    assert.strictEqual(normaliseReason('  ', 'custom'), 'custom');
  });

  it('normalisePercent', () => {
    for (const v of [NaN, Infinity, '50', undefined]) assert.strictEqual(normalisePercent(v), undefined);
    assert.strictEqual(normalisePercent(-5), 0);
    assert.strictEqual(normalisePercent(150), 100);
    assert.strictEqual(normalisePercent(42.5), 42.5);
  });

  it('okReading clamps and never yields an empty ok', () => {
    const r = okReading('codex', source, [{ ...win, usedPercent: 120 }]);
    assert.strictEqual(r.status, 'ok');
    if (r.status === 'ok') assert.strictEqual(r.windows[0].usedPercent, 100);
    const empty = okReading('codex', source, []);
    assert.strictEqual(empty.status, 'unavailable');
    if (empty.status === 'unavailable') {
      assert.ok(empty.reason.length > 0);
      assert.strictEqual(empty.checkedAt, source.readAt);
      assert.strictEqual(empty.mechanism, source.mechanism);
    }
  });

  it('staleReading keeps the last good data', () => {
    const good = ok();
    const stale = staleReading(good, '  ', 9000);
    assert.strictEqual(stale.status, 'stale');
    assert.deepStrictEqual(stale.windows, good.windows);
    assert.deepStrictEqual(stale.source, good.source);
    assert.strictEqual(stale.tier, good.tier);
    assert.strictEqual(stale.source.readAt, 1000);
    assert.strictEqual(stale.failedAt, 9000);
    assert.ok(stale.reason.length > 0);
    assert.strictEqual(readingAgeMs(stale, 6000), 5000);
    assert.strictEqual(readingAgeMs(stale, 0), 0);
    assert.strictEqual(readingAgeMs(unavailableReading('codex', 'x', 1), 10), undefined);
  });

  it('barPercent never derives from raw numbers', () => {
    const raw: UsageWindow = { id: 'w', label: 'W', raw: { used: 10, limit: 50 }, provenance: 'provider-reported' };
    assert.strictEqual(barPercent(raw), undefined);
    assert.strictEqual(remainingPercent(raw), undefined);
    const pct: UsageWindow = { ...raw, usedPercent: 30 };
    assert.strictEqual(barPercent(pct), 30);
    assert.strictEqual(remainingPercent(pct), 70);
  });

  it('isBaitonDerived', () => {
    assert.strictEqual(isBaitonDerived(ok()), false);
    assert.strictEqual(isBaitonDerived(okReading('codex', { ...source, provenance: 'baiton-derived' }, [win])), true);
    assert.strictEqual(isBaitonDerived(okReading('codex', source, [win, { ...win, id: 'b', provenance: 'baiton-derived' }])), true);
    assert.strictEqual(isBaitonDerived(unavailableReading('codex', 'x', 1)), false);
  });

  it('readings are JSON-safe and carry no credential keys', () => {
    const good = ok();
    const readings: UsageReading[] = [good, staleReading(good, 'boom', 2), unavailableReading('claude', 'none', 3, 'cli-files')];
    for (const r of readings) {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
      for (const k of keys(r)) assert.ok(!/^(token|authorization|apiKey|credential)$/i.test(k), k);
    }
  });

  it('model.ts is host-free', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'model.ts'), 'utf8');
    assert.ok(!/^\s*import\s|require\(/m.test(text));
  });
});
