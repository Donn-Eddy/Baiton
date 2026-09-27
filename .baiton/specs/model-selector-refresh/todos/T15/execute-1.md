# Execute T15

## Summary

Added test/modelSelectorRefresh.test.ts, the end-to-end suite for model-selector-refresh: 22 cases across five legs (reload refresh, discovery fallback + stale-list handling, provider filtering, provider-first selection through media/chat.js, config + selection round-trip) wiring the REAL modules the way the host does — fake feed/CLI transports -> ModelDiscoveryService -> CatalogStore -> agentCapabilities(table) -> ConfigPanelController, and -> ProviderRouter -> ChatController -> media/chat.js. The file imports every module statically with no vscode loader hook. Also rewrote README's 'Agent Model & Effort Discovery' section (now describing the four sources, the async timeboxed refresh, memento persistence, stale-keeps-last-good, baiton.refreshModels, the round-trip guarantee and the no-secrets rule) and the two provider sections it contradicted ('Providers and models' now describes the feed-derived catalog with the table re-titled as the offline fallback; 'The Provider & Model dropdown' now describes the provider-first two-select, configured-only, stale-badged selector). tsc, eslint, the targeted mocha runs and npm run test:unit are clean apart from the pre-existing keytar native-module failure.

## Files changed

- `test/modelSelectorRefresh.test.ts`
- `README.md`

## Commands run

- `npx tsc --noEmit -p tsconfig.json — clean, no output`
- `npx eslint test/modelSelectorRefresh.test.ts --ext .ts — clean, no output`
- `npx mocha --no-config --require ts-node/register --node-option no-strip-types --timeout 60000 test/modelSelectorRefresh.test.ts — 22 passing (327ms), 0 failing`
- `npx mocha --no-config ... test/modelSelectorRefresh.test.ts test/modelDiscovery.test.ts test/modelCatalog.test.ts test/providers.test.ts test/providerRouter.test.ts test/configPanel.controller.test.ts test/configPanel.view.test.ts test/chatView.providers.test.ts test/webviewProtocol.mirror.test.ts test/setApiKey.test.ts — 323 passing, 0 failing`
- `npx mocha --no-config ... test/setApiKey.test.ts test/modelSelectorRefresh.test.ts (reverse order, loader-using suite first) — 64 passing, 0 failing`
- `npm run test:unit — 1625 passing, 1 pending, 1 failing (the pre-existing test/activation.gating.test.ts keytar native-module case); the new suite's 6 describe blocks are included`
- `npm run test:property — 1701 passing, 1 pending, 1 failing (same keytar case only)`
- `git status --porcelain — ' M README.md' and '?? test/modelSelectorRefresh.test.ts' only`

## Notes

- PLAN DEVIATION (leg 1 case 1): the plan expected the pre-refresh `loaded` to carry no own `stale`/`fetchedAt` key. It does carry them — CatalogStore seeds its builtins at construction, so agentCapabilities() stamps `source: 'builtin'`, `stale: false` and a `fetchedAt` before any fetch. The case now asserts models deep-equal builtinAgentCapabilities().claude.models, `source === 'builtin'`, `stale === false`, and no own `staleReason` key. The 'no own key' assertion is kept for antigravity, which really is never overlaid.
- PLAN DEVIATION (leg 4 half B case 5): posting `setProviders` with `groups: []` does NOT show the Set-API-key affordance — media/chat.js gates both its conditions on `state.providers.length > 0`, treating an empty post as 'nothing known yet'. The case therefore uses the configured-but-modelless shape, which is exactly what the acceptance criterion names ('when no provider offers a model'); a comment in the test records why.
- PLAN DEVIATION (leg 4 half B case 2): the host's own posted message carries a selection, so the seed paint chooses the SELECTED provider, not the first group. The case asserts both: the selected group's models with the message verbatim, then the first group's models with the same groups and `selection: null`, followed by the provider-change repaint that posts nothing.
- PLAN DEVIATION (leg 4 half B case 4): picking the model that is already the active selection posts nothing by design (media/chat.js short-circuits a re-pick), so the custom-model case paints with `selection: null` before selecting `claude-opus-9-gone`; the posted payload is then fed back into `router.select()` as planned.
- Leg 4 needed a fresh group beside the stale one. Since one models.dev snapshot backs every feed provider, all snapshot-backed providers go stale together; the harness therefore also configures Copilot (live-enumerated through the fake `lm`, never snapshot-backed) so the stale badge can be asserted as following the chosen provider.
- GAP CONFIRMED, outside this todo's file list (flagged by the plan, left unfixed as instructed): src/extension.ts:192 still passes `capabilities: agentCapabilities()` to registerConfigPanel and never passes `getCapabilities`/`onDidChangeCapabilities`, because the panel is registered before the CatalogStore/ModelDiscoveryService are built. So in a real window the config panel's model lists do NOT refresh today, even though every seam exists and this suite drives it. Follow-up: a one-line reorder in activate() (build the store/discovery first, then pass the two callbacks to registerConfigPanel).
- One unrelated pre-existing flake was observed once during a full-spec run: test/adapter.launch.property.test.ts 'builds shellArgs matching the permission table for any role and request' failed on a random fast-check seed and passed on the next run. It is untouched by this change.
- The fake DOM (FakeEl/FakeClassList/loadChatView) and the codex app-server spawner are duplicated from test/chatView.providers.test.ts and test/adapter.codex.test.ts rather than extracted to test/fixtures/, matching the T09 precedent and T15's two-file list; each copy is trimmed to the surface actually exercised and a comment says so.
