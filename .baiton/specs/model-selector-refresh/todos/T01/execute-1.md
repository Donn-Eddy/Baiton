# Execute T01

## Summary

T01 implemented the host-free model catalog core. (1) Created src/orchestrator/modelCatalog.ts with the full snapshot vocabulary in the specified export order (CatalogSourceId, CATALOG_SOURCE_IDS, isCatalogSourceId, ModelEntry, SnapshotSource, ModelCatalogSnapshot, ModelCatalogTable, CatalogFetch, CatalogFailure) plus the pure helpers modelIds/findModel/effortsFor/normalizeModelEntry. File header mirrors providers.ts style, documents the sourceId-vs-source split the OVERVIEW ambiguity resolved into, and the module imports only `type { Result }` from ../model/result — no vscode, no node builtins, no I/O. Naming note: `Thenable<void>` in CatalogMemento is the ambient world-scope interface from @types/vscode (verified NOT to be a namespace import; the host-free regex test passes). (2) Added mergePreservingExisting (trim/skip empty + dedupe vs refreshed ids exact case-sensitive + earlier appends, appends {id, custom:true} at end, never mutates input, always returns a new object incl. a structurally equal copy when nothing is appended, carries stale/staleReason through) and mergeTablePreservingExisting per present source. (3) Added CatalogStore with CatalogMemento (docs: host passes context.globalState), MODEL_CATALOG_MEMENTO_KEY = 'baiton.models.catalog', MODEL_CATALOG_PERSIST_VERSION = 1, CatalogStoreOptions (now defaults to toISOString, builtins, log), hydrate() with defensive version/snapshot validation that never throws (wrong/absent version discards the whole blob; unknown source keys and bad entries skipped; get-throw tolerated and logged; source forced to 'cached'; fetchedAt kept when a non-empty string else now()), builtin seeding for sources with no snapshot, applyResult (success → live/non-stale snapshot + persist; failure → keeps previous models/efforts/fetchedAt/source, sets stale:true + staleReason, returns undefined only when no previous snapshot AND no builtin; failure never clears a success, later success clears stale/staleReason), private persist() ({version:1, snapshots: table}; swallows sync throws and attaches .then(undefined, log) rejection handlers so a rejecting memento.update can never surface an unhandled rejection), and clear(). No timers/network/spawning. Optional fields (efforts, staleReason) are conditionally added so hydrated/live literals carry no undefined own keys. (4) Added `export * from './modelCatalog';` next to './providers' in the orchestrator barrel (verified all 20 new names are collision-free via grep). (5) Wrote test/modelCatalog.test.ts (mocha + assert, no vscode import) with fakeMemento/get-throwing/update-throwing/rejecting-update fakes, a deterministic ISO clock, and the 8 planned describe blocks: vocabulary, normalizeModelEntry, lookup helpers, merge semantics, applyResult stale/preserve semantics, persistence round-trip + malformed-blob tolerance + unhandled-rejection guard, builtins, and the fs.readFileSync host-free guard. Implementation decisions recorded: optionalStringArray drops empty arrays (efforts: [] normalizes away); effortsFor returns [] for an unknown model id and applies snapshot-level efforts only for an existing model without per-model efforts (resolving the plan's 'unknown model id → []' bullet). Verification: npx tsc --noEmit -p tsconfig.json exit 0; npm run compile exit 0; eslint on the three touched files clean; npx mocha test/modelCatalog.test.ts (repo .mocharc) = 1452 passing / 1 failing where the only failure is the pre-existing environmental 'packaging gating: includes zero native modules' keytar check in test/activation.gating.test.ts (documented pre-existing at baseline in earlier runs); npm run test:unit = 1376 passing / 1 pending / 1 failing — same single pre-existing failure, all new suites green.

## Files changed

- `src/orchestrator/modelCatalog.ts`
- `src/orchestrator/index.ts`
- `test/modelCatalog.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json (exit 0)`
- `npm run compile (exit 0)`
- `npx eslint src/orchestrator/modelCatalog.ts src/orchestrator/index.ts test/modelCatalog.test.ts --ext .ts (clean)`
- `npx mocha test/modelCatalog.test.ts (1452 passing, 1 pre-existing environmental keytar failure)`
- `npm run test:unit (1376 passing / 1 pending / 1 pre-existing failure)`

## Notes

- The single failing test in every suite run is the pre-existing 'packaging gating … includes zero native modules' assertion about node_modules/keytar (activation.gating.test.ts) — an environment/node_modules state issue predating this todo, unrelated to modelCatalog.
- CatalogMemento.update is typed `Thenable<void> | void` using the ambient global Thenable interface of @types/vscode (global-scope augmentation, no import statement, verified host-free by the module-source regex test).
- effortsFor semantics tightened per the plan's test bullet: unknown model id → [], snapshot-level efforts are the fallback only for an existing model without its own efforts.
- normalizeModelEntry and the hydration path drop empty efforts arrays rather than storing a meaningless [].
