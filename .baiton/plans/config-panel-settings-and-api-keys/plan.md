---
version: 1
name: config-panel-settings-and-api-keys
status: draft
mode: manual
base:
base_commit:
branch:
approved_rev:
---

# Endstate

The Baiton Configuration view (`baiton.configPanel`) toolbar carries two more buttons beside Save / Reload / Reset…:

- **More settings…** opens VS Code Settings filtered to `baiton.orchestrator`, which is the same target the Chat view's inline-error "open settings" fix uses (`triggerFix` in `src/activation/commands.ts` runs `workbench.action.openSettings` with `${SETTINGS_NS}.orchestrator`).
- **Manage API keys…** runs the existing `baiton.setProviderApiKey` command with no provider argument. The user gets the current provider quick pick, where each item shows "API key set" or "No API key set", and then the masked input, where an empty submit clears the key. That one flow covers both changing a stored key and adding a first key for a provider. Provider availability is refreshed the same way it is today when that command runs.

Both buttons work in every panel state, including `loadFailed` and while a load or save is in flight. Neither depends on the config document having loaded. Neither touches the form, the draft, the dirty state, or the Save button's enablement. The webview posts a fire-and-forget message for each button. The host-free controller sends each message to an injected seam and posts nothing back. A seam that throws is logged and never shows up as a `saveFailed`. A seam that is not wired is a silent no-op. Controller and view tests cover all of this, and the existing mirror, gating and view suites still pass.

# What needs changing

**Message contract — `src/config/configPanel.ts`.** Add two variants to `ConfigPanelWebviewToHost`: `{ type: 'openSettings' }` (open the remaining settings) and `{ type: 'manageApiKeys' }` (run the per-provider key flow). Give each a doc comment in the style the union already uses. Add nothing to `ConfigPanelHostToWebview`, because both requests are one-way.

**Controller — `src/activation/configPanelController.ts`.** Add two optional seams to `ConfigPanelControllerDeps`: `openSettings?(): Promise<void> | void` and `manageApiKeys?(): Promise<void> | void`. Document them like `confirmReset` / `applyConfig`. In `handle()`, add `case 'openSettings'` and `case 'manageApiKeys'`. Each calls its seam if one is present. It catches a synchronous throw or a rejected promise and passes it to `deps.log` with a `ConfigPanelController:` prefix. It does not change `doc` / `token` / `form` / `writing`, posts nothing to the webview, and does not trigger a load. If the seam is absent, the case does nothing; it does not fall through to the "unrecognised message type" log. Update the class doc comment that lists the handled messages.

**Provider — `src/activation/configPanel.ts`.** Add two optional entries to `RegisterConfigPanelDeps` (`openSettings?()`, `manageApiKeys?()`). Pass them into the `ConfigPanelController` deps wherever `ensureController` builds the controller, alongside `confirmReset` / `applyConfig`. Leave them `undefined` when absent, so a caller that passes neither, such as `test/configPanel.view.test.ts`, keeps a fully working panel.

**Wiring — `src/extension.ts`.** At the `registerConfigPanel({ ... })` call, next to `getCapabilities` / `onDidChangeCapabilities` / `applyConfig`, pass:
- `openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', `${SETTINGS_NS}.orchestrator`)`. Reuse the same namespace constant `triggerFix` uses; import it if `extension.ts` does not already have it.
- `manageApiKeys: () => vscode.commands.executeCommand(COMMANDS.setProviderApiKey)`, with no argument.

Both return `Thenable<unknown>`, so wrap or adapt them to the seam's `Promise<void> | void` type. The panel is registered before the activation gate, but `baiton.setProviderApiKey` is registered inside `registerCommands`. If the command is not registered yet (uninitialised folder or failed activation), `executeCommand` rejects. The controller catches that and logs it, so the panel stays usable. Note this in a comment at the call site.

**Webview — `media/config.html` and `media/config.js`.** In `media/config.html`, add `<button id="more-settings" class="secondary" type="button">More settings&hellip;</button>` and `<button id="manage-api-keys" class="secondary" type="button">Manage API keys&hellip;</button>` inside `<header class="toolbar">` after Reset…. In `media/config.js`, look both buttons up next to `saveBtn` / `reloadBtn` / `resetBtn`. Add click handlers that call `vscode.postMessage({ type: 'openSettings' })` and `vscode.postMessage({ type: 'manageApiKeys' })`. Do not add them to `updateEnablement()`, `render()`, `isDirty()` or `persistDraft()`, so they are never disabled, including while busy or in `loadFailed`. Do not add them to the plain-script mirror block at the top of the file.

