# Plan T01

## Steps

1. Create src/orchestrator/modelCatalog.ts with the snapshot vocabulary

   New host-free module (no `vscode` import, no node builtins, no I/O) with a file header in the style of src/orchestrator/providers.ts explaining that it is the single source of truth for refreshed model lists and is consumed by both host glue and unit tests.

   Export, in this order:
   - `export type CatalogSourceId = 'claude' | 'codex' | 'opencode' | 'models.dev';`
   - `export const CATALOG_SOURCE_IDS: readonly CatalogSourceId[] = ['claude', 'codex', 'opencode', 'models.dev'] as const;`
   - `export function isCatalogSourceId(value: unknown): value is CatalogSourceId` — `typeof value === 'string' && (CATALOG_SOURCE_IDS as readonly string[]).includes(value)`.
   - `export interface ModelEntry { readonly id: string; readonly label?: string; readonly provider?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string; readonly custom?: boolean; }` — `id` is the value written into config / `ModelSelection.model`; `provider` carries the `provider` half of an `provider/model` id (OpenCode) or the feed provider id; `efforts`/`defaultEffort` are the per-model reasoning levels (codex `supportedReasoningEfforts`); `custom: true` marks an entry appended by `mergePreservingExisting` rather than returned by the source.
   - `export type SnapshotSource = 'live' | 'cached' | 'builtin';` — `live` = just fetched in this window, `cached` = rehydrated from the memento, `builtin` = the curated fallback baked into the extension.
   - `export interface ModelCatalogSnapshot { readonly sourceId: CatalogSourceId; readonly models: readonly ModelEntry[]; readonly efforts?: readonly string[]; readonly fetchedAt: string; readonly source: SnapshotSource; readonly stale: boolean; readonly staleReason?: string; }` — `efforts` is the union-of-levels list for sources that expose one (codex); per-model levels live on `ModelEntry.efforts`. `fetchedAt` is an ISO-8601 string (the time of the last *successful* fetch, not of the failure that marked it stale). Document that the same snapshot object is what the discovery service hands to `agentCapabilities(snapshots)` and to the provider router.
   - `export type ModelCatalogTable = Readonly<Partial<Record<CatalogSourceId, ModelCatalogSnapshot>>>;`
   - `export interface CatalogFetch { readonly models: readonly ModelEntry[]; readonly efforts?: readonly string[]; }` — the payload a source's discovery returns on success.
   - `export type CatalogFailure = string;` (the human-readable `staleReason`).

   Pure helpers (all total, never throw):
   - `export function modelIds(snapshot: ModelCatalogSnapshot | undefined): readonly string[]` — `snapshot?.models.map((m) => m.id) ?? []`.
   - `export function findModel(snapshot: ModelCatalogSnapshot | undefined, id: string): ModelEntry | undefined`.
   - `export function effortsFor(snapshot: ModelCatalogSnapshot | undefined, id: string): readonly string[]` — the model's own `efforts`, else the snapshot-level `efforts`, else `[]`.
   - `export function normalizeModelEntry(value: unknown): ModelEntry | undefined` — accepts a plain string (→ `{ id: trimmed }`) or an object with a non-empty string `id`; trims `id`, drops empty; keeps `label`/`provider`/`defaultEffort` only when non-empty strings, `efforts` only when an array of non-empty strings, `custom` only when `true`. Returns undefined otherwise. Used by both the store's memento rehydration and by source adapters in later todos.

   Files: `src/orchestrator/modelCatalog.ts`

2. Add mergePreservingExisting to modelCatalog.ts

   `export function mergePreservingExisting(snapshot: ModelCatalogSnapshot, existingValues: readonly (string | undefined)[]): ModelCatalogSnapshot`.

   Behaviour:
   - Trim each entry of `existingValues`; skip `undefined`, empty and whitespace-only values, and skip any value whose trimmed form already equals an `id` of `snapshot.models` (exact, case-sensitive match) or is a duplicate of an earlier appended value.
   - Append the survivors, in the order given, as `{ id: trimmed, custom: true }` at the END of `models` (refreshed ids keep their source order and stay first).
   - Return a NEW snapshot object with a new `models` array; never mutate the input. When nothing is appended, still return a new object (a structurally equal copy) so callers can treat the result uniformly — assert this in the test with `deepStrictEqual` on values, not identity.
   - Every other field (`sourceId`, `efforts`, `fetchedAt`, `source`, `stale`, `staleReason`) is carried through unchanged: merging is not a refresh and must not clear staleness.
   Also add a convenience overload-free helper `export function mergeTablePreservingExisting(table: ModelCatalogTable, existing: Partial<Record<CatalogSourceId, readonly (string | undefined)[]>>): ModelCatalogTable` that applies `mergePreservingExisting` per present source and leaves absent sources untouched — the config-panel and router todos both need the per-source form.

   Files: `src/orchestrator/modelCatalog.ts`

