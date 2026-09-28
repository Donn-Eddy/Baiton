# Plan T06

## Steps

1. Declare the local per-model entry type on AgentFormCapability

   In `src/config/configPanel.ts`, above `interface AgentFormCapability`, add an exported interface `FormModelEntry` that mirrors `ModelEntry` from `src/orchestrator/modelCatalog.ts` WITHOUT importing it (this module must stay import-free of adapter/orchestrator code, as its header comment states):

   ```ts
   /**
    * One model behind `AgentFormCapability.models`, as the webview receives it
    * (codex-opencode-dropdown-fix T06). Structurally a subset of `ModelEntry`
    * from `src/orchestrator/modelCatalog`, declared locally to keep this module
    * import-free of adapter/orchestrator code. `provider` is deliberately NOT
    * mirrored: only ids, labels and effort names cross to the webview.
    */
   export interface FormModelEntry {
     /** The model id itself, exactly as written into configuration. */
     readonly id: string;
     /** Human label shown as the option text; absent when the id is the label. */
     readonly label?: string;
     /** This model's own reasoning levels, when the source discloses them. */
     readonly efforts?: readonly string[];
     /** This model's default reasoning level, when the source discloses it. */
     readonly defaultEffort?: string;
     /** True when this entry came from user configuration, not from the list; rendered as "Other…". */
     readonly custom?: boolean;
   }
   ```

   Then add to `AgentFormCapability`, directly after `modelLink`:

   ```ts
     /**
      * Rich per-model detail behind `models` — same order and length as `models`
      * when present, absent when `models` is empty. `custom: true` marks a value
      * that came from the configuration rather than the list.
      */
     readonly modelEntries?: readonly FormModelEntry[];
   ```

   No other member changes. `AgentCapabilities.modelEntries` (`readonly ModelEntry[]`, `src/adapter/adapter.ts:87`) stays structurally assignable to this because excess-property checking does not apply to non-literal values, so `configFormOptions(ids, agentCapabilities(), form)` in the controller still type-checks unchanged.

   Files: `src/config/configPanel.ts`

