# Execute T01

## Summary

Added the host-free provider catalog (src/orchestrator/providers.ts): ProviderId type with PROVIDER_IDS dropdown order and isProviderId guard; ProviderInfo/PROVIDERS records for copilot, google, opencode, mistral and openai with labels, default base URLs, requiresKey/usesSettings flags and built-in model lists; providerInfo/providerCatalog accessors; SecretStorage key names (PROVIDER_SECRET_KEY_PREFIX, providerSecretKey, LEGACY_API_KEY_SECRET pinned byte-identical to setApiKey.ts); the ModelSelection type with MODEL_SELECTION_KEY, defaultModelFor and the pure normalizeModelSelection validator. Re-exported the catalog from src/orchestrator/index.ts (no name collisions with ModelProvider/EndpointProvider/ApiKeyProvider) and added test/providers.test.ts covering all 12 plan test groups. Verified: tsc --noEmit clean, eslint on the new files clean (the only repo-wide finding is a pre-existing no-unused-vars warning in webviewProtocol.ts, untouched by this todo), npx mocha test/providers.test.ts green, and npm run test:unit green (1170 passing) including modelClient and webviewProtocol.mirror tests. No host-facing files (modelClient.ts, webviewProtocol.ts, commands.ts, setApiKey.ts, media/) were touched.

## Files changed

- `src/orchestrator/providers.ts`
- `src/orchestrator/index.ts`
- `test/providers.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src/orchestrator/providers.ts src/orchestrator/index.ts test/providers.test.ts --ext .ts`
- `npx mocha test/providers.test.ts`
- `npm run test:unit`
- `npx eslint src test --ext .ts`

## Notes

- providers.ts imports nothing from vscode, fs or path — pure data/validation like webviewProtocol.ts.
- Base URLs left unshaped: google keeps its trailing slash, mistral stays bare (/v1); completionsUrl() normalizes both.
- LEGACY_API_KEY_SECRET ('baiton.orchestrator.apiKey') matches API_KEY_SECRET in setApiKey.ts exactly; setApiKey.ts was not edited.
- normalizeModelSelection validates the provider id only and trims the model, so copilot (runtime enumeration) and openai (free text) keep working with models absent from the catalog.
- npm run test:unit reports 1170 passing / 1 pending; the earlier full-suite mocha invocation (1246 passing) additionally ran the property tests already green on the branch.
