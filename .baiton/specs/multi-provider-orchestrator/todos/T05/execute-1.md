# Execute T05

## Summary

T05 complete: replaced the single-key handler with per-provider key management. src/activation/setApiKey.ts keeps all legacy exports (API_KEY_SECRET, setOrchestratorApiKey and its 8 tests) byte-identical and adds setProviderApiKey (quick-pick of the four keyed providers in catalog order with set/missing descriptions, masked prompt, trimmed store, empty-submit clear, failure paths), providerKeyPrompt/Saved/Cleared/Failed message helpers, PROVIDER_* constants, migrateLegacyApiKey (one-time globalState-flagged copy of the legacy secret into the openai slot, never deleting the legacy secret, false-swallowing) and LEGACY_MIGRATION_FLAG. commands.ts registers both baiton.setProviderApiKey and the retained baiton.setOrchestratorApiKey alias bound to setProviderApiKey(context.secrets), runs the migration fire-and-forget at registerCommands start, and triggerFix now dispatches COMMANDS.setProviderApiKey (buildModelClient untouched). package.json contributes the new command and commandPalette entry (gated on baiton.activated) with the alias entries preserved; vscodeFake.mjs gained a delegating showQuickPick; test/setApiKey.test.ts extended with 10 setProviderApiKey and 7 migrateLegacyApiKey cases against the same redirected loader.

## Files changed

- `src/activation/setApiKey.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/fixtures/vscodeFake.mjs`
- `test/setApiKey.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json (clean)`
- `npx eslint src/activation/setApiKey.ts src/activation/commands.ts test/setApiKey.test.ts --ext .ts (no findings)`
- `npx mocha test/setApiKey.test.ts (all green: 8 pre-existing setOrchestratorApiKey tests unchanged + 10 setProviderApiKey + 7 migrateLegacyApiKey)`
- `node -e JSON.parse(package.json) (valid; contributes.commands has baiton.setProviderApiKey 'Set Provider API Key' and baiton.setOrchestratorApiKey; commandPalette gates both on baiton.activated)`
- `npm run test:unit (1251 passing, 1 pending, no regression)`
- `node JSON check of package.json contribution acceptance`

## Notes

- Imports in setApiKey.ts use ../orchestrator/providers directly, not the barrel.
- migrateLegacyApiKey copies without deleting the legacy secret; buildModelClient still reads baiton.orchestrator.apiKey, trivially unaffected.
- Each command id is registered exactly once; the alias remains for existing key bindings and README parity.
- test:unit count (1251) differs from direct mocha (1327) because they load different file sets; both are fully green with no regressions.
