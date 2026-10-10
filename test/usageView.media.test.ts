import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  USAGE_MECHANISM_LABELS,
  USAGE_TOOL_IDS,
  USAGE_TOOL_LABELS,
  okReading,
  staleReading,
  unavailableReading,
  usageViewRows,
  type OkUsageReading,
  type UsageReading,
  type UsageSource,
  type UsageWindow,
} from '../src/usage';

/**
 * Shell checks for media/usage.html + media/usage.js and parity checks for the
 * host-free formatting mirror. Objects from the vm context have foreign
 * prototypes, so results are JSON round-tripped before comparison.
 */

const mediaDir = path.join(__dirname, '..', 'media');
const html = fs.readFileSync(path.join(mediaDir, 'usage.html'), 'utf8');
const script = fs.readFileSync(path.join(mediaDir, 'usage.js'), 'utf8');

interface WindowView {
  label: string;
  scopeText: string;
  hasBar: boolean;
  remainingPercent?: number;
  figure: string;
  resetText: string;
  resetAbsolute: string;
  derived: boolean;
}
interface CardView {
  tool: string;
  label: string;
  refreshing: boolean;
  status: string;
  badge: string;
  tier: string;
  windows: WindowView[];
  reason: string;
  ageText: string;
  badgeHint: string;
  sourceLine: string;
  derived: boolean;
}
interface WindowRow {
  label: string;
  figure: string;
  reset: string;
  resetTitle: string;
}
interface UsageMirror {
  TOOL_ORDER: string[];
  TOOL_LABELS: Record<string, string>;
  MECHANISM_LABELS: Record<string, string>;
  formatAge(ms: unknown): string;
  formatReset(resetsAt: unknown, now: unknown): { relative: string; absolute: string };
  formatRaw(raw: unknown): string;
  windowView(w: unknown, now: unknown): WindowView;
  windowRow(w: unknown): WindowRow;
  cardView(row: unknown, now: unknown): CardView;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadMirror(): UsageMirror {
  const sandbox: { window: { baitonUsageView?: UsageMirror } } = { window: {} };
  vm.runInNewContext(script, sandbox, { filename: 'media/usage.js' });
  assert.ok(sandbox.window.baitonUsageView, 'media/usage.js must expose window.baitonUsageView');
  return sandbox.window.baitonUsageView;
}

const NOW = 1_700_000_000_000;

function source(provenance: UsageSource['provenance'] = 'provider-reported'): UsageSource {
  return { mechanism: 'cli-server', detail: 'codex app-server', provenance, readAt: NOW - 5 * 60_000 };
}

function win(extra: Partial<UsageWindow> = {}): UsageWindow {
  return { id: 'five-hour', label: '5-hour', provenance: 'provider-reported', ...extra };
}

function rowFor(reading: UsageReading) {
  return usageViewRows([reading])[0 + USAGE_TOOL_IDS.indexOf(reading.tool)];
}

describe('usage.html shell', () => {
  it('has a strict CSP', () => {
    const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
    assert.ok(m, 'CSP meta present');
    const csp = m[1];
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'nonce-${nonce}'"));
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:']) {
      assert.ok(!csp.includes(bad), `CSP must not contain ${bad}`);
    }
  });

  it('has exactly one nonce\'d script, usage.js, and a nonce\'d style', () => {
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');
    const scripts = markup.match(/<script\b[^>]*>/g) ?? [];
    assert.strictEqual(scripts.length, 1);
    assert.ok(scripts[0].includes('nonce="${nonce}"'));
    assert.ok(/src="\$\{baseUri\}\/usage\.js"/.test(scripts[0]));
    const styles = markup.match(/<style\b[^>]*>/g) ?? [];
    assert.ok(styles.length >= 1);
    for (const s of styles) assert.ok(s.includes('nonce="${nonce}"'));
  });

  it('has no inline handlers, style attributes, links or external URLs', () => {
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    assert.ok(!/style\s*=\s*"/i.test(html));
    assert.ok(!/<link\b/i.test(html));
    assert.ok(!/https?:\/\//i.test(html));
  });

  it('uses no hard-coded colors', () => {
    const css = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css));
    assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/i.test(css));
  });
});

describe('usage.js source', () => {
  it('uses no unsafe sinks or network access', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'http://', 'https://']) {
      assert.ok(!script.includes(bad), `usage.js must not contain ${bad}`);
    }
  });

  it('no longer draws a source-line in the card body', () => {
    assert.ok(!script.includes('source-line'), 'usage.js must not append a .source-line element');
  });

  it('puts the badge hint on the status badge as title, aria-label and tabindex', () => {
    assert.ok(/statusBadge\.title\s*=\s*v\.badgeHint/.test(script));
    assert.ok(/statusBadge\.setAttribute\(\s*'aria-label'\s*,\s*v\.badgeHint\s*\)/.test(script));
    assert.ok(/statusBadge\.setAttribute\(\s*'tabindex'\s*,\s*'0'\s*\)/.test(script));
    assert.ok(/v\.status\s*!==\s*'loading'/.test(script));
    assert.ok(/windowRow\(w\)/.test(script));
    assert.ok(html.includes('focus-visible'));
    assert.ok(html.includes('var(--vscode-focusBorder)'));
  });
});

