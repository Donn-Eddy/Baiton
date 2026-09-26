# Plan T09

## Steps

1. Handle the additive `optionsChanged` host message in media/config.js

   In `media/config.js`, inside the `window.addEventListener('message', ...)` switch (currently `loaded` / `loadFailed` / `saved` / `saveFailed` / `externalChange` / `default`), add a new case BEFORE `default`:

   ```js
   case 'optionsChanged':
     // Additive out-of-band refresh (model-selector-refresh T08/T09): replace the
     // option lists only. No form, no token, no baseline, no busy/error change —
     // the user's in-progress edits and the conflict token must survive.
     state.options = msg.options || { agents: [], byAgent: {} };
     state.stale = msg.stale || {};
     break;
   ```

   Do NOT touch `state.form`, `state.baseline`, `state.token`, `state.errors`, `state.errorsFromServer`, `state.busy`, `state.banner`, `state.phase` or `state.pendingExternal` in this case. The existing tail of the listener (`persistDraft(); render();`) then runs, which is correct: the persisted draft is unchanged and `render()` reprojects. Handling the message while `state.phase !== 'ready'` (no form yet) must be safe — it just stores the options; a later `loaded` overwrites `state.options` from its own payload, so also add `state.stale = {}` to the `loaded` case so a reload clears stale badges that no longer apply.

   Add `stale: {}` to the initial `state` object literal (next to `options: { agents: [], byAgent: {} }`) and document it in the state comment as `stale: Record<agentId, { stale: boolean, reason?: string, fetchedAt?: string }>`.

   All of this lives BELOW the `if (typeof acquireVsCodeApi !== 'function') { return; }` guard. Nothing may be added above that guard (the mirror block must stay DOM-free so `loadConfigMirror()` in test/configPanel.mirror.test.ts can still evaluate the file with only a fake `window`).

   Files: `media/config.js`

