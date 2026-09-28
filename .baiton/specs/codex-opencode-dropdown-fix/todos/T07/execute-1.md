# Execute T07

## Summary

Implemented T07 in the config webview. media/config.js now derives both dropdowns from the host's `modelEntries`: a new `optionSpec` normaliser lets `syncSelectOptions` carry option TEXT alongside the value (early return compares both, so a label-only change rebuilds while focus/caret still survive an unchanged list), and six module-private helpers (`capabilityFor`, `capabilityEntries`, `modelOptionsFor`, `modelEntryFor`, `effortOptionsFor`, `defaultEffortText`, `listedValue`) are the single source of truth shared by `renderOptionLists()` and `renderValues()`. Model options are every non-`custom` entry as `{ value: id, text: label || id }`, so a `custom: true` entry renders only through `Other…` with an editable text input; effort options are the SELECTED model's own `efforts` when its entry carries that key (an explicitly empty list leaves just the static `(default)` and `Other…`) and the agent-level union otherwise, while the select-vs-free-text shape is still chosen from the agent-level union — which is what turns OpenCode's controls into dropdowns in place once a list arrives. The static `(default)` option's text is rewritten per render to `(default: <effort>)` from the model's `defaultEffort`, keeping its empty value and `data-static` marker. The mirror block above the `acquireVsCodeApi` guard is byte-identical, so validation still runs against the agent-level union. Added 12 fake-DOM cases and 1 mirror-parity case; doc comments in media/config.js and media/config.html updated.

## Files changed

- `media/config.js`
- `media/config.html`
- `test/configPanel.view.test.ts`
- `test/configPanel.mirror.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile: clean.
- npm run lint: only the pre-existing warning src/orchestrator/webviewProtocol.ts:626 ('_legacy' assigned but never used); no new ones.
- npm test: 2184 passing, 1 pending, 0 failing — 2171 + 13 new cases (12 in test/configPanel.view.test.ts, 1 in test/configPanel.mirror.test.ts); the pending count is unchanged.
- Every pre-existing case in test/configPanel.view.test.ts passes unmodified: `viewOptions()` emits capabilities without `modelEntries`, which `capabilityEntries` synthesises into bare `{ id }` entries.
- The validator mirror (lines 30-113) and `window.baitonConfigForm` are untouched; 'the mirror block stays DOM-free' still passes, and the new mirror case pins that an effort valid for another model of the same agent produces no error from either implementation.
- Plan step 7 listed 9 test cases; they are implemented as 12 `it(...)` blocks because a few were split for readability — the label case's id-as-text half, and the OpenCode model case's listed-vs-unlisted halves, are separate tests. All the assertions the plan named are covered.
