# Plan T11

## Steps

1. Add the host-free catalog seam to ProviderRouterConfig

   In src/activation/providerRouter.ts add, next to the existing SecretsLike / MementoLike structural seams, a new exported interface:

   ```ts
   /**
    * The live model catalog the router reads: the `models.dev` snapshot the
    * discovery service refreshes plus the last successfully parsed feed. Both are
    * read at CALL time (never hoisted), so a refresh that lands after the router
    * was built is picked up by the next availability() call.
    */
   export interface ModelCatalogSource {
     /** `CatalogStore.get('models.dev')`, or undefined when no list is known. */
     snapshot(): ModelCatalogSnapshot | undefined;
     /** `ModelDiscoveryService.feed()`, or undefined until one refresh parsed it. */
     feed(): ModelsDevFeed | undefined;
   }
   ```

   Import the two shapes TYPE-ONLY so the module stays host-free and the unit test keeps loading it statically:
   `import type { ModelCatalogSnapshot } from '../orchestrator/modelCatalog';` and `import type { ModelsDevFeed } from '../orchestrator/modelsDev';`.

   Add `catalog?: ModelCatalogSource;` to `ProviderRouterConfig` (documented as: absent means "no live catalog" — the router then behaves exactly as today, on the five builtin entries).

   Extend `ProviderAvailability` with additive optional fields (do NOT change `models: readonly string[]`, so src/activation/chatController.ts `postProviders()` keeps compiling untouched):
   ```ts
     /** True when the models.dev snapshot backing `models` is no longer known current. */
     stale?: boolean;
     /** Why the snapshot is stale; present only with `stale: true`. */
     staleReason?: string;
     /** ISO-8601 time of the last SUCCESSFUL catalog fetch backing `models`. */
     fetchedAt?: string;
     /** Ids inside `models` that came from a preserved selection, not the catalog. */
     customModels?: readonly string[];
   ```
   Update the module header comment: availability is now catalog-driven and limited to CONFIGURED providers, with the unconfigured ones behind `hiddenProviders()`.

   Files: `src/activation/providerRouter.ts`

