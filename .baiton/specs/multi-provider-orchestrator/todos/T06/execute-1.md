# Execute T06

## Summary

Built the host-side ProviderRouter (T06). Added the availability vocabulary to src/orchestrator/providers.ts (providerNeedsKeyReason, PROVIDER_NEEDS_ENDPOINT_REASON, COPILOT_UNAVAILABLE_REASON, sameModelSelection) while keeping the module dependency-free. Created src/activation/providerRouter.ts with a type-only vscode import and an injected-dependency surface (SecretsLike, MementoLike, ProviderSettings, ProviderRouterConfig, ProviderAvailability), the pure per-provider providerClientConfig (catalog endpoint/model/key wiring, gemini dialect for google, OpenCode extra headers built once per client, a 'copilot' programmer-error throw), and the ProviderRouter class: lazily memoised clients, call-time model resolution (modelFor with per-provider last-model memory and the openai setting fall-through), availability()/enabledProviders()/modelsFor() recomputed per call (Copilot via lm.selectChatModels with dedupe + rejection guarding; keyed providers via SecretStorage; openai key+endpoint with the deterministic key-first reason), init()/select() round-tripping the selection through workspaceState under MODEL_SELECTION_KEY with fallback persistence, a defensive onDidChangeSelection, and a routing complete() that forwards the request object by reference and delegates errors unwrapped. Added test/providerRouter.test.ts (static import, local fakes, 34 cases covering client config, availability, init, select, routing, model resolution). Did not touch src/activation/commands.ts, the chat controller, the tool loop, the auto-mode evaluator, or src/activation/index.ts. Verified: tsc clean, eslint clean on the three files, test/providerRouter.test.ts green, providers.test.ts green, and npm run test:unit fully green at 1285 passing / 1 pending (above the 1251 T05 baseline).

## Files changed

- `src/orchestrator/providers.ts`
- `src/activation/providerRouter.ts`
- `test/providerRouter.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src/activation/providerRouter.ts src/orchestrator/providers.ts test/providerRouter.test.ts --ext .ts`
- `npx mocha test/providerRouter.test.ts`
- `npm run test:unit`
- `npm run test:unit (baseline check before implementation: 1251 passing / 1 pending)`

## Notes

- src/orchestrator/providers.ts stays import-free; the new exports are pure functions/constants only.
- src/activation/providerRouter.ts imports vscode as a type only; the runtime vscode surface arrives via ProviderRouterConfig.lm. Two small exported type aliases (SecretsLikeIsHostSubset, MementoLikeIsHostSubset) reference the type-only import so noUnusedLocals stays satisfied.
- Exported PROVIDERS is referenced directly in copilotAvailability (catalog label) since the plan's import list includes PROVIDERS.
- init() persists only a computed fallback, not a restored-but-already-persisted selection; init never fires the change event and swallows all failures via log.
- The OpenCode extra-header factory is built once per client so x-opencode-session stays stable per conversation.
- Availability is never cached: keys, the endpoint settings and Copilot enumeration are re-read on every availability() call.
- src/activation/index.ts was deliberately left untouched (plan prefers direct module imports over extending the host-free barrel).
- npm run test:unit: 1285 passing / 1 pending — 34 new provider-router tests, no regressions.
