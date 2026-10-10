# Plan T01

## Steps

1. Add pure windowRow(w) helper in media/usage.js

   In media/usage.js, inside the host-free mirror section, directly after `function windowView(w, now) {...}` (ends ~line 128) and before `cardView`, add:

     function windowRow(w) {
       var v = isObject(w) ? w : {};
       var reset = str(v.resetText);
       return {
         label: str(v.label) + (v.derived === true ? ' · Baiton-derived' : ''),
         figure: str(v.figure),
         reset: reset,
         resetTitle: reset ? str(v.resetAbsolute) : '',
       };
     }

   It takes a windowView() result (not a raw window) and does no DOM access. `label` keeps the ' · Baiton-derived' suffix exactly as buildCard renders it today, so the derived marker stays visible. `reset` is '' when windowView produced no resetText (resetsAt absent/non-finite); `resetTitle` is resetAbsolute, or '' when there's no reset. formatReset, formatRaw and windowView stay unchanged. For a window with no usedPercent, `figure` is the raw-number text (e.g. '12 / 100 requests used') or 'No figure reported', because it is passed through from windowView.figure.

   Expose it on the test mirror: in the `window.baitonUsageView = { ... }` object (~line 181) add `windowRow: windowRow,` after `windowView: windowView,`. Optionally mention windowRow in the header comment's list of pure helpers.

   Files: `media/usage.js`

2. Rebuild each window in buildCard as row + scope + bar

   In media/usage.js `buildCard`, replace the body of `v.windows.forEach(function (w) { ... })` (lines ~239-262) with:

       v.windows.forEach(function (w) {
         var r = windowRow(w);
         var box = el('div', 'window');
         var rowEl = el('div', 'window-row');
         var head = el('div', 'window-head');
         head.appendChild(el('span', 'window-label', r.label));
         head.appendChild(el('span', 'window-figure', r.figure));
         rowEl.appendChild(head);
         if (r.reset) {
           var reset = el('span', 'window-reset', r.reset);
           if (r.resetTitle) reset.title = r.resetTitle;
           rowEl.appendChild(reset);
         }
         box.appendChild(rowEl);
         if (w.scopeText) box.appendChild(el('div', 'window-scope', w.scopeText));
         if (w.hasBar) {
           // existing progressbar block, unchanged: el('div','bar'), role=progressbar,
           // aria-valuemin 0, aria-valuemax 100, aria-valuenow String(w.remainingPercent),
           // aria-label w.label + ' remaining', .bar-fill with fill.style.width = w.remainingPercent + '%'
           box.appendChild(track);
         }
         card.appendChild(box);
       });

   Order in the box is: .window-row, then .window-scope (only when scopeText), then .bar (only when hasBar). When there is no reset, nothing is appended to the right, so no space is reserved. Write text only via el()/textContent and `title` (no innerHTML). Keep the aria-label of the bar as `w.label + ' remaining'` (the label without the suffix, as today). Leave the header, tier, stale 'Showing data from', reason and the source-line lines (`if (v.sourceLine) ...`) as they are. Moving the source line into the badge hint is a separate todo and is out of scope here.

   Files: `media/usage.js`

3. Add wrapping flex CSS for the window row in media/usage.html

   In the <style nonce> block of media/usage.html, replace/extend the window rules (currently `.window`, `.window-label`, `.window-figure`, `.window-reset, .window-scope`) with:

         .window {
           margin: 6px 0;
         }

         .window-row {
           display: flex;
           flex-wrap: wrap;
           align-items: baseline;
           justify-content: space-between;
           gap: 2px var(--baiton-gap);
         }

         .window-head {
           display: flex;
           flex-wrap: wrap;
           align-items: baseline;
           gap: 0 6px;
           flex: 0 1 auto;
           min-width: min-content;
         }

         .window-label { color: var(--vscode-foreground); }
         .window-figure { color: var(--vscode-foreground); }

         .window-reset {
           margin-left: auto;
           white-space: nowrap;
         }

         .window-reset,
         .window-scope {
           color: var(--vscode-descriptionForeground);
           font-size: 0.9em;
         }

   The head wraps internally (label, then figure) and is not shrunk below its content. Because the row has flex-wrap, at activity-bar width the nowrap reset moves onto its own line, right-aligned by margin-left:auto, instead of overflowing. Keep `.bar` as it is (it is a block under the row and scope). Use no hex/rgb colors, only var(--vscode-*), and add no style attributes or inline handlers. Leave `.source-line` in the selector list for now, since the element is still emitted until the badge-hint todo. Optionally update the header comment to mention the compact row layout.

   Files: `media/usage.html`

4. Verify

   Run `npm run compile`, `npm run lint` and `npm test` (mocha; test/usageView.media.test.ts loads usage.js via vm.runInNewContext and checks the HTML for CSP, no inline handlers or style attributes, no hex/rgb colors, and no unsafe sinks). All existing assertions must keep passing unchanged. Test additions for windowRow belong to the tests todo. If the executor wants a quick check, `mirror.windowRow(mirror.windowView(win({usedPercent:40, resetsAt: NOW+3600000}), NOW))` should give figure '60% remaining', reset 'resets in 1h 0m' and a non-empty resetTitle, and with no resetsAt, reset === '' and resetTitle === ''.

   Files: (none)

## Risks

- windowRow.label includes the ' · Baiton-derived' suffix. A later test todo may expect the bare label. The spec only requires the suffix to stay visible, and putting it in the helper keeps buildCard simple. If tests expect the bare label, the suffix can move back to buildCard.
- Changing .window-label/.window-figure/.window-reset from div to span changes the default display. The flex containers make them flex items regardless, so the layout is unaffected.
- min-width: min-content on .window-head could overflow when a single word is wider than the view. This is acceptable (same as today's text) but should be kept in mind. Dropping it in favour of flex-shrink:0 plus wrapping would be the alternative.
- Do not remove the source-line output or add the badge title/tabindex in this todo. Those belong to the badge-hint todo, and doing them here would collide with it.
- The test file's UsageMirror interface doesn't declare windowRow. That is fine for compile because tests don't call it yet. The tests todo will add it.

## Acceptance

- media/usage.js defines a pure function windowRow(w) returning { label, figure, reset, resetTitle }, with reset '' and resetTitle '' when the windowView result has no resetText, and it is exposed as window.baitonUsageView.windowRow.
- buildCard renders each window as .window > .window-row (containing .window-head with .window-label then .window-figure, plus .window-reset only when reset is non-empty, with title = resetAbsolute when present), followed by .window-scope (only if scopeText), followed by the .bar progressbar (only if hasBar) with unchanged role/aria attributes.
- A derived window's label still shows ' · Baiton-derived'.
- media/usage.html has .window-row with display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap, and .window-reset with margin-left:auto; white-space:nowrap. All colors come from VS Code theme variables, and there are no inline styles or handlers.
- No innerHTML or other unsafe sinks were introduced. formatReset, windowView, cardView, the protocol, TOOL_ORDER and the CSP are unchanged.
- `npm run compile`, `npm run lint` and `npm test` all pass.