3. Add the stale-aware CatalogStore with memento persistence

   In the same module:

   - `export interface CatalogMemento { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | void; }` — the structural subset of `vscode.Memento` (`globalState`), mirroring the `MementoLike` pattern in src/activation/providerRouter.ts so the module stays host-free. Document that the host passes `context.globalState`.
   - `export const MODEL_CATALOG_MEMENTO_KEY = 'baiton.models.catalog';`
   - `export const MODEL_CATALOG_PERSIST_VERSION = 1;`
   - `export interface CatalogStoreOptions { memento?: CatalogMemento; now?: () => string; builtins?: Partial<Record<CatalogSourceId, CatalogFetch>>; log?: (message: string) => void; }` — `now` defaults to `() => new Date().toISOString()` so tests are deterministic; `builtins` supplies the curated fallback used when neither memento nor a live fetch has produced a snapshot.
   - `export class CatalogStore`:
     - Constructor stores options and calls a private `hydrate()`: reads `memento.get(MODEL_CATALOG_MEMENTO_KEY)`, validates it defensively (object, `version === MODEL_CATALOG_PERSIST_VERSION`, `snapshots` an object), and for each entry whose key passes `isCatalogSourceId` rebuilds a snapshot with `normalizeModelEntry` on every model, `fetchedAt` kept when it is a non-empty string (else `now()`), `stale`/`staleReason` kept as stored, and `source` forced to `'cached'`. Anything unparseable is skipped silently (no throw), and a wrong/absent version discards the whole blob. `hydrate` must never throw even if `memento.get` throws — wrap in try/catch and route the message through `log`.
     - After hydration, seed any source that has no snapshot but has a `builtins[source]` entry with `{ source: 'builtin', stale: false, fetchedAt: now() }`.
     - `get(sourceId: CatalogSourceId): ModelCatalogSnapshot | undefined`.
     - `table(): ModelCatalogTable` — a shallow copy so callers cannot mutate internal state.
     - `applyResult(sourceId: CatalogSourceId, result: Result<CatalogFetch, CatalogFailure>): ModelCatalogSnapshot | undefined` (import `Result` from `../model/result`, the repo's existing discriminated union):
       - success → replace the snapshot with `{ sourceId, models: [...result.value.models], efforts: result.value.efforts && [...], fetchedAt: now(), source: 'live', stale: false }` (no `staleReason`), then persist.
       - failure → keep the previous snapshot's `models`/`efforts`/`fetchedAt`/`source` exactly as they are and return a copy with `stale: true` and `staleReason: result.error`; persist. When there is NO previous snapshot and no builtin, record nothing and return `undefined` (a source that never succeeded has no list to show) — but if a builtin exists, mark the builtin snapshot stale rather than dropping it.
       - A failure must never clear a previous success, and a later success must clear `stale`/`staleReason`.
     - `persist(): void` — private, called at the end of `applyResult`; writes `{ version: MODEL_CATALOG_PERSIST_VERSION, snapshots: <table> }` through `memento.update`, ignores a missing memento, and swallows/loggs a rejected or throwing `update` (persistence is best-effort and must never fail a refresh). If `update` returns a thenable, attach a `.then(undefined, …)`-style rejection handler so no unhandled rejection escapes.
     - `clear(): void` — drops all snapshots and persists (used by tests and a future `baiton.refreshModels` hard reset).
   Keep the class free of timers, network and process spawning: the discovery service (a later todo) owns all of that and only calls `applyResult`.

   Files: `src/orchestrator/modelCatalog.ts`

4. Re-export the new module from the orchestrator barrel

   Add `export * from './modelCatalog';` to src/orchestrator/index.ts, placed next to `export * from './providers';` (the catalog/vocabulary neighbours) and keeping the file's existing one-export-per-line style. Verify no exported name collides with an existing barrel export (checked: `ModelEntry`, `ModelCatalogSnapshot`, `CatalogStore`, `SnapshotSource`, `modelIds`, `effortsFor`, `mergePreservingExisting` are all new; do not name anything `ModelSelection`, `defaultModelFor` or `providerInfo`).

   Files: `src/orchestrator/index.ts`

5. Write test/modelCatalog.test.ts

   Mocha + `assert` (no vscode import), matching the style of test/providers.test.ts: `import * as assert from 'assert';` and named imports from `../src/orchestrator/modelCatalog`, plus `ok`/`err` from `../src/model/result`.

   Helpers at the top of the file: a `fakeMemento()` returning `{ store: new Map<string, unknown>(), get, update }` (with a variant whose `update` throws and one whose `get` throws), and a deterministic `clock` counter producing `'2026-01-01T00:00:0Ns'`-style ISO strings.

   Describe blocks and cases:
   1. `vocabulary` — `CATALOG_SOURCE_IDS` is exactly `['claude', 'codex', 'opencode', 'models.dev']`; `isCatalogSourceId` accepts each and rejects `'anthropic'`, `''`, `42`, `null`, `undefined`.
   2. `normalizeModelEntry` — string input → `{ id }`; trims; rejects `''`/whitespace/number/null/object without `id`; keeps `efforts` only when all members are non-empty strings; drops unknown extra keys.
   3. `modelIds` / `findModel` / `effortsFor` — `[]`/`undefined` for an undefined snapshot; per-model `efforts` win over snapshot-level `efforts`; snapshot-level `efforts` are the fallback; unknown model id → `[]`.
   4. `mergePreservingExisting` — appends a configured value missing from the refreshed list as `{ id, custom: true }` at the end; does NOT duplicate a value already present; skips `undefined`, `''` and whitespace; dedupes repeated existing values; preserves refreshed order; does not mutate the input snapshot (assert the original `models.length` afterwards); carries `stale: true` + `staleReason` through unchanged.
   5. `CatalogStore.applyResult` — success records `source: 'live'`, `stale: false`, `fetchedAt` from the injected clock; a subsequent failure keeps the previous `models` and `fetchedAt` while setting `stale: true` and the given `staleReason`; a later success clears `stale`/`staleReason` and advances `fetchedAt`; a failure with no previous snapshot and no builtin returns `undefined` and leaves `get()` undefined; a failure with only a builtin marks the builtin snapshot stale but keeps its models; `table()` is a copy (mutating the returned object does not affect a later `table()`).
   6. `CatalogStore` persistence — after `applyResult` the memento holds `{ version: 1, snapshots: { … } }` under `MODEL_CATALOG_MEMENTO_KEY`; a NEW store constructed over the same memento rehydrates the same model ids with `source: 'cached'` and the stored `stale`/`fetchedAt`; a blob with a wrong `version`, a non-object blob, or a snapshot under an unknown source key is discarded without throwing; a memento whose `get` throws still constructs; a memento whose `update` throws or returns a rejecting thenable does not fail `applyResult` (await a macrotask tick and assert no unhandled rejection).
   7. `CatalogStore` builtins — a source with only a `builtins` entry reports `source: 'builtin'`, `stale: false`; a hydrated cached snapshot wins over the builtin for the same source.
   8. `host-free` guard — assert the module source contains no `vscode` import, in the style used elsewhere: read `src/orchestrator/modelCatalog.ts` with `fs.readFileSync` and assert `!/from '.*vscode'/.test(source)`.

   Files: `test/modelCatalog.test.ts`

## Risks

- Naming collision in the barrel: `src/orchestrator/index.ts` uses `export *`, so any new symbol that duplicates one from providers.ts/webviewProtocol.ts breaks the build. Keep the names listed in step 4 and run `npm run compile`/`tsc` after adding the re-export.
- The OVERVIEW calls the snapshot field `source` for BOTH the source id and the `live | cached | builtin` origin. This plan resolves it as `sourceId` (which source) + `source` (origin); later todos (discovery service, router, config panel) must use the same split, so keep the doc comment explicit.
- `tsconfig.json` has `strict`, `noUnusedLocals` and `noUnusedParameters`. Optional fields (`efforts`, `staleReason`, `label`) must be omitted rather than set to `undefined` when building snapshot literals, or `deepStrictEqual` assertions in the test will fail on the extra own key.
- Persistence is best-effort: a `memento.update` that returns a rejecting thenable would otherwise surface as an unhandled rejection at activation. The rejection handler in `persist()` is load-bearing, not defensive noise.
- Scope creep: the store must stay free of fetching, timers and events. `onDidChange` belongs to the discovery service todo; adding it here would duplicate the later wiring.

## Acceptance

- `src/orchestrator/modelCatalog.ts` exists, imports only `../model/result` (type + `Result`), and contains no `vscode` import and no node builtin import.
- It exports `CatalogSourceId`, `CATALOG_SOURCE_IDS`, `isCatalogSourceId`, `ModelEntry`, `SnapshotSource`, `ModelCatalogSnapshot`, `ModelCatalogTable`, `CatalogFetch`, `normalizeModelEntry`, `modelIds`, `findModel`, `effortsFor`, `mergePreservingExisting`, `mergeTablePreservingExisting`, `CatalogMemento`, `MODEL_CATALOG_MEMENTO_KEY`, `MODEL_CATALOG_PERSIST_VERSION`, `CatalogStoreOptions` and `CatalogStore`.
- `CatalogStore.applyResult` with a failure after a success keeps the previous `models` and `fetchedAt` and sets `stale: true` with the given `staleReason`; a following success clears both.
- A second `CatalogStore` built over the same fake memento rehydrates the previously applied snapshots with `source: 'cached'` and identical model ids.
- `mergePreservingExisting` appends every configured value missing from the refreshed list as `custom: true`, in order, without duplicating or reordering refreshed ids, and without mutating its input.
- `src/orchestrator/index.ts` re-exports the module (`export * from './modelCatalog';`).
- `test/modelCatalog.test.ts` covers vocabulary, entry normalization, lookup helpers, merge semantics, stale/preserve semantics, persistence round-trip, malformed-blob tolerance and builtin seeding.
- `npx tsc --noEmit` (or the repo's compile script) passes and `npx mocha test/modelCatalog.test.ts` is green; the existing suite (`npm run test:unit`) shows no new failures.
