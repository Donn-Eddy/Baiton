# Plan T03

## Steps

1. Add contextWindow/maxOutput to ModelEntry and round-trip them through normalizeModelEntry (memento)

   In src/orchestrator/modelCatalog.ts:
   1. Extend `interface ModelEntry` with two optional readonly fields, placed after `defaultEffort` and before `custom`, with doc comments in the existing style:
      `/** The model's total context window in tokens, when the source discloses it (models.dev `limit.context`). */ readonly contextWindow?: number;`
      `/** The model's maximum output tokens, when the source discloses it (models.dev `limit.output`). */ readonly maxOutput?: number;`
      Update the interface's JSDoc paragraph to mention that `contextWindow`/`maxOutput` are carried only from the models.dev feed; other sources leave them undefined.
   2. Add a private helper beside `optionalString`/`optionalStringArray`:
      ```ts
      /** An unknown value as a positive finite integer token count, or undefined. */
      function optionalTokenCount(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
      }
      ```
   3. In `normalizeModelEntry`, widen the local `entry` type literal to include `contextWindow?: number; maxOutput?: number;` and, after the `defaultEffort` block and before the `custom` block, add conditional-own-key reads:
      ```ts
      const contextWindow = optionalTokenCount(raw['contextWindow']);
      if (contextWindow !== undefined) { entry.contextWindow = contextWindow; }
      const maxOutput = optionalTokenCount(raw['maxOutput']);
      if (maxOutput !== undefined) { entry.maxOutput = maxOutput; }
      ```
      (Never write an explicit `undefined` own key.) Because `CatalogStore.hydrateSnapshot` rebuilds every model through `normalizeModelEntry`, and `persist()` writes the snapshots (entries as-is) into the blob, this alone makes the memento round-trip the two fields. Do NOT bump `MODEL_CATALOG_PERSIST_VERSION` — old blobs without the fields must still load (backward compatible), and new fields in an old reader are simply dropped by its normalizer.
      Nothing else in modelCatalog.ts needs to change (`mergePreservingExisting` copies entries by reference; custom entries have no limits).

   Files: `src/orchestrator/modelCatalog.ts`

2. Add a pure feed-limits → entry-fields helper in modelsDev.ts

   In src/orchestrator/modelsDev.ts, add an exported pure helper next to the `FeedModelLimits` / parser section (e.g. just after `parseModelsDevFeed`, under a `// --- entry projection ---` comment):
   ```ts
   /**
    * The context/output limits of a feed model as the optional `ModelEntry`
    * fields `contextWindow` / `maxOutput`: each key present only when the feed
    * disclosed a positive integer for it (conditional own keys, never an explicit
    * `undefined`). `{}` when the model has no usable limits. Pure.
    */
   export function feedModelLimitFields(model: FeedModel): { contextWindow?: number; maxOutput?: number } {
     const fields: { contextWindow?: number; maxOutput?: number } = {};
     const context = model.limits?.context;
     if (context !== undefined && Number.isInteger(context) && context > 0) {
       fields.contextWindow = context;
     }
     const output = model.limits?.output;
     if (output !== undefined && Number.isInteger(output) && output > 0) {
       fields.maxOutput = output;
     }
     return fields;
   }
   ```
   Do not import from modelCatalog.ts (keep the return type structural so there is no new import cycle; modelsDev.ts stays host-free). Leave `parseFeedModel` unchanged — it already parses `limit.context`/`limit.output` into `limits`.

   Files: `src/orchestrator/modelsDev.ts`

3. Carry limits onto models.dev entries in discovery

   In src/activation/modelDiscovery.ts, import `feedModelLimitFields` from '../orchestrator/modelsDev' (add it to the existing import of `ModelsDevFeed` from that module, keeping `type` imports as they are). In the private `feedCatalogFetch(feed)` change the pushed entry to:
   ```ts
   models.push({
     id: model.id,
     provider: provider.id,
     ...(model.name !== model.id ? { label: model.name } : {}),
     ...feedModelLimitFields(model),
   });
   ```
   Update the function's JSDoc: 'plus `contextWindow`/`maxOutput` from the feed's `limit` block when disclosed'.

   Files: `src/activation/modelDiscovery.ts`

4. Carry limits onto the Claude adapter's feed-fallback entries

   In src/adapter/claude.ts, import `feedModelLimitFields` from '../orchestrator/modelsDev' (alongside the existing `ModelsDevFeed`/`parseModelsDevFeed`/`fetchModelsDev` imports from that module). In `claudeModelsFromFeed`, widen the entry literal type to `{ id: string; label?: string; provider: string; contextWindow?: number; maxOutput?: number }` and after the label assignment add:
   ```ts
   const limits = feedModelLimitFields(model);
   if (limits.contextWindow !== undefined) { entry.contextWindow = limits.contextWindow; }
   if (limits.maxOutput !== undefined) { entry.maxOutput = limits.maxOutput; }
   ```
   Update the JSDoc sentence 'always `{ id, provider }`, plus `label` only when …' to add 'plus `contextWindow`/`maxOutput` when the feed discloses positive integer limits'. `claudeModelsFromCatalog` (local CLI catalog leg) is NOT changed — that source leaves the fields undefined. Other adapters (codex, opencode, antigravity) are untouched.

   Files: `src/adapter/claude.ts`