**Tests.**
- `test/configPanel.controller.test.ts`: each message calls its seam exactly once. It posts nothing to the fake webview, in particular no `saveFailed` or `loaded`. It leaves the controller's loaded state intact, so a following `save` still works. A seam that throws synchronously, and one that rejects, are both logged and post nothing. An unwired seam is a no-op: no throw, no post, no "unrecognised message type" log. Both messages also work after a `loadFailed`.
- `test/configPanel.view.test.ts`: add `more-settings` and `manage-api-keys` to the fake DOM the script runs against, so `getElementById` does not return null. Assert that clicking each one posts the matching message and that neither button is disabled in the busy or `loadFailed` phases. At provider level, assert that `registerConfigPanel` passes the seams through: a message posted by the fake webview reaches the injected dep exactly once, and leaving the deps out is harmless.
- If `test/activation.gating.test.ts` inspects the text of the `registerConfigPanel({ ... })` call, add assertions that both seams are wired to the expected commands.

# Limitations & constraints

- **No secrets or catalog data in the webview.** No API-key value, no set/not-set flag, and no part of the provider catalog crosses into the webview. The panel shows no key state at all, and the `setProviderApiKey` quick pick stays the only place where set/not-set is visible. Neither new message carries a payload.
- **No new surface area.** Add no new command, no new setting, and change no `package.json` contribution. Both buttons hand off to `workbench.action.openSettings` and the already-registered `baiton.setProviderApiKey`. The key flow keeps its SecretStorage keys (`baiton.orchestrator.key.<slot>`), its aliased-slot grouping, and its current availability refresh. `migrateLegacyApiKey` and `src/activation/setApiKey.ts` are not modified.
- **Layering.** `src/config/configPanel.ts` stays free of `vscode` and Node imports, and `ConfigPanelController` stays host-free. All `vscode.commands` calls live in `src/extension.ts`, at the wiring passed into `registerConfigPanel`, never in the controller.
- **Graceful degradation.** Both seams are optional at both levels (`ConfigPanelControllerDeps` and `RegisterConfigPanelDeps`). If they are absent, every other panel behaviour is unchanged and the buttons do nothing harmlessly. A throwing or rejecting seam is logged and never turns into a `saveFailed`, a `loadFailed`, or a change to panel state.
- **Form isolation.** The new buttons never take part in `render()`, `updateEnablement()`, `isDirty()` or `persistDraft()`. They never invalidate or re-post the form, and they never change the conflict token.
- **Mirror test.** `test/configPanel.mirror.test.ts` (and the mirror property test) must stay green. The plain-script mirror block at the top of `media/config.js` does not grow.
- **Message contract.** An unrecognised message type is still logged and ignored. `retainContextWhenHidden`, the CSP/nonce setup, the `${nonce}` / `${cspSource}` / `${baseUri}` substitution, and `localResourceRoots` are unchanged. The new buttons add no inline script or inline handler, since all wiring goes in `media/config.js` under the existing nonce.
- **Untouched behaviour.** Save / Reload / Reset, the conflict and `externalChange` banner flow, preservation of unknown keys in `applyFormToDocument`, and the roles/limits/git fieldset layout do not change.
- The worktree under `.claude/worktrees/` is not a target. Every phase belongs to the owning repository.

# PHASES

- [pending] P01 Add openSettings/manageApiKeys messages and host-free controller seams with unit tests (files: src/config/configPanel.ts, src/activation/configPanelController.ts, test/configPanel.controller.test.ts)
- [pending] P02 Pass the seams through registerConfigPanel and wire them to openSettings and setProviderApiKey in extension.ts (after P01; files: src/activation/configPanel.ts, src/extension.ts, test/configPanel.view.test.ts, test/activation.gating.test.ts)
- [pending] P03 Add More settings… and Manage API keys… toolbar buttons to the webview with view tests (after P01; files: media/config.html, media/config.js, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