2. Derive the provider list and per-provider models from the catalog

   Still in src/activation/providerRouter.ts, replace the hard-coded `PROVIDER_IDS` iteration with catalog-derived enumeration.

   Imports from '../orchestrator/providers': add `buildProviderCatalog`; keep `providerInfo`, `providerSecretKey`, `providerNeedsKeyReason`, `defaultModelFor`, `normalizeModelSelection`, `sameModelSelection`, `PROVIDERS`, `MODEL_SELECTION_KEY`, `COPILOT_UNAVAILABLE_REASON`, `PROVIDER_NEEDS_ENDPOINT_REASON`. REMOVE the now-unused `PROVIDER_IDS` import (tsconfig has noUnusedLocals and eslint no-unused-vars).

   New private members on `ProviderRouter`:

   1. `private catalogEntries(): readonly ProviderInfo[]` — `const entries = [...buildProviderCatalog(this.config.catalog?.feed())]` (with no feed this is byte-identical to today's five builtins, in the same order), then append, in this order and skipping ids already present:
      - every distinct `entry.provider` of the models.dev snapshot, in snapshot order, as `providerInfo(id)` (T10's synthesised `source: 'custom'` fallback: `label === id`, `requiresKey: true`, no base URL). This is the OFFLINE path: the snapshot is persisted but the feed is not, so a window whose fetch has not landed yet still enumerates every provider the cached snapshot knows.
      - the active selection's provider and the preserved selection's provider (step 4), so a persisted id that has left the feed is still enumerated rather than dropped.

   2. `private snapshotModelsFor(id: ProviderId): readonly string[]` — the ids of `this.config.catalog?.snapshot()?.models` whose `provider === id`, de-duplicated, in snapshot order.

   3. `private modelsForInfo(info: ProviderInfo): { models: readonly string[]; fromSnapshot: boolean }` — the snapshot list when non-empty, else `info.models` (the builtin/feed-merged list) with `fromSnapshot: false`.

   4. `private preserveInto(id: ProviderId, models: readonly string[]): { models: readonly string[]; customModels: readonly string[] }` — appends, at the END and without reordering the catalog ids, the model ids this router must keep selectable for `id` and that the list does not already carry: `this.selected?.model` when `this.selected?.provider === id`, `this.preserved?.model` when `this.preserved?.provider === id`, and `this.lastModel.get(id)`. Trim, skip blanks and duplicates (exact, case-sensitive match) — the same semantics as `mergePreservingExisting` in src/orchestrator/modelCatalog.ts, applied to a bare id list; say so in the doc comment. The appended ids are the entry's `customModels`.

   Rewrite `availabilityOf` into `private async computeEntry(info: ProviderInfo): Promise<ProviderAvailability>` taking the resolved catalog entry (not a bare id), keeping the three existing branches verbatim in behaviour:
      - `copilot` → `copilotAvailability()` unchanged (models from `vscode.lm`, never stale, no `fetchedAt`);
      - `openai` → `openAiAvailability(info)` unchanged (key first, then endpoint, models = the `baiton.orchestrator.model` setting when set), never stale;
      - any other id → keyed on `providerSecretKey(id)!` exactly as today, with `models` from `modelsForInfo(info)`.
   After the branch, for entries whose models came from the snapshot (`fromSnapshot === true`) copy `fetchedAt` from the snapshot and, when `snapshot.stale === true`, `stale: true` plus `staleReason` (omit the keys otherwise — the existing suite asserts key ABSENCE with `'reason' in entry`, so keep the same additive style). Run `preserveInto` on every branch's models and attach `customModels` only when non-empty.

   `private async computeAll(): Promise<ProviderAvailability[]>` = `Promise.all(this.catalogEntries().map((info) => this.computeEntry(info)))` — one catalog build per call, not per provider.

   Files: `src/activation/providerRouter.ts`

3. Limit availability() to configured providers and add hiddenProviders()

   In src/activation/providerRouter.ts:

   - `public async availability(): Promise<ProviderAvailability[]>` → `(await this.computeAll()).filter((a) => a.enabled)`. Document: only CONFIGURED providers are returned — a keyed provider with a stored key, `openai` with key + endpoint, `copilot` when `vscode.lm` enumerates at least one model — and every returned entry therefore has `enabled: true` and no `reason`.
   - New `public async hiddenProviders(): Promise<ProviderAvailability[]>` → `(await this.computeAll()).filter((a) => !a.enabled)`, i.e. exactly the entries availability() omits, each carrying its `reason` (`providerNeedsKeyReason(id)` / `PROVIDER_NEEDS_ENDPOINT_REASON` / `COPILOT_UNAVAILABLE_REASON`). Document it as the list the Set-API-key quick pick uses to offer a provider the dropdown hides.
   - `enabledProviders()` keeps its body (`availability()` is already filtered) but drop the now-wrong "all providers" wording.
   - `modelsFor(id)` must keep working for a HIDDEN id (the chat view asks for models of the active provider even mid-clear): implement it as `computeEntry(providerInfo(id, this.catalogEntries()))` rather than searching `availability()`.
   - `firstUsableSelection()` iterates `await this.availability()` in order (catalog order: builtins, feed-only providers, `openai` last) and returns `{ provider: entry.id, model: entry.models[0] }` for the first entry with a model — no `PROVIDER_IDS` loop and no second availability read per provider.
   - `modelFor(id)` is unchanged except that `defaultModelFor(id)` now receives the live catalog: `defaultModelFor(id, this.catalogEntries())`, so a feed-only provider's first model is its default too.

   Files: `src/activation/providerRouter.ts`

4. Preserve a legacy selection and re-resolve it on every reload

   In src/activation/providerRouter.ts add `private preserved: ModelSelection | undefined;` documented as: a persisted (or previously active) selection whose provider is not configured in this window — kept in memory, NOT written over in `workspaceState`, and restored by `refresh()` the moment its provider becomes configured again.

   `init()`:
   - `const stored = normalizeModelSelection(this.config.workspaceState.get(MODEL_SELECTION_KEY));`
   - `const enabled = await this.enabledProviders();`
   - if `stored !== undefined && enabled.includes(stored.provider)` → `this.selected = stored`, no rewrite (unchanged). Note in the comment that the stored MODEL is deliberately not validated against the list: a model that left the feed stays selected and is surfaced through `customModels`.
   - else if `stored !== undefined` (a real selection whose provider is not configured right now) → `this.preserved = stored`; `this.selected = await this.firstUsableSelection()`; DO NOT persist, so the user's choice survives the reload and comes back when the key/endpoint/Copilot returns.
   - else (absent/malformed blob) → today's behaviour: fall back to `firstUsableSelection()` and persist it.
   - `lastModel` is still seeded from `this.selected`, and from `this.preserved` when set, so the preserved model reappears in that provider's list.
   - The whole body stays inside the existing try/catch that logs and leaves `selected` undefined.

   `refresh()`:
   - `const enabled = await this.enabledProviders();`
   - FIRST: if `this.preserved !== undefined && enabled.includes(this.preserved.provider)` → `this.selected = this.preserved`, `this.lastModel.set(...)`, `this.preserved = undefined`, and persist nothing (the stored blob already equals it).
   - else if the active selection is undefined or its provider is no longer enabled → when an active selection exists, record it as `this.preserved` (so it too returns later) and re-resolve via `firstUsableSelection()` WITHOUT persisting; when there was no active selection, keep today's behaviour and persist the fallback.
   - else leave the selection untouched.
   - Still fires exactly once at the end, still swallows and logs every failure with the existing `refreshing provider availability failed` message.

   `select()` is unchanged: `normalizeModelSelection` already accepts any non-blank provider id, so a feed-only or vanished provider stays selectable; validation happens only through availability/`customModels`. A successful `select()` also clears `this.preserved` when it names the same provider (the user has spoken).

   Files: `src/activation/providerRouter.ts`

5. Wire the catalog and the discovery event into the router in commands.ts

   In src/activation/commands.ts, at the `new ProviderRouter({...})` site (~line 505):

   - Add `import { getModelCatalogStore, getModelDiscovery } from '../extension';`. These two accessors were added by T07 and are used nowhere yet — they are the seam for this wiring. The resulting `extension -> activation -> commands -> extension` cycle is harmless under tsc's CommonJS output because both accessors are called only inside closures, never at module evaluation; say so in a short comment above the import.
   - Pass the seam:
   ```ts
       // The live model catalog: models come from the `models.dev` snapshot the
       // discovery service refreshes, with its stale flag, and the provider list
       // from the last parsed feed. Read per call — a refresh that lands after
       // activation must be picked up without rebuilding the router.
       catalog: {
         snapshot: () => getModelCatalogStore()?.get('models.dev'),
         feed: () => getModelDiscovery()?.feed(),
       },
   ```
   - Keep `void legacyMigration.then(() => router.init()).then(() => router.refresh());` as the once-per-activation refresh.
   - Subscribe the router to discovery so a landed refresh re-resolves availability and repaints the Chat dropdown:
   ```ts
     // A landed catalog refresh changes which providers exist and which models
     // they offer, so re-read availability; refresh() never rejects.
     const catalogSub = getModelDiscovery()?.onDidChange(() => {
       void router.refresh();
     });
     if (catalogSub !== undefined) {
       disposables.push(new vscode.Disposable(() => catalogSub.dispose()));
     }
   ```
   No other change in this file; do not touch src/extension.ts, the chat controller, the webviews or setApiKey.ts (later todos own those).

   Files: `src/activation/commands.ts`

6. Update and extend test/providerRouter.test.ts

   Harness changes (test/providerRouter.test.ts):
   - Load the fixture feed the way test/providers.test.ts does: `fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8')` + `parseModelsDevFeed(JSON.parse(text))`, asserting `result.ok`. The fixture has 8 providers (anthropic, deepinfra, cerebras, baseten, deepseek, google, mistral, opencode).
   - Add `makeSnapshot(entries: {id: string; provider?: string}[], opts?: { stale?: boolean; staleReason?: string; fetchedAt?: string }): ModelCatalogSnapshot` (sourceId `'models.dev'`, `source: 'live'`, `stale: false` by default) and `snapshotFromFeed(feed)` helper mirroring `feedCatalogFetch` (bare `id`, provider half on `provider`).
   - `makeHarness` takes `catalog?: ModelCatalogSource` (or `{ snapshot?, feed? }`) and passes it through `ProviderRouterConfig`. Every EXISTING harness call site passes nothing, so `buildProviderCatalog(undefined)` keeps the five builtin entries and today's assertions on `gemini-2.5-pro` / `mistral-large-latest` stay green.

   Rewrite the four `ProviderRouter.availability` cases that inspect DISABLED providers so they read `hiddenProviders()` instead — the entries are gone from `availability()` now:
   - 'returns one entry per provider in PROVIDER_IDS order' becomes 'availability() returns only configured providers, in catalog order' (default harness: `['copilot']`; every entry `enabled: true` with no `reason`), plus an assertion that `hiddenProviders()` carries the other four with non-empty reasons and that the two lists are disjoint and together cover the catalog.
   - 'keyed providers flip `enabled` with the secret and report the catalog reason' → assert google/mistral/opencode appear in `hiddenProviders()` with `providerNeedsKeyReason(id)` and their builtin model lists, then that storing the google key moves google into `availability()` and out of `hiddenProviders()` while the others stay hidden.
   - the `openai` key/endpoint case and the `copilot` empty/rejecting cases → same reasons, read from `hiddenProviders()`; the enabled steps keep reading `availability()`.
   - 'a throwing secrets.get degrades to disabled without throwing' → availability() is `['copilot']` and google/openai are hidden with their reasons; still no rejection.

   New cases to add:
   1. catalog models win: with `snapshotFromFeed(fixtureFeed)` + the fixture feed and a stored google key, `modelsFor('google')` is the fixture's google models (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, …) and NOT the stale builtin `['gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite']` list.
   2. feed-only provider: a stored `baiton.orchestrator.key.deepseek` makes `deepseek` appear in `availability()` with the feed label 'DeepSeek' and the fixture's `deepseek-chat`/`deepseek-reasoner` models; with no key it is hidden with `providerNeedsKeyReason('deepseek')`.
   3. legacy key compatibility: keys stored under the legacy `google`/`mistral`/`opencode`/`openai` slots still enable those providers when a feed is present (ids and `providerSecretKey` unchanged).
   4. offline/cached path: snapshot present, `feed()` undefined → a keyed snapshot-only provider (`deepseek`) is still enumerated, with `label === 'deepseek'` (the synthesised fallback) and the cached models.
   5. stale propagation: a snapshot with `stale: true, staleReason: 'models.dev fetch failed: boom', fetchedAt: '2026-01-01T00:00:00.000Z'` → the entry for a keyed feed provider carries `stale: true`, that exact `staleReason` and `fetchedAt`, while `copilot` and `openai` carry no `stale` key at all; a non-stale snapshot leaves `stale` absent and `fetchedAt` set.
   6. preserved model stays selectable: select `{ provider: 'google', model: 'gemini-1.0-vanished' }`, then with the fixture snapshot assert `modelsFor('google')` ENDS with `gemini-1.0-vanished`, that the catalog ids keep their order first, and that the entry's `customModels` is `['gemini-1.0-vanished']`.
   7. legacy selection re-resolved on reload: stored blob `{ provider: 'deepseek', model: 'deepseek-chat' }` with NO deepseek key and copilot available → after `init()` the selection is `{ provider: 'copilot', model: 'fake-model' }`, `memento.updates` is EMPTY (the user's blob is untouched), and after storing the deepseek key a `refresh()` restores `{ provider: 'deepseek', model: 'deepseek-chat' }`, fires once and still writes nothing.
   8. orphaned active selection returns: `select({provider:'google',model:'gemini-2.5-flash'})`, clear the key, `refresh()` (falls to the next configured provider, no persist), restore the key, `refresh()` → google/gemini-2.5-flash is active again.
   9. a vanished provider is never dropped: stored blob `{ provider: 'gone-forever', model: 'x' }` with a key stored for `gone-forever` → it is enumerated via the synthesised entry, `availability()` includes it, the selection is restored as-is, and `complete()` routes to it (RecordingClient via `createClient`).
   10. discovery-driven change: a mutable fake catalog whose snapshot/feed are swapped between calls proves `availability()` re-reads the catalog per call (no hoisting) and that `refresh()` after the swap re-resolves the selection.

   Keep the existing init/select/refresh/routing/model-resolution suites otherwise untouched; only 'falls back when the blob is absent, malformed, unknown, or its provider is disabled' needs splitting: the `{ provider: 'nope', model: 'x' }` and `{ provider: 'google', model: '   ' }` entries still fall back and persist (unknown provider with no key is unconfigured, blank model fails normalisation), but a case whose provider is a KNOWN-but-unconfigured id now takes the preserve path — move it into case 7 and note why in a comment.

   Files: `test/providerRouter.test.ts`

7. Verify

   Run, from the repo root:
   - `npx tsc --noEmit -p tsconfig.json` (must exit 0)
   - `npm run compile` (must exit 0)
   - `npx eslint src/activation/providerRouter.ts src/activation/commands.ts test/providerRouter.test.ts --ext .ts` (no findings; watch for the removed `PROVIDER_IDS` import and any unused helper)
   - `npx mocha test/providerRouter.test.ts` (note: .mocharc.json widens the spec to the whole suite)
   - `npm run test:unit` — the ONLY acceptable failure is the pre-existing 'packaging gating: includes zero native modules' keytar case in test/activation.gating.test.ts
   - `git status --porcelain` — exactly the three files this todo owns.

   Files: `src/activation/providerRouter.ts`, `src/activation/commands.ts`, `test/providerRouter.test.ts`

## Risks

- commands.ts importing `getModelCatalogStore`/`getModelDiscovery` from '../extension' creates an import cycle (extension -> activation barrel -> commands -> extension). It is safe only because both accessors are called inside closures, never at module evaluation; if the executor prefers to avoid the cycle entirely, the alternative is threading the two seams through `registerCommands`'s parameters from src/extension.ts, which adds a file outside this todo's list.
- `availability()` now probes a SecretStorage key per catalog provider, and the real models.dev feed lists far more providers than the 8-provider fixture — that is dozens of parallel `secrets.get` calls per call, and `postProviders()` calls it on every repaint. Keep the reads in one `Promise.all` and do not add a per-provider sequential await; if this proves heavy in the host, a short-lived per-refresh memo is the follow-up (out of scope here).
- Providers known only from the persisted snapshot (feed not yet fetched in this window) get `label === id` because the snapshot stores no provider label. Labels upgrade as soon as the refresh lands and `refresh()` re-reads the catalog; do not paper over it by inventing labels.
- Narrowing `availability()` to configured providers changes what src/activation/chatController.ts `postProviders()` posts (no more disabled optgroups) before the Chat view is updated in a later todo. That is the intended interim state; do NOT edit chatController.ts, media/chat.js, media/protocol.js or setApiKey.ts here, and check test/chatController.*.test.ts still passes (they use their own fake ProviderSource, so they should be unaffected).
- The preserve-don't-persist rule must not regress the existing refresh/init persistence assertions: the fallback is still persisted when there was no stored/active selection to protect. Getting this branch wrong silently overwrites a user's provider choice, which is exactly what this todo exists to prevent.
- `ProviderAvailability`'s new fields must stay additive and key-absent when empty: the suite asserts absence with `'reason' in entry`-style checks, and the webview protocol mirror tests in a later todo pin the same shape.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` both exit 0, and eslint reports nothing on the three touched files.
- `ProviderRouter.availability()` returns ONLY configured providers (keyed provider with a stored key, `openai` with key + endpoint, `copilot` when `vscode.lm` enumerates a model), every entry `enabled: true` with no `reason`; `hiddenProviders()` returns exactly the rest, each with its `providerNeedsKeyReason` / `PROVIDER_NEEDS_ENDPOINT_REASON` / `COPILOT_UNAVAILABLE_REASON`.
- With a models.dev snapshot present, a provider's models come from that snapshot (in snapshot order) rather than the hard-coded builtin list, and a feed-only provider such as `deepseek` becomes selectable once its `baiton.orchestrator.key.deepseek` secret exists; legacy `google`/`mistral`/`opencode`/`openai` keys keep working unchanged.
- A stale models.dev snapshot propagates `stale: true`, its `staleReason` and `fetchedAt` onto the snapshot-backed availability entries, while `copilot` and `openai` entries carry no `stale` key; a successful snapshot leaves `stale` absent.
- A persisted selection whose provider is not configured in this window is NOT written over in `workspaceState` (`memento.updates` stays empty on that path), routing falls back to the first configured provider, and a later `refresh()` restores the persisted selection once its provider becomes configured.
- A selected model that is absent from the refreshed list stays selectable: it is appended at the END of that provider's `models` and reported in `customModels`, with the catalog ids keeping their source order first.
- With no `catalog` seam injected, the router behaves exactly as before: the five builtin entries in the same order with their builtin model lists (proved by the untouched pre-existing cases in test/providerRouter.test.ts).
- commands.ts passes the `catalog` seam (reading `getModelCatalogStore()?.get('models.dev')` and `getModelDiscovery()?.feed()` per call), keeps the single post-`init()` `router.refresh()`, and re-runs `router.refresh()` from `discovery.onDidChange`, with the subscription pushed onto the returned disposables.
- `npx mocha test/providerRouter.test.ts` passes, including the ten new cases; `npm run test:unit` shows no new failures beyond the pre-existing keytar 'includes zero native modules' packaging-gating failure.
- `git status --porcelain` lists exactly src/activation/providerRouter.ts, src/activation/commands.ts and test/providerRouter.test.ts; src/orchestrator/*, src/extension.ts, media/* and setApiKey.ts are untouched, and providerRouter.ts still imports `vscode` type-only.
