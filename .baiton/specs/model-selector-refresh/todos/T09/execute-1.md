# Execute T09

## Summary

Implemented T09: the config panel webview now applies refreshed agent/model/effort option lists in place on an additive `optionsChanged` host message, renders a per-agent stale indicator, and keeps in-progress `Other…` custom entries editable. media/config.js gained `state.stale`/`state.otherModel`/`state.otherEffort`, an `optionsChanged` case that replaces only the option lists (form, baseline, token, errors, busy and banner untouched), a build-once `buildRoleRows()` (static `(default)`/`Other…` options marked `data-static`, an always-present documentation link and a `.stale-note` element per role), plus new `syncSelectOptions()` / `renderOptionLists()` / `renderStale()` helpers wired into `render()` before `renderValues()`. `syncSelectOptions()` early-returns when the rendered dynamic option values already match, so per-keystroke renders never rebuild option nodes. media/config.html gained a theme-variable-only `.stale-note` rule. Added a self-contained fake-DOM suite (9 cases) to test/configPanel.view.test.ts and two new mirror guards to test/configPanel.mirror.test.ts.

## Files changed

- `media/config.js`
- `media/config.html`
- `test/configPanel.view.test.ts`
- `test/configPanel.mirror.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint test/configPanel.view.test.ts test/configPanel.mirror.test.ts --ext .ts`
- `npx mocha test/configPanel.view.test.ts test/configPanel.mirror.test.ts test/configPanel.mirror.property.test.ts test/configPanel.test.ts test/configPanel.controller.test.ts test/configPanel.form.property.test.ts test/configPanel.document.test.ts test/configRefresh.test.ts`
- `npm run test:unit`
- `git status --porcelain`

## Notes

- tsc --noEmit and npm run compile both exit 0; eslint on the two touched test files is clean.
- The targeted configPanel mocha run is fully green, including all 9 new cases in 'config panel webview options refresh (model-selector-refresh T09)' and both new mirror cases ('the mirror block stays DOM-free', 'refresh metadata on a capability does not change validation in either implementation').
- npm run test:unit: 1546 passing, 1 pending, 1 failing — the failure is the pre-existing test/activation.gating.test.ts keytar native-module baseline (node_modules/keytar/build/Release/keytar.node), unrelated to this todo. No new failures.
- git status --porcelain shows exactly the four expected files modified.
- All role-control ids, classNames, data-path/data-role/data-error-for and aria-describedby strings were kept byte-identical; the only new ids are the additive role-<role>-model-link and role-<role>-stale.
- renderValues()'s round-trip append of a configured-but-uninstalled agent is now a no-op because renderOptionLists() already appends that value to the agent select's desired list, so the option list is not thrashed between renders.
- The new option-sync and stale rendering all live below the `acquireVsCodeApi` guard; the mirror block above it is unchanged and still loads with only a fake `window`.
- media/config.html: the new .stale-note rule uses only VS Code theme variables (no literal colour), and the CSP plus the ${nonce}/${cspSource}/${baseUri} placeholders are untouched.
- The new view suite imports only fs/path/vm/assert and type-only imports from ../src/config/configPanel, duplicating the ROLES list locally, so it never touches the `vscode` loader or `globalThis.__vscodeFake` that the pre-existing suite in the same file registers — suite ordering cannot matter.
