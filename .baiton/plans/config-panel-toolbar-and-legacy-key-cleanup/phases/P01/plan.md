# Plan P01

## Steps

1. Add the two toolbar buttons to the markup and compact the toolbar CSS

   In media/config.html, inside `<header class="toolbar">` directly after `<button id="reset" class="secondary" type="button">Reset&hellip;</button>`, add exactly:
     <button id="more-settings" class="secondary" type="button">More settings&hellip;</button>
     <button id="manage-api-keys" class="secondary" type="button">Manage API keys&hellip;</button>
   No inline handlers (CSP). Tighten the toolbar in the existing nonce'd <style> block. In the `.toolbar` rule, change `gap: var(--baiton-gap)` to `gap: 4px` and `padding: var(--baiton-gap) 0` to `padding: 4px 0`. Add a rule `.toolbar button { padding: 2px 8px; white-space: nowrap; }` so five buttons fit and wrap cleanly in a narrow sidebar. Leave `#config-path` as `flex: 1 1 auto` with ellipsis. Optionally add `flex-basis: 100%` only if it is needed for wrapping; the default is to leave it unchanged. Do NOT touch the roles fieldset, the Limits/Git fieldsets or the `.role-group` CSS in this phase; the layout flattening is a later phase. Do not change the CSP meta, the nonce placeholders or the script tag.

   Files: `media/config.html`

2. Wire click handlers in media/config.js

   In the `// ----- Elements` block (after `var resetBtn = ...`, ~L142, which is below the `acquireVsCodeApi` guard and so outside the mirror block), add:
     var moreSettingsBtn = /** @type {HTMLButtonElement} */ (document.getElementById('more-settings'));
     var manageApiKeysBtn = /** @type {HTMLButtonElement} */ (document.getElementById('manage-api-keys'));
   In the Actions section, after `resetBtn.addEventListener('click', requestReset); errorResetBtn.addEventListener(...)` (~L1029-1030), add:
     // One-way hand-offs to the host. They never touch state, the draft, the
     // dirty flag or enablement, so they work in every phase and while busy.
     moreSettingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); });
     manageApiKeysBtn.addEventListener('click', function () { vscode.postMessage({ type: 'manageApiKeys' }); });
   Do NOT reference either button in render(), updateEnablement(), isDirty(), persistDraft() or the plain-script mirror block at the top of the file. Both buttons sit in the header, outside #config-form, so the `formEl.querySelectorAll('input, select')` disabling loop never reaches them. Optionally add a sentence to the file-header comment noting the two toolbar hand-offs. Keep it outside the mirror block.

   Files: `media/config.js`

3. Widen the openSettings filter in extension.ts and fix the comment

   In src/extension.ts at the registerConfigPanel({...}) call (~L254-268), change the openSettings seam body to:
     openSettings: async () => {
       await vscode.commands.executeCommand('workbench.action.openSettings', `@${SETTINGS_NS}`);
     },
   Keep it on one line or split across lines as before; the regex in step 5 accepts either. It stays `async`, returning Promise<void>. Replace the comment block above it. Keep the note that the panel is registered ahead of the activation gate, that `baiton.setProviderApiKey` is registered only inside `registerCommands`, and that a rejection is logged by the controller while the panel stays usable. Remove the sentence 'Same settings target as the Chat view's inline-error "open settings" fix (`triggerFix` ...)'. Replace it with: 'More settings… opens every Baiton setting (`@baiton`), deliberately wider than the Chat view's inline-error "open settings" fix (`triggerFix` in activation/commands.ts), which still targets `baiton.orchestrator`.' Leave manageApiKeys (`executeCommand(COMMANDS.setProviderApiKey)`) unchanged. Do not touch `const SETTINGS_NS = 'baiton';` or triggerFix.

   Files: `src/extension.ts`

4. Update the openSettings seam JSDoc in configPanel.ts and configPanelController.ts

   src/activation/configPanel.ts ~L224-229: reword to 'Opens VS Code Settings filtered to every Baiton setting. Optional: a caller that omits it (test/configPanel.view.test.ts) gets a silent no-op for the panel's "More settings…" button. `src/extension.ts` binds it to `workbench.action.openSettings` with the `@${SETTINGS_NS}` query.' src/activation/configPanelController.ts ~L105: change '... filtered to `${SETTINGS_NS}.orchestrator`' to '... with the `@${SETTINGS_NS}` query, i.e. every Baiton setting'. Comment-only changes. No signature changes, and no vscode import is added to either file.

   Files: `src/activation/configPanel.ts`, `src/activation/configPanelController.ts`