2. Split row construction from option-list population so refreshes update in place

   Today `buildRoleRows()` keys its rebuild on `JSON.stringify(state.options) + '|' + roleAgentsSignature()` and does `rolesBody.textContent = ''`, so every refreshed model list destroys and recreates all six role blocks — losing focus, caret position and the shown/hidden state of the `Other…` text inputs. Restructure into build-once + sync-in-place:

   1. Replace `var renderedOptionsSignature = null;` with `var rolesBuilt = false;` (delete `roleAgentsSignature()`; it becomes unused).
   2. `buildRoleRows()` becomes structure-only and runs once: `if (rolesBuilt) { return; } rolesBuilt = true;` then build the same DOM it builds today for each role in `ROLES`, with these changes:
      - keep every existing id, `className`, `dataset.path`, `dataset.role`, `data-error-for` and `aria-describedby` value byte-identical (`role-<role>-agent`, `role-<role>-model-select`, `role-<role>-model-input`, `role-<role>-effort-select`, `role-<role>-effort-input`, `error-roles-<role>-<field>`), because renderValues/renderErrors and the change handlers look them up by those exact strings;
      - append NO dynamic options here. The agent select is created empty; the model select gets only the trailing `Other…` option (`opt.value = OTHER_MODEL_VALUE`, `opt.dataset.static = 'other'`); the effort select gets only the leading `(default)` option (`value = ''`, `dataset.static = 'default'`) and the trailing `Other…` option (`dataset.static = 'other'`). Dynamic options are added by step 3 and are identified by the absence of `dataset.static`.
      - always create the documentation link element (`var modelLink = document.createElement('a'); modelLink.className = 'doc-link'; modelLink.target = '_blank'; modelLink.rel = 'noreferrer noopener'; modelLink.textContent = 'Documentation'; modelLink.id = 'role-' + role + '-model-link'; modelLink.style.display = 'none';`) and append it to `modelGroup`, instead of creating it conditionally from `cap.modelLink`. Its href/visibility is set per render in step 3.
      - append a stale note element to `modelRow`, after `modelGroup` and before the model `.field-error` div: `var staleNote = document.createElement('div'); staleNote.className = 'stale-note'; staleNote.id = 'role-' + role + '-stale'; staleNote.dataset.staleFor = role;` (empty text; CSS hides it when empty — step 5).
   3. Add `function syncSelectOptions(selectEl, values)`: returns without touching the DOM when the currently rendered dynamic option values (children with `tagName === 'OPTION'` and no `dataset.static`) already deep-equal `values` in order — this is what preserves focus, the open dropdown and the current selection on a no-op refresh. Otherwise: remember `var previous = selectEl.value;` remove the dynamic options in place (`selectEl.removeChild(...)` over a snapshot of `selectEl.children`, leaving the `data-static` ones), then insert one `<option>` per value (`opt.value = opt.textContent = value`) with `selectEl.insertBefore(opt, otherOption)` so the static `Other…` stays last and the static `(default)` stays first; finally restore `selectEl.value = previous` when an option with that value still exists (real select semantics mean an absent value yields `''`, which renderValues fixes on the same pass).
   4. Add `function renderOptionLists()`: for each `role` in `ROLES`, with `entry = state.form.roles[role]`:
      - agent select: desired list = `state.options.agents` plus `entry.agent` appended when `entry.agent !== ''` and not already present (so the existing append in `renderValues()` becomes a no-op and the list is not thrashed between renders); call `syncSelectOptions`.
      - `var cap = (state.options.byAgent && state.options.byAgent[entry.agent]) || { models: [], efforts: [] };` then `syncSelectOptions(modelSelect, cap.models || [])` and `syncSelectOptions(effortSelect, cap.efforts || [])`.
      - doc link: if `cap.modelLink` set `link.href = cap.modelLink; link.style.display = '';` else `link.removeAttribute('href'); link.style.display = 'none';`.
      Guard every `document.getElementById` result before use (the tests build a minimal DOM).
   5. `render()` becomes `renderErrorView(); if (state.form) { buildRoleRows(); renderOptionLists(); renderStale(); renderValues(); renderErrors(); } renderBanner(); renderStatus(); updateEnablement();` — option lists are synced BEFORE `renderValues()` so the select values it writes land on freshly present options.

   Files: `media/config.js`

3. Keep `Other…` custom entries editable across a refresh

   `renderValues()` currently derives whether the free-text input is shown purely from membership (`models.indexOf(entry.model) !== -1`, and for effort `entry.effort === '' || efforts.indexOf(...) !== -1`). That loses an in-progress `Other…` entry two ways: an empty effort input snaps back to `(default)` before the user types, and a refresh whose list now contains the typed value silently flips the control back to the dropdown and blanks the input.

   Add sticky per-role `Other…` tracking in `media/config.js`:
   - new state fields `otherModel: {}` and `otherEffort: {}` (role → true), documented in the state comment;
   - in the `change` handler branch for `role-model-select`: set `state.otherModel[role] = true` when `select.value === OTHER_MODEL_VALUE`, else `delete state.otherModel[role]`. Same for the effort branch with `state.otherEffort[effortRole]`. Keep the rest of those branches (focus, `setField`, status/banner clearing, `persistDraft()`, `render()`) unchanged.
   - in the `loaded` case reset both to `{}` (a fresh form re-derives from membership). Do NOT reset them in `optionsChanged` — that is the whole point.
   - in `renderValues()`, replace the membership test with `var showInput = !!state.otherModel[role] || models.indexOf(entry.model) === -1;` (and, for effort, `var showEffortInput = !!state.otherEffort[role] || !(entry.effort === '' || efforts.indexOf(entry.effort) !== -1);`). When the input is shown, set the select to `OTHER_MODEL_VALUE` / `OTHER_EFFORT_VALUE` and write `entry.model` / `entry.effort` into the input — both only when that element is not `document.activeElement`, exactly as today. When it is hidden, keep today's behaviour (`input.value = ''`, select set to the value). The `models.length === 0` / `efforts.length === 0` free-text-only branches stay as they are.

   Net effect an executor can verify: after `optionsChanged`, a role whose model select showed `Other…` with text `my-custom-model` still shows the input with that text, `state.form` is untouched, and `isDirty()`/the Save button state is unchanged.

   Files: `media/config.js`

