# Plan T08

## Steps

1. Extend the end-to-end harness in test/modelSelectorRefresh.test.ts so every corrected source can be driven

   All work in this step is inside the existing `describe('model selector refresh (T15 end to end)')` shared-harness region (roughly lines 108-476), and MUST keep every default behaving exactly as today so no existing case changes.

   1. `HarnessMode` gains five fields, with defaults chosen so today's cases are untouched:
      - `codex: 'ok' | 'fail' | 'hang' | 'data' | 'paged' | 'malformed'` (widen the existing field; default stays `'ok'`).
      - `claudeCatalog: 'missing' | 'ok' | 'malformed' | 'hang'` — default `'missing'` (today's injected `readLocalCatalog: async () => undefined`).
      - `opencodeCli: 'empty' | 'ok' | 'fail'` — default `'empty'` (today's `runModelsCli: async () => undefined`).
      - `agy: 'fail' | 'ok'` — default `'fail'` (today's antigravity stub resolving `undefined`).
      Update `buildDiscovery`'s `mode` literal with the three new defaults and widen its `Partial<HarnessMode>` option as usual.

   2. Fixture readers next to `fixtureFeed()`, each re-reading/re-parsing per call so no test can mutate another's data:
      - `function claudeCatalogFixture(): unknown` — `JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claudeModelCatalog.sample.json'), 'utf8'))`.
      - `function opencodeVerboseFixture(): string` — read `test/fixtures/opencodeModelsVerbose.sample.txt`.
      - `function agyModelsFixture(): string` — read `test/fixtures/agyModels.sample.txt`.
      - `const MALFORMED_CLAUDE_CATALOG = { version: 2, catalog: { surface: 'zed', config: { models: [{ id: 'claude-x' }] } } }` (a non-`cc` surface, which `claudeModelsFromCatalog` rejects to `[]`).

   3. Codex app-server payloads: keep `CODEX_PAYLOAD` byte-identical (it is what every existing case asserts) and add
      - `CODEX_DATA_PAYLOAD = { data: [ { model: 'gpt-6-astra', id: 'ignored-astra-id', displayName: 'GPT-6 Astra', hidden: false, supportedReasoningEfforts: [ { reasoningEffort: 'low', description: 'l' }, { reasoningEffort: 'medium', description: 'm' }, { reasoningEffort: 'high', description: 'h' }, { reasoningEffort: 'xhigh', description: 'x' } ], defaultReasoningEffort: 'medium' }, { model: 'gpt-6-sol', id: 'ignored-sol-id', displayName: 'GPT-6 Sol', hidden: true, supportedReasoningEfforts: [ { reasoningEffort: 'medium' }, { reasoningEffort: 'max' } ] } ] }` — `model`-before-`id` precedence, `{ reasoningEffort }` objects and a hidden model that is still kept.
      - `CODEX_PAGE_1 = { data: [ { model: 'gpt-6-astra', supportedReasoningEfforts: ['low','high'] } ], nextCursor: 'cursor-2' }` and `CODEX_PAGE_2 = { data: [ { model: 'gpt-6-sol', supportedReasoningEfforts: ['high'] } ] }` (no cursor → pagination ends).
      - `CODEX_MALFORMED_PAYLOAD = { data: 'not-an-array' }` (parses to `[]`, so `discoverModels` resolves `undefined`).

   4. `codexAppServer(mode)` gains request recording and page replies. Keep the existing `kills` counter and the `'fail'`/`'hang'` paths exactly as they are. In `stdin.write`, after parsing each JSONL line, record every written message on a `writes: unknown[]` array captured in the closure, and reply:
      - `id === 1` → `{ jsonrpc: '2.0', id: 1, result: {} }` (unchanged).
      - `id === 2` → the payload for the behaviour: `'ok'` → `CODEX_PAYLOAD`; `'data'` → `CODEX_DATA_PAYLOAD`; `'malformed'` → `CODEX_MALFORMED_PAYLOAD`; `'paged'` → `CODEX_PAGE_1`.
      - `typeof parsed.id === 'number' && parsed.id >= 3` → for `'paged'` reply `{ jsonrpc: '2.0', id: parsed.id, result: CODEX_PAGE_2 }`; otherwise ignore.
      Return `{ spawner, kills, writes: () => writes, modelListRequests: () => writes.filter(m => (m as { method?: string }).method === 'model/list') }`. `buildRegistry` must expose the codex fake so tests can read `modelListRequests()`: change `buildRegistry` to return `{ registry, codex }` (or set it on a mutable holder the caller passes in) and thread it onto `Harness` as `codexServer`. `buildDiscovery` keeps its current signature; add `codexServer` to the `Harness` interface and fill it in.

   5. Injected transports, all inside `buildRegistry`, all driven off `mode()` so one registry serves a whole test's refresh sequence:
      - claude: keep `fetchFeed` exactly as today but count its calls on a closure counter exposed as `Harness.claudeFeedCalls: () => number`; replace the fixed `readLocalCatalog: async () => undefined` with `async () => { const m = mode().claudeCatalog; if (m === 'hang') { return never<unknown>(); } if (m === 'ok') { return claudeCatalogFixture(); } if (m === 'malformed') { return MALFORMED_CLAUDE_CATALOG; } return undefined; }`.
      - opencode: keep `serverBaseUrl: 'http://127.0.0.1:65535'`; count `fetchModels` calls on a closure counter exposed as `Harness.opencodeApiCalls: () => number`; replace `runModelsCli: async () => undefined` with `async () => { const m = mode().opencodeCli; if (m === 'ok') { return opencodeVerboseFixture(); } if (m === 'fail') { throw new Error('spawn opencode ENOENT'); } return undefined; }`.
      - antigravity: `new AntigravityAdapter({ runModelsCli: async () => (mode().agy === 'ok' ? agyModelsFixture() : undefined) })`.
      Keep the comments explaining WHY every seam is injected (no real binary, no developer `~/.claude`, no loopback request), updating them to say the live legs are now driven from checked-in fixtures rather than deferred to a later todo.

   6. Update the file header comment: the leg list becomes six legs, with the new leg 6 ("corrected sources → open panel → media/config.js") described in one sentence each for: the codex `data`/paged reply, the claude local catalog working offline, the opencode CLI-first path, the agy families, the malformed-refresh staleness and the custom-as-Other… round-trip.

   Files: `test/modelSelectorRefresh.test.ts`

2. Leg 1 additions: the corrected Codex reply reaches an open panel with per-model efforts

   Add to `describe('model selector refresh: reload refresh')`:

   1. `it('a data-shaped model/list reply reaches an open panel with per-model efforts', ...)`: `buildDiscovery({ mode: { codex: 'data' } })`, write `defaultConfigJson()`, `buildPanel`, `await webview.send({ type: 'ready' })`, `await harness.discovery.refresh()`. On the LAST `optionsChanged().options.byAgent.codex`:
      - `models` deep-equals `['gpt-6-astra', 'gpt-6-sol']` — the `model` field wins over `id`, and the `hidden: true` model is kept.
      - `modelEntries` deep-equals `[ { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low','medium','high','xhigh'], defaultEffort: 'medium' }, { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['medium','max'] } ]` (use `assert.deepStrictEqual`; the second entry must carry NO `defaultEffort` own key — check with the file's `hasOwnKey` helper).
      - `efforts` (via `assertSameSet`) is `['low','medium','high','xhigh','max']`, the union including the level `max` that curated `CODEX_EFFORTS` lacks.
      - `source === 'live'`, `stale === false`, `hasOwnKey(cap, 'staleReason') === false`.
      - the request shape: `harness.codexServer.modelListRequests()` has length 1 and its `params` deep-equals `{ includeHidden: true, limit: 100 }` — assert against `codexModelListParams()` imported from `../src/adapter/codex` rather than re-typing the literal.

   2. `it('a paged model/list reply arrives whole', ...)`: `mode: { codex: 'paged' }`; after `refresh()` the store's `codex` snapshot models are `[{ id: 'gpt-6-astra', efforts: ['low','high'] }, { id: 'gpt-6-sol', efforts: ['high'] }]` (deep-equal on ids + efforts), `modelListRequests()` has length 2, and the second request's `params.cursor === 'cursor-2'` while its JSON-RPC `id` is 3. Snapshot `stale === false`.

   Both cases must leave the existing `'a window reload refreshes every source…'` case untouched (it still runs with the default `codex: 'ok'` payload).

   Files: `test/modelSelectorRefresh.test.ts`

3. New leg: the Claude local catalog drives the panel and works offline

   Add `describe('model selector refresh: claude local catalog')` after leg 1.

   1. `it('an offline window refreshes claude from the local catalog, with per-model efforts and defaults', ...)`: `buildDiscovery({ mode: { claudeCatalog: 'ok', feed: 'fail', claudeFeed: 'fail' } })`, panel open on `defaultConfigJson()`, `refresh()`. Assert on the last `optionsChanged().options.byAgent.claude`:
      - `models` deep-equals `['claude-opus-5-5','claude-sonnet-5','claude-haiku-4-5-20251001','claude-opus-4-7','claude-label-equals-id']` — `section: 'main'` in file order, then `overflow` in file order, the duplicate `claude-sonnet-5` dropped, `gpt-5` and the blank id skipped.
      - `modelEntries` deep-equals `[ { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low','medium','high','xhigh','max'], defaultEffort: 'medium' }, { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low','high'], defaultEffort: 'high' }, { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] }, { id: 'claude-opus-4-7', label: 'Opus 4.7', efforts: ['low','high'], defaultEffort: 'high' }, { id: 'claude-label-equals-id', efforts: [] } ]` — note the EXPLICIT empty `efforts` on the `thinking: none` model (the webview reads it as "this model has no levels"), the absent `label` when `name === id`, and that NO entry carries `provider` or `custom` (assert with `hasOwnKey` on one entry, since only ids/labels/effort names may cross to the webview).
      - `efforts` deep-equals `['low','medium','high','xhigh','max']` (the ordered union), `source === 'live'`, `stale === false`.
      - the offline guarantee: `harness.claudeFeedCalls() === 0` (the adapter returned before touching its fetcher) while `harness.store.get('models.dev')` is `undefined` (the feed source failed and has no builtin seed), proving claude refreshed with no network.

   2. `it('a malformed local catalog falls back to the models.dev feed', ...)`: `mode: { claudeCatalog: 'malformed' }` (feed `'ok'`). After `refresh()`: the claude snapshot is feed-derived — `models` includes `'claude-haiku-4-5'` (feed-only id) and does NOT include `'claude-opus-4-7'` (catalog-only id); its entries carry NO per-model `efforts` (check with `hasOwnKey`), the capability `efforts` is the curated `CLAUDE_EFFORTS` (import from `../src/adapter/claude` and compare with `assert.deepStrictEqual`), `source === 'live'`, `stale === false`, and `'claude-sonnet-5'` appears exactly once (`models.filter(m => m === 'claude-sonnet-5').length === 1`).

   3. `it('both claude sources unusable keeps the last known-good catalog list, marked stale', ...)`: first refresh with `{ claudeCatalog: 'ok' }` (record `models`, `modelEntries` and `fetchedAt` of `store.get('claude')`), then set `mode.claudeCatalog = 'malformed'; mode.claudeFeed = 'fail'; mode.feed = 'fail'` and refresh again. The snapshot keeps `models`/`modelEntries` deep-equal to the recorded ones and the same `fetchedAt`, with `stale === true` and a non-empty `staleReason`; the last `optionsChanged` still lists `'claude-opus-4-7'` behind `stale.claude.stale === true`.

   Do NOT assert that the `'hang'` catalog mode resolves `undefined`: a timed-out catalog leg is treated as "no catalog" and discovery falls THROUGH to the feed. If a hang case is added, assert exactly that (feed-derived ids with `stale === false`).

   Files: `test/modelSelectorRefresh.test.ts`

4. New leg: the OpenCode CLI is the primary source and no server is touched

   Add `describe('model selector refresh: opencode CLI first')`.

   1. `it('the verbose CLI listing reaches an open panel as a model list with per-model variants', ...)`: `buildDiscovery({ mode: { opencodeCli: 'ok', opencode: 'fail' } })` (the API would fail if it were reached), panel open, `refresh()`. On the last `optionsChanged().options.byAgent.opencode`:
      - `models` deep-equals `['anthropic/claude-sonnet-5','openai/gpt-6','google/gemini-3-pro','zed/weird-1','local/llama-4','broken/model-1','last/no-detail']` (listing order, the duplicate `openai/gpt-6` block dropped).
      - `modelEntries` deep-equals `[ { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low','high','max'] }, { id: 'openai/gpt-6', label: 'GPT-6' }, { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['none','thinking'] }, { id: 'zed/weird-1', label: 'Weird {model} name', efforts: ['minimal'] }, { id: 'local/llama-4' }, { id: 'broken/model-1' }, { id: 'last/no-detail' } ]` — a `{}`-variants model carries NO `efforts` key, the unparseable block degrades to a plain entry, and `name === bare model id` yields no label. Explicitly assert `hasOwnKey(entries[0], 'provider') === false`: the parser stamps `provider` on the entry, and `configFormOptions`/`formModelEntry` must strip it before it crosses to the webview.
      - `efforts` deep-equals `['low','high','max','none','thinking','minimal']` (ordered union) — this is what turns the OpenCode effort control into a dropdown; `modelLink` is still present (re-attached from the builtin).
      - no server, no request: `harness.opencodeApiCalls() === 0`.
   2. `it('falls back to /api/model only when the CLI yields nothing', ...)`: `mode: { opencodeCli: 'fail', opencode: 'ok' }` → the snapshot's models include `'anthropic/claude-sonnet-5'` and `'github-copilot/gpt-5'`, no entry carries `efforts`, the capability `efforts` is `[]` (free-text shape preserved), and `harness.opencodeApiCalls() >= 1`.
   3. `it('both opencode sources unusable keeps the last known-good list, marked stale', ...)`: refresh once with `{ opencodeCli: 'ok' }`, then `mode.opencodeCli = 'empty'; mode.opencode = 'fail'` and refresh again: `models`/`modelEntries` survive byte for byte (deep-equal against the recorded values), `fetchedAt` unchanged, `stale === true` with a reason.

   Files: `test/modelSelectorRefresh.test.ts`

5. New leg: `agy models` drives the antigravity selector families and fixed ids

   Add `describe('model selector refresh: antigravity agy models')`.

   1. `it('the agy listing reaches an open panel as families with their levels and fixed ids', ...)`: `buildDiscovery({ mode: { agy: 'ok' } })`, panel open, `refresh()`. On the last `optionsChanged().options.byAgent.antigravity`:
      - `models` deep-equals `['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.1-pro','claude-sonnet-4-6','claude-opus-4-6-thinking','gpt-oss-120b-medium']` (first-mention order).
      - `modelEntries` deep-equals `[ { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low','medium','high'] }, { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', efforts: ['low','medium','high'] }, { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['low','medium','high'] }, { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low','high'] }, { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: [] }, { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', efforts: [] }, { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B Medium', efforts: [] } ]` — the family labels lose their trailing ` (Level)`, the lone suffixed `gpt-oss-120b-medium` stays a fixed id with an explicit empty list, and no entry carries `defaultEffort`.
      - `efforts` deep-equals `['low','medium','high']`, `source === 'live'`, `stale === false`.
      - The discovered list is compared with the curated seed to prove discovery is what is on screen, not the hand-maintained table: assert the discovered `models` deep-equals `builtinAgentCapabilities().antigravity.models` when the fixture still matches the curated table, but write it as a single `assert.deepStrictEqual(byAgent.antigravity.models, builtinAgentCapabilities().antigravity.models, 'the checked-in agy listing still reproduces the curated table')` with a comment saying this is the intended drift alarm: when the curated table is next refreshed by hand, this assertion fails and the fixture is refreshed with it.
   2. `it('a failed agy listing keeps the curated antigravity table, marked stale', ...)`: with the default `agy: 'fail'`, refresh once and assert `models` deep-equals `builtinAgentCapabilities().antigravity.models`, `source === 'builtin'`, `stale === true`, a non-empty reason, AND that the curated entries still carry their per-family efforts (`modelEntries` is non-empty and at least one entry has a non-empty `efforts`) — the empty-snapshot overlay branch keeping the builtin's own `modelEntries`.

   Files: `test/modelSelectorRefresh.test.ts`

6. New leg: a failed, timed-out or malformed refresh never blanks a selector

   Add to `describe('model selector refresh: discovery fallback')`:

   1. `it('malformed data from every source keeps the last known-good lists, marked stale', ...)`: first refresh with `{ codex: 'data', claudeCatalog: 'ok', opencodeCli: 'ok', agy: 'ok' }` and a panel open; snapshot the four `store.get(sourceId)!` objects (`models`, `modelEntries` through `agentCapabilities`, `efforts`, `fetchedAt`). Then set `mode.codex = 'malformed'; mode.claudeCatalog = 'malformed'; mode.claudeFeed = 'fail'; mode.feed = 'fail'; mode.opencodeCli = 'empty'; mode.opencode = 'fail'; mode.agy = 'fail'` and refresh again. For each of `['claude','codex','opencode','antigravity']`:
      - `models` and `efforts` deep-equal the recorded values, `fetchedAt` identical, `stale === true`, `staleReason` non-empty, `models.length > 0` ("never blanked").
      - The last `optionsChanged`: `options.byAgent[agent].models.length > 0` and `stale[agent]` deep-equals `{ stale: true, reason: snapshot.staleReason, fetchedAt: recordedFetchedAt }`, and the per-model efforts are still on `modelEntries` (assert one rich entry, e.g. codex `gpt-6-astra` still carrying `efforts` and `defaultEffort`).
   2. `it('a timed-out refresh of every source keeps the last known-good lists', ...)`: same shape but the second refresh uses the hang transports (`{ feed: 'hang', claudeFeed: 'hang', codex: 'hang' }` plus `opencodeCli: 'empty'`, `opencode: 'fail'`, `agy: 'fail'`) on a harness built with `timeoutMs: 50`; `this.timeout(10_000)`. Assert `await assert.doesNotReject(() => harness.discovery.refresh())` and the same never-blanked/stale guarantees. NOTE: with `claudeCatalog: 'hang'` the claude leg falls through to the (hanging) feed, so use the hanging feed as the claude failure driver and say so in a comment.

   Files: `test/modelSelectorRefresh.test.ts`

7. Leg 5 addition: custom values survive the refresh as Other… entries and still save

   Add to `describe('model selector refresh: round-trip')`:

   `it('a configured value the refreshed lists lack rides along as a custom entry and still saves', ...)`: `buildDiscovery({ mode: { claudeCatalog: 'ok', codex: 'data', opencodeCli: 'ok', agy: 'ok' } })`; `writeRoles(dir, { planner: { agent: 'claude', model: 'claude-opus-5', effort: 'medium' }, executor: { agent: 'opencode', model: 'openrouter/legacy-model', effort: 'ultra' } })` — `claude-opus-5` is a real legacy id the corrected curated table and the catalog both drop, and `ultra` is outside the opencode variant union. Panel open, `refresh()`. On the last `optionsChanged().options.byAgent`:
   - `claude.models` includes `'claude-opus-5'` (so `validateConfigForm` and the host re-validation still accept it) AND `claude.modelEntries` ends with exactly `{ id: 'claude-opus-5', custom: true }`, while every discovered entry carries no `custom` own key (`hasOwnKey`).
   - `opencode.models` ends with `'openrouter/legacy-model'` and `opencode.modelEntries` ends with `{ id: 'openrouter/legacy-model', custom: true }`; `opencode.efforts` includes `'ultra'` appended after the discovered union.
   - The configured values are appended once only after a second `refresh()` (guard against duplicate appends): re-refresh and assert `models.filter(m => m === 'claude-opus-5').length === 1`.
   Then `await webview.send({ type: 'save', form: loaded.form, token: loaded.token })` → exactly one `saved`, no `saveFailed`, and `loadConfig(dir)` still reads back `claude-opus-5` / `openrouter/legacy-model` / `ultra` unchanged.

   Files: `test/modelSelectorRefresh.test.ts`

8. New leg 6: replay the panel's real messages through media/config.js

   The host-side payloads above are the *input* to the webview; this leg proves the Other… and dropdown rendering end to end by feeding the controller's OWN `loaded`/`optionsChanged` messages into `media/config.js`, the same way leg 4 feeds `setProviders` into `media/chat.js`.

   1. Hoist the leg-4 `FakeClassList` and `FakeEl` classes out of `describe('model selector refresh: provider-first selection')` up to the outer suite scope (they are generic and leg 4 keeps using them unchanged), and extend `FakeEl` with exactly what `media/config.js` needs beyond what `media/chat.js` needed:
      - `public remove(): void` — detach from `parentNode.children` (config.js calls `.remove()` on 4 nodes).
      - `public removeChild(node: FakeEl): FakeEl` — same detach, returning the node.
      - selector support in `matches`: split the selector on `,` and match any part; per part support `[name="value"]` (attribute equality, quotes optional) in addition to today's `[name]`, `.class` and tag forms. Also make `descendants()` public (or add `public findById(id: string): FakeEl | null`) so the document stub can resolve ids created during render.
      Keep every existing behaviour (`options`, `selectedIndex`, `value`, `insertBefore`, `dataset`, `style`, `focus`) untouched so leg 4 still passes.
   2. Add `function loadConfigView(): { ids; posted; send; byId; setActive }` inside the new leg, patterned on `loadConfigView()` in test/configPanel.view.test.ts but trimmed: create the ids `media/config.html` defines (`config-form`, `roles-body`, `save`, `reload`, `reset`, `banner`, `banner-message`, `banner-primary`, `banner-secondary`, `status`, `error-view`, `error-message`, `error-reset`, `error-reload`, `limit-plan_review_rounds`, `limit-exec_attempts`, `limit-stall_notice_minutes`, `git-remote`, `git-base`), mirror the containment (a `fieldset` holding `roles-body` inside `config-form`; each limit/git control in a `.field-row` beside a `.field-error` whose `data-error-for` is the control's `data-path`), and run `media/config.js` with `vm.runInNewContext` over a sandbox of `{ window: { addEventListener }, document: { createElement, getElementById (ids first, then a descendant search of the form), activeElement }, acquireVsCodeApi }`. `getElementById` MUST find the role controls the renderer creates (`role-<role>-model-select`, `-model-input`, `-effort-select`, `-effort-input`, `-model-link`, `-stale`, `-agent`). Document in a comment that the harness is a trimmed copy for the same reason leg 4's is.
   3. Helpers: `dynamicOptions(select)` (value+text of options without `dataset.static`), `staticOption(select, 'default' | 'other')`, and the `OTHER_SENTINEL = '\u0000other'` constant (copy the value from media/config.js, do not invent one).
   4. Cases, each building a harness with the rich sources, opening a real `ConfigPanelController` over a config file, refreshing, then replaying `webview.loaded()[0]` and the last `webview.optionsChanged()` into the view verbatim (`view.send(msg)` after `JSON.parse(JSON.stringify(msg))` so no host-realm object crosses into the vm):
      - `it('a custom value renders as an editable Other… entry after the refresh', ...)`: config `planner: claude / claude-opus-5 / medium`; after the replay `view.byId('role-planner-model-select').value === OTHER_SENTINEL`, `role-planner-model-input` has `style.display !== 'none'`, `value === 'claude-opus-5'` and `disabled === false`, and `'claude-opus-5'` is NOT among `dynamicOptions(select).map(o => o.value)` (a `custom: true` entry is never an ordinary option), while `'claude-opus-5-5'` IS, with its text `'Opus 5.5'`.
      - `it('the opencode model and effort controls become dropdowns once a list arrives', ...)`: config `executor: opencode / anthropic/claude-sonnet-5 / high`; before the refresh (replay only `loaded`) the model input is shown and the effort control is the free-text input (the curated opencode lists are empty); after replaying the post-refresh `optionsChanged` the model select is shown (`style.display !== 'none'`) carrying the discovered ids and the effort select is shown carrying that model's own variants `['low','high','max']`, with the documentation link still visible (`role-executor-model-link` has an `href`).
      - `it('per-model effort lists and the default label follow the selected model', ...)`: config `planner: claude / claude-opus-5-5 / ''`; the effort select's dynamic values are `['low','medium','high','xhigh','max']` and its static default option reads `'(default: medium)'`; switching the model input/select to `claude-haiku-4-5-20251001` (set the select value and `fire('change')`) leaves only the static options (empty per-model list); switching to an antigravity role with `gemini-3.1-pro` shows `['low','high']` and with `claude-sonnet-4-6` leaves only the static options.
      - `it('a stale refresh keeps the options on screen and shows the note', ...)`: replay a post-failure `optionsChanged` (from the malformed-refresh case's harness) and assert the model select still carries the last known-good options and `role-<role>-stale` has the `visible` class and text starting `'stale — showing last known models'`.

   Files: `test/modelSelectorRefresh.test.ts`

9. test/modelDiscovery.test.ts: antigravity as the fifth source and per-model effort persistence

   1. Add `it('drives the antigravity source through the same per-agent loop', ...)` to `describe('T07 ModelDiscoveryService.refresh')`: a `fakeAdapter('antigravity', async () => caps([...]))` built with per-model entries rather than the bare `caps()` helper — add a small local helper `entryCaps(entries: readonly ModelEntry[], efforts?: readonly string[]): AgentCapabilities` (or call `capabilitiesFromEntries` from `../src/adapter/adapter`) so a family entry with `efforts: ['low','high']` and a fixed entry with `efforts: []` can be returned. Assert: the adapter is called exactly once, its `ctx.feed` is `undefined` (only claude gets the feed), `table['antigravity']?.source === 'live'`, `stale === false`, the snapshot's `models` keep the per-entry `efforts`, and `Object.keys(table).sort()` contains `antigravity` alongside the other sources. Also assert `AGENT_CATALOG_SOURCE['antigravity'] === 'antigravity'` and that `CATALOG_SOURCE_IDS` deep-equals `['claude','codex','opencode','antigravity','models.dev']` (imported from `../src/orchestrator/modelCatalog`).
   2. Add `it('per-model efforts and defaults survive the persistence round-trip, an empty list excepted', ...)` to `describe('T07 ModelDiscoveryService persistence')`: refresh a service whose antigravity (or codex) adapter returns entries `[{ id: 'fam', efforts: ['low','high'], defaultEffort: 'high' }, { id: 'fixed', efforts: [] }]`, dispose, then rehydrate a second store over the same memento and assert the `cached` snapshot's first entry deep-equals `{ id: 'fam', efforts: ['low','high'], defaultEffort: 'high' }` while the second is `{ id: 'fixed' }` — `optionalStringArray` in src/orchestrator/modelCatalog.ts deliberately drops an empty array, so the "this model has no levels" marker does NOT survive a reload and the webview falls back to the agent-level union for it. State that consequence in the test name/comment; do not change production code for it.

   Files: `test/modelDiscovery.test.ts`

10. README: correct the config-panel selector and refresh description

   Only the config-panel/discovery prose changes; the per-source Sources bullets (claude catalog, codex `model/list`, `opencode models --verbose`, `agy models`) are already correct and must not be rewritten.

   1. The **Managed fields** bullet (around README.md:731-739): replace "a per-agent model dropdown with curated suggestions" with a description of the live-backed control — the model dropdown is populated from the refreshed per-agent list (Codex, Claude, OpenCode and Antigravity alike, OpenCode included now that its list is discoverable), with the curated table as the offline fallback; the effort dropdown offers the SELECTED model's own levels when its source discloses them and the agent-level union otherwise, shows `(default: <effort>)` when the source names a default, leaves only `(default)` for a model with no levels (a `thinking: none` Claude model, an antigravity fixed id), and stays a free-text field only while the agent-level union is empty; validation is always against the agent-level union, so an effort valid for another model of the same agent is never rejected.
   2. In the same bullet or the one after, state that a configured value the list lacks renders as an editable **"Other…"** entry — the select shows `Other…`, the text input keeps the value and stays editable, and the choice is sticky across refreshes — rather than as an ordinary option.
   3. The **How a refresh behaves** bullet (around README.md:837-846): add that the config panel is wired to the live catalog (`getCapabilities` / `onDidChangeCapabilities` over the `CatalogStore` and `ModelDiscoveryService`, built before the panel is registered), so the panel's FIRST `loaded` already shows the rehydrated `cached` lists and every later refresh reaches an open panel as an in-place option update that never re-posts `loaded` and never disturbs unsaved edits.
   4. The **What survives** bullet (around README.md:847-851): add that a failed, timed-out or malformed refresh never blanks a selector and never rewrites a custom value — the last known-good list stays on screen behind the per-agent "stale — showing last known models" note, and the appended configured value stays selected as its editable "Other…" entry.

   Files: `README.md`

11. Verify

   Run, in order: `npm run compile`, `npm run lint`, `npm test`. Expect 0 compile errors, 0 lint errors (the single pre-existing warning `src/orchestrator/webviewProtocol.ts:626 '_legacy' is assigned a value but never used` is untouched and expected), and the whole mocha suite green with no failures and the pending count unchanged. Confirm mocha exits on its own (no leaked timer from the hang cases) and that the new cases add no real process spawn or filesystem read outside `test/fixtures` — grep the file for `new ClaudeAdapter(`, `new OpencodeAdapter(`, `new AntigravityAdapter(` and `new CodexAdapter(` and confirm every construction still injects its transport seam.

   Files: `test/modelSelectorRefresh.test.ts`, `test/modelDiscovery.test.ts`, `README.md`

## Risks

- Harness defaults are load-bearing: `claudeCatalog: 'missing'`, `opencodeCli: 'empty'`, `agy: 'fail'` and the `models`-shaped `CODEX_PAYLOAD` reproduce today's injected stubs exactly. Changing any default silently rewrites the existing leg-1/leg-2/leg-3/leg-5 expectations (e.g. leg 1 asserts antigravity is stale with the curated list, leg 3 asserts feed-derived provider lists).
- Hermeticity: a missed seam injection makes the suite read the developer's real `~/.claude/cache/model-catalog`, spawn `opencode serve`/`agy models`/`codex app-server`, or hit loopback. Every new adapter construction must inject `readLocalCatalog` / `runModelsCli` / `fetchModels` + `serverBaseUrl` / `spawnAppServer`.
- A timed-out or hanging Claude local-catalog read is treated as "no catalog" and falls THROUGH to the models.dev feed (recorded T02 behaviour); asserting `undefined` for `claudeCatalog: 'hang'` will fail. Drive claude failure through the feed legs instead.
- `optionalStringArray` drops an empty array, so an explicit `efforts: []` marker does not survive the memento round-trip: a `cached` snapshot's fixed antigravity ids and `thinking: none` Claude models come back with no `efforts` key. Assert the actual behaviour (and its webview consequence: those models fall back to the agent-level union) rather than the marker surviving — fixing it is out of scope.
- `overlayCapabilities` prefers the snapshot-level `efforts` when non-empty and only falls back to the union of entry efforts otherwise; for an EMPTY refreshed list it keeps the builtin models/efforts/`modelEntries` with the snapshot's stale metadata and `source: 'builtin'`. Expected unions and `source` values must follow those branches, not the raw adapter output.
- The antigravity leg's `assert.deepStrictEqual(discovered, builtinAgentCapabilities().antigravity.models)` is a deliberate drift alarm: it will fail the next time the curated `ANTIGRAVITY_MODELS` table is refreshed by hand without refreshing `test/fixtures/agyModels.sample.txt`. Keep the comment saying so, and refresh both together.
- Extending `FakeEl` for `media/config.js` risks breaking leg 4: `matches` must keep supporting the bare `[attr]`, `.class` and tag forms it already answers, and `remove`/`removeChild` must not disturb `options`/`selectedIndex`/`value` semantics.
- `media/config.js` renders role controls into `roles-body` at `loaded` time; the view harness's `getElementById` must search the form's descendants, not just the pre-made id map, or every `role-*` lookup returns null and the cases pass vacuously. Assert at least one positive property of each control so a null lookup fails loudly (`view.byId` already asserts existence).
- Replaying host messages into the vm realm requires a `JSON.parse(JSON.stringify(...))` clone (leg 4's `plainClone` precedent); passing host objects straight in can make `deepStrictEqual` comparisons across realms fail confusingly.
- Cross-realm and cross-page assertions on `modelEntries` are order-sensitive; the fixture-derived orders stated in the steps (claude main-then-overflow, opencode listing order, agy first-mention order, codex `model`-first ids) were read off the parsers and fixtures but not executed — if any deep-equal fails, re-derive from the parser rather than loosening the assertion to a set comparison.
- The hang/timeout cases need an explicit `this.timeout(10_000)` and a small `timeoutMs` (50) or mocha will time out; a leaked unref'd timer would also show up as a non-exiting mocha run.
- Scope creep guard: T08 adds coverage and README prose only. If a new case exposes a production defect (for example a custom entry not appended, or a `provider` key crossing to the webview), report it rather than changing `src/` or `media/` in this todo — those seams belong to T01-T07.

## Acceptance

- test/modelSelectorRefresh.test.ts drives the corrected sources from checked-in fixtures and asserts each one reaching an OPEN config panel as `optionsChanged`: the codex `result.data` reply (ids from `model`, `{ reasoningEffort }` efforts, hidden models kept, `includeHidden`/`limit` params, a `nextCursor` page followed), the Claude local catalog (main-then-overflow ids, per-model efforts and `defaultEffort`, explicit empty efforts for a `thinking: none` model), `opencode models --verbose` (listing-order ids, `variants` keys as efforts, no `efforts` key for `{}`, no server started and no `/api/model` request), and `agy models` (families with their levels, fixed ids with empty lists, labels without the trailing `(Level)`).
- The Claude leg proves the offline path: with both the shared feed and the adapter's own fetcher failing, the claude snapshot is `live` and not stale, its fetcher was never called, and a malformed/empty catalog falls back to the feed with `claude-sonnet-5` present exactly once.
- A second refresh that fails, times out or returns malformed data for every source keeps each snapshot's `models`, `efforts`, `modelEntries` and `fetchedAt` byte for byte with `stale: true` and a non-empty reason, never blanks a selector, and the open panel's last `optionsChanged` still carries the non-empty lists plus the per-agent stale metadata.
- A configured model and effort the refreshed lists lack ride along as `modelEntries` entries marked `custom: true` (appended once, listed entries unmarked, no `provider` key present), stay inside `models`/`efforts` so validation passes, and the unmodified form still saves with `.baiton/config.json` reading back unchanged.
- Leg 6 replays the controller's real `loaded`/`optionsChanged` messages through `media/config.js` and asserts: a custom value renders as `Other…` with a visible, editable, correctly valued text input and is absent from the ordinary options; the OpenCode model and effort controls switch from free text to dropdowns once a list arrives, with the documentation link intact; per-model effort lists and the `(default: <effort>)` label follow the selected model, with only the static options left for a model that discloses none; and a stale refresh keeps the last known-good options on screen with the stale note visible.
- test/modelDiscovery.test.ts covers antigravity as the fifth catalog source (driven through the per-agent loop, `ctx.feed` undefined, `live`/not stale, per-entry efforts preserved, `AGENT_CATALOG_SOURCE`/`CATALOG_SOURCE_IDS` pinned) and documents that per-model `efforts`/`defaultEffort` survive the memento round-trip while an explicit `efforts: []` is dropped.
- README's config-panel and refresh prose describes the live-backed dropdowns for all four agents, the per-model effort lists with `(default: <effort>)` and the agent-level-union fallback and validation, the editable "Other…" rendering of configured-but-unlisted values, the live panel wiring (first `loaded` already `cached`, later refreshes arriving as in-place option updates), and the never-blank/never-rewrite guarantee behind the stale note.
- `npm run compile`, `npm run lint` and `npm test` all pass: 0 compile errors, 0 lint errors (only the pre-existing `_legacy` warning), no test failures, the pending count unchanged, and mocha exits on its own with no new process spawn or read outside `test/fixtures`.
