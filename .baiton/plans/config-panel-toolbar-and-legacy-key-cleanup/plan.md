---
version: 1
name: config-panel-toolbar-and-legacy-key-cleanup
status: approved
mode: manual
base: main
base_commit: 9404cd8180097980e6823858e2e6855f91634fb2
branch: baiton/config-panel-toolbar-and-legacy-key-cleanup
approved_rev: 4af64dd7464ea7baf1d51a7bd80f1bf8994c85259011087473c7a9293bafb9b1
---

# Endstate

**The easy button exists and goes somewhere useful.** The Configuration view's toolbar carries **More settings…** and **Manage API keys…** beside Save / Reload / Reset…. Clicking **More settings…** opens VS Code Settings filtered to every Baiton setting (`workbench.action.openSettings` with an `@baiton` query, i.e. `@${SETTINGS_NS}`), not just the orchestrator group. Clicking **Manage API keys…** runs `baiton.setProviderApiKey` with no argument. Both buttons work in every panel state: ready, `loadFailed`, and while a load or save is in flight. They never touch the form, the draft, the dirty flag or Save's enablement.

**The panel is flat.** There are no nested boxes. The Roles section is a single table (`#roles-table`) with one row per role and Agent / Model / Effort columns. Each cell holds that field's control (dropdown, `Other…` input, documentation link, staleness note) directly under its column header, with its inline error in the same cell. Limits and Git are plain headed sections, not bordered fieldsets, and the toolbar is compact.

**The legacy orchestrator key path is gone.** `baiton.setOrchestratorApiKey`, `setOrchestratorApiKey()`, the `baiton.orchestrator.apiKey` secret constant (`LEGACY_API_KEY_SECRET` / `API_KEY_SECRET`), `migrateLegacyApiKey()` and its `keyMigrated` flag no longer exist anywhere in the build. Nothing reads or migrates the old secret, and activation no longer runs a one-time migration in front of `router.init()` / `router.refresh()`. The per-provider flow (`baiton.setProviderApiKey`, `baiton.setProviderEndpoint`, `baiton.orchestrator.key.<id>` slots) is unchanged. Tests, the README and the doc comments describe the code as it now is.

# What needs changing

**Toolbar markup and handlers (`media/config.html`, `media/config.js`).**
- Add `<button id="more-settings" class="secondary" type="button">More settings&hellip;</button>` and `<button id="manage-api-keys" class="secondary" type="button">Manage API keys&hellip;</button>` inside `<header class="toolbar">`, after Reset….
- In `media/config.js`, look both buttons up next to `saveBtn` / `reloadBtn` / `resetBtn`. On click they post `{ type: 'openSettings' }` and `{ type: 'manageApiKeys' }`.
- Keep both buttons out of `render()`, `updateEnablement()`, `isDirty()`, `persistDraft()` and the plain-script mirror block at the top of the file.
- Tighten the toolbar CSS so it stays compact with five buttons.

**Settings filter (`src/extension.ts`, plus doc comments in `src/activation/configPanel.ts` and `src/activation/configPanelController.ts`).**
- At the `registerConfigPanel({ ... })` call, change the `openSettings` seam from `${SETTINGS_NS}.orchestrator` to `@${SETTINGS_NS}`. It stays a `Promise<void>`.
- Rewrite the comment that says the seam matches the Chat view's inline-error fix, since that fix still targets `baiton.orchestrator`. Keep the note that the panel is registered ahead of the activation gate.
- Update the JSDoc on the `openSettings` seam in `configPanel.ts` (~L228) and `configPanelController.ts` (~L105), which still name `${SETTINGS_NS}.orchestrator`.

**Roles layout (`media/config.html`, `media/config.js`).**
- Replace the `#roles-fieldset` box and its per-role fieldsets with `<table id="roles-table">`. It has a `thead` naming Agent / Model / Effort and a `<tbody id="roles-body">`.
- `buildRoleRows()` appends one `<tr data-role=…>` per role instead of a `fieldset.role-group`. Each row has the role name in a `th scope="row"`, then one `td` per field.
- The cells keep the existing element ids: `role-<role>-agent`, `role-<role>-model-select`, `role-<role>-model-input`, `role-<role>-effort-select`, `role-<role>-effort-input`, `error-roles-<role>-<field>` and `role-<role>-stale`. They also keep their classes and the `data-path` / `data-error-for` / `data-static` attributes.
- Keep the build-once guard, the static-option markers and the in-place sync in `renderOptionLists()`. Render never rebuilds the structure, so focus and caret are preserved.
- Flatten Limits and Git to headed sections without a bordered fieldset, and delete the unused `.role-group` / fieldset CSS rules.

**Legacy key removal (`src/activation/setApiKey.ts`).**
- Delete `setOrchestratorApiKey`, `API_KEY_SECRET`, `API_KEY_PROMPT`, `API_KEY_SAVED_MESSAGE`, `API_KEY_NO_VALUE_MESSAGE`, `API_KEY_SAVE_FAILED_MESSAGE`, `LEGACY_MIGRATION_FLAG`, `MementoLike` and `migrateLegacyApiKey`, plus the `LEGACY_API_KEY_SECRET` import.
- Keep `setProviderApiKey`, `promptProviderKey`, the per-provider message helpers, the aliased-slot grouping and the availability refresh.
- Rewrite the module doc comment so it describes only the per-provider flow.

