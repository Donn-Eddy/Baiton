# Plan T07

## Steps

1. Create the host-free discovery service module skeleton

   New file `src/activation/modelDiscovery.ts`. It must load with NO running VS Code host: import `vscode` only as `import type * as vscode from 'vscode'` (or not at all) — follow the header/doc style of `src/activation/providerRouter.ts`, which documents exactly this constraint. Imports: `type { Adapter, AgentCapabilities, AgentId }`, `AGENT_CATALOG_SOURCE`, `DEFAULT_DISCOVERY_TIMEOUT_MS`, `capabilitiesToCatalogFetch` from `../adapter/adapter`; `builtinAgentCapabilities` from `../adapter` (the barrel; it is the documented builtin seed source); `CatalogStore`, `type CatalogFetch`, `type CatalogSourceId`, `type ModelCatalogTable`, `type ModelEntry` from `../orchestrator/modelCatalog`; `fetchModelsDev`, `type ModelsDevFeed` from `../orchestrator/modelsDev`; `ok`, `err`, `isOk`, `type Result` from `../model/result`. Write a file header comment in the repo's style: this module owns the asynchronous, timeboxed refresh of every catalog source on window reload, never throws, never blocks activation, and feeds `CatalogStore.applyResult` only — the store owns provenance (`source`/`fetchedAt`) and persistence.

   Files: `src/activation/modelDiscovery.ts`

2. Export builtinCatalogFetches() — the CatalogStore builtin seeds

   In `src/activation/modelDiscovery.ts` export `builtinCatalogFetches(): Partial<Record<CatalogSourceId, CatalogFetch>>`. Implementation: start from `builtinAgentCapabilities()`; for each `agent` of `Object.keys(...) as AgentId[]`, read `const sourceId = AGENT_CATALOG_SOURCE[agent]`; skip when `undefined` (this is exactly what keeps `antigravity` out — its curated catalogue is never overlaid or seeded); otherwise set `out[sourceId] = capabilitiesToCatalogFetch(caps[agent])`. No entry for `'models.dev'` (there is no curated feed fallback). Returns a fresh object on every call (factory convention of `builtinAgentCapabilities`/`defaultConfig`). Pure, never throws. The host passes this as `CatalogStore`'s `builtins` so a first-ever window with no memento and no network still shows the curated lists (`source: 'builtin'`).

   Files: `src/activation/modelDiscovery.ts`

3. Define the service's injected dependency surface

   In `src/activation/modelDiscovery.ts`:

   - `export const MODEL_DISCOVERY_SOURCE_TIMEOUT_MS = DEFAULT_DISCOVERY_TIMEOUT_MS;` — the default per-source wall-clock budget.
   - `export type FeedFetcher = (options: { timeoutMs: number; signal?: AbortSignal }) => Promise<Result<ModelsDevFeed, string>>;`
   - `export interface DiscoveryRegistry { get(agent: string): Adapter | undefined; readonly ids: readonly AgentId[] }` — structurally satisfied by `AdapterRegistry` from `src/adapter/index.ts`, so the host passes the real registry and the test passes a literal.
   - `export interface ModelDiscoveryOptions {`
     `store: CatalogStore;`
     `registry: DiscoveryRegistry;`
     `/** Defaults to a wrapper over fetchModelsDev({ timeoutMs }). */ fetchFeed?: FeedFetcher;`
     `/** Read per refresh, never hoisted: activation may resolve the workspace after the service is built. */ cwd?: () => string | undefined;`
     `/** Per-source budget; defaults to MODEL_DISCOVERY_SOURCE_TIMEOUT_MS. */ timeoutMs?: number;`
     `log?: (message: string) => void;`
   `}`

   The default `fetchFeed` is `(o) => fetchModelsDev({ timeoutMs: o.timeoutMs })` (fetchModelsDev already owns its own AbortController + timer). Nothing here reads a secret, an env var or SecretStorage — document that only ids and labels ever leave the host.

   Files: `src/activation/modelDiscovery.ts`