5. Update the wiring test in activation.gating.test.ts

   In test/activation.gating.test.ts ~L907-914, rename the test to 'wires openSettings to workbench.action.openSettings filtered to all Baiton settings (@baiton)'. Replace the regex with:
     /executeCommand\(\s*'workbench\.action\.openSettings',\s*`@\$\{SETTINGS_NS\}`\s*,?\s*\)/
   Keep `assert.match(call, /openSettings:/)` and the SETTINGS_NS constant assertion. Also add `assert.doesNotMatch(call, /`\$\{SETTINGS_NS\}\.orchestrator`/)` so the panel seam cannot regress to the narrow filter. Check that `call` is the extracted registerConfigPanel(...) text and not the whole source, because triggerFix in commands.ts is a separate file anyway. Leave the manageApiKeys wiring test as is.

   Files: `test/activation.gating.test.ts`

6. Extend the webview view test with the new buttons

   In test/configPanel.view.test.ts `loadConfigView()` (~L800-812), add `make('more-settings', 'button'); make('manage-api-keys', 'button');` next to save/reload/reset. Without these, `document.getElementById` returns null and addEventListener throws. Do not restructure the roles stub (the roles table is a later phase). Add a new `describe('config panel webview toolbar hand-offs', ...)` after the options-refresh describe, reusing the existing loadConfigView/viewForm/viewOptions helpers. The ViewEl class supports addEventListener/fire and has a `disabled` field. Tests:
   (a) 'More settings… posts openSettings': loaded view, record posted.length, `view.ids['more-settings'].fire('click')`. Assert the new posts deepStrictEqual [{ type: 'openSettings' }].
   (b) 'Manage API keys… posts manageApiKeys': same, asserting [{ type: 'manageApiKeys' }].
   (c) 'neither button disables while busy': loaded view, make the form dirty by setting git-remote to 'upstream' and firing input on config-form (as the existing optionsChanged test does), then fire click on 'save' to set busy. Assert `view.ids['save'].disabled === true` and `view.ids['reload'].disabled === true` as a sanity check that busy took effect, then that both new buttons have `disabled === false`. Click each and assert it posts its message and that no extra 'save'/'load' is posted.
   (d) 'neither button disables in loadFailed': send { type: 'loadFailed', kind: 'invalid', message: 'bad', canReset: true }. Assert both buttons are not disabled, and clicking each posts its message.
   (e) 'clicking does not touch the draft or Save': loaded view, dirty edit as in (c), capture save.disabled (false) and git-remote value. Click both buttons, then assert save.disabled is unchanged, the git-remote value is unchanged, and no 'save'/'load' message was posted. Before that, cheaply check whether the sandbox exposes the persisted state. If it does not, skip the persisted-state assertion.

   Files: `test/configPanel.view.test.ts`

## Risks

- The hand-rolled DOM in test/configPanel.view.test.ts returns null for unknown ids. If the two `make(...)` lines are not added, every existing view test throws at `moreSettingsBtn.addEventListener`. Add them in the same change as config.js.
- The mirror test (test/configPanel.mirror.test.ts) evaluates the top of media/config.js outside a webview. Putting the button lookups or handlers above the `acquireVsCodeApi` guard would break it or grow the mirror block. Keep them strictly in the Elements and Actions sections below the guard.
- Getting the view into `busy` relies on doSave: the form must be loaded, dirty and valid, or Save does not post. If the fixture form fails validation, the busy test silently exercises the wrong state, so assert save/reload are disabled before checking the new buttons.
- The gating test regex works on source text. Using double quotes or string concatenation instead of the template literal `@${SETTINGS_NS}` would fail it, so use the template literal exactly.
- Scope creep: the roles table, the Limits/Git flattening, the legacy-key removal and the README belong to later phases. Touching the roles markup or the `.role-group` CSS here would break the existing `.role-group` count assertion in the view test.

## Acceptance

- media/config.html has <button id="more-settings" class="secondary" type="button">More settings&hellip;</button> and <button id="manage-api-keys" class="secondary" type="button">Manage API keys&hellip;</button> inside header.toolbar after Reset…, with no inline handlers and an unchanged CSP.
- In the view test, clicking #more-settings posts exactly { type: 'openSettings' } and clicking #manage-api-keys posts exactly { type: 'manageApiKeys' }.
- Neither button is disabled while busy (save in flight) or in the loadFailed phase, and clicking them changes neither Save's disabled state nor any form value, and posts no load/save.
- media/config.js references moreSettingsBtn/manageApiKeysBtn only in the Elements lookup and their click listeners: grep shows no use in render/updateEnablement/isDirty/persistDraft or in the mirror block.
- src/extension.ts passes `@${SETTINGS_NS}` to workbench.action.openSettings in the registerConfigPanel openSettings seam, the seam stays async, and the comment no longer claims it matches the Chat view's fix.
- The openSettings JSDoc in src/activation/configPanel.ts and src/activation/configPanelController.ts no longer mentions `${SETTINGS_NS}.orchestrator`.
- test/activation.gating.test.ts asserts the `@${SETTINGS_NS}` wiring, and triggerFix in commands.ts still targets baiton.orchestrator, unchanged.
- `npm run compile` (or the repo's build/typecheck script) and the full test suite (`npm test`) pass, including test/configPanel.mirror.test.ts, test/configPanel.controller.test.ts, test/configPanel.view.test.ts and test/activation.gating.test.ts.