5. Create host-free src/orchestrator/contextBudget.ts with resolveContextWindow

   New file src/orchestrator/contextBudget.ts. Header JSDoc in the style of modelCatalog.ts: 'The chat orchestrator's context budget (host-free core). … carries no `vscode` import …'. Contents for this todo (later todos will add estimateTokens/ContextTracker here, so keep it focused):
   ```ts
   import type { ModelEntry } from './modelCatalog';

   /** The `baiton.orchestrator.contextWindow` setting key (0 = unset). */
   export const CONTEXT_WINDOW_SETTING = 'baiton.orchestrator.contextWindow';

   /**
    * The selected model's context window in tokens: the catalog entry's
    * `contextWindow` first, else the user's `baiton.orchestrator.contextWindow`
    * setting, else `undefined` (unknown). A value counts only when it is a
    * positive finite integer — `0` (the setting's default), negatives,
    * fractions, NaN/Infinity, strings and other shapes are "unset". Pure; never throws.
    */
   export function resolveContextWindow(entry: ModelEntry | undefined, configured: unknown): number | undefined {
     const fromCatalog = positiveInteger(entry?.contextWindow);
     if (fromCatalog !== undefined) {
       return fromCatalog;
     }
     return positiveInteger(configured);
   }

   /** `value` when a positive finite integer, else undefined. */
   function positiveInteger(value: unknown): number | undefined {
     return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
   }
   ```
   (Mirror `resolveMaxTokens` in src/orchestrator/modelClient.ts for the validation rule.) Only a type import of ModelEntry — no runtime import, no `vscode`.

   Files: `src/orchestrator/contextBudget.ts`

6. Contribute the baiton.orchestrator.contextWindow setting

   In package.json `contributes.configuration.properties`, add after `baiton.orchestrator.maxTokens` (before `baiton.orchestrator.roundBound`):
   ```json
   "baiton.orchestrator.contextWindow": {
     "type": "integer",
     "default": 0,
     "minimum": 0,
     "description": "Context window, in tokens, of the orchestrator's selected model, used only when the model catalog (models.dev) does not disclose one. 0 (the default) leaves it unset, so the context window is unknown unless the catalog knows it."
   }
   ```
   Keep valid JSON (commas). No code reads it yet beyond `resolveContextWindow`'s `configured` argument; wiring into the controller is a later todo.

   Files: `package.json`

7. Tests: modelCatalog normalize + memento round-trip

   In test/modelCatalog.test.ts:
   - Under `describe('normalizeModelEntry')` add `it('keeps contextWindow/maxOutput only when positive integers')`: `normalizeModelEntry({ id: 'm', contextWindow: 200000, maxOutput: 64000 })` deepStrictEquals `{ id: 'm', contextWindow: 200000, maxOutput: 64000 }`; for each field and each bad value in `[0, -1, 1.5, NaN, Infinity, '200000', null]` the result deepStrictEquals `{ id: 'm' }` (no own key).
   - Under `describe('CatalogStore persistence')` add a round-trip test using the file's existing fake memento helper: `applyResult('models.dev', ok({ models: [{ id: 'a', provider: 'p', contextWindow: 1048576, maxOutput: 65536 }, { id: 'b', provider: 'p' }] }))`, then construct a new `CatalogStore` over the same memento and assert `get('models.dev')?.models` deepStrictEquals the same two entries (b has no limit own keys) and `source === 'cached'`. Also assert an old-shape blob (version 1, entries without the fields) still hydrates unchanged.

   Files: `test/modelCatalog.test.ts`

