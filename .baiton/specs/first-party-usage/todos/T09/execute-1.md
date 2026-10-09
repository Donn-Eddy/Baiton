# Execute T09

## Summary

Added the static Usage webview shell (media/usage.html), its script (media/usage.js) and a mocha test (test/usageView.media.test.ts). Compile, lint and the full test suite pass (2793 passing).

## Files changed

- `media/usage.html`
- `media/usage.js`
- `test/usageView.media.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Lint reports 0 errors and 1 pre-existing warning in src/orchestrator/webviewProtocol.ts, which this todo did not touch.
- Bar widths are set through el.style.width (CSSOM), which the nonce-only style-src permits. There are no style= attributes.
- The shell test strips HTML comments before counting script tags, because the header comment mentions <script>.
- Not run in a real webview; verified only through the shell text checks and the vm-evaluated mirror helpers.
- formatReset returns {relative, absolute}; windowView also exposes resetAbsolute, used as the reset line's title attribute.
- The todo text was truncated, so the card contents follow the plan's inferred field list.
