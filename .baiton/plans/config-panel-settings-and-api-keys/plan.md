---
version: 1
name: config-panel-settings-and-api-keys
status: approved
mode: manual
base: main
base_commit: 01b75cb67794f2dbff580f7dac78dba06c792d25
branch: baiton/config-panel-settings-and-api-keys
approved_rev: 90377d9cfbf5b10abd755fdd52fc52ab0082f20aa4c2c200ca87fc114966aa69
---

# Endstate

Configuration is personal, not shared: nothing the Config Panel or Initialize writes ever shows up as a git change.

**Local config file.** `.baiton/config.local.json` is the file the extension writes, and it is gitignored (`/config.local.json` and the atomic `.config.*.json.*.tmp` temp files from `GITIGNORE_CONTENTS`, so `refreshGitignore` fixes existing workspaces at activation and Initialize fixes new ones). Initialize on a fresh workspace seeds `config.local.json` from `defaultConfig()` and no longer creates a tracked `config.json`.

**Reading.** `loadConfig` reads the optional committed `.baiton/config.json` (the shared team baseline, when a repo chooses to keep one), reads `.baiton/config.local.json` when present, and deep-merges the local file over the baseline — objects merge key by key, arrays and scalars are replaced — then validates the merged result. Neither file present is still `absent` and still points the user at Initialize. Only a baseline present, only a local file present, and both present all load. A version migration persists the migrated document to the local file, never to the committed one. Parse errors name the exact file that failed to parse; validation errors name the local file, which is the file the panel can fix.

**Writing.** Every Config Panel save — roles, limits, git — writes the full effective document to `.baiton/config.local.json` and leaves `.baiton/config.json` byte-for-byte untouched. The conflict token, the save token check, and the external-change watcher move to the local file, and the watcher also still reports a change to the committed baseline so an open panel notices a baseline edit. Reset-to-defaults writes `defaultConfig()` to the local file. The panel shows the merged effective values and names `.baiton/config.local.json` as the file it edits. `migrateLegacyApiKey`, `baiton.setProviderApiKey`, and SecretStorage are unchanged — keys were already local.

**Toolbar buttons.** The Configuration view (`baiton.configPanel`) toolbar carries two more buttons beside Save / Reload / Reset…:

- **More settings…** opens VS Code Settings filtered to `baiton.orchestrator`, the same target the Chat view's inline-error "open settings" fix uses (`triggerFix` in `src/activation/commands.ts` runs `workbench.action.openSettings` with `${SETTINGS_NS}.orchestrator`).
- **Manage API keys…** runs the existing `baiton.setProviderApiKey` command with no provider argument. The user gets the current provider quick pick, where each item shows "API key set" or "No API key set", and then the masked input, where an empty submit clears the key. That one flow covers both changing a stored key and adding a first key for a provider. Provider availability is refreshed the same way it is today when that command runs.

Both buttons work in every panel state, including `loadFailed` and while a load or save is in flight. Neither depends on the config document having loaded. Neither touches the form, the draft, the dirty state, or the Save button's enablement. The webview posts a fire-and-forget message for each button. The host-free controller sends each message to an injected seam and posts nothing back. A seam that throws is logged and never shows up as a `saveFailed`. A seam that is not wired is a silent no-op. Controller and view tests cover all of this, and the existing mirror, gating and view suites still pass.

# What needs changing

**Overlay path and merge — `src/config/loadConfig.ts`.** Add `localConfigFilePath(baitonDir)` beside `configFilePath` as the single place that spells `config.local.json`. Change `loadConfig` to read both files, merge with the local file winning, and validate the merged document against the same rules. Deep-merge objects, replace arrays and scalars. Keep `absent` when neither file exists. `writeJsonAtomic` keeps its signature and formatting; its temp-file naming stays as is and the gitignore pattern covers it. Migration (`migrateAndPersist`) writes the migrated document to the local file, creating `.baiton/` when needed, and never writes the baseline.

**Gitignore and Initialize — `src/config/gitignore.ts`, `src/config/initialize.ts`.** Add `/config.local.json` and a temp-file pattern (`/.config*json.*.tmp`) to `GITIGNORE_CONTENTS` so `refreshGitignore` brings every existing workspace up to date at activation. Initialize writes `defaultConfigJson()` to `config.local.json` instead of `config.json`, still never overwriting an existing local file, still leaving any pre-existing `config.json` untouched, and still rolling back its own creations.

