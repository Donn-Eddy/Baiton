# Plan T07

## Steps

1. Do not touch the mirror block in media/config.js

   Everything in this todo goes BELOW the `if (typeof acquireVsCodeApi !== 'function') { return; }` guard at media/config.js:118. `ROLES`, `LIMIT_BOUNDS`, `validateConfigForm` and the `window.baitonConfigForm` export (lines 30-113) stay byte-identical: validation keeps running against the AGENT-LEVEL `cap.efforts` union, so a saved effort belonging to another model is never rejected, and `test/configPanel.mirror.test.ts` keeps passing untouched (it evaluates the file with `window` as its only global — no `document`, no `acquireVsCodeApi` — so no DOM access may appear above the guard).

   Files: `media/config.js`

2. Teach syncSelectOptions to carry option text, comparing by value AND text

   Replace the body of `syncSelectOptions(selectEl, values)` (media/config.js:392-444) so `values` may hold either strings or `{ value, text }` objects. Add a module-private normaliser directly above it:

   ```js
   /** One dynamic option, from a plain id or a { value, text } pair. */
   function optionSpec(item) {
     if (item !== null && typeof item === 'object') {
       var value = String(item.value);
       return { value: value, text: item.text === undefined || item.text === null || item.text === '' ? value : String(item.text) };
     }
     var v = String(item);
     return { value: v, text: v };
   }
   ```

   In `syncSelectOptions`: build `var desired = (values || []).map(optionSpec);` (use an explicit `for` loop to match the file's ES5 idiom). Collect `current` as `{ value: child.value, text: child.textContent }` for every OPTION child WITHOUT `dataset.static` (unchanged predicate). The early return now fires only when `current.length === desired.length` AND every index matches on BOTH `value` and `text` — this is what keeps focus, an open dropdown and the caret intact across the render that runs on every keystroke, while still rebuilding when only a label changed. On rebuild, keep the existing sequence exactly: remember `previous = selectEl.value`, remove the non-static options, locate the `dataset.static === 'other'` option, `insertBefore` each new option with `opt.value = desired[i].value; opt.textContent = desired[i].text;`, then restore `previous` when an option with that value is still present. The agent select keeps passing plain strings and is unaffected.

   Files: `media/config.js`

3. Add the per-role option derivation helpers

   Insert these module-private helpers between `syncSelectOptions` and `renderOptionLists` in media/config.js. They are the single source of truth for what each role's two dropdowns contain, and BOTH `renderOptionLists()` and `renderValues()` call them, so the two passes can never disagree about the list a value is tested against.

   ```js
   /** The capability for an agent id, never undefined. */
   function capabilityFor(agent) {
     return (state.options.byAgent && state.options.byAgent[agent]) || { models: [], efforts: [] };
   }

   /**
    * The rich entries behind a capability's `models`: the host's `modelEntries`
    * (codex-opencode-dropdown-fix T06) when present, else one bare `{ id }` per
    * model so an older/leaner payload renders exactly as before.
    */
   function capabilityEntries(cap) {
     if (cap && Array.isArray(cap.modelEntries)) {
       return cap.modelEntries;
     }
     var models = (cap && cap.models) || [];
     var out = [];
     for (var i = 0; i < models.length; i++) {
       out.push({ id: models[i] });
     }
     return out;
   }

   /**
    * The dynamic model options for a capability: every entry EXCEPT the ones
    * marked `custom: true`, as `{ value: id, text: label || id }`. A custom entry
    * is a configured-but-unlisted value and is rendered through `Other…`, never
    * as an ordinary option.
    */
   function modelOptionsFor(cap) {
     var entries = capabilityEntries(cap);
     var out = [];
     for (var i = 0; i < entries.length; i++) {
       var e = entries[i];
       if (!e || typeof e.id !== 'string' || e.id === '' || e.custom === true) {
         continue;
       }
       out.push({ value: e.id, text: typeof e.label === 'string' && e.label !== '' ? e.label : e.id });
     }
     return out;
   }

   /** The entry describing one model id (first match, custom entries included), or undefined. */
   function modelEntryFor(cap, modelId) {
     var entries = capabilityEntries(cap);
     for (var i = 0; i < entries.length; i++) {
       if (entries[i] && entries[i].id === modelId) {
         return entries[i];
       }
     }
     return undefined;
   }

   /**
    * The dynamic effort options for a role: the SELECTED model's own levels when
    * its entry discloses them (Codex/Claude reasoning efforts, OpenCode variant
    * keys, an Antigravity family's levels) — including an explicitly EMPTY list,
    * which leaves only the static `(default)` and `Other…` options — else the
    * agent-level union.
    */
   function effortOptionsFor(cap, modelId) {
     var entry = modelEntryFor(cap, modelId);
     if (entry && Array.isArray(entry.efforts)) {
       return entry.efforts.slice();
     }
     return ((cap && cap.efforts) || []).slice();
   }

   /** The static `(default)` option's text: `(default: <effort>)` when the model declares one. */
   function defaultEffortText(cap, modelId) {
     var entry = modelEntryFor(cap, modelId);
     if (entry && typeof entry.defaultEffort === 'string' && entry.defaultEffort !== '') {
       return '(default: ' + entry.defaultEffort + ')';
     }
     return '(default)';
   }

   /** True when `value` is one of the rendered `{ value, text }` options. */
   function listedValue(options, value) {
     for (var i = 0; i < options.length; i++) {
       if (options[i].value === value) {
         return true;
       }
     }
     return false;
   }
   ```

   Files: `media/config.js`

4. Sync labelled model options, per-model effort options and the default-effort label in renderOptionLists

   In `renderOptionLists()` (media/config.js:447-482) keep the agent-select block verbatim (including the configured-agent append). Replace the two capability lines with:

   ```js
   var cap = capabilityFor(entry.agent);
   syncSelectOptions(document.getElementById('role-' + role + '-model-select'), modelOptionsFor(cap));
   var effortSelect = document.getElementById('role-' + role + '-effort-select');
   syncSelectOptions(effortSelect, effortOptionsFor(cap, entry.model));
   if (effortSelect) {
     for (var k = 0; k < effortSelect.children.length; k++) {
       if (effortSelect.children[k].dataset.static === 'default') {
         var wanted = defaultEffortText(cap, entry.model);
         if (effortSelect.children[k].textContent !== wanted) {
           effortSelect.children[k].textContent = wanted;
         }
         break;
       }
     }
   }
   ```

   The `modelLink` block below is unchanged: the documentation link stays visible for OpenCode whether the control is a dropdown or the free-text input. Because the effort options depend on `entry.model`, switching the model re-syncs the effort list on the very next `render()` (the model `change` handler already calls `render()`), and the static `(default)`/`Other…` options are never touched by the sync, so an `Other…` effort selection survives the re-sync. Update the function's doc comment to say the options now carry labels and per-model efforts.

   Files: `media/config.js`

5. Render values against the rendered option lists, so a custom entry lands in the Other… state

   In `renderValues()` (media/config.js:523-638) replace

   ```js
   var cap = (state.options.byAgent && state.options.byAgent[entry.agent]) || { models: [], efforts: [] };
   var models = cap.models || [];
   var efforts = cap.efforts || [];
   ```

   with

   ```js
   var cap = capabilityFor(entry.agent);
   var modelOptions = modelOptionsFor(cap);
   var effortOptions = effortOptionsFor(cap, entry.model);
   var agentEfforts = cap.efforts || [];
   ```

   Model block (lines 551-583), structure otherwise unchanged:
   - the free-text-only branch is now `if (modelOptions.length === 0)` — so OpenCode's model control is the plain text input ONLY while no list has arrived yet, and becomes the dropdown plus `Other…` as soon as a non-empty list lands, with no structural rebuild;
   - the sticky test becomes `var showInput = !!state.otherModel[role] || !listedValue(modelOptions, entry.model);`. A model that matches a `custom: true` entry is, by construction, absent from `modelOptions`, so it renders in the `Other…` state: the select shows `Other…`, the text input is visible, carries the value and stays editable. Everything else (the `!== active` guards, hiding and clearing the input in the non-Other branch) is untouched.

   Effort block (lines 585-616), structure otherwise unchanged:
   - the select-vs-free-text decision moves to the AGENT-LEVEL union: `if (agentEfforts.length === 0) { … free text … }`. This is what turns OpenCode's effort control into the same select plus `Other…` as the other agents once any of its models discloses variant keys, and keeps it a free-text input only while the union is empty. It also keeps the select visible for a model whose own list is empty (Claude Haiku with `thinking.type: none`, an Antigravity fixed id), which then offers only `(default)` and `Other…`;
   - the membership test uses the RENDERED list: `var showEffortInput = !!state.otherEffort[role] || !(entry.effort === '' || effortOptions.indexOf(entry.effort) !== -1);`. An effort valid for another model of the same agent therefore shows as an editable `Other…` value rather than silently snapping to `(default)`, while `validateConfigForm` (which still checks the agent-level union) raises no error for it.

   The limits/git tail of the function is unchanged.

   Files: `media/config.js`

6. Refresh the doc comments in media/config.js and media/config.html

   media/config.js: extend the `buildRoleRows()` comment to note that the static `(default)` option's TEXT is now rewritten per render from the selected model's `defaultEffort` (its value stays `''` and it keeps `data-static`, so the sync never removes it), and that dynamic model options carry a label as their text while their value is always the id. Add a short paragraph to the file header explaining that `modelEntries` — id, optional label, optional per-model `efforts`, optional `defaultEffort`, optional `custom` — is what the host now sends and that `custom: true` entries are rendered exclusively through `Other…`.

   media/config.html: no structural or CSS change is required — the markup is a static shell and every control involved is built by `buildRoleRows()`, the `.select-input-group`, `.doc-link` and `.stale-note` rules already cover the new states, and option text needs no styling. Update the top-of-file comment only, so it no longer implies the model control may be a free-text field for some agents: state that every agent renders a model dropdown plus `Other…` once a list exists, that the free-text input is the fallback shown only while the list is empty, and that the effort control follows the same rule against the agent-level union.

   Files: `media/config.js`, `media/config.html`

7. Extend the fake-DOM suite in test/configPanel.view.test.ts

   All new cases go in the existing `describe('config panel webview options refresh (model-selector-refresh T09)')` block (or a sibling `describe('config panel webview per-model options (codex-opencode-dropdown-fix T07)')` reusing the same helpers); the `ViewEl`/`loadConfigView()` machinery needs no change.

   Helpers to add next to `dynamicValues` (line 759):
   - `function dynamicOptions(select: ViewEl): { value: string; text: string }[]` — the non-static OPTIONs as value/text pairs;
   - `function staticOption(select: ViewEl, kind: 'default' | 'other'): ViewEl` — the option whose `dataset.static === kind`;
   - `function capsOptions(byAgent: Record<string, unknown>, agents: readonly string[]): ViewConfigFormOptions` — a thin builder so a test can hand in a capability carrying `modelEntries`. Type the capability values as `import('../src/config/configPanel').AgentFormCapability` so `modelEntries` type-checks (a bare inline literal with extra keys would trip tsc's excess-property check, as noted in T06).

   Cases:
   1. **custom entry renders as Other…** — `loaded` with `byAgent.claude = { models: ['claude-sonnet-5', 'my-model'], efforts: ['high'], modelEntries: [{ id: 'claude-sonnet-5' }, { id: 'my-model', custom: true }] }` and the executor role on `my-model`. Assert `dynamicValues(modelSelect)` is `['claude-sonnet-5']` (the custom id is NOT an ordinary option), `modelSelect.value === OTHER_SENTINEL`, the model input's `style.display !== 'none'` and its value is `my-model`; then fire an `input` event on that input with a new value and assert `posted` grows no `load`/`save` and the input keeps the typed text across a following `optionsChanged` with the same options (still editable).
   2. **labels are the option text, ids the values** — entries `[{ id: 'claude-opus-5-5', label: 'Opus 5.5' }]` → `dynamicOptions` is `[{ value: 'claude-opus-5-5', text: 'Opus 5.5' }]`; a refresh that changes only the label rebuilds the option text while `view.byId(...)` returns the SAME select node and the selection survives.
   3. **OpenCode: text input → dropdown** — first `loaded` with `byAgent.opencode = { models: [], efforts: [], modelLink: 'https://…' }` and every role on `opencode`: model select hidden, model input visible with the configured value, doc link visible. Then `optionsChanged` with `models: ['anthropic/claude-sonnet-5', 'openai/gpt-5']` and matching `modelEntries`: the select is now visible, the input hidden (the configured model is listed) or in the `Other…` state (when it is not), the doc link still visible, and the select node is the same object as before.
   4. **OpenCode effort: free text → select plus Other…** — same agent, first with `efforts: []` (effort select hidden, effort input visible), then `optionsChanged` with `efforts: ['low','high','max']` and `modelEntries: [{ id: 'anthropic/claude-sonnet-5', efforts: ['low','high','max'] }, { id: 'openai/gpt-5' }]`: effort select visible, `Other…` present as the last option, and `staticOption(effortSelect, 'default').textContent === '(default)'` (OpenCode declares no default variant).
   5. **Codex/Claude per-model efforts and the default label** — entries `[{ id: 'gpt-5-codex', efforts: ['low','medium','high'], defaultEffort: 'medium' }, { id: 'gpt-5', efforts: ['minimal','low'] }]` with agent-level `efforts: ['low','medium','high','minimal']`. With the role on `gpt-5-codex`: `dynamicValues(effortSelect)` is `['low','medium','high']` and the default option reads `(default: medium)`. Set the model select to `gpt-5` and fire `change`: `dynamicValues(effortSelect)` becomes `['minimal','low']` and the default option reads `(default)` again.
   6. **Antigravity families and fixed ids** — entries `[{ id: 'gemini-3.1-pro', efforts: ['low','high'] }, { id: 'claude-sonnet-4-6', efforts: [] }]` with agent-level `efforts: ['low','medium','high']`. On `gemini-3.1-pro`: dynamic efforts `['low','high']`. On `claude-sonnet-4-6`: the effort select is STILL visible (the agent union is non-empty), `dynamicValues(effortSelect)` is `[]`, and the only options left are the static `(default)` and `Other…`.
   7. **a model entry without an `efforts` key falls back to the agent union** — entry `{ id: 'openai/gpt-5' }` under an agent whose union is `['low','high']` → dynamic efforts `['low','high']`, so a hand-typed level stays reachable through `Other…`.
   8. **switching models does not reset an Other… effort** — select `Other…` in the effort select, type a value, then change the model select to another entry with different `efforts`; assert the effort input stays visible with its text and the effort select still reads `OTHER_SENTINEL`.
   9. **stale note still renders with rich entries** — reuse the existing stale assertions with a `modelEntries`-carrying capability, proving the badge path is untouched.

   Every existing case in the suite must keep passing unmodified: `viewOptions()` produces capabilities WITHOUT `modelEntries`, which `capabilityEntries` synthesises into bare `{ id }` entries, so the old value-only expectations still hold.

   Files: `test/configPanel.view.test.ts`

8. Confirm the validator mirror is untouched

   Leave `test/configPanel.mirror.test.ts` unedited unless a case is added. Optionally add one case asserting that a capability carrying `modelEntries` (with labels, per-model `efforts`, `defaultEffort` and a `custom: true` entry) produces byte-identical errors from the TypeScript `validateConfigForm` and the mirror — the same shape as the existing 'refresh metadata on a capability does not change validation in either implementation' test — which pins that per-model detail is render-only and never narrows validation. Do not add any DOM access above the `acquireVsCodeApi` guard, or 'the mirror block stays DOM-free' will fail.

   Files: `test/configPanel.mirror.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. `media/config.js` is a plain script that tsc does not typecheck, so the fake-DOM suite is the only compile-time guard on it — run the full suite, not just the two config-panel files. Expect the pre-existing lint warning in `src/orchestrator/webviewProtocol.ts:626` ('_legacy' assigned but never used) and no new ones; expect no failures and no change to the pending count (T06 left 2171 passing, 1 pending, 0 failing, plus the cases added here).

   Files: `media/config.js`, `test/configPanel.view.test.ts`, `test/configPanel.mirror.test.ts`

## Risks

- Widening `syncSelectOptions`' equality to include the option TEXT makes the early return fire less often. If a host payload's labels are not stable across refreshes, the option list is rebuilt on every render, which would drop an open dropdown and reset the select's scroll. Mitigation: the rebuild still restores the previously selected value, and `renderValues()` never writes to a focused control — assert node identity plus the surviving selection in test case 2.
- Choosing the effort control's shape (select vs. free text) from the AGENT-LEVEL union while filling it from the PER-MODEL list is deliberate but subtle: a model with `efforts: []` shows a select with only `(default)` and `Other…`. Getting this backwards (using the per-model list for the shape) would make Claude Haiku and Antigravity's fixed ids fall back to a free-text box. Test cases 4 and 6 pin both halves.
- The per-model effort list is narrower than the agent-level union, so a saved effort belonging to another model of the same agent now renders through `Other…` instead of as a selected option. That must NOT become a validation error: `validateConfigForm` (both copies) keeps checking the union only. Any edit that narrows the validator's `cap.efforts` lookup would silently break the round trip and the mirror parity test.
- `configFormOptions` still appends a configured-but-unlisted model to `models` as well as to `modelEntries`. The webview must derive its options from `modelEntries` alone — reading `cap.models` for the dropdown would resurrect the custom id as an ordinary option and defeat the todo.
- A capability with `modelEntries` present but shorter than `models` (or vice versa) would silently hide models. The helpers treat `modelEntries` as authoritative when it is an array; that matches T06, which always emits one entry per model, but it means a future host regression would show up as missing dropdown entries rather than a crash.
- `capabilityEntries` must accept a payload with no `modelEntries` key (every existing test fixture, and any older persisted state) and synthesise bare `{ id }` entries; forgetting the fallback breaks all nine pre-existing cases in the view suite at once.
- The static `(default)` option is identified by `dataset.static === 'default'`; rewriting its text must not clear its `value` (`''`) or its `data-static` marker, or `syncSelectOptions` would start deleting it on the next render.

## Acceptance

- A capability entry with `custom: true` is never rendered as an ordinary `<option>`; a role whose model matches one (or is absent from the list entirely) shows the select on `Other…` with the text input visible, carrying the value and still editable, and the sticky `state.otherModel` flag keeps it visible across an `optionsChanged` whose list contains the typed value.
- An entry's `label` is the option's text while its `value` stays the model id; an entry without a label renders id-as-text exactly as today.
- OpenCode renders the model free-text input only while its model list is empty and switches to the dropdown plus `Other…` as soon as a non-empty list arrives, in place, reusing the same select node, with the documentation link visible in both states.
- The effort control is a select plus `Other…` whenever the agent-level `efforts` union is non-empty and a free-text input only while that union is empty — for OpenCode exactly as for the other agents.
- The effort dropdown's dynamic options are the SELECTED model's own `efforts` when its entry carries that key (Codex/Claude reasoning levels, OpenCode variant keys, an Antigravity family's levels), and the agent-level union when it does not; an entry with an explicitly empty `efforts` list leaves only the static `(default)` and `Other…` options.
- The static default option reads `(default: <effort>)` when the selected model's entry carries `defaultEffort` and plain `(default)` otherwise, and it keeps `value === ''` and its `data-static` marker.
- Changing the model re-syncs the effort options on the next render without clearing an in-progress `Other…` effort or its text.
- `syncSelectOptions` still replaces only non-static options, in place, returns early when value AND text already match, restores the previous selection when it survives, and never writes to a focused control (`renderValues()`'s `!== active` guards intact).
- The stale note (`stale — showing last known models`, with `(last updated …)` and the reason as `title`) renders exactly as before, including with rich entries.
- `validateConfigForm` in both `src/config/configPanel.ts` and the `media/config.js` mirror block is unchanged and still validates efforts against the agent-level union; `test/configPanel.mirror.test.ts` passes, including 'the mirror block stays DOM-free'.
- Every pre-existing case in `test/configPanel.view.test.ts` passes unmodified against capabilities that carry no `modelEntries`.
- `npm run compile`, `npm run lint` (only the pre-existing `webviewProtocol.ts:626` warning) and `npm test` (0 failing) all pass.
