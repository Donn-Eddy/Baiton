# Plan T02

## Steps

1. Add badgeHint to cardView (sourceLine kept as alias)

   In media/usage.js `cardView(row, now)`: add `badgeHint: ''` to the initial `view` object literal next to `sourceLine: ''`. Loading rows (no reading) return early, so badgeHint stays ''. In the `status === 'unavailable'` branch replace `if (tried) view.sourceLine = 'Tried: ' + tried;` with `if (tried) view.badgeHint = 'Tried: ' + tried;` followed by `view.sourceLine = view.badgeHint;` (so unknown mechanism yields '' for both). In the ok/stale path replace `view.sourceLine = pieces.join(' · ');` with `view.badgeHint = pieces.join(' · '); view.sourceLine = view.badgeHint;`. Do not change how the pieces are built (mechanism — detail · Provider-reported|Baiton-derived · read <age>). Optionally update the header comment of the file to mention the badge hint. No other helper changes; window.baitonUsageView export list needs no change (cardView already exported).

   Files: `media/usage.js`

2. Set hint attributes on the status badge in buildCard

   In `buildCard(row)` replace `badges.appendChild(el('span', 'badge ' + v.status, v.badge));` with:
   ```
   var statusBadge = el('span', 'badge ' + v.status, v.badge);
   if (v.status !== 'loading' && v.badgeHint) {
     statusBadge.title = v.badgeHint;
     statusBadge.setAttribute('aria-label', v.badgeHint);
     statusBadge.setAttribute('tabindex', '0');
   }
   badges.appendChild(statusBadge);
   ```
   Use exactly the literal strings `setAttribute('aria-label'`, `setAttribute('tabindex', '0')` and `.title = v.badgeHint` so the planned source-text tests (T03) can find them. Keep the `.badge.derived` 'Baiton-derived' badge and 'Refreshing…' span unchanged (derived provenance must stay visible in the body). Note: aria-label replaces the accessible name 'OK'/'Stale'/'Unavailable'; to keep the status audible, it is acceptable (preferred) to set aria-label to `v.badge + ': ' + v.badgeHint` ONLY if the spec allowed it — it says 'same text', so set aria-label to exactly v.badgeHint as above.

   Files: `media/usage.js`

3. Stop drawing .source-line

   In `buildCard`, delete the line `if (v.sourceLine) card.appendChild(el('div', 'source-line', v.sourceLine));`. Keep `if (v.reason) card.appendChild(el('div', 'reason', v.reason));` and the stale `Showing data from <age>` muted line untouched. After the edit the string `source-line` must not appear anywhere in media/usage.js (grep to confirm), since T03's test will assert usage.js no longer appends `source-line`.

   Files: `media/usage.js`

4. Badge focus ring and help cursor; drop .source-line CSS

   In media/usage.html <style>: remove `.source-line,` from the `.tier, .reason, .source-line, .muted` selector list (leaving `.tier, .reason, .muted`). After the `.badge.derived` rule add:
   ```
   .badge[tabindex] {
     cursor: help;
   }

   .badge:focus-visible {
     outline: 1px solid var(--vscode-focusBorder);
     outline-offset: 1px;
   }

   .badge:focus:not(:focus-visible) {
     outline: none;
   }
   ```
   Colors only via VS Code theme variables; no style attributes, no inline handlers, no URLs. Optionally update the HTML header comment to mention the badge hint. Do not touch the CSP meta, script tag or body markup.

   Files: `media/usage.html`

5. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Existing tests in test/usageView.media.test.ts assert `v.sourceLine.includes('Provider-reported')`, `v.sourceLine === 'Tried: CLI command'`, `v.sourceLine.includes('Baiton-derived')` — these must still pass via the alias. Do not edit the test file or README in this todo (later todo owns them). If npm test fails with EPERM spawning child processes in a sandbox, rerun with escalation as T01 did.

   Files: (none)

## Risks

- Accidentally leaving `source-line` text in usage.js (e.g. in a comment) would trip the planned source-text test; remove all occurrences.
- Setting badgeHint on loading rows would add tabindex to the loading badge; the early return plus the `v.status !== 'loading'` guard prevents it.
- Unavailable rows with an unknown mechanism must yield badgeHint '' and no title/tabindex/aria-label; ensure the alias assignment does not produce 'Tried: undefined'.
- aria-label overrides the badge's visible text for screen readers; spec requires the same text as title, so follow it.
- Lint has a pre-existing warning in src/orchestrator/webviewProtocol.ts:678 unrelated to this change; it is not a failure.
- Sandboxed npm test may fail with EPERM spawning child processes; rerun escalated.

## Acceptance

- cardView returns badgeHint: ok/stale = the previous source line string; unavailable = 'Tried: <mechanism label>' or '' if unknown; loading = ''; sourceLine equals badgeHint in every case.
- buildCard sets title, aria-label (same text) and tabindex='0' on the .badge.<status> span only when status is not loading and badgeHint is non-empty.
- media/usage.js contains no `source-line` string and no longer appends a source line div; reason and 'Showing data from' lines and the .badge.derived badge and per-window ' · Baiton-derived' label suffix remain.
- media/usage.html has a `.badge:focus-visible` rule using var(--vscode-focusBorder), a `cursor: help` rule for the focusable badge, and no `.source-line` selector; no style attributes, inline handlers or URLs added; CSP unchanged.
- `npm run compile`, `npm run lint` and `npm test` pass with all existing assertions unchanged.