describe('usage.js mirror', () => {
  const mirror = loadMirror();

  it('mirrors model.ts constants', () => {
    assert.deepStrictEqual(plain(mirror.TOOL_ORDER), Array.from(USAGE_TOOL_IDS));
    assert.deepStrictEqual(plain(mirror.TOOL_LABELS), plain(USAGE_TOOL_LABELS));
    assert.deepStrictEqual(plain(mirror.MECHANISM_LABELS), plain(USAGE_MECHANISM_LABELS));
  });

  it('formatAge', () => {
    assert.strictEqual(mirror.formatAge(5_000), 'just now');
    assert.strictEqual(mirror.formatAge(5 * 60_000), '5 min ago');
    assert.strictEqual(mirror.formatAge(3 * 3_600_000), '3 h ago');
    assert.strictEqual(mirror.formatAge(2 * 86_400_000), '2 d ago');
    assert.strictEqual(mirror.formatAge(-1), '');
    assert.strictEqual(mirror.formatAge(NaN), '');
  });

  it('formatReset', () => {
    assert.strictEqual(mirror.formatReset(undefined, NOW).relative, '');
    assert.strictEqual(mirror.formatReset(NOW - 1, NOW).relative, 'resets now');
    assert.strictEqual(mirror.formatReset(NOW + 90 * 60_000, NOW).relative, 'resets in 1h 30m');
    assert.strictEqual(mirror.formatReset(NOW + 20 * 60_000, NOW).relative, 'resets in 20m');
    assert.strictEqual(mirror.formatReset(NOW + 26 * 3_600_000, NOW).relative, 'resets in 1d 2h');
  });

  it('formatRaw', () => {
    assert.strictEqual(mirror.formatRaw({ used: 12, limit: 50, unit: 'requests' }), '12 / 50 requests used');
    assert.strictEqual(mirror.formatRaw({ remaining: 38, unit: 'requests' }), '38 requests remaining');
    assert.strictEqual(mirror.formatRaw({}), '');
    assert.strictEqual(mirror.formatRaw(undefined), '');
  });

  it('windowRow puts the figure beside the label and the reset on the right', () => {
    const resetsAt = NOW + 90 * 60_000;
    const reading = okReading('codex', source(), [win({ usedPercent: 30, resetsAt })]);
    const w = mirror.cardView(rowFor(reading), NOW).windows[0];
    const r = plain(mirror.windowRow(w));
    assert.strictEqual(r.label, '5-hour');
    assert.strictEqual(r.figure, '70% remaining');
    assert.strictEqual(r.reset, 'resets in 1h 30m');
    assert.strictEqual(r.resetTitle, mirror.formatReset(resetsAt, NOW).absolute);
    assert.notStrictEqual(r.resetTitle, '');
  });

  it('windowRow has an empty reset when resetsAt is absent', () => {
    const reading = okReading('codex', source(), [win({ usedPercent: 30 })]);
    const w = mirror.cardView(rowFor(reading), NOW).windows[0];
    const r = plain(mirror.windowRow(w));
    assert.strictEqual(r.reset, '');
    assert.strictEqual(r.resetTitle, '');
  });

  it('windowRow shows the raw figure when there is no percent', () => {
    const reading = okReading('codex', source(), [win({ raw: { used: 12, limit: 50, unit: 'requests' } })]);
    const w = mirror.cardView(rowFor(reading), NOW).windows[0];
    const r = plain(mirror.windowRow(w));
    assert.strictEqual(r.figure, '12 / 50 requests used');
    assert.ok(!r.figure.includes('%'));
    assert.strictEqual(r.reset, '');
  });

  it('windowRow keeps the Baiton-derived label suffix', () => {
    const reading = okReading('opencode-go', source('baiton-derived'), [win({ usedPercent: 50, provenance: 'baiton-derived' })]);
    const w = mirror.cardView(rowFor(reading), NOW).windows[0];
    const r = plain(mirror.windowRow(w));
    assert.strictEqual(r.label, '5-hour · Baiton-derived');
  });

  it('ok reading with a percent shows a remaining bar', () => {
    const reading = okReading('codex', source(), [win({ usedPercent: 30 })], 'Pro');
    const v = plain(mirror.cardView(rowFor(reading), NOW));
    assert.strictEqual(v.status, 'ok');
    assert.strictEqual(v.tier, 'Pro');
    assert.strictEqual(v.windows[0].hasBar, true);
    assert.strictEqual(v.windows[0].remainingPercent, 70);
    assert.strictEqual(v.windows[0].figure, '70% remaining');
    assert.strictEqual(v.derived, false);
    assert.ok(v.sourceLine.includes('Provider-reported'));
  });

  it('raw-only window has no bar and no invented percent', () => {
    const reading = okReading('codex', source(), [win({ raw: { used: 12, limit: 50, unit: 'requests' } })]);
    const w = plain(mirror.cardView(rowFor(reading), NOW)).windows[0];
    assert.strictEqual(w.hasBar, false);
    assert.ok(w.figure.includes('12') && w.figure.includes('50'));
    assert.ok(!w.figure.includes('%'));
  });

  it('stale keeps windows and shows the failure', () => {
    const good = okReading('claude', source(), [win({ usedPercent: 10 })]) as OkUsageReading;
    const reading = staleReading(good, 'timed out', NOW);
    const v = plain(mirror.cardView(rowFor(reading), NOW));
    assert.strictEqual(v.status, 'stale');
    assert.ok(v.reason.startsWith('Last read failed:'));
    assert.strictEqual(v.windows.length, 1);
    assert.strictEqual(v.ageText, '5 min ago');
  });

  it('unavailable shows only the reason', () => {
    const reading = unavailableReading('antigravity', 'not installed', NOW, 'cli-command');
    const v = plain(mirror.cardView(rowFor(reading), NOW));
    assert.strictEqual(v.status, 'unavailable');
    assert.strictEqual(v.reason, 'not installed');
    assert.strictEqual(v.windows.length, 0);
    assert.strictEqual(v.sourceLine, 'Tried: CLI command');
  });

  it('baiton-derived is labelled', () => {
    const reading = okReading('opencode-go', source('baiton-derived'), [win({ usedPercent: 50 })]);
    const v = plain(mirror.cardView(rowFor(reading), NOW));
    assert.strictEqual(v.derived, true);
    assert.ok(v.sourceLine.includes('Baiton-derived'));
  });

  it('badgeHint carries the source line per status', () => {
    const ok = okReading('codex', source(), [win({ usedPercent: 30 })]);
    const okView = plain(mirror.cardView(rowFor(ok), NOW));
    assert.strictEqual(okView.badgeHint, 'CLI server — codex app-server · Provider-reported · read 5 min ago');
    assert.strictEqual(okView.sourceLine, okView.badgeHint);

    const good = okReading('claude', source(), [win({ usedPercent: 10 })]) as OkUsageReading;
    const stale = staleReading(good, 'timed out', NOW);
    const staleView = plain(mirror.cardView(rowFor(stale), NOW));
    assert.strictEqual(staleView.badgeHint, 'CLI server — codex app-server · Provider-reported · read 5 min ago');
    assert.strictEqual(staleView.sourceLine, staleView.badgeHint);
    assert.ok(staleView.reason.startsWith('Last read failed:'));

    const derived = okReading('opencode-go', source('baiton-derived'), [win({ usedPercent: 50 })]);
    const derivedView = plain(mirror.cardView(rowFor(derived), NOW));
    assert.ok(derivedView.badgeHint.includes('Baiton-derived'));
    assert.strictEqual(derivedView.derived, true);

    const unavailable = unavailableReading('antigravity', 'not installed', NOW, 'cli-command');
    const unavailableView = plain(mirror.cardView(rowFor(unavailable), NOW));
    assert.strictEqual(unavailableView.badgeHint, 'Tried: CLI command');
    assert.strictEqual(unavailableView.reason, 'not installed');

    const unknownMechanism = unavailableReading('antigravity', 'not installed', NOW);
    const unknownView = plain(mirror.cardView(rowFor(unknownMechanism), NOW));
    assert.strictEqual(unknownView.badgeHint, '');
    assert.strictEqual(unknownView.sourceLine, '');

    const loadingView = plain(mirror.cardView({ tool: 'claude', label: 'Claude Code', refreshing: false }, NOW));
    assert.strictEqual(loadingView.badgeHint, '');
  });

  it('row without a reading is loading', () => {
    const v = plain(mirror.cardView({ tool: 'claude', label: 'Claude Code', refreshing: false }, NOW));
    assert.strictEqual(v.status, 'loading');
    assert.strictEqual(v.badge, 'Loading…');
  });

  it('tolerates malformed input', () => {
    assert.doesNotThrow(() => mirror.cardView({}, NaN));
    assert.doesNotThrow(() => mirror.cardView(null, undefined));
    assert.doesNotThrow(() => mirror.windowView(null, 0));
    assert.doesNotThrow(() => mirror.windowRow(null));
    assert.deepStrictEqual(plain(mirror.windowRow(null)), { label: '', figure: '', reset: '', resetTitle: '' });
    assert.doesNotThrow(() => mirror.cardView({ reading: { status: 'ok', windows: 'x', source: 5 } }, NOW));
  });
});
