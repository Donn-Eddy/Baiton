# Plan T15

## Steps

1. Create test/modelSelectorRefresh.test.ts with the shared end-to-end harness

   New file, mocha + `assert`, NO `vscode` loader hook (every module it touches is host-free: it must import statically and never register `test/fixtures/vscodeLoader.mjs`, so suite ordering can never matter — the same rule test/modelDiscovery.test.ts and test/providerRouter.test.ts state in their headers).

   File header comment: this is the end-to-end suite for model-selector-refresh (T15). It wires the REAL modules the way the host wires them — fake feed/CLI transports -> `ModelDiscoveryService` -> `CatalogStore` -> `agentCapabilities(table)` -> `ConfigPanelController`, and -> `ProviderRouter` -> `ChatController` -> `media/chat.js` — and asserts the whole chain rather than any single unit. Name what each leg covers (reload refresh, discovery fallback, provider filtering, provider-first selection, stale-list handling, config + selection round-trip) and state that the Set-API-key quick pick itself stays covered by test/setApiKey.test.ts (that file needs the vscode loader; this one deliberately does not).

   Static imports:
   - `CatalogStore`, `MODEL_CATALOG_MEMENTO_KEY`, `MODEL_CATALOG_PERSIST_VERSION`, types `ModelCatalogTable`/`ModelCatalogSnapshot` from `../src/orchestrator/modelCatalog`.
   - `ModelDiscoveryService`, `builtinCatalogFetches`, types `DiscoveryRegistry`/`FeedFetcher` from `../src/activation/modelDiscovery`.
   - `parseModelsDevFeed`, type `ModelsDevFeed` from `../src/orchestrator/modelsDev`.
   - `agentCapabilities`, `builtinAgentCapabilities` from `../src/adapter`; types `Adapter`, `AgentCapabilities`, `AgentId`, `DiscoveryContext` from `../src/adapter/adapter`.
   - `ClaudeAdapter` (`../src/adapter/claude`), `CodexAdapter` + types `CodexAppServerProcess`/`CodexAppServerSpawner` (`../src/adapter/codex`), `OpencodeAdapter` (`../src/adapter/opencode`), `AntigravityAdapter` (`../src/adapter/antigravity`).
   - `ProviderRouter`, types `ProviderSettings`/`SecretsLike`/`MementoLike`/`ProviderAvailability` from `../src/activation/providerRouter`.
   - `providerCatalog`, `providerSecretKey`, `MODEL_SELECTION_KEY`, `PROVIDER_NEEDS_ENDPOINT_REASON`, `COPILOT_UNAVAILABLE_REASON`, `providerNeedsKeyReason`, type `ModelSelection` from `../src/orchestrator/providers`.
   - `ConfigPanelController`, type `ConfigPanelWebview` from `../src/activation/configPanelController`; types `ConfigPanelHostToWebview`/`ConfigPanelWebviewToHost` + `formFromConfig` from `../src/config/configPanel`; `configFilePath`, `loadConfig` from `../src/config/loadConfig`; `defaultConfig`, `defaultConfigJson` from `../src/config/defaultConfig`; `configToken` from `../src/config/configDocument`.
   - `ChatController` from `../src/activation/chatController`; types `HostToWebview`/`ProviderGroup` from `../src/orchestrator/webviewProtocol`.
   - `ok`, `err` from `../src/model/result`.

   Shared harness helpers (all local to this file):
   - `fixtureFeed(): ModelsDevFeed` — read `test/fixtures/modelsDev.sample.json` with `fs.readFileSync`, `JSON.parse`, `parseModelsDevFeed`, assert `isOk`, return the value. The fixture carries `anthropic` (claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5), `google`, `mistral`, `opencode`, `deepseek`, `deepinfra`, `cerebras`, `baseten`, each with an `api`.
   - `fakeMemento()` — Map-backed `{ store, updates, get, update }` exactly as test/modelDiscovery.test.ts does, so a second `CatalogStore` over the same object models a window reload.
   - `codexAppServer(payload, opts?)` — the fake `CodexAppServerSpawner` copied in compact form from test/adapter.codex.test.ts (`fakeAppServer`): listener arrays for stdout/stderr/error/exit/close, `stdin.write` parsing each JSONL line and replying `{ jsonrpc: '2.0', id, result }` for `initialize` (id 1) and `model/list` (id 2) via `setImmediate`, a `kills()` counter, plus an `opts.fail` mode that emits `api.error(new Error('spawn codex ENOENT'))` instead of replying. Default payload: `{ models: [ { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportedReasoningEfforts: ['low','medium','high','xhigh'], defaultReasoningEffort: 'medium' }, { id: 'gpt-5-codex', supportedReasoningEfforts: ['minimal','low','medium','high'], defaultReasoningEffort: 'low' } ] }`.
   - `opencodeFetch(payload)` — a `FeedFetch`-shaped fake returning `{ ok: true, status: 200, text: async () => JSON.stringify(payload) }`, and a `failing` variant that rejects. Payload shape: `{ providers: { anthropic: { models: { 'claude-sonnet-5': {} } }, 'github-copilot': { models: { 'gpt-5': {} } } } }` so ids come out as `anthropic/claude-sonnet-5`, `github-copilot/gpt-5`.
   - `buildRegistry(opts)` -> `DiscoveryRegistry` over REAL adapters with injected seams: `new ClaudeAdapter(undefined, { fetchFeed: opts.claudeFeed })`, `new CodexAdapter({ spawnAppServer })`, `new OpencodeAdapter(undefined, { serverBaseUrl: 'http://127.0.0.1:65535', fetchModels, runModelsCli })` (a `serverBaseUrl` means nothing is spawned and nothing killed), `new AntigravityAdapter()` (no `discoverModels`). `get(agent)` indexes the map; `ids` = its keys. Using the real adapters is what makes the suite end-to-end rather than a second copy of test/modelDiscovery.test.ts.
   - `buildDiscovery(opts)` -> `{ store, discovery, memento }`: `new CatalogStore({ memento, builtins: builtinCatalogFetches(), now: () => opts.now ?? '2026-09-26T00:00:00.000Z' })` and `new ModelDiscoveryService({ store, registry, fetchFeed, cwd: () => opts.cwd, timeoutMs: 200, log: (m) => logs.push(m) })`. Register an `afterEach` that calls `discovery.dispose()` on every service built, so no aborted run leaks into the next test.
   - `RecordingConfigWebview` — the `post`/`onMessage`/`send` recorder copied from test/configPanel.controller.test.ts.
   - `newDir()` / `writeConfigFile(dir, text)` + `afterEach` cleanup (`fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-model-selector-'))`), same as test/configPanel.controller.test.ts.
   - `fakeSecrets(initial: Record<string,string>)` -> `SecretsLike` plus a mutable `set(key, value)` so a stored key can appear mid-test; `fakeWorkspaceState(initial)` -> `MementoLike` recording updates; `fakeSettings(overrides)` -> `ProviderSettings`; `fakeLm(modelIds)` -> the `{ lm: { selectChatModels } }` shape `CopilotVscodeApi` needs (empty array = Copilot unavailable).
   - `waitFor(condition, what)` — the 5 s poll helper from test/chatController.autoMode.test.ts, for the fire-and-forget `ChatController.start()` post.

   Files: `test/modelSelectorRefresh.test.ts`

