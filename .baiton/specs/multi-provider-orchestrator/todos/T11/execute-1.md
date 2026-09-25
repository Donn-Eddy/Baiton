# Execute T11

## Summary

T11 done: added a '### Providers and models' section to README.md between '### Auto mode' and '### The config panel' covering the five-provider table (catalog order: copilot, google, opencode, mistral, openai), per-provider SecretStorage keys, the legacy apiKey migration, the Provider & Model dropdown mechanics (setProviders/selectModel authority, Set API key affordance, workspaceState selection), GitHub Copilot in-window mode, Gemini tool chaining and OpenCode request headers; documented baiton.setProviderApiKey in Commands and reworded baiton.setOrchestratorApiKey as its retained alias (source-verified: the alias invokes promptProviderKey() with no provider); rewrote the Settings section so endpoint/model read as the OpenAI / Custom provider; updated package.json's endpoint/model descriptions and added the confirmed Copilot-always-streams clause to streaming.

## Files changed

- `README.md`
- `package.json`

## Commands run

- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" — ok`
- `git diff package.json — only the three intended description lines changed`
- `npx tsc --noEmit -p tsconfig.json — clean`
- `npm run test:unit — 1337 passing / 1 pending (T10 baseline)`

## Notes

- All catalog values (ids, labels, base URLs, model lists, reason strings, MODEL_SELECTION_KEY, LEGACY_API_KEY_SECRET), setApiKey behaviour and LEGACY_MIGRATION_FLAG, COPILOT_VENDOR/COPILOT_JUSTIFICATION/error mapping, gemini shaping and opencode headers were re-read from source before writing; no drift from the plan.
- package.json: only the two required description strings plus the optional streaming clause changed; types/defaults/minimum and formatting untouched; commands and menus not modified (setProviderApiKey was already contributed and palette-gated).