2. Carry and synthesise modelEntries in configFormOptions, marking appended values custom

   In `src/config/configPanel.ts`, `configFormOptions` (currently lines 152-219):

   1. Widen the local `byAgent` builder value type with `modelEntries: FormModelEntry[]` (mutable, always present while building; removed at the end when empty).
   2. Add a module-private pure helper next to `asString`/`asFormNumber`:

   ```ts
   /** One capability model entry as the form carries it: id, label, efforts, defaultEffort, custom — nothing else. */
   function formModelEntry(entry: FormModelEntry): FormModelEntry {
     return {
       id: entry.id,
       ...(entry.label !== undefined ? { label: entry.label } : {}),
       ...(entry.efforts !== undefined ? { efforts: [...entry.efforts] } : {}),
       ...(entry.defaultEffort !== undefined ? { defaultEffort: entry.defaultEffort } : {}),
       ...(entry.custom !== undefined ? { custom: entry.custom } : {}),
     };
   }
   ```

   It copies CONDITIONALLY (never an explicit `undefined` own key, matching the existing metadata-copy style), copies `efforts` into a fresh array so mutating the result cannot disturb the capability table, and drops `provider` and any other key so only ids, labels and effort names reach the webview.

   3. In the `if (capabilities)` branch, seed the entries from the capability, falling back to one bare `{ id }` per model when the capability carries none:

   ```ts
         const entries: FormModelEntry[] =
           cap.modelEntries !== undefined
             ? cap.modelEntries.map(formModelEntry)
             : cap.models.map((id) => ({ id }));
         byAgent[agent] = {
           models: [...cap.models],
           efforts: [...cap.efforts],
           modelEntries: entries,
           ... // the existing conditional modelLink/source/stale/staleReason/fetchedAt spreads, unchanged
         };
   ```

   In the `else` branch (no capabilities) and in the `if (!byAgent[trimmedAgent])` branch inside the form loop, the seed becomes `{ models: [], efforts: [], modelEntries: [] }`.

   4. In the form loop, when a form model is appended, append the matching custom entry in the same `if`, so `modelEntries` stays parallel to `models` by construction:

   ```ts
           if (cap.models.length > 0 && trimmedModel !== '' && !cap.models.includes(trimmedModel)) {
             cap.models.push(trimmedModel);
             cap.modelEntries.push({ id: trimmedModel, custom: true });
           }
   ```

   The existing guard already implements the `mergePreservingExisting` rules (`src/orchestrator/modelCatalog.ts:238`): trim; skip blank; skip a value already in the list; skip a duplicate across roles (the previous role's push put it in `cap.models`); refreshed ids keep their order first and configured ones land last. Do NOT change the guard, and do NOT touch the effort append below it — out-of-set efforts keep going into `efforts` only, exactly as today.

   5. After the form loop and before `return { agents, byAgent }`, normalise so an agent with no models carries no `modelEntries` own key at all (mirroring `capabilitiesFromEntries`, which sets `modelEntries` only for non-empty entries, and keeping the `{ models: [], efforts: [] }` shape that existing tests deep-compare):

   ```ts
     for (const cap of Object.values(byAgent)) {
       if (cap.modelEntries.length === 0) {
         delete (cap as { modelEntries?: FormModelEntry[] }).modelEntries;
       }
     }
   ```

   6. Update the `configFormOptions` doc comment to say that `modelEntries` is copied through (or synthesised as bare ids) and that a configured-but-unlisted model is appended both to `models` and to `modelEntries` as `{ id, custom: true }`.

   Do NOT change `models`, `efforts`, `agents`, `validateConfigForm`, `agentStaleness`, `formFromConfig`, `formFromDocument` or `applyFormToDocument`. `models` must keep containing the custom id so host-side re-validation, `media/config.js`'s mirror validator and the round-trip tests stay unchanged.

   Files: `src/config/configPanel.ts`

3. Keep the curated modelEntries when an empty snapshot overlays a capability

   In `src/adapter/index.ts`, `overlayCapabilities` (lines 292-340): the `modelIds(effective).length === 0` branch rebuilds the capability from `builtin.models`/`builtin.efforts`/`builtin.modelLink` but drops `builtin.modelEntries`, so an antigravity refresh that fails or returns nothing loses the curated per-family effort lists that `builtinAgentCapabilities().antigravity.modelEntries` carries — exactly the case the config panel must still render as per-family dropdowns.

   Add `modelEntries?: readonly ModelEntry[];` to the `empty` object's local type annotation and, beside the existing `builtin.modelLink` guard, copy it conditionally:

   ```ts
       if (builtin.modelEntries !== undefined) {
         empty.modelEntries = [...builtin.modelEntries];
       }
   ```

   Conditional so codex/claude/opencode (whose builtins carry none) keep exactly their current key set — `test/adapter.index.test.ts` asserts `hasOwnProperty(codex, 'modelEntries') === false` on the empty-codex-snapshot path and that assertion must keep passing. Update the `overlayCapabilities` doc comment where it says "the builtin models/efforts/modelLink stay (no `modelEntries`)" to state that the builtin's own `modelEntries` are carried through when it has them (antigravity), and that an agent with no curated entries still carries none.

   Nothing else in this file changes: `agentCapabilities`, `builtinAgentCapabilities`, `antigravityBuiltinEntries` and the non-empty `capabilitiesFromEntries` path are untouched.

   Files: `src/adapter/index.ts`

4. Document the richer options in the controller (no behaviour change)

   `src/activation/configPanelController.ts` needs no code change: `currentCapabilities()` already resolves `getCapabilities()` → `capabilities` → `agentCapabilities()` on every use, and `load()` (line 272) and `refreshOptions()` (line 184) already pass the live table plus `this.form` into `configFormOptions`, so the richer `byAgent[...].modelEntries` flows into both the `loaded` and the `optionsChanged` payloads automatically.

   Extend the module header comment (lines 12-21), which already explains why `form` is passed into `configFormOptions`, with one sentence: the same round-trip pass is what marks a configured-but-unlisted model `custom: true` in `modelEntries`, so the webview can render it as an editable "Other…" entry instead of an ordinary option. Make no other edit to this file.

   Files: `src/activation/configPanelController.ts`

5. Update and extend the configFormOptions unit tests

   `test/configPanel.test.ts`:

   (a) Fix the two existing assertions that pin the exact key set, which now legitimately gains `modelEntries`:
   - `describe('configFormOptions')` → `'with no form, returns installed agents and clones capabilities into byAgent'` (~line 306): the per-agent `assert.deepStrictEqual(result.byAgent[agent], {...})` must add `...(CAPABILITIES[agent].models.length > 0 ? { modelEntries: expectedEntries(agent) } : {})`, where `expectedEntries(agent)` is `CAPABILITIES[agent].modelEntries` mapped to `{ id, label?, efforts?, defaultEffort?, custom? }` when present (antigravity's curated table has them) and `CAPABILITIES[agent].models.map((id) => ({ id }))` otherwise (claude, codex). opencode's builtin has no models, so its expected entry keeps exactly `{ models: [], efforts: [], modelLink }`.
   - `'a capability without the metadata yields an entry with exactly the old keys'` (~line 546): the final assertion becomes `assert.deepStrictEqual(keys.sort(), ['efforts', 'models', 'modelEntries'].sort())`; the loop asserting `source`/`stale`/`staleReason`/`fetchedAt` are absent stays as is.
   - `'configFormOptions copies source/stale/staleReason/fetchedAt alongside models/efforts/modelLink'` (~line 523): the expected object gains `modelEntries: [{ id: 'claude-opus-5-5' }]`.

   (b) Leave `'with no capabilities provided, initializes empty byAgent for installed agents'` and `'appends an unknown agent to agents and creates empty byAgent entry for it'` asserting `{ models: [], efforts: [] }` — they are the regression guard for the empty-entries normalisation.

   (c) Add a new `describe('configFormOptions modelEntries (codex-opencode-dropdown-fix T06)')` with cases:
   - copies a capability's entries verbatim minus `provider`: input capability `{ models: ['a','b'], efforts: ['low','high'], modelEntries: [{ id: 'a', label: 'A', efforts: ['low','high'], defaultEffort: 'high', provider: 'p' }, { id: 'b' }] }` yields `byAgent.x.modelEntries` deep-equal to `[{ id: 'a', label: 'A', efforts: ['low','high'], defaultEffort: 'high' }, { id: 'b' }]`, and `hasOwnProperty(entries[0], 'provider') === false`.
   - synthesises bare `{ id }` entries when the capability carries none: `{ models: ['m1','m2'], efforts: [] }` yields `[{ id: 'm1' }, { id: 'm2' }]`.
   - appends a configured-but-unlisted model as `{ id, custom: true }` at the END, with `models` and `modelEntries` the same length and in the same id order, and with the refreshed entries still first.
   - never duplicates: the same custom model set on two roles appends exactly one entry; a configured model already in the list appends nothing and the existing entry keeps its label/efforts and has no `custom` key; a blank/whitespace-only model appends nothing.
   - an out-of-set EFFORT is still appended to `efforts` only and adds no entry (the existing effort behaviour is unchanged).
   - an agent whose capability has no models (opencode's builtin, and the form-appended unknown agent) carries no `modelEntries` own key.
   - mutating `result.byAgent[x].modelEntries` and `...modelEntries[0].efforts` does not disturb the input capability (fresh arrays).
   - the round-trip case: with a configured `claude-opus-5` dropped by a refresh, `validateConfigForm(form, result)` is still `[]` and `result.byAgent.claude.models` still contains `claude-opus-5` — i.e. validation and `models` are unchanged by this todo.

   Files: `test/configPanel.test.ts`

6. Cover the curated modelEntries surviving an empty overlay

   `test/adapter.index.test.ts`, in `describe('agentCapabilities snapshot overlay')`: extend the existing `'an empty antigravity snapshot keeps the curated list with the snapshot metadata'` case (or add one beside it) to assert that the curated per-family detail survives:

   ```ts
       assert.deepStrictEqual(
         antigravity.modelEntries?.map((entry) => entry.id),
         Object.keys(ANTIGRAVITY_MODELS),
       );
       for (const entry of antigravity.modelEntries ?? []) {
         assert.deepStrictEqual([...(entry.efforts ?? [])], ANTIGRAVITY_MODELS[entry.id], entry.id);
       }
   ```

   and assert the array is a fresh copy (`assert.notStrictEqual(antigravity.modelEntries, builtinAgentCapabilities().antigravity.modelEntries)`).

   Leave `'an empty refreshed list never wipes the curated list'` (codex) exactly as it is: its `hasOwnProperty(codex, 'modelEntries') === false` assertion is the guard that the copy stays conditional.

   Files: `test/adapter.index.test.ts`

7. Cover the richer options reaching loaded and optionsChanged

   `test/configPanel.controller.test.ts`, inside `describe('9. live capabilities and optionsChanged (model-selector-refresh T08)')`, using the existing `makeCapabilitySource`, `RecordingWebview`, `loadedMessages` and `optionsChanged` helpers:

   - `'loaded carries modelEntries from the live capability table'`: capabilities `{ claude: { models: ['m-listed'], efforts: ['low','high'], modelEntries: [{ id: 'm-listed', label: 'Listed', efforts: ['low','high'], defaultEffort: 'high' }] } }`, config on disk with `roles.planner.model = 'm-listed'`; assert `loadedMessages(webview)[0].options.byAgent.claude.modelEntries` deep-equals the entry list (label, efforts, defaultEffort intact).
   - `'a configured model missing from the list arrives as a custom entry'`: same source but the config's planner model is `m-configured`; assert the last `modelEntries` element is `{ id: 'm-configured', custom: true }`, that `models` ends with the same id, and that the listed entry is untouched.
   - `'optionsChanged carries the refreshed modelEntries'`: after `source.set(...)` with a new entry list and `source.fire()`, assert `optionsChanged(webview)[0].options.byAgent.claude.modelEntries` reflects the new list and still ends with the configured-but-unlisted `{ id, custom: true }` entry (proving `refreshOptions()` re-applies the round-trip append against `this.form`).
   - Optionally assert `JSON.parse(JSON.stringify(options))` round-trips the entries unchanged (the payload really is postMessage-safe) and that no entry carries a `provider` key.

   No production change is needed in the controller for these to pass; they are the regression guard that the seam stays wired.

   Files: `test/configPanel.controller.test.ts`

8. Verify

   Run `npm run compile` (tsc), `npm run lint`, and `npm test`. All pre-existing suites must stay green — in particular `test/configPanel.mirror.test.ts` (untouched, because `validateConfigForm` and `media/config.js` are not edited by this todo), `test/configPanel.view.test.ts`, `test/modelSelectorRefresh.test.ts`, `test/adapter.claude.test.ts`, `test/adapter.codex.test.ts`, `test/adapter.opencode.test.ts` and `test/adapter.antigravity.test.ts`. If a suite outside the six files above fails on a key-set deep-equal over `byAgent`, that is this change surfacing — fix the expectation, not the production rule.

   Files: (none)

## Risks

- Several existing tests deep-compare a whole `byAgent[agent]` object or its exact key list; adding `modelEntries` breaks them until the three assertions named in the test step are updated. Search for `deepStrictEqual` over `byAgent` before assuming a failure is a real regression.
- Emitting `modelEntries: []` for an agent with no models would break `'with no capabilities provided, initializes empty byAgent for installed agents'` and the unknown-agent case. The end-of-function normalisation that deletes the empty array is load-bearing.
- `AgentCapabilities.modelEntries` is `readonly ModelEntry[]`, which has an extra `provider` member. It stays assignable to `readonly FormModelEntry[]` only because excess-property checking does not apply to non-literal values; a test that passes an inline capability literal with `provider` into `configFormOptions` WILL be rejected by tsc, so such fixtures must be built through a typed variable (or `FormModelEntry` must not be widened to forbid it).
- `formModelEntry` must copy `efforts` into a new array: the capability table handed in by `getCapabilities()` is rebuilt per call today, but a caller holding a static `capabilities` table would otherwise share the array with the webview payload.
- Copying `builtin.modelEntries` unconditionally in `overlayCapabilities`'s empty branch would add a `modelEntries` key to codex/claude/opencode and fail `test/adapter.index.test.ts`'s `hasOwnProperty` guard; the copy must be conditional.
- The webview (`media/config.js`) does not read `modelEntries` yet (that is a later todo). This change must therefore be render-neutral: `models`, `efforts`, `agents` and `validateConfigForm` stay byte-identical in behaviour, and the extra field is simply ignored by the current script.

## Acceptance

- `AgentFormCapability` carries an optional `modelEntries: readonly FormModelEntry[]` with `id`, optional `label`, `efforts`, `defaultEffort` and `custom`, declared locally in `src/config/configPanel.ts` with no adapter/orchestrator import added to that module.
- `configFormOptions` copies a capability's `modelEntries` (conditionally, dropping `provider` and never writing an explicit `undefined` own key) and synthesises `{ id }` per model when the capability carries none; an agent with no models carries no `modelEntries` own key.
- A configured-but-unlisted model is appended to `models` AND to `modelEntries` as `{ id, custom: true }`, last, following the `mergePreservingExisting` rules (trimmed; blank, duplicate and already-present values skipped); `models` and `modelEntries` are the same length and in the same id order for every agent with at least one model.
- `models`, `efforts`, `agents`, `validateConfigForm`, `agentStaleness` and the config round-trip are behaviourally unchanged; `test/configPanel.mirror.test.ts` passes with `media/config.js` untouched.
- `overlayCapabilities` keeps the builtin's `modelEntries` when a refreshed list is empty (antigravity's curated per-family efforts survive a failed refresh) and still emits no `modelEntries` key for a builtin that has none (codex).
- `loaded` and `optionsChanged` both carry the richer `byAgent[...].modelEntries`, including the `custom: true` entry for a configured-but-unlisted model, with no controller behaviour change.
- `npm run compile`, `npm run lint` and `npm test` all pass, with the new unit cases in `test/configPanel.test.ts`, `test/configPanel.controller.test.ts` and `test/adapter.index.test.ts` covering the entry copy, the custom append, the empty-entries normalisation and the curated-entries overlay.