2. Leg 1 — reload refresh end to end (describe: 'model selector refresh: reload refresh')

   Cases:

   1. 'a window reload refreshes every source and the config panel picks it up without a second loaded'. Build `buildDiscovery` with the fixture feed (`fetchFeed: async () => ok(fixtureFeed())`), the default codex payload and the opencode payload. Write `defaultConfigJson()` into a temp dir. Build `new ConfigPanelController({ webview, baitonDir: dir, agentIds: ['claude','opencode','antigravity','codex'], getCapabilities: () => agentCapabilities(store.table()), onDidChangeCapabilities: (l) => discovery.onDidChange(l), confirmReset: async () => false, log: () => {} })`, `controller.start()`, `await webview.send({ type: 'ready' })`. Assert exactly one `loaded`; its `options.byAgent.claude.models` deep-equals `builtinAgentCapabilities().claude.models` (the pre-refresh builtin table) and carries no `stale`/`fetchedAt` own key. Then `await discovery.refresh()`. Assert: at least one `optionsChanged` was posted and NO second `loaded`; the LAST `optionsChanged.options.byAgent.claude.models` contains `claude-opus-5-5` and `claude-sonnet-5`; `byAgent.codex.models` deep-equals `['gpt-6-astra','gpt-5-codex']` and `byAgent.codex.efforts` is the union `['low','medium','high','xhigh','minimal']` (assert as a set-equality over the returned array so the union order stays the implementation's business); `byAgent.opencode.models` contains `anthropic/claude-sonnet-5`; `byAgent.antigravity.models` deep-equals `builtinAgentCapabilities().antigravity.models` and its entry has NO `source`/`stale`/`fetchedAt` own key (antigravity is never overlaid, `AGENT_CATALOG_SOURCE` has no entry for it).

   2. 'the persisted snapshots come back as cached on the next window, before any fetch'. Reuse the SAME `fakeMemento` from case 1 (or re-run a refresh first in this case): assert `memento.store.get(MODEL_CATALOG_MEMENTO_KEY)` has `version === MODEL_CATALOG_PERSIST_VERSION`, then build a SECOND `CatalogStore` over that memento with fresh builtins and assert, with no refresh at all, `store2.get('claude')!.source === 'cached'`, `stale === false`, and `agentCapabilities(store2.table()).claude.models` contains `claude-opus-5-5` — i.e. a reload shows the last good list immediately. Then `await discovery2.refresh()` and assert `store2.get('claude')!.source === 'live'`.

   3. 'refresh never blocks and never rejects'. Build a service whose `fetchFeed` returns a promise that never settles and whose codex spawner never replies (`timeoutMs: 50`). Assert `agentCapabilities(store.table())` is answerable synchronously while the refresh is in flight (claude models equal the builtin seeds), then `await discovery.refresh()` resolves (no rejection) and every source that had a seed still has a snapshot. Also assert a second `refresh()` started before the first settles resolves too, and that an adapter whose `discoverModels` throws synchronously (a one-off `throwingAdapter`-style literal) does not reject the refresh.

   Files: `test/modelSelectorRefresh.test.ts`

3. Leg 2 — discovery fallback and stale-list handling (describe: 'model selector refresh: discovery fallback')

   Cases:

   1. 'every source failing keeps the curated builtin lists and marks them stale'. `fetchFeed: async () => err('models.dev request failed: ETIMEDOUT')`, `claudeFeed` also failing (the claude adapter falls back to its own fetcher only when `ctx.feed` is absent — which is exactly the case after a feed failure), codex spawner in `fail` mode, opencode `fetchModels` rejecting AND `runModelsCli` returning `undefined`. `await discovery.refresh()`. Assert per source `store.get(id)!.stale === true`, `staleReason` non-empty, `models` deep-equal to the builtin seed's models (`builtinCatalogFetches()[id]!.models`), and `fetchedAt` unchanged from the seeded value. Then `const caps = agentCapabilities(store.table())`: `caps.claude.models` deep-equals `builtinAgentCapabilities().claude.models`, `caps.claude.stale === true`, `caps.claude.source === 'builtin'`; `caps.antigravity` has no `stale` own key. Assert `store.get('models.dev')` is `undefined` (models.dev has no builtin seed, so a never-successful source records nothing) — this is the documented `applyResult` contract.

   2. 'a failure after a success keeps the last good list' (the core stale-list guarantee). One successful refresh with the fixture feed; capture `store.get('claude')!` (`models`, `fetchedAt`). Swap the fetchers to failing ones (build the service with mutable closures so the second refresh fails) and `await discovery.refresh()` again. Assert the claude snapshot's `models` and `fetchedAt` are byte-identical to the captured ones, `source` is still `'live'`, `stale === true`, `staleReason` names the failure. Assert the config panel's last `optionsChanged.stale.claude` is `{ stale: true, reason: <staleReason>, fetchedAt: <same fetchedAt> }` — the panel's per-agent stale note — while `options.byAgent.claude.models` still lists the refreshed ids.

   3. 'a later success clears the stale mark'. Third refresh with the fetchers restored: `stale` is absent/false, `staleReason` gone, `fetchedAt` advanced (inject `now` as an incrementing stub), and the panel's last `optionsChanged.stale` has no `claude` entry with `stale: true`.

   4. 'one failing source never poisons the others' — codex failing while the feed succeeds: `store.get('codex')!.stale === true` with the curated `CODEX_MODELS`, while `store.get('claude')!.stale === false` with the feed-derived list.

   Files: `test/modelSelectorRefresh.test.ts`

4. Leg 3 — provider filtering, hidden providers and key-driven reveal (describe: 'model selector refresh: provider filtering')

   Build the router the way commands.ts does: `new ProviderRouter({ secrets, workspaceState, settings: fakeSettings({ getEndpoint: () => undefined, getModel: () => undefined }), lm: fakeLm([]), version: '1.2.3', catalog: { snapshot: () => store.get('models.dev'), feed: () => discovery.feed() }, log: () => {} })`, after `await discovery.refresh()` with the fixture feed.

   Cases:

   1. 'availability lists only configured providers'. Secrets hold only `providerSecretKey('anthropic')` (`baiton.orchestrator.key.anthropic`). `await router.init(); await router.refresh();` then `const av = await router.availability()`. Assert `av.map(e => e.id)` deep-equals `['anthropic']`, every entry has `enabled === true` and no `reason` own key, and `av[0].models` contains `claude-opus-5-5` (the feed-derived snapshot list, not a hard-coded one). Assert `av[0].fetchedAt` equals the snapshot's `fetchedAt`.

   2. 'unconfigured providers are hidden, each with its reason'. `const hidden = await router.hiddenProviders()`. Assert the ids include `copilot`, `google`, `mistral`, `opencode`, `openai` and the feed-only ids (`deepseek`, `deepinfra`, `cerebras`, `baseten`), that none appears in `availability()`, and that the reasons are exactly the catalog strings: `COPILOT_UNAVAILABLE_REASON` for copilot, `PROVIDER_NEEDS_ENDPOINT_REASON` for `openai` once a key is stored but no endpoint is set, `providerNeedsKeyReason(id, ...)` otherwise.

   3. 'legacy secret slots still enable their providers'. Store keys under `baiton.orchestrator.key.google` / `.mistral` / `.opencode` (the pre-refresh names), `await router.refresh()`, and assert all three now appear in `availability()` with feed-derived model lists (google's `models` contain `gemini-2.5-pro` from the fixture and the entry's base URL override is irrelevant here — assert the model list, not the URL).

   4. 'a hidden feed provider becomes usable once its key is stored' (what the Set-API-key quick pick enables). Assert first that `providerCatalog(discovery.feed()).some(p => p.id === 'deepseek' && p.requiresKey)` — the quick pick's candidate set includes the hidden provider — then `secrets.set(providerSecretKey('deepseek')!, 'sk-test')`, `await router.refresh()`, and assert `deepseek` is now in `availability()` with the fixture's `deepseek-chat`/`deepseek-reasoner` and is gone from `hiddenProviders()`. Add a one-line comment that the quick-pick UI itself is covered by test/setApiKey.test.ts, which needs the vscode loader this suite avoids.

   5. 'an offline window falls back to the five builtin providers'. A router whose `catalog` snapshot/feed both return `undefined`, with only the `google` key stored: `availability()` is `['google']` with the builtin `gemini-2.5-*` list, and `hiddenProviders()` ids are exactly the other four builtins.

   Files: `test/modelSelectorRefresh.test.ts`

5. Leg 4 — provider-first selection in the Chat view, through ChatController (describe: 'model selector refresh: provider-first selection')

   Two halves, joined by the real `setProviders` message.

   Half A — host: construct a `ChatController` with `providers: router` (the real router from leg 3), a recording `FakeWebview` (`post` pushes, `onMessage` stores the handler), a temp `baitonDir`/`specsDir`, and the minimal remaining deps the constructor needs, copied from test/chatController.autoMode.test.ts's literal: `client` (a stub `ModelClient` whose `complete` is never called), `registry` (`{ call: async () => ({ ok: true, data: '' }) } as unknown as ToolRegistry`), `toolsFor: () => []`, `guardContext: () => ({}) as GuardContext`, `roundBound: () => 4`, `config: { getEndpoint: () => undefined, getModel: () => undefined }`, `triggerFix: () => {}`, `log: () => {}`. `controller.start()`, then `await waitFor(() => posted.some(m => m.type === 'setProviders'), 'setProviders')`. Assert on the posted message: `groups.map(g => g.id)` equals the configured ids from `availability()` (no hidden provider is posted); every group has `enabled: true`; the stale group carries `stale: true` + `staleReason` (arrange it by failing the feed on a second refresh first, as in leg 2 case 2, then `await router.refresh()` and take the latest `setProviders`); `refreshedAt` equals the snapshot's `fetchedAt`; a preserved selection's model appears as a `{ id, custom: true }` item. Call `controller.dispose()` at the end of each case.

   Half B — webview: take THAT posted message verbatim and feed it into `media/chat.js` in a `vm` sandbox over a compact fake DOM. Duplicate a minimal `FakeEl`/`FakeClassList` and the `loadChatView()` loader from test/chatView.providers.test.ts (only the surface chat.js touches: `children`, `options`, `value`, `selected`, `disabled`, `textContent`, `dataset`, `classList`, `title`, `appendChild`, `replaceChildren`/`remove` as that file implements them, plus the `ELEMENT_IDS` list including `provider-select`, `model-select`, `model-stale`, `model-set-key`). Duplicating rather than extracting is deliberate: T15's file list is this test plus README.md, and the T09 suite set the same precedent for self-contained view harnesses — say so in a comment.

   Cases:
   1. 'only configured providers reach the provider select' — `provider-select` option values equal the posted group ids in host order; no hidden provider id appears anywhere in either select.
   2. 'the model select shows only the chosen provider models' — after the seed paint, `model-select` values equal the first group's model ids; setting `provider-select.value` to the second group's id and firing its `change` handler repaints the models and posts NOTHING.
   3. 'the stale badge follows the chosen provider' — selecting the stale group makes `model-stale` visible with text mentioning 'stale' and `title` equal to the group's `staleReason`; selecting a fresh group clears text, class and title.
   4. 'a custom (preserved) model stays selectable and postable' — the `custom: true` item renders with a '(custom)' marker, can be selected, and firing the model select's `change` posts exactly one `selectModel` carrying `{ provider, model }` for that id; feeding that payload into `router.select(...)` returns `true` and `router.getSelection()` equals it — closing the loop back to the host.
   5. 'the Set API key affordance appears when nothing is usable' — post a `setProviders` with `groups: []` and assert `model-set-key` becomes visible and its click posts `triggerFix`.

   Files: `test/modelSelectorRefresh.test.ts`

6. Leg 5 — config and selection round-trip (describe: 'model selector refresh: round-trip')

   Cases:

   1. 'a configured model a refresh does not list stays listed and saveable'. Write a `.baiton/config.json` built from `defaultConfig()` with one role set to `{ agent: 'claude', model: 'claude-opus-4-legacy', effort: 'high' }` and another to `{ agent: 'codex', model: 'gpt-5-codex', effort: 'xhigh' }`. `ready` -> `loaded`; `await discovery.refresh()` with the fixture feed and the default codex payload -> the last `optionsChanged.options.byAgent.claude.models` CONTAINS `claude-opus-4-legacy` (appended by `configFormOptions(agentIds, caps, form)`) while also containing `claude-opus-5-5`, and `byAgent.codex.efforts` contains `xhigh`. Then `await webview.send({ type: 'save', form: <the loaded form, unmodified>, token: <the loaded token> })`: assert exactly one `saved` (no `saveFailed`), `loadConfig` of the file is OK, and the file still names `claude-opus-4-legacy` and `xhigh`.

   2. 'an agent id no longer installed still round-trips' — same shape with a role whose `agent` is `agy-legacy`: it appears in `optionsChanged.options.agents` after the refresh, and the panel's own validation accepts the unmodified save.

   3. 'a persisted ModelSelection whose provider left the feed survives a refresh'. `workspaceState` pre-seeded with `{ [MODEL_SELECTION_KEY]: { provider: 'anthropic', model: 'claude-opus-9-gone' } }` and the anthropic key stored. `await router.init()` -> `router.getSelection()` deep-equals the stored pair (the model is NOT validated away), `workspaceState` recorded NO update for `MODEL_SELECTION_KEY`, and the `anthropic` availability entry lists `claude-opus-9-gone` in `customModels` and inside `models`. After `await discovery.refresh()` + `await router.refresh()` the selection is still the stored pair.

   4. 'a persisted selection whose provider is unconfigured comes back when its key returns' — seed `{ provider: 'deepseek', model: 'deepseek-chat' }` with no deepseek key: `init()` routes to the first configured provider and persists nothing; `secrets.set(providerSecretKey('deepseek')!, 'k'); await router.refresh();` -> `getSelection()` is the stored deepseek pair again.

   Files: `test/modelSelectorRefresh.test.ts`

7. Rewrite the README discovery section (and the two provider sections it contradicts)

   1. Replace the body of `#### Agent Model & Effort Discovery (CLI Probing & Architecture)` (README.md ~lines 468-483). The current text asserts static catalogues are the decision and lists dynamic discovery as a roadmap item; that is now wrong. New content, keeping the heading text and the bullet style of the surrounding document:
   - One lead sentence: model lists are refreshed asynchronously on every window reload from authoritative sources, with the curated catalogues as the offline fallback.
   - **Sources**, one bullet each: `claude` — the `anthropic` provider of the models.dev feed (`https://models.dev/api.json?type=all`, `src/orchestrator/modelsDev.ts`), efforts stay `low|medium|high`, `claude-sonnet-5` always present; `codex` — `codex app-server` over stdio JSON-RPC (`initialize` -> `initialized` -> `model/list`), per-model `supportedReasoningEfforts` becoming the effort list; `opencode` — `GET /api/model` from a running/started server with `opencode models` stdout as fallback, `provider/model` ids, effort free text; `antigravity` (`agy`) — unchanged curated catalogue and model/effort mapping, never overlaid (no `AGENT_CATALOG_SOURCE` entry); models.dev additionally backs the orchestrator's provider catalog.
   - **How a refresh behaves**: `ModelDiscoveryService` (`src/activation/modelDiscovery.ts`) runs every source in parallel behind a per-source timeout, never awaited by activation and never able to fail it; outcomes land in the `CatalogStore` (`src/orchestrator/modelCatalog.ts`), which persists the last good snapshot per source in `globalState` under `baiton.models.catalog`; a failed refresh keeps the previous list and marks it `stale` with a reason, and a later success clears it; **Baiton: Refresh Model Lists** (`baiton.refreshModels`) re-runs it on demand.
   - **What survives**: existing `.baiton/config.json` values and the persisted `ModelSelection` always round-trip — a configured agent/model/effort missing from a refreshed list is appended and stays editable, and the config panel shows a per-agent "stale — showing last known models" note.
   - **Privacy**: discovery reads no secret or credential; only model ids and labels leave the host, and webviews receive ids, labels and stale metadata only.
   - Keep the CLI-probe findings that are still facts (no `claude models` subcommand, `agy models` exists, `codex` has no `models` subcommand, `opencode models` lists provider-prefixed ids) as a short **CLI capabilities** bullet list; drop the "Why static capability catalogues" and "Roadmap for dynamic discovery" bullets, replacing the latter with a sentence that the curated catalogues remain the builtin fallback.

   2. Fix `### Providers and models` (~316-338): it says "one of five inference providers" with a five-row table. Reword to: the builtin base (`copilot`, `google`, `opencode`, `mistral`, `openai`/Custom) plus every provider the models.dev feed lists, built by `providersFromFeed`/`buildProviderCatalog` in `src/orchestrator/providers.ts`; keys stay at `baiton.orchestrator.key.<id>` so existing `google`/`mistral`/`opencode`/`openai` secrets keep working. Keep the table but re-title the Models column as the builtin/offline fallback and add a sentence that a configured provider's live list comes from the refreshed snapshot.

   3. Fix `#### The Provider & Model dropdown` (~360-382): replace the single grouped `<select>` description with the provider-first pair — a provider `<select>` followed by a model `<select>` populated from the chosen provider; only CONFIGURED providers are listed (unconfigured ones are hidden and reachable through **Baiton: Set Provider API Key**, which quick-picks every keyed provider in the live catalog); a stale badge appears beside the model select when the active provider's snapshot is stale; a selection whose model is not in the list renders as a selectable `(custom)` option rather than being dropped. Keep the existing sentences about host authority (`selectModel` -> `setProviders`), the disabled-while-running rule, and `MODEL_SELECTION_KEY` persistence.

   Do not touch the `Harness ask relay` probe findings or any other section.

   Files: `README.md`

8. Verify

   Run, in order, and report the real output:
   - `npx tsc --noEmit -p tsconfig.json` (the new test file is type-checked by the project config).
   - `npx eslint test/modelSelectorRefresh.test.ts --ext .ts`.
   - `npx mocha test/modelSelectorRefresh.test.ts` — every case green.
   - `npx mocha test/modelSelectorRefresh.test.ts test/modelDiscovery.test.ts test/modelCatalog.test.ts test/providers.test.ts test/providerRouter.test.ts test/configPanel.controller.test.ts test/configPanel.view.test.ts test/chatView.providers.test.ts test/webviewProtocol.mirror.test.ts test/setApiKey.test.ts` — proves the new suite coexists with the loader-using setApiKey suite in one process, in both orders if a failure appears.
   - `npm run test:unit` — expect the single pre-existing `test/activation.gating.test.ts` keytar native-module failure and no new ones.
   - `git status --porcelain` — exactly `test/modelSelectorRefresh.test.ts` (new) and `README.md` (modified).

   Files: `test/modelSelectorRefresh.test.ts`, `README.md`

## Risks

- GAP FOUND, outside this todo's file list: `src/extension.ts:192` still passes `capabilities: agentCapabilities()` and never passes `getCapabilities`/`onDidChangeCapabilities` to `registerConfigPanel` — `src/activation/configPanel.ts:206-215` documents that host wiring as 'a separate step' because the panel is registered BEFORE the `CatalogStore`/`ModelDiscoveryService` are built. So in a real window the config panel's model lists do NOT refresh today, even though every seam for it exists. The plan therefore wires the documented seam itself in leg 1 (`getCapabilities: () => agentCapabilities(store.table())`, `onDidChangeCapabilities: (l) => discovery.onDidChange(l)`) rather than asserting on `extension.ts`. Do NOT edit `src/extension.ts` under T15 (its file list is the test plus README) — surface this to the user as a follow-up; a one-line reorder in `activate()` (build the store/discovery before `registerConfigPanel`, pass the two callbacks) closes it.
- The suite must stay free of the `test/fixtures/vscodeLoader.mjs` hook: `setProviderApiKey` needs it, and registering a module customization hook is process-global. Leg 3 case 4 therefore asserts the quick pick's INPUT (`providerCatalog(feed)` membership) and its EFFECT (key stored -> provider becomes available) instead of importing `setApiKey.ts`. If a later reader wants the quick pick in the e2e chain, it belongs in test/setApiKey.test.ts, not here.
- Duplicating the fake DOM and the codex app-server fake inflates the file (expect 700-1000 lines). Extracting them to a shared `test/fixtures/` module would be cleaner but adds a third file the todo does not list; duplication matches the T09 precedent. Keep each copy trimmed to the surface actually exercised.
- Timing: `ModelDiscoveryService.onDidChange` fires ONCE PER SOURCE as it lands, so `optionsChanged` is posted several times per refresh. Assert on the LAST `optionsChanged` (and on 'at least one'), never on an exact count. `ChatController.start()` posts `setProviders` fire-and-forget — always go through `waitFor`, never a bare `await`.
- `store.get('models.dev')` is `undefined` when the feed never succeeded (no builtin seed for that source). Any leg that fails the feed and then reads the router must expect the builtin provider list and absent `fetchedAt`, not a stale models.dev snapshot.
- The opencode `/api/model` and codex `model/list` payload shapes are only loosely pinned by the adapters' tolerant parsers. Keep the fake payloads in the shapes the adapters' own suites already use, and assert on the resulting ids rather than restating parser rules — otherwise this suite becomes a duplicate of test/adapter.opencode.test.ts / test/adapter.codex.test.ts.
- Every service built must be `dispose()`d and every temp dir removed in `afterEach`; a leaked in-flight refresh with an unresolved fetch keeps mocha alive or leaks a rejection into an unrelated suite (the contract `withTimeout`/`raceAbort` document).
- The README edit spans three sections that currently contradict the shipped behaviour. Rewriting the two provider sections is in scope (README.md is in the file list) but must not disturb the `Harness ask relay` probe findings, which are dated evidence.

## Acceptance

- `test/modelSelectorRefresh.test.ts` exists, imports every module statically with no `vscode` loader hook, and passes on its own and inside `npm run test:unit`.
- A reload-refresh case drives real adapters through `ModelDiscoveryService` -> `CatalogStore` -> `agentCapabilities(table)` -> `ConfigPanelController` and asserts feed-derived claude models, app-server codex models plus their effort union, `provider/model` opencode ids, an untouched antigravity list, exactly one `loaded` and at least one `optionsChanged`.
- A second `CatalogStore` over the same memento returns the previous lists with `source: 'cached'` before any fetch, and `source: 'live'` after one.
- A discovery-fallback case shows every source failing keeps the curated builtin models with `stale: true` and a reason, `refresh()` resolving without rejecting, capabilities answerable synchronously mid-refresh, and `models.dev` recording nothing when it never succeeded.
- A stale-list case proves a failure after a success preserves `models` and `fetchedAt` byte-for-byte while setting `stale`/`staleReason`, that the panel's `optionsChanged.stale.<agent>` mirrors it, and that a later success clears it.
- A provider-filtering case proves `availability()` returns only configured providers (all `enabled`, no `reason`), `hiddenProviders()` carries the rest with the exact catalog reason strings, legacy `baiton.orchestrator.key.<id>` slots still enable `google`/`mistral`/`opencode`, storing a key for a hidden feed provider reveals it, and an offline router falls back to the five builtins.
- A provider-first case feeds a real `ChatController`-posted `setProviders` into `media/chat.js` and asserts: only configured providers in the provider select, models scoped to the chosen provider, a provider change repainting without posting, the stale badge following the chosen provider (text + `staleReason` title, cleared on a fresh one), a `custom` model selectable and posting exactly one `selectModel` that `router.select()` accepts, and the Set-API-key affordance with `triggerFix` when no provider offers a model.
- A round-trip case proves a configured-but-unlisted model, effort and agent stay listed after a refresh and save unchanged (exactly one `saved`, file still naming the original values), and that a persisted `ModelSelection` with a vanished model or an unconfigured provider is preserved, reported as `customModels`, never rewritten in `workspaceState`, and restored when its key returns.
- README's `Agent Model & Effort Discovery` section describes the four sources, the async timeboxed refresh, memento persistence, stale-keeps-last-good, `baiton.refreshModels`, the round-trip guarantee and the no-secrets rule, with no remaining claim that discovery is static or a roadmap item; the `Providers and models` and `Provider & Model dropdown` sections describe the feed-derived catalog and the two-select, configured-only, stale-badged selector.
- `npx tsc --noEmit`, eslint on the new test file, and the targeted mocha run are clean; `npm run test:unit` shows no new failures beyond the pre-existing keytar case; `git status --porcelain` lists only the new test file and README.md.