4. Implement ModelDiscoveryService: refresh(), feed(), table(), onDidChange(), dispose()

   `export class ModelDiscoveryService` in `src/activation/modelDiscovery.ts`. Private state: `readonly options`, `listeners = new Set<(table: ModelCatalogTable) => void>()`, `inFlight: { controller: AbortController; done: Promise<ModelCatalogTable> } | undefined`, `lastFeed: ModelsDevFeed | undefined`, `disposed = false`.

   Public API:

   1. `table(): ModelCatalogTable` → `this.options.store.table()`.
   2. `feed(): ModelsDevFeed | undefined` → the last SUCCESSFULLY parsed models.dev feed (so T09's provider catalog and any later consumer need no second network call).
   3. `onDidChange(listener: (table: ModelCatalogTable) => void): { dispose(): void }` → copy the exact pattern of `ProviderRouter.onDidChangeSelection`/`fire()` at src/activation/providerRouter.ts:395-415: add to the Set, return a handle whose `dispose()` deletes it; a private `fire()` iterates `[...this.listeners]`, wraps each call in try/catch and routes a throw to `log` so one bad listener cannot break the others. Document that listeners may be called several times per refresh and must tolerate an unchanged table (same contract as `router.refresh()`).
   4. `refresh(): Promise<ModelCatalogTable>` — NEVER rejects. If `this.disposed`, return `Promise.resolve(this.table())`. If a refresh is in flight, `controller.abort()` it first (the superseded run stops writing: see the generation guard below) and start a new one; the new `AbortController` is stored with the promise. Body:
      - `const signal = controller.signal; const timeoutMs = this.options.timeoutMs ?? MODEL_DISCOVERY_SOURCE_TIMEOUT_MS; const cwd = this.options.cwd?.();`
      - Kick the feed off FIRST but do not await it before starting the CLI sources: `const feedPromise = this.refreshFeed(signal, timeoutMs);` then build the adapter jobs. `claude` awaits `feedPromise` and passes the resolved feed as `ctx.feed` (so the feed is fetched exactly once per refresh — the claude adapter falls back to its own fetcher only when `ctx.feed` is undefined); `codex` and `opencode` start immediately. Gather with `await Promise.all([...])` so every source runs in parallel.
      - Adapter job, `private async refreshAgent(agent: AgentId, sourceId: CatalogSourceId, ctx-parts)`: `const adapter = this.options.registry.get(agent)`; if `adapter?.discoverModels === undefined` return without touching the store (an adapter with no discovery seam — antigravity — must never be marked stale and never gets a snapshot). Otherwise build `const ctx: DiscoveryContext = { timeoutMs, signal, ...(cwd !== undefined ? { cwd } : {}), ...(feed !== undefined ? { feed } : {}), log: (m) => this.log(`${agent} model discovery: ${m}`) }` and call `this.withTimeout(adapter.discoverModels(ctx), timeoutMs, agent)`. Map the outcome to a `Result<CatalogFetch, string>`: an `AgentCapabilities` → `ok(capabilitiesToCatalogFetch(caps))`; `undefined` → `err(`${agent} model discovery returned no models`)`; a rejection (contract-breaking, but the service must survive it) → `err(`${agent} model discovery failed: ${message}`)`; the timeout → `err(`${agent} model discovery timed out after ${timeoutMs}ms`)`. Then `this.apply(sourceId, result, controller)`.
      - Feed job, `private async refreshFeed(signal, timeoutMs): Promise<ModelsDevFeed | undefined>`: call the injected `fetchFeed({ timeoutMs, signal })` inside try/catch + `withTimeout`. On `ok`, store `this.lastFeed = feed`, `this.apply('models.dev', ok(feedCatalogFetch(feed)), controller)` and return the feed. On failure/timeout/throw, `this.apply('models.dev', err(reason), controller)` and return `undefined`.
      - `private apply(sourceId, result, controller)`: if `controller.signal.aborted || this.disposed` → return WITHOUT writing (the generation guard: a superseded or torn-down refresh must not overwrite a newer snapshot or persist late). Else `this.options.store.applyResult(sourceId, result)`, log one line naming the source and outcome, then `this.fire()` with the full current table so an open view repaints progressively.
      - Resolve `this.table()`, clear `this.inFlight` when it still points at this run, and return the table.
   5. `dispose(): void` — set `disposed = true`, `this.inFlight?.controller.abort()`, `this.listeners.clear()`. Idempotent.

   Private helpers: `withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error'; message: string }>` — a defensive second line of defence over an adapter that ignores `ctx.timeoutMs`; `setTimeout(...).unref?.()`, always `clearTimeout` in a `finally`, and always consume the losing promise's rejection so no unhandled rejection escapes into unrelated suites (same requirement `ClaudeAdapter.raceAbort` documents). `feedCatalogFetch(feed: ModelsDevFeed): CatalogFetch` — flatten the feed to `ModelEntry[]`, one entry per provider/model pair, as `{ id: model.id, provider: provider.id, ...(model.name !== model.id ? { label: model.name } : {}) }`; the BARE model id is the `id` (that is what `ModelSelection.model` stores) and the provider half rides on `provider`, so duplicate ids across providers are expected and only a (provider, id) pair is de-duplicated; source order preserved; no `efforts` on the fetch. `log(message)` → `this.options.log?.('Baiton model discovery: ' + message)`. `describe(value: unknown): string` for error messages (`value instanceof Error ? value.message : String(value)`), matching modelCatalog.ts's `errorMessage`.

   Files: `src/activation/modelDiscovery.ts`

5. Export the service from the activation barrel

   Add `export * from './modelDiscovery';` to `src/activation/index.ts` alongside the existing `./engineVersion`, `./workspace`, `./executable` exports, and extend that file's header comment with one clause naming the model-discovery service. Before adding it, grep the repo for each new exported name (`ModelDiscoveryService`, `ModelDiscoveryOptions`, `DiscoveryRegistry`, `FeedFetcher`, `builtinCatalogFetches`, `MODEL_DISCOVERY_SOURCE_TIMEOUT_MS`) to confirm no collision with an already-exported symbol; if one collides, rename the new symbol rather than shadowing.

   Files: `src/activation/index.ts`

6. Add the command id to the single COMMANDS table

   In `src/activation/commands.ts`, add `refreshModels: 'baiton.refreshModels',` to the `COMMANDS` object literal (src/activation/commands.ts:142-159), placed next to `openConfigPanel`. Nothing else in `commands.ts` changes: the command is registered in `src/extension.ts`, where the discovery service lives, and the provider-router/catalog wiring belongs to a later todo (the existing `void legacyMigration.then(() => router.init()).then(() => router.refresh())` at src/activation/commands.ts:517 stays exactly as it is).

   Files: `src/activation/commands.ts`

7. Wire the store, the service and the refresh command into activation

   In `src/extension.ts`, all inside `activate()` BEFORE the gated `completeActivation()` call (discovery must work even when workspace resolution or config load fails, exactly like the config panel registration already does):

   1. Extend the imports: `CatalogStore` from `./orchestrator/modelCatalog` (plus `type ModelCatalogTable` if referenced), `ModelDiscoveryService` + `builtinCatalogFetches` from `./activation/modelDiscovery` (or via `./activation`), `COMMANDS` from `./activation/commands` (add to the existing import list from that module), and `createAdapterRegistry` is already imported.
   2. Hoist the registry: replace the inline `agentIds: createAdapterRegistry().ids` in the `registerConfigPanel({ ... })` call with a `const adapterRegistry = createAdapterRegistry();` declared just above and `agentIds: adapterRegistry.ids`. Leave `capabilities: agentCapabilities()` untouched — turning it into a live source is a later todo; this one must not change the panel's contract.
   3. Build the store: `const catalogStore = new CatalogStore({ memento: context.globalState, builtins: builtinCatalogFetches(), log: (m) => surface.log(m) });` (the store's own constructor rehydrates the persisted snapshots and seeds the builtins — nothing else to do).
   4. Build the service: `const discovery = new ModelDiscoveryService({ store: catalogStore, registry: adapterRegistry, cwd: () => getActivationState()?.workspace.root.fsPath, log: (m) => surface.log(m) });` — the `cwd` accessor is a closure precisely because the workspace is resolved later in `completeActivation()`.
   5. Module-level state + accessors mirroring `activationState`/`getActivationState()`: `let modelCatalogStore: CatalogStore | undefined;`, `let modelDiscovery: ModelDiscoveryService | undefined;` reset to `undefined` at the top of `activate()` and in `deactivate()`, assigned here, plus `export function getModelCatalogStore(): CatalogStore | undefined` and `export function getModelDiscovery(): ModelDiscoveryService | undefined` so the later config-panel and provider-router todos have one source of truth.
   6. Register the command: `context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.refreshModels, () => discovery.refresh().then(() => undefined)));` — the handler returns a promise so the palette shows progress, and `refresh()` never rejects. Do NOT gate it on `baiton.activated`.
   7. Register teardown: `context.subscriptions.push(new vscode.Disposable(() => { discovery.dispose(); modelDiscovery = undefined; modelCatalogStore = undefined; }));`
   8. Log-only subscription for now (the config-panel/router consumers land in later todos): `context.subscriptions.push(discovery.onDidChange((table) => surface.log(`Baiton: model catalog updated (${Object.keys(table).join(', ')}).`)));`
   9. Start the refresh WITHOUT awaiting it, as the last discovery statement: `void discovery.refresh();` — add a comment stating that activation never awaits discovery and that every failure degrades to a stale-marked or builtin list.

   Nothing in `completeActivation()` changes.

   Files: `src/extension.ts`

8. Contribute the command in package.json

   In `package.json`, add to `contributes.commands` (after the `baiton.openConfigPanel` entry): `{ "command": "baiton.refreshModels", "title": "Refresh Model Lists", "category": "Baiton" }`. Do NOT add a `contributes.menus.commandPalette` entry for it — discovery runs before the activation gate, so, like `baiton.initialize` and `baiton.openConfigPanel`, it must stay visible while `baiton.activated` is false (see the assertions at test/activation.gating.test.ts:472-507). Keep the JSON formatting (2-space indent) byte-consistent with its neighbours and re-run `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` to confirm the file still parses.

   Files: `package.json`

9. Write test/modelDiscovery.test.ts

   New mocha + `assert` suite, STATICALLY importing `../src/activation/modelDiscovery` (no vscode loader dance — the module is host-free, like test/providerRouter.test.ts explains for the router). Local fakes, all in-file:
   - `fakeMemento()` — a Map-backed `{ get, update }` recording every `update` call.
   - `fakeAdapter(id, impl)` — an object with just `{ id, discoverModels }` cast to `Adapter`, recording every `ctx` it was handed; variants: resolves capabilities, resolves `undefined`, rejects, throws synchronously, never settles, and one with `discoverModels: undefined` (the antigravity shape).
   - `fakeRegistry(map)` — `{ get: (a) => map[a], ids: Object.keys(map) }`.
   - `fakeFeed()` — reuse `test/fixtures/modelsDev.sample.json` via `fs.readFileSync` + `parseModelsDevFeed` (the pattern at test/modelsDev.test.ts:20) so the feed shape is real, and a `fetchFeed` spy counting calls.
   - A deterministic `now` for the `CatalogStore`.

   Cases (describe blocks headed `T07`):
   1. `refresh()` drives all four sources: each adapter's `discoverModels` was called exactly once, the feed fetcher exactly once, and the claude adapter's `ctx.feed` is the SAME feed object the fetcher returned (no second network call).
   2. `refresh()` resolves the full table; `models.dev`, `claude`, `codex`, `opencode` snapshots are present with `source: 'live'`, `stale: false`.
   3. The `models.dev` snapshot's entries carry bare model ids with the provider id on `provider`, in feed order, and `service.feed()` returns the parsed feed.
   4. Per-source failure semantics: with a store pre-seeded from builtins, an adapter resolving `undefined` (and one rejecting, and one throwing synchronously) leaves that source's previous `models` intact with `stale: true` and a non-empty `staleReason`, while the other sources still land as `live`; `refresh()` itself resolves and never rejects.
   5. A feed fetcher returning `err(...)` marks only `models.dev` stale and still lets the CLI sources land.
   6. An adapter that never settles: with `timeoutMs: 20`, `refresh()` still resolves, that source is `stale` with a timeout reason, and the adapter's `ctx.signal` is not required to be aborted by the timeout but the refresh must not hang (assert with a bounded mocha timeout).
   7. An adapter with no `discoverModels` writes NO snapshot and marks nothing stale.
   8. `ctx.cwd` is the value the injected `cwd()` accessor returned at refresh time, and a `cwd` accessor returning `undefined` leaves `ctx.cwd` absent (no explicit `undefined` own key).
   9. `onDidChange` fires with the current table (at least once per applied source); a throwing listener is logged and does not stop the others or the refresh; the returned handle's `dispose()` unsubscribes.
   10. Persistence: after `refresh()` the fake memento holds a `{ version: 1, snapshots: {...} }` blob under `baiton.models.catalog`; a second `ModelDiscoveryService` over a fresh `CatalogStore` on the same memento starts from `source: 'cached'` snapshots before any refresh.
   11. Supersede: a second `refresh()` while the first is in flight aborts the first run's `signal` (assert via the recorded `ctx.signal.aborted`) and the superseded run writes nothing after the abort; both promises resolve.
   12. `dispose()` aborts the in-flight refresh, fires no further listeners, and a `refresh()` after dispose resolves with the current table without calling any adapter.
   13. `builtinCatalogFetches()`: keys are exactly `['claude','codex','opencode']` (no `antigravity`, no `models.dev`), claude's models contain `claude-sonnet-5`, codex carries a non-empty `efforts`, and two calls return independent objects/arrays.
   14. Host-free guard, mirroring the `fs.readFileSync` regex test in test/modelCatalog.test.ts: the module source contains no runtime `require('vscode')`/`from 'vscode'` import (a `import type * as vscode from 'vscode'` line is allowed).
   Ensure every fake settles or is consumed so the suite leaks no pending timer or unhandled rejection.

   Files: `test/modelDiscovery.test.ts`

10. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json`; `npm run compile`; `npx eslint src/activation/modelDiscovery.ts src/activation/index.ts src/activation/commands.ts src/extension.ts test/modelDiscovery.test.ts --ext .ts`; `npx mocha test/modelDiscovery.test.ts` (the repo `.mocharc` widens this to the whole spec — expect only the known pre-existing `packaging gating: includes zero native modules` keytar failure in test/activation.gating.test.ts); `npm run test:unit`; `npm run test:property`. Also re-check `git status --porcelain` shows only the five files this todo owns (plus package.json), and confirm no `src/orchestrator/*` or `src/adapter/*` file was modified.

   Files: (none)

## Risks

- Double network fetch: if the claude job is started without awaiting the feed promise, `ClaudeAdapter.discoverModels` falls back to its own `fetchModelsDev` and the feed is fetched twice per reload. The claude job MUST await the service's single feed promise and pass the result as `ctx.feed`; the test asserts the fetcher was called exactly once and that `ctx.feed` is the same object.
- A superseded or disposed refresh writing late: an adapter that settles after `refresh()` was superseded (or after `dispose()`) would otherwise overwrite a newer snapshot and persist stale data. The `apply()` generation guard (`controller.signal.aborted || this.disposed` → skip the store write and the fire) is load-bearing and must be covered by a test.
- Unhandled rejections: `withTimeout` and any abort race must consume the losing promise's rejection (the constraint `ClaudeAdapter.raceAbort` documents), otherwise a rejecting fake in this suite surfaces as an unhandled rejection in unrelated suites.
- Leaked timers: every `setTimeout` in `withTimeout` must be `unref()`'d (guarded — `unref` is absent on the browser typing) and cleared in a `finally`, or mocha will not exit.
- Activation must never await discovery: the refresh is started with `void discovery.refresh()`, and no discovery failure may reach `showErrorMessage` or change the activation return value. Keep the service construction and the command registration before the gate so `baiton.refreshModels` works in an uninitialized folder.
- Command-visibility gating: adding `baiton.refreshModels` to `contributes.menus.commandPalette` would hide it until `baiton.activated` is true, which contradicts registering it before the gate; test/activation.gating.test.ts only pins `initialize`/`openConfigPanel`, so this has to be got right by construction.
- Scope creep into later todos: the config panel's `capabilities` dep, `providersFromFeed`, the `ProviderRouter` catalog read and the chat/webview protocol belong to other todos. This todo only exposes `getModelCatalogStore()`/`getModelDiscovery()` and a log-only `onDidChange` subscriber; do not touch `src/orchestrator/providers.ts`, `src/activation/providerRouter.ts`, `src/config/configPanel.ts` or any `media/*.js`.
- Memento write volume: `CatalogStore.applyResult` persists on every source, so one refresh performs up to four `globalState.update` calls. That is accepted (writes are best-effort and swallowed by the store); do not add a debounce that could drop the last write.
- `models.dev` entry-id choice: storing bare model ids with the provider on `ModelEntry.provider` is what keeps a persisted `ModelSelection.model` comparable. Switching to `provider/model` composite ids later would break that round-trip, so document the choice in the module header.
- Baseline test noise: the suite already fails `packaging gating: includes zero native modules` (keytar under node_modules) in every run. Do not attempt to fix it here; report it as pre-existing.

## Acceptance

- `src/activation/modelDiscovery.ts` exists, exports `ModelDiscoveryService`, `ModelDiscoveryOptions`, `DiscoveryRegistry`, `FeedFetcher`, `MODEL_DISCOVERY_SOURCE_TIMEOUT_MS` and `builtinCatalogFetches`, and contains no runtime `vscode` import (only `import type`), proven by a regex guard test over the module source.
- `ModelDiscoveryService.refresh()` runs the models.dev feed plus every adapter with a `discoverModels` seam in parallel, each bounded by a per-source timeout, and resolves a `ModelCatalogTable`; it never rejects for any source outcome (undefined, rejection, synchronous throw, hang, missing seam).
- A failing source keeps its previous snapshot's models and gains `stale: true` with a non-empty `staleReason`; a succeeding source lands as `source: 'live'`, `stale: false`; an adapter without `discoverModels` (antigravity) produces no snapshot at all.
- The feed is fetched exactly once per refresh and handed to the claude adapter as `ctx.feed`; `service.feed()` returns the last successfully parsed feed.
- Snapshots persist through the injected memento under `baiton.models.catalog` as `{ version: 1, snapshots }`, and a new store over the same memento rehydrates them as `source: 'cached'`.
- `onDidChange(listener)` fires with the current table as sources land, tolerates a throwing listener, and its handle's `dispose()` unsubscribes; `dispose()` aborts the in-flight refresh and stops all further writes and fires.
- A second `refresh()` while one is in flight aborts the first (its `ctx.signal.aborted === true`) and the superseded run writes nothing afterwards.
- `src/extension.ts` builds the `CatalogStore` (with `context.globalState` and `builtinCatalogFetches()`) and the `ModelDiscoveryService` before the activation gate, registers `COMMANDS.refreshModels`, registers disposal, and starts the refresh with `void discovery.refresh()` — activation awaits nothing and no discovery failure surfaces an error message; `getModelCatalogStore()` and `getModelDiscovery()` are exported.
- `COMMANDS.refreshModels === 'baiton.refreshModels'` in `src/activation/commands.ts`, and `package.json` contributes that command with title `Refresh Model Lists`, category `Baiton`, and NO `commandPalette` entry; `package.json` still parses.
- `test/modelDiscovery.test.ts` covers all fourteen listed cases and passes, with no leaked timer and no unhandled rejection.
- `npx tsc --noEmit -p tsconfig.json` exits 0, `npm run compile` exits 0, eslint on the five touched files is clean, and `npm run test:unit` plus `npm run test:property` show only the pre-existing `packaging gating: includes zero native modules` keytar failure.
- No file outside `src/activation/modelDiscovery.ts`, `src/activation/index.ts`, `src/activation/commands.ts`, `src/extension.ts`, `package.json` and `test/modelDiscovery.test.ts` is modified; in particular `src/adapter/*`, `src/orchestrator/*`, `src/config/*` and `media/*` are untouched, and antigravity behaviour is unchanged.