8. Tests: feedModelLimitFields

   In test/modelsDev.test.ts add a `describe('feedModelLimitFields')` block (import it from '../src/orchestrator/modelsDev'):
   - a FeedModel with `limits: { context: 200000, output: 64000 }` → `{ contextWindow: 200000, maxOutput: 64000 }`;
   - only `output` → `{ maxOutput: … }` with no `contextWindow` own key (use `Object.prototype.hasOwnProperty.call`);
   - no `limits` → `{}`;
   - `context: 0` / `context: 1.5` → no `contextWindow` key;
   - parse the fixture (test/fixtures/modelsDev.sample.json, read untyped as the file already does) and assert the anthropic `claude-opus-5-5` model yields `{ contextWindow: 200000, maxOutput: 64000 }` (verify the exact numbers against the fixture's first `limit` block, line ~17).

   Files: `test/modelsDev.test.ts`

9. Tests: discovery carries limits and the memento round-trips them

   In test/modelDiscovery.test.ts add `it('carries models.dev limits onto every feed entry as contextWindow/maxOutput and persists them')`: build a `ModelDiscoveryService` with `makeStore(fakeMemento())`, `fakeRegistry({})`, `feedSpy(fakeFeed()).fetchFeed`; `await service.refresh()`; compute expected per feed model as `{ contextWindow: model.limits?.context, maxOutput: model.limits?.output }` (only positive integers, conditional keys) and assert each `table['models.dev'].models[i]` matches on those two fields and has NO own key when the feed model had no limit. Then construct a second service over the SAME memento and assert `second.table()['models.dev']?.models` deepStrictEquals the first table's models (limits survive rehydration) and `source === 'cached'`. Keep the existing 'stores bare feed model ids …' test unchanged (it projects only id/provider).
   In test/adapter.claude.test.ts (existing `describe('claudeModelsFromFeed …')`), add one test: fixture entries carry `contextWindow`/`maxOutput` equal to the fixture's `limit` values, and `providerOf(...)` synthetic models (no limits) carry neither own key. Update the existing assertion loop that checks `efforts`/`defaultEffort`/`custom` own keys are absent — it stays valid. (This file is outside the todo's listed files but is the existing home of claudeModelsFromFeed's tests; if the executor must stay strictly in the listed files, put this test in test/modelDiscovery.test.ts instead, importing claudeModelsFromFeed from '../src/adapter/claude'.)

   Files: `test/modelDiscovery.test.ts`, `test/adapter.claude.test.ts`

10. Tests: resolveContextWindow and host-free check

   New test/contextBudget.test.ts (mocha, `import * as assert from 'assert'`, same style as test/modelCatalog.test.ts):
   - catalog wins: `resolveContextWindow({ id: 'm', contextWindow: 200000 }, 64000) === 200000`;
   - setting fallback: `resolveContextWindow({ id: 'm' }, 64000) === 64000`; `resolveContextWindow(undefined, 131072) === 131072`;
   - unknown: `resolveContextWindow(undefined, 0)`, `resolveContextWindow({ id: 'm' }, undefined)`, and for configured in `[0, -5, 1.5, NaN, Infinity, '64000', null, {}]` → `undefined`;
   - a bad catalog value falls through to the setting: `resolveContextWindow({ id: 'm', contextWindow: 0 }, 32000) === 32000`;
   - `CONTEXT_WINDOW_SETTING === 'baiton.orchestrator.contextWindow'` and package.json (read via fs + JSON.parse) contributes that key with `type: 'integer'`, `default: 0`;
   - host-free: read src/orchestrator/contextBudget.ts and assert no `from '...vscode'` / `require(...vscode` (copy the pattern from modelCatalog.test.ts 'host-free').

   Files: `test/contextBudget.test.ts`

11. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. If any existing test deep-compares feed-derived ModelEntry objects (e.g. models.dev snapshots or claude feed-leg `modelEntries` in test/modelSelectorRefresh.test.ts, test/providerRouter.test.ts, test/providers.test.ts, test/setEndpoint.test.ts) and now fails because entries gained `contextWindow`/`maxOutput`, update that expectation to include the fixture's limits rather than stripping the fields from production code. Confirm the webview projections (`formModelEntry` in src/config/configPanel.ts and the `setProviders` mapping in src/activation/chatController.ts) still project only id/label/efforts/defaultEffort/custom — no change needed there.

   Files: (none)

## Risks

- Existing deepStrictEqual assertions on feed-derived entries (models.dev snapshots, the claude feed leg's modelEntries in test/modelSelectorRefresh.test.ts, helpers like snapshotFromFeed in test/providerRouter.test.ts) may fail once entries carry the new fields; fix expectations, not production code.
- Bumping MODEL_CATALOG_PERSIST_VERSION would discard every user's cached catalog — do not bump it; the additive optional fields are backward compatible through normalizeModelEntry.
- claudeModelsFromFeed's tests live in test/adapter.claude.test.ts, which is not in the todo's file list; either touch it (small, additive) or place the claude-feed limit test in test/modelDiscovery.test.ts.
- Import cycle: modelsDev.ts must not import modelCatalog.ts for the helper's return type; keep it structural. contextBudget.ts uses only `import type` from modelCatalog.
- Validation drift: normalizeModelEntry, feedModelLimitFields and resolveContextWindow must all treat only positive integers as valid; a 0/fractional feed value must not become a window of 0.

## Acceptance

- ModelEntry has optional readonly contextWindow and maxOutput; normalizeModelEntry keeps them only when positive integers and never emits explicit undefined keys.
- A CatalogStore snapshot containing entries with contextWindow/maxOutput persists to the memento and rehydrates with the same values; old blobs without the fields still load; MODEL_CATALOG_PERSIST_VERSION is unchanged at 1.
- Every models.dev entry produced by ModelDiscoveryService (feedCatalogFetch) and by claudeModelsFromFeed carries contextWindow/maxOutput from the feed's limit.context/limit.output when disclosed; claudeModelsFromCatalog, codex, opencode and antigravity entries do not.
- src/orchestrator/contextBudget.ts exists, has no vscode import, and exports resolveContextWindow(entry, configured) returning catalog contextWindow first, then a positive-integer setting, else undefined.
- package.json contributes baiton.orchestrator.contextWindow (integer, default 0, minimum 0).
- New tests in test/modelCatalog.test.ts, test/modelsDev.test.ts, test/modelDiscovery.test.ts and test/contextBudget.test.ts pass.
- npm run compile, npm run lint and npm test are all green.