**Legacy key removal (`src/activation/commands.ts`, `src/orchestrator/providers.ts`, `src/activation/providerRouter.ts`, `package.json`).**
- In `commands.ts`, drop `COMMANDS.setApiKey`, its `registerCommand` alias that calls `promptProviderKey()`, the `migrateLegacyApiKey` import, the `legacyMigration` promise and the `.then(…)` chain that awaited it. `router.init()` / `router.refresh()` run exactly as before, just without the migration gate.
- In `providers.ts`, delete `export const LEGACY_API_KEY_SECRET` and its doc comment.
- In `providerRouter.ts`, reword the comment near L520 that says "matching `migrateLegacyApiKey`".
- In `package.json`, remove the `baiton.setOrchestratorApiKey` entry from `contributes.commands` and from `menus.commandPalette`.
- Leave `FixAction` and the `setApiKey` branch of `triggerFix` alone. They already call `promptProviderKey` directly.

**Tests.**
- `test/configPanel.view.test.ts`:
  - Add `more-settings` and `manage-api-keys` to the fake DOM.
  - Assert that clicking each posts the matching message.
  - Assert that neither is disabled in the busy or `loadFailed` phases.
  - Rebuild the hand-rolled DOM stub so it has the roles table/tbody, and move the `rolesBody` containment and `.role-group` count assertions to rows.
- `test/activation.gating.test.ts` (~L907–911): point the `openSettings` wiring test (title and regex) at `@${SETTINGS_NS}`.
- `test/setApiKey.test.ts`: delete the `setOrchestratorApiKey` and `migrateLegacyApiKey` suites and their module-binding lines.
- `test/providers.test.ts`: drop the three `LEGACY_API_KEY_SECRET` assertions. Either restate the "a per-provider slot is never the legacy name" guarantee against the literal `'baiton.orchestrator.apiKey'`, or remove it, so no import is left dangling.
- `test/fixtures/vscodeFake.mjs`: update the header comment that names `setOrchestratorApiKey`.

**README.**
- In *Per-provider API keys*, rewrite the **Baiton: Set Orchestrator API Key** paragraph to say the alias and the migration were removed, and that a user whose only key is the old secret has to set it again through the per-provider flow.
- Update the *Toolbar* bullet: **More settings…** opens all Baiton settings, and **Manage API keys…** is listed.
- Describe the roles table in *Managed fields*.

# Limitations & constraints

- **The save path does not change.** Leave these alone:
  - Save / Reload / Reset
  - the conflict and `externalChange` banners
  - unknown-key preservation in `applyFormToDocument`
  - validation order and messages
  - the `.baiton/config.local.json` file the panel edits
- **The message contract does not change.** `ConfigPanelWebviewToHost` already carries `openSettings` and `manageApiKeys`. Add no variant, payload or reply. `src/config/configPanel.ts` stays free of `vscode` and Node imports, `ConfigPanelController` stays host-free, and every `vscode.commands` call stays in `src/extension.ts` at the wiring.
- **No new surface.** No API-key value and no set/not-set flag crosses into the webview. No command, setting or `package.json` contribution is added; one is removed.
- **The new buttons are inert.** They never enter `render()`, `updateEnablement()`, `isDirty()` or `persistDraft()`. They never disable, never re-post the form and never change the conflict token. An absent seam is a silent no-op. A seam that throws or rejects is logged by the controller and never becomes a `saveFailed`.
- **The layout change is layout only.** Only the markup and the DOM-building code that fills it change. These keep working as they do now:
  - element ids and the `data-path` / `data-error-for` / `data-static` markers
  - the agent/model/effort option sync and `Other…` stickiness
  - the documentation link and the staleness note
  - role agent/model/effort resolution

  The CSP, nonce, `localResourceRoots` and `retainContextWhenHidden` do not change, and no inline script or handler is added. The roles table must still read sensibly in a narrow sidebar.
- **Mirror test.** `test/configPanel.mirror.test.ts` and the mirror property test stay green. The plain-script mirror block at the top of `media/config.js` does not grow.
- **The removal is real, not a shim.** No deprecated stub is left behind. `baiton.setOrchestratorApiKey` becomes an unregistered command, the old secret is neither read nor written, and no migration runs. When the removal phase is done, a grep for `setOrchestratorApiKey`, `LEGACY_API_KEY_SECRET`, `migrateLegacyApiKey`, `keyMigrated` and `API_KEY_SECRET` across `src/`, `test/`, `media/`, `package.json` and `README.md` should come back empty. Historical `.baiton/plans/` records are exempt.
- **Everything else stays.** The provider catalog, the Chat view's `setApiKey` / `setEndpoint` / `openSettings` fix actions (still scoped to `baiton.orchestrator`), `baiton.setProviderEndpoint`, the model dropdown, Usage and every other view are untouched.
- **Repository.** The `.claude/worktrees/agent-a5ddc1998c8737446` checkout is not a target. Every phase belongs to the owning repository `.`.
- **Every phase leaves the build and the full test suite green.** If a phase changes code, it updates the matching tests in the same phase.

# PHASES

- [done] P01 Add More settings… and Manage API keys… toolbar buttons and widen the settings filter to all Baiton settings (files: media/config.html, media/config.js, src/extension.ts, src/activation/configPanel.ts, src/activation/configPanelController.ts, test/configPanel.view.test.ts, test/activation.gating.test.ts)
- [executed] P02 Flatten the Configuration view: roles as an Agent/Model/Effort table, Limits and Git as plain headed sections (after P01; files: media/config.html, media/config.js, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts)
- [pending] P03 Remove the legacy orchestrator API key command, secret constant and activation-time migration (files: src/activation/setApiKey.ts, src/activation/commands.ts, src/orchestrator/providers.ts, src/activation/providerRouter.ts, package.json, test/setApiKey.test.ts, test/providers.test.ts, test/fixtures/vscodeFake.mjs)
- [pending] P04 Update README for the new toolbar buttons, the roles table and the removed legacy key alias (after P01, P02, P03; files: README.md)