4. Render the per-agent stale indicator

   Add `function renderStale()` to `media/config.js`: for each `role` in `ROLES`, look up `var note = document.getElementById('role-' + role + '-stale');` and `var info = state.stale && state.stale[state.form.roles[role].agent];`. When `info && info.stale === true`, set `note.textContent = 'stale — showing last known models'` (this exact string) and, when `info.fetchedAt` is present, append ` (last updated ' + info.fetchedAt + ')'`; set `note.title = info.reason` when `info.reason` is a non-empty string, else `note.removeAttribute('title')`; add class `visible`. Otherwise `note.textContent = ''`, remove the `visible` class and remove `title`. Never write HTML — `textContent` only (the view's no-sanitizer invariant documented in media/config.html). Agents with no entry in `state.stale`, and `{ stale: false }` entries (fresh fetch), render no note — `agentStaleness()` emits `{}` for an untouched builtin table, so the default panel shows no badges at all.

   Files: `media/config.js`

5. Style the stale note in media/config.html

   Add a rule block next to the existing `.doc-link` / `.field-error` rules in the `<style nonce="${nonce}">` block:

   ```css
   .stale-note {
     display: none;
     font-size: 0.9em;
     color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground));
   }

   .stale-note.visible:not(:empty) {
     display: block;
   }
   ```

   Every colour must come from a VS Code theme variable (no literal colour values) — that invariant is asserted by the existing view/shell expectations and stated in the file header comment. No markup change is needed: the role rows are built by config.js, and the three `${nonce}` / `${cspSource}` / `${baseUri}` placeholders and the CSP must stay exactly as they are.

   Files: `media/config.html`

6. Fake-DOM tests for the refresh behaviour in test/configPanel.view.test.ts

   Append a NEW top-level `describe('config panel webview options refresh (model-selector-refresh T09)', ...)` to `test/configPanel.view.test.ts`, independent of the existing host-side suite (it must not rely on the `vscode` loader registered in that file's `before` hook; it only needs `fs`, `path`, `vm` and the types from `../src/config/configPanel`).

   Add a local `loadConfigView()` helper following the fake-DOM pattern of `test/chatView.providers.test.ts` (`FakeClassList` + `FakeEl` + `vm.runInNewContext`), trimmed to what config.js touches: `tagName`, `children`, `style`, `dataset`, `classList`, `id`, `htmlFor`, `type`, `disabled`, `selected`, `title`, `textContent`, `value` with real SELECT semantics (selected option wins; an unmatched assignment yields `''`), `options`, `appendChild`, `insertBefore`, `removeChild`, `setAttribute`/`getAttribute`/`removeAttribute`, `focus()`, `querySelector`/`querySelectorAll` (attribute `[data-error-for="…"]`, class and tag selectors), and `addEventListener` plus a test-only `fire(type, evt)`.

   The sandbox must provide: `window.addEventListener` capturing the `message` listener, `document.createElement`, `document.getElementById` over a pre-seeded id map, a settable `document.activeElement` (default `null`), and `acquireVsCodeApi()` returning `{ postMessage, getState, setState }` recording posts. Seed the ids media/config.html defines: `config-form`(form), `roles-body`(div), `save`/`reload`/`reset`(button), `banner`(div), `banner-message`(span), `banner-primary`/`banner-secondary`(button), `status`(div), `error-view`(div), `error-message`(p), `error-reset`/`error-reload`(button), `limit-plan_review_rounds`, `limit-exec_attempts`, `limit-stall_notice_minutes`, `git-remote`, `git-base`(input). `getElementById` must also resolve ids created at runtime by config.js (`role-*-agent`, `role-*-model-select`, `role-*-model-input`, `role-*-effort-select`, `role-*-effort-input`, `role-*-model-link`, `role-*-stale`): implement it as a lookup in the seeded map falling back to a depth-first search of the `config-form` element tree by `id`.

   Cover, as separate `it` cases, using a helper that sends `{ type: 'loaded', form, token, options }` first:
   1. baseline: six `.role-group` fieldsets are built, and the model select for a role whose agent has models lists them plus a trailing `Other…` option; the effort select leads with `(default)`.
   2. `optionsChanged` with a longer model list replaces the model select's options in place — the same `HTMLSelectElement` object identity as before (assert `select === view.ids...`/the node captured before the message), the new ids present, `Other…` still last, and the role's selected value preserved.
   3. `optionsChanged` does not reset edits: mutate a field through the form `input` event (e.g. `git-remote`), send `optionsChanged`, assert `git-remote` still holds the edited text, the Save button is still enabled (dirty, no errors) and no `load`/`save` message was posted by the webview.
   4. focus preservation: set `document.activeElement` to a role's model text input, send `optionsChanged`, and assert the input's `value` was not overwritten.
   5. `Other…` stickiness: fire `change` on a role's model select with value `'\u0000other'`, type a custom value through the input's `input` event, send `optionsChanged` whose `byAgent[agent].models` now CONTAINS that custom value, then assert the model input is still displayed (`style.display !== 'none'`) with the custom text and the select still reads the `Other…` sentinel. Repeat the same for the effort select with an empty input (asserting it does not snap back to `(default)`).
   6. stale badge: `optionsChanged` with `stale: { claude: { stale: true, reason: 'models.dev fetch failed', fetchedAt: '2026-09-01T00:00:00.000Z' } }` renders `role-<role>-stale` containing `stale — showing last known models` with `title` equal to the reason for every role whose agent is `claude`, and empty text for roles on another agent; a follow-up `optionsChanged` with `stale: {}` clears the note text and the `visible` class.
   7. a new agent id appearing in `options.agents` shows up in every role's agent select, while a configured agent absent from `options.agents` is still present as an option and still selected (round-trip).
   8. an unknown message type (e.g. `{ type: 'somethingElse' }`) leaves the rendered options unchanged.

   Files: `test/configPanel.view.test.ts`

7. Extend the mirror guard for the new capability metadata

   In `test/configPanel.mirror.test.ts`, keep `loadConfigMirror()` and every existing assertion as-is (it is imported by `test/configPanel.mirror.property.test.ts`, so its export signature must not change) and add two cases to the existing `describe('config panel browser mirror (config-panel T09)')`:
   1. 'the mirror block stays DOM-free': assert that evaluating media/config.js in a sandbox whose only global is `window` (i.e. no `document`, no `acquireVsCodeApi`) still exports `window.baitonConfigForm` and does not throw — this is the guard that the new option-sync/stale rendering was added below the `acquireVsCodeApi` guard. Implement by reusing `loadConfigMirror()` inside `assert.doesNotThrow`.
   2. 'refresh metadata on a capability does not change validation in either implementation': build a `ConfigForm` (all six ROLES on agent `claude`, model `claude-sonnet-5`, effort `high`) and two `ConfigFormOptions` that differ only by the T08 metadata keys on `byAgent.claude` (`source: 'cached'`, `stale: true`, `staleReason: 'fetch failed'`, `fetchedAt: '2026-09-01T00:00:00.000Z'`), then assert `validateConfigForm` from `../src/config/configPanel` and `mirror.validateConfigForm` return deep-equal error arrays for both option objects and across the pair — extra metadata keys are ignored by both validators. Declare the fixtures inline in this file; do not edit `test/fixtures/configFormCases.ts`.

   Files: `test/configPanel.mirror.test.ts`

## Risks

- `buildRoleRows()` moving from signature-keyed rebuild to build-once is the riskiest edit: any id, className, `data-path`, `data-role`, `data-error-for` or `aria-describedby` string that changes silently breaks `renderValues()`, `renderErrors()` and the delegated `input`/`change` handlers. Keep those strings byte-identical and re-run the whole configPanel suite.
- The `(default)` and `Other…` options must be marked `data-static` and skipped by `syncSelectOptions`, otherwise a refresh either duplicates them or drops the `Other…` escape hatch and custom values become unreachable.
- `syncSelectOptions` must early-return when the desired list already matches; without that, every `render()` (which runs on each keystroke) rebuilds the option nodes, closing an open dropdown and resetting the caret.
- Because T08's `configFormOptions` appends a configured value to `cap.models`/`cap.efforts`, a custom value can become a real list member after a refresh; only the sticky `state.otherModel`/`state.otherEffort` flags keep an in-progress `Other…` entry visible. Losing that flag on `optionsChanged` would look like the webview discarding the user's typing.
- The mirror block above the `acquireVsCodeApi` guard must gain no `document`/`window`-DOM reference, or `loadConfigMirror()` — and therefore both mirror suites — throws at load.
- media/*.js and media/*.html are neither compiled by `tsc` nor linted by `npm run lint`, so the fake-DOM suite in test/configPanel.view.test.ts is the only automated check on this code; a gap there means a silently broken panel.
- The new suite in test/configPanel.view.test.ts shares a file with a suite that registers the `vscode` loader and mutates `globalThis.__vscodeFake`; keep the new describe self-contained (no `vscode` import, no reliance on that `before` hook) so ordering between the suites cannot matter.
- `state.stale` keys are agent ids while the panel renders per role; a role pointing at an agent with no stale entry must render no badge, so the lookup must tolerate a missing key rather than defaulting to stale.
- test/activation.gating.test.ts has a pre-existing baseline failure (the keytar/native-module assertion) unrelated to this todo; do not treat it as a regression.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` exit 0.
- `npx eslint test/configPanel.view.test.ts test/configPanel.mirror.test.ts --ext .ts` is clean.
- `npx mocha test/configPanel.view.test.ts test/configPanel.mirror.test.ts test/configPanel.mirror.property.test.ts test/configPanel.test.ts test/configPanel.controller.test.ts test/configPanel.form.property.test.ts test/configPanel.document.test.ts test/configRefresh.test.ts` is fully green.
- `npm run test:unit` shows no new failure beyond the pre-existing test/activation.gating.test.ts native-module baseline failure.
- A `loaded` message followed by `optionsChanged` carrying a longer model list updates the role model selects in place: the select nodes keep their object identity, the new model ids are present, `Other…` remains the last option, and the previously selected value stays selected.
- `optionsChanged` never mutates `state.form`, `state.baseline`, `state.token`, `state.errors`, `state.busy` or `state.banner`: an edited field keeps its text, the Save button keeps its enabled/disabled state, and the webview posts no `load` or `save` in response.
- A role whose model (or effort) select is on `Other…` still shows its free-text input, with the typed text intact, after an `optionsChanged` whose refreshed list now contains that value; the focused control's value is never overwritten.
- `stale: { <agent>: { stale: true, reason, fetchedAt } }` renders the exact text `stale — showing last known models` (plus the `fetchedAt` suffix) with `title` set to the reason on every role bound to that agent, and a subsequent `optionsChanged` with `stale: {}` clears the note and its `visible` class; an untouched builtin table (`stale: {}`) renders no note anywhere.
- A configured agent/model/effort that is absent from the refreshed lists is still listed and still selected in its control (round-trip preserved).
- media/config.js still exports `window.baitonConfigForm` when evaluated with only a fake `window` (no `document`, no `acquireVsCodeApi`), and both mirror suites pass unchanged in their existing assertions.
- media/config.html introduces no literal colour value and leaves the CSP and the `${nonce}` / `${cspSource}` / `${baseUri}` placeholders untouched.
- Only media/config.js, media/config.html, test/configPanel.view.test.ts and test/configPanel.mirror.test.ts are modified (`git status --porcelain` shows no other file).
