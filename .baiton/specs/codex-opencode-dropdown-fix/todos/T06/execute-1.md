# Execute T06

## Summary

Carried per-model detail through the config-panel seam. Added an exported FormModelEntry interface (id, optional label/efforts/defaultEffort/custom, no provider) to src/config/configPanel.ts, declared locally so the module stays import-free of adapter/orchestrator code, plus an optional modelEntries member on AgentFormCapability. configFormOptions now copies a capability's modelEntries through a module-private formModelEntry helper (conditional keys, fresh efforts array, provider dropped) or synthesises one bare { id } per model when the capability carries none; a configured-but-unlisted model is appended to both models and modelEntries as { id, custom: true } under the unchanged mergePreservingExisting guard, and an end-of-function normalisation deletes an empty modelEntries so an agent with no models carries no such own key. overlayCapabilities in src/adapter/index.ts now copies builtin.modelEntries conditionally on the empty-snapshot path, so antigravity's curated per-family efforts survive a failed refresh while codex/claude/opencode keep their exact key set. The controller needed no code change (doc comment extended only). models, efforts, agents, validateConfigForm, agentStaleness and the round trip are behaviourally unchanged and media/config.js was not touched.

## Files changed

- `src/config/configPanel.ts`
- `src/adapter/index.ts`
- `src/activation/configPanelController.ts`
- `test/configPanel.test.ts`
- `test/configPanel.controller.test.ts`
- `test/adapter.index.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2171 passing, 1 pending, 0 failing. npm run compile clean. npm run lint reports only the pre-existing warning in src/orchestrator/webviewProtocol.ts:626 ('_legacy' assigned but never used), in a file this todo does not touch.
- Three existing configFormOptions assertions were updated for the new key, as the plan specified: the per-agent deepStrictEqual in 'with no form, returns installed agents and clones capabilities into byAgent' (via a new expectedEntries helper), the exact key list in 'a capability without the metadata yields an entry with exactly the old keys' (now ['efforts','models','modelEntries']), and the expected object in the source/stale/staleReason/fetchedAt case (now gains modelEntries: [{ id: 'claude-opus-5-5' }]). The two empty-byAgent cases still assert { models: [], efforts: [] }, guarding the normalisation.
- formModelEntry is placed directly after configFormOptions rather than beside asString/asFormNumber (the plan's suggested location) so the helper sits next to its only caller; it is still module-private and pure.
- Per the plan's risk note, the new test fixture whose entries carry `provider` is built through a typed local variable, since an inline literal would trip tsc's excess-property check against FormModelEntry.
- The new controller tests write every role onto claude (not just planner) so the default roles' models do not add unrelated custom entries to the assertions; they also assert the options payload survives JSON round-tripping and that no entry carries a provider key.
- test/configPanel.mirror.test.ts passes untouched, confirming this change is render-neutral for media/config.js, which does not read modelEntries yet.