**Panel document I/O — `src/config/configDocument.ts`.** `readConfigDocument` returns the merged document (parsed object from the merge, token computed over the local file's text, `ABSENT_TOKEN` when the local file does not exist but a baseline does), and its `path`/error messages name the local file. `writeConfigDocument` and `readConfigToken` read and write `.baiton/config.local.json` only, keeping the `expectedToken` conflict behaviour and the atomic write. `migrateAndPersist`'s and `writeJsonAtomic`'s guarantees are unchanged.

**Controller — `src/activation/configPanelController.ts`.** Reset writes defaults to the local file. The reset-confirm text, the activation-values note and the conflict messages name `.baiton/config.local.json`. `applySaved()` still re-validates with `loadConfig` so the merged document is what the running extension is checked against. Separately, add two optional seams to `ConfigPanelControllerDeps`: `openSettings?(): Promise<void> | void` and `manageApiKeys?(): Promise<void> | void`, documented like `confirmReset` / `applyConfig`. In `handle()`, add `case 'openSettings'` and `case 'manageApiKeys'`. Each calls its seam if one is present, catches a synchronous throw or a rejected promise and passes it to `deps.log` with a `ConfigPanelController:` prefix, and changes no controller state (`doc` / `token` / `form` / `writing`), posts nothing, and does not trigger a load. An absent seam is a silent no-op and does not fall through to the "unrecognised message type" log. Update the class doc comment listing handled messages.

**Message contract — `src/config/configPanel.ts`.** Add two variants to `ConfigPanelWebviewToHost`: `{ type: 'openSettings' }` and `{ type: 'manageApiKeys' }`, each with a doc comment in the style the union already uses. Add nothing to `ConfigPanelHostToWebview`; both requests are one-way.

**Provider — `src/activation/configPanel.ts`.** Add optional `openSettings?()` and `manageApiKeys?()` to `RegisterConfigPanelDeps` and pass them into the `ConfigPanelController` deps in `ensureController`, alongside `confirmReset` / `applyConfig`, leaving them `undefined` when absent. Widen the config watcher so a change to either `config.json` or `config.local.json` schedules the existing debounced `notifyExternalChange()`.

**Wiring — `src/extension.ts`.** At the `registerConfigPanel({ ... })` call, next to `getCapabilities` / `onDidChangeCapabilities` / `applyConfig`, pass:
- `openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', `${SETTINGS_NS}.orchestrator`)`, reusing the namespace constant `triggerFix` uses (import it if absent).
- `manageApiKeys: () => vscode.commands.executeCommand(COMMANDS.setProviderApiKey)`, with no argument.

Both return `Thenable<unknown>`, so adapt them to `Promise<void> | void`. The panel is registered before the activation gate but `baiton.setProviderApiKey` is registered inside `registerCommands`, so an uninitialised folder or failed activation makes `executeCommand` reject; the controller logs that and the panel stays usable. Note this in a comment at the call site. Any user-facing message that names the config file should name the local one.

**Webview — `media/config.html` and `media/config.js`.** In `media/config.html`, add `<button id="more-settings" class="secondary" type="button">More settings&hellip;</button>` and `<button id="manage-api-keys" class="secondary" type="button">Manage API keys&hellip;</button>` inside `<header class="toolbar">` after Reset…, and update the `#config-path` label to `.baiton/config.local.json`. In `media/config.js`, look both buttons up next to `saveBtn` / `reloadBtn` / `resetBtn` and add click handlers that post `{ type: 'openSettings' }` and `{ type: 'manageApiKeys' }`. Do not add them to `updateEnablement()`, `render()`, `isDirty()` or `persistDraft()`, so they are never disabled, including while busy or in `loadFailed`. Do not add them to the plain-script mirror block at the top of the file.

**Tests.**
- Overlay: new cases for merge precedence (local wins, arrays replaced, unknown keys from either side preserved), baseline-only, local-only, neither (`absent`), local file corrupt (`unparseable` naming the local file), migration persisted to the local file with the baseline untouched, and `writeConfigDocument` / `readConfigToken` targeting the local file.
- `test/config.gitignore.test.ts`: assert the new patterns and their placement.
- `test/config.test.ts`: Initialize seeds `config.local.json`, leaves an existing one alone, never creates a tracked `config.json`, and rolls back.
- `test/configPanel.document.test.ts` / `test/configPanel.controller.test.ts`: saves, tokens, conflicts, external changes and Reset all land on `config.local.json` with `config.json` unchanged. Plus, for each new message: the seam is called exactly once, nothing is posted (no `saveFailed`, no `loaded`), loaded state stays intact so a following `save` still works, a synchronous throw and a rejected promise are both logged and post nothing, an unwired seam is a no-op with no "unrecognised message type" log, and both work after a `loadFailed`.
- `test/configPanel.view.test.ts`: add `more-settings` and `manage-api-keys` to the fake DOM; clicking each posts the matching message; neither is disabled in the busy or `loadFailed` phases; provider-level pass-through of the seams, and omitting them is harmless.
- `test/activation.gating.test.ts`: if it inspects the `registerConfigPanel({ ... })` text, assert both seams are wired to the expected commands.

# Limitations & constraints

- **No tracked writes.** No code path may write `.baiton/config.json`: not save, not reset, not migration, not Initialize. A repo that already tracks one keeps it as a read-only baseline until someone edits it by hand.
- **Backward compatibility.** Reading a workspace with only `.baiton/config.json` behaves exactly as today, so existing tests and existing checkouts keep working with no migration step and no `git rm --cached`. `writeJsonAtomic`'s signature and byte formatting stay; `ConfigError` variants keep their kinds and messages apart from naming the local file.
- **Accepted shadowing.** The local file holds the full effective document, so once a field is saved locally it no longer tracks a later commit to the baseline. That is the trade-off of the chosen storage model, and it makes merge order trivial: local wins.
- **No secrets or catalog data in the webview.** No API-key value, no set/not-set flag, and no part of the provider catalog crosses into the webview. Neither new message carries a payload.
- **No new surface area.** Add no new command, no new setting, and change no `package.json` contribution. Both buttons hand off to `workbench.action.openSettings` and the already-registered `baiton.setProviderApiKey`. The key flow keeps its SecretStorage keys (`baiton.orchestrator.key.<slot>`), its aliased-slot grouping and its availability refresh. `migrateLegacyApiKey` and `src/activation/setApiKey.ts` are not modified.
- **Layering.** `src/config/configPanel.ts` stays free of `vscode` and Node imports, and `ConfigPanelController` stays host-free. All `vscode.commands` calls live in `src/extension.ts`, at the wiring passed into `registerConfigPanel`, never in the controller.
- **Graceful degradation.** Both seams are optional at both levels (`ConfigPanelControllerDeps` and `RegisterConfigPanelDeps`). A throwing or rejecting seam is logged and never turns into a `saveFailed`, a `loadFailed`, or a change to panel state.
- **Form isolation.** The new buttons never take part in `render()`, `updateEnablement()`, `isDirty()` or `persistDraft()`. They never invalidate or re-post the form and never change the conflict token.
- **Mirror test.** `test/configPanel.mirror.test.ts` (and the mirror property test) stay green; the plain-script mirror block at the top of `media/config.js` does not grow.
- **Message contract and CSP.** An unrecognised message type is still logged and ignored. `retainContextWhenHidden`, the CSP/nonce setup, the `${nonce}` / `${cspSource}` / `${baseUri}` substitution, and `localResourceRoots` are unchanged. The new buttons add no inline script or inline handler.
- **Untouched behaviour.** Save / Reload / Reset flows, the conflict and `externalChange` banner flow, preservation of unknown keys in `applyFormToDocument`, the roles/limits/git fieldset layout, run/plan/worktree paths, and the roles' agent/model/effort resolution do not change.
- The worktree under `.claude/worktrees/` is not a target. Every phase belongs to the owning repository.

# PHASES

- [done] P01 Add openSettings/manageApiKeys messages and host-free controller seams with unit tests (files: src/config/configPanel.ts, src/activation/configPanelController.ts, test/configPanel.controller.test.ts)
- [done] P02 Pass the seams through registerConfigPanel and wire them to openSettings and setProviderApiKey in extension.ts (after P01; files: src/activation/configPanel.ts, src/extension.ts, test/configPanel.view.test.ts, test/activation.gating.test.ts)
- [done] P04 Add .baiton/config.local.json as a merged overlay in loadConfig, migrating to it instead of config.json (files: src/config/loadConfig.ts, test/config.test.ts, test/config.overlay.test.ts)
- [done] P05 Gitignore the local config and seed it from Initialize instead of config.json (after P04; files: src/config/gitignore.ts, src/config/initialize.ts, src/extension.ts, test/config.gitignore.test.ts, test/config.test.ts)
- [done] P06 Point panel saves, tokens, reset and the watcher at config.local.json and relabel the panel's config path (after P05; files: src/config/configDocument.ts, src/activation/configPanelController.ts, src/activation/configPanel.ts, media/config.html, test/configPanel.document.test.ts, test/configPanel.controller.test.ts, test/configPanel.view.test.ts)
- [planning] P07 Document the local config overlay and the new toolbar buttons in README (after P06; files: README.md)
