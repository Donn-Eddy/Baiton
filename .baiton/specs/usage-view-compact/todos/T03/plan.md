# Plan T03

## Steps

1. Extend the mirror typings in the test

   In test/usageView.media.test.ts: add `resetAbsolute: string;` to `interface WindowView`; add `badgeHint: string;` to `interface CardView` (keep `sourceLine`); add `interface WindowRow { label: string; figure: string; reset: string; resetTitle: string; }`; add `windowRow(w: unknown): WindowRow;` to `interface UsageMirror`. No other existing code changes; every existing `it(...)` block (formatAge, formatReset, formatRaw, sourceLine expectations, etc.) stays byte-for-byte.

   Files: `test/usageView.media.test.ts`

2. Add source-text checks for badge attributes and no body source-line

   In the existing `describe('usage.js source', ...)` block, after the unsafe-sinks test, add:
   1. `it('no longer draws a source-line in the card body', ...)`: `assert.ok(!script.includes('source-line'), 'usage.js must not append a .source-line element');`.
   2. `it('puts the badge hint on the status badge as title, aria-label and tabindex', ...)`: assert with regexes against `script`: `/statusBadge\.title\s*=\s*v\.badgeHint/`, `/statusBadge\.setAttribute\(\s*'aria-label'\s*,\s*v\.badgeHint\s*\)/`, `/statusBadge\.setAttribute\(\s*'tabindex'\s*,\s*'0'\s*\)/`, and that the guard excludes loading: `/v\.status\s*!==\s*'loading'/`. (These match media/usage.js lines 244-247 as landed by T02.) Optionally also assert `/windowRow\(w\)/.test(script)` so buildCard keeps building rows from the helper, and that html contains `focus-visible` and `var(--vscode-focusBorder)` for the badge focus ring.

   Files: `test/usageView.media.test.ts`

3. Add windowRow assertions in the mirror block

   Inside `describe('usage.js mirror', ...)`, add `it('windowRow puts the figure beside the label and the reset on the right', ...)`:
   - `const resetsAt = NOW + 90 * 60_000; const reading = okReading('codex', source(), [win({ usedPercent: 30, resetsAt })]); const w = mirror.cardView(rowFor(reading), NOW).windows[0]; const r = plain(mirror.windowRow(w));`
   - assert `r.label === '5-hour'`, `r.figure === '70% remaining'`, `r.reset === 'resets in 1h 30m'`, `r.resetTitle === mirror.formatReset(resetsAt, NOW).absolute` and `r.resetTitle !== ''` (compare against the mirror's own formatReset, not a host toLocaleString, to avoid locale/realm drift).
   Add `it('windowRow has an empty reset when resetsAt is absent', ...)`: window `win({ usedPercent: 30 })` → `r.reset === ''` and `r.resetTitle === ''`.
   Add `it('windowRow shows the raw figure when there is no percent', ...)`: window `win({ raw: { used: 12, limit: 50, unit: 'requests' } })` → `r.figure === '12 / 50 requests used'`, `!r.figure.includes('%')`, `r.reset === ''`.
   Add `it('windowRow keeps the Baiton-derived label suffix', ...)`: `okReading('opencode-go', source('baiton-derived'), [win({ usedPercent: 50, provenance: 'baiton-derived' })])` → `r.label === '5-hour · Baiton-derived'`.
   Also add to the existing malformed-input test or a new one: `assert.doesNotThrow(() => mirror.windowRow(null))` and `plain(mirror.windowRow(null))` deep-equals `{ label: '', figure: '', reset: '', resetTitle: '' }`.

   Files: `test/usageView.media.test.ts`

4. Add per-status badgeHint assertions

   Inside `describe('usage.js mirror', ...)`, add `it('badgeHint carries the source line per status', ...)` (or one `it` per status):
   - ok: `okReading('codex', source(), [win({ usedPercent: 30 })])` → `v.badgeHint === 'CLI server — codex app-server · Provider-reported · read 5 min ago'` and `v.sourceLine === v.badgeHint`.
   - stale: `staleReading(okReading('claude', source(), [win({ usedPercent: 10 })]) as OkUsageReading, 'timed out', NOW)` → `v.badgeHint === 'CLI server — codex app-server · Provider-reported · read 5 min ago'`, `v.sourceLine === v.badgeHint`, and `v.reason.startsWith('Last read failed:')` still (reason stays visible in body).
   - derived: `okReading('opencode-go', source('baiton-derived'), [win({ usedPercent: 50 })])` → `v.badgeHint.includes('Baiton-derived')` and `v.derived === true` (body badge still drawn).
   - unavailable with mechanism: `unavailableReading('antigravity', 'not installed', NOW, 'cli-command')` → `v.badgeHint === 'Tried: CLI command'`, `v.reason === 'not installed'`.
   - unavailable without mechanism: `unavailableReading('antigravity', 'not installed', NOW)` → `v.badgeHint === ''`, `v.sourceLine === ''`.
   - loading: `mirror.cardView({ tool: 'claude', label: 'Claude Code', refreshing: false }, NOW)` → `v.badgeHint === ''`.

   Files: `test/usageView.media.test.ts`

5. Only touch media/usage.js if a new assertion exposes a mismatch

   media/usage.js already implements windowRow (exported on window.baitonUsageView) and cardView.badgeHint per T01/T02. Do not change it unless a new test fails because of a genuine deviation from the contract (windowRow returns {label, figure, reset, resetTitle} with reset '' when no resetText; badgeHint '' for loading and for unavailable with unknown mechanism; title/aria-label/tabindex='0' only on non-loading badges with a non-empty hint; no 'source-line' string). If a fix is needed, keep textContent-only DOM writes and do not change the webview protocol.

   Files: `media/usage.js`

6. Run the finish-line checks

   Run `npm run compile`, `npm run lint`, `npm test`. If `npm test` fails with EPERM spawning child processes in a sandbox, rerun with elevated permissions (previous todos had to). The pre-existing lint warning in src/orchestrator/webviewProtocol.ts:678 is not this todo's concern.

   Files: (none)

## Risks

- toLocaleString in the vm sandbox vs the host may differ; compare resetTitle against mirror.formatReset(...).absolute rather than a host-built string.
- Objects from the vm context have foreign prototypes; wrap results in plain() before deepStrictEqual.
- Source-text regexes are tied to T02's exact spelling (statusBadge.title = v.badgeHint, setAttribute('aria-label'/'tabindex')); if the executor reformats usage.js the regexes must be updated together.
- Window label for win() is '5-hour'; okReading normalises windows, so check that provenance/resetsAt survive normaliseWindow (they do for existing tests' usedPercent/raw; verify resetsAt if the reset assertion fails).
- Typecheck: tests are compiled by `npm run compile`/test tsconfig, so new interface fields (badgeHint, resetAbsolute, windowRow) must be declared or the test won't compile.

## Acceptance

- test/usageView.media.test.ts contains windowRow tests covering: figure beside label, reset text and title, empty reset when resetsAt is absent, raw-number figure without percent (plus derived label suffix).
- test/usageView.media.test.ts contains badgeHint assertions for ok, stale, unavailable (with and without mechanism) and loading rows, and asserts sourceLine === badgeHint.
- A source-text test asserts usage.js does not contain 'source-line' and does set title, aria-label and tabindex='0' on the status badge.
- All pre-existing assertions (CSP, shell, unsafe sinks, constants, formatAge, formatReset, formatRaw, sourceLine checks, stale/unavailable/derived/loading/malformed) remain unchanged and pass.
- `npm run compile`, `npm run lint` and `npm test` pass.
