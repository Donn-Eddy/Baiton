# Execute T10

## Summary

Generalised the orchestrator provider catalog. ProviderId is now an open string with a typed builtin vocabulary (BuiltinProviderId/BUILTIN_PROVIDER_IDS, PROVIDER_IDS unchanged in value and order); isProviderId keeps builtin-membership semantics (narrowing to BuiltinProviderId) and the new isProviderIdLike is the open check. ProviderInfo gained optional source/env/doc; PROVIDERS is retyped Readonly<Record<BuiltinProviderId, ProviderInfo>> with byte-identical values and is documented as the offline/legacy-id base. Added PROVIDER_DIALECTS, PROVIDER_HEADER_STYLES, PROVIDER_BASE_URL_OVERRIDES (google's OpenAI-compatible base wins over the feed's native /v1beta), FEED_PROVIDER_DENY, the pure providersFromFeed() and buildProviderCatalog() (builtins keep host traits, the feed wins on models, feed-only ids follow, openai last, ids unique). Lookup helpers are now tolerant of arbitrary ids via hasOwnProperty guards: findProviderInfo (exact match, optional catalog), providerInfo (non-optional return, synthesised source:'custom' fallback), providerCatalog(feed?), providerSecretKey (blank rejected, copilot undefined, prefix+id otherwise), defaultModelFor and providerNeedsKeyReason both taking an optional catalog. normalizeModelSelection now accepts any non-blank provider and stores it trimmed; dialectFor accepts DialectId | string. Tests updated and extended.

## Files changed

- `src/orchestrator/providers.ts`
- `src/orchestrator/modelClient.ts`
- `test/providers.test.ts`
- `test/providerRouter.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json (exit 0)`
- `npm run compile (exit 0)`
- `npx eslint src/orchestrator/providers.ts src/orchestrator/modelClient.ts test/providers.test.ts test/providerRouter.test.ts --ext .ts (exit 0, no findings)`
- `npx mocha test/providers.test.ts (runs the whole suite via .mocharc: 1643 passing)`
- `npm run test:unit (1568 passing, 1 failing = the pre-existing keytar packaging-gating failure only)`

## Notes

- One edit outside the plan's file list: test/providerRouter.test.ts. Its 'ProviderRouter.select rejects malformed input' case pinned { provider: 'nope', model: 'x' } as rejected, which is exactly the parse-time behaviour this todo deliberately opens up (the plan says the router, in a later todo, marks such a selection custom/stale rather than dropping it). I replaced that one list entry with { provider: '', model: 'x' } and a comment naming why; no production code outside providers.ts/modelClient.ts was touched. Without this the acceptance criterion 'no new failures in npm run test:unit' was unreachable.
- src/orchestrator/index.ts needed no edit, but note the plan's premise was slightly off: the barrel re-exports './providers' and does NOT re-export './modelsDev'. Every modelsDev consumer (src/adapter/*, src/activation/modelDiscovery.ts, providers.ts) imports that module directly, so the new ModelsDevFeed-typed signatures resolve fine and I left the barrel alone. Grep confirmed none of the new exported names (BuiltinProviderId, BUILTIN_PROVIDER_IDS, isProviderIdLike, PROVIDER_DIALECTS, PROVIDER_HEADER_STYLES, PROVIDER_BASE_URL_OVERRIDES, FEED_PROVIDER_DENY, providersFromFeed, buildProviderCatalog, findProviderInfo) collides elsewhere in src/.
- providersFromFeed emits env as the feed's array or [] (never an own key with an undefined value) and omits doc when the feed omits it; buildProviderCatalog's merged builtin entries carry the feed's env/doc and keep source: 'builtin'.
- buildProviderCatalog() with no feed returns the same object identities as before (PROVIDER_IDS.map(id => PROVIDERS[id])), so an offline window is unchanged; buildProviderCatalog([]) takes the same path.
- providers.ts still imports types only (import type { ModelsDevFeed, FeedProvider } from './modelsDev') — no vscode, no node builtins, no I/O.
- Fixture feed has 8 providers, all with api + models, so providersFromFeed keeps all 8; the skip rules (no api, zero models, blank id, denied id) are covered with hand-built entries, plus a malformed-input case asserting it never throws.
- The only remaining test failure in npm run test:unit is the documented pre-existing 'packaging gating ... includes zero native modules' (keytar) case in test/activation.gating.test.ts.
