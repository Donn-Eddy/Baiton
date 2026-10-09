import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { USAGE_TOOL_IDS, okReading, staleReading, unavailableReading } from '../src/usage/model';
import type { UsageReading, UsageToolId } from '../src/usage/model';
import {
  parseUsageWebviewMessage,
  readingsMessage,
  stateMessage,
  toWebviewReading,
  usageViewRows,
} from '../src/usage/protocol';

function ok(tool: UsageToolId): UsageReading {
  return okReading(
    tool,
    { mechanism: 'cli-server', detail: 'fake', provenance: 'provider-reported', readAt: 5 },
    [{
      id: 'w', label: 'Weekly', usedPercent: 12, raw: { used: 1, limit: 10, remaining: 9, unit: 'req' },
      resetsAt: 99, scope: { model: 'm', plan: 'p' }, provenance: 'provider-reported',
    }],
    'Pro',
  );
}

describe('usage protocol (first-party-usage T08)', () => {
  it('parses ready/refresh and drops extra fields', () => {
    assert.deepStrictEqual(parseUsageWebviewMessage({ type: 'ready', x: 1 }), { type: 'ready' });
    assert.deepStrictEqual(parseUsageWebviewMessage({ type: 'refresh', y: 2 }), { type: 'refresh' });
    for (const bad of [null, 'ready', {}, { type: 'save' }, { type: 1 }, undefined]) {
      assert.strictEqual(parseUsageWebviewMessage(bad), undefined);
    }
  });

  it('gives four ordered rows for no readings', () => {
    const rows = usageViewRows([]);
    assert.deepStrictEqual(rows.map((r) => r.tool), ['claude', 'codex', 'antigravity', 'opencode-go']);
    assert.deepStrictEqual(rows.map((r) => r.label), ['Claude Code', 'Codex', 'Antigravity', 'OpenCode Go']);
    for (const r of rows) {
      assert.ok(!Object.prototype.hasOwnProperty.call(r, 'reading'));
      assert.strictEqual(r.refreshing, false);
    }
  });

  it('orders out-of-order readings, ignores bogus tools, marks in-flight', () => {
    const readings = [
      unavailableReading('opencode-go', 'nope', 1),
      ok('claude'),
      staleReading(ok('codex') as never, 'boom', 2),
      { tool: 'bogus', status: 'unavailable', reason: 'x', checkedAt: 1 } as unknown as UsageReading,
    ];
    const rows = usageViewRows(readings, new Set<UsageToolId>(['codex']));
    assert.deepStrictEqual(rows.map((r) => r.tool), [...USAGE_TOOL_IDS]);
    assert.strictEqual(rows[0].reading?.status, 'ok');
    assert.strictEqual(rows[1].reading?.status, 'stale');
    assert.strictEqual(rows[2].reading, undefined);
    assert.strictEqual(rows[3].reading?.status, 'unavailable');
    assert.deepStrictEqual(rows.map((r) => r.refreshing), [false, true, false, false]);
  });

  it('toWebviewReading drops smuggled fields and keeps known ones', () => {
    const base = ok('claude') as Extract<UsageReading, { status: 'ok' }>;
    const dirty = {
      ...base,
      token: 'sk-ant-xxxxxxxxxx',
      source: { ...base.source, token: 'sk-ant-xxxxxxxxxx' },
      windows: base.windows.map((w) => ({ ...w, token: 'sk-ant-xxxxxxxxxx' })),
    } as UsageReading;
    const out = toWebviewReading(dirty);
    assert.ok(!JSON.stringify(out).includes('sk-ant'));
    assert.deepStrictEqual(out, base);
    const w = (out as typeof base).windows[0];
    assert.strictEqual(w.usedPercent, 12);
    assert.deepStrictEqual(w.raw, { used: 1, limit: 10, remaining: 9, unit: 'req' });
    assert.strictEqual(w.resetsAt, 99);
    assert.deepStrictEqual(w.scope, { model: 'm', plan: 'p' });
    assert.strictEqual(w.provenance, 'provider-reported');
    assert.strictEqual((out as typeof base).tier, 'Pro');
    assert.strictEqual((out as typeof base).source.readAt, 5);

    const stale = toWebviewReading({ ...staleReading(base, 'why', 7), token: 'sk-ant-xxxxxxxxxx' } as UsageReading);
    assert.strictEqual(stale.status === 'stale' && stale.reason, 'why');
    assert.strictEqual(stale.status === 'stale' && stale.failedAt, 7);
    assert.ok(!JSON.stringify(stale).includes('sk-ant'));

    const un = toWebviewReading({
      ...unavailableReading('codex', 'gone', 3, 'cli-files'), token: 'sk-ant-xxxxxxxxxx',
    } as UsageReading);
    assert.deepStrictEqual(un, { tool: 'codex', status: 'unavailable', reason: 'gone', checkedAt: 3, mechanism: 'cli-files' });
  });

  it('messages carry their type and survive a JSON round trip', () => {
    const rm = readingsMessage([ok('claude')], new Set(), 10);
    const sm = stateMessage({ refreshing: false, trusted: true, refreshIntervalSeconds: 300, now: 10 });
    assert.strictEqual(rm.type, 'readings');
    assert.strictEqual(sm.type, 'state');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rm)), rm);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sm)), sm);
  });

  it('is host-free', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'protocol.ts'), 'utf8');
    assert.ok(!/from 'vscode'/.test(text));
    assert.ok(!/from '(fs|path|child_process|os|http|https)'/.test(text));
  });
});
