# Execute T05

## Summary

Wired the live model catalog into the config panel. In src/extension.ts the CatalogStore/ModelDiscoveryService constructions and the modelCatalogStore/modelDiscovery assignments now sit immediately after createAdapterRegistry() and before the registerConfigPanel push; that call gained getCapabilities: () => agentCapabilities(catalogStore.table()) and onDidChangeCapabilities wrapping discovery.onDidChange in a vscode.Disposable, while keeping capabilities: agentCapabilities() as the static fallback. The refreshModels command, the discovery dispose disposable, the onDidChange logging subscription and void discovery.refresh() all stayed after the panel registration. Corrected the three stale doc comments and added the two test blocks. compile, lint and the full test suite pass (2158 passing).

## Files changed

- `src/extension.ts`
- `src/activation/configPanel.ts`
- `test/activation.gating.test.ts`
- `test/modelSelectorRefresh.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- No behavioural change was needed in registerConfigPanel or ConfigPanelController: both seams were already optional and conditionally spread, and test/configPanel.view.test.ts (which passes neither) still passes.
- npm run lint reports one pre-existing warning unrelated to this todo: src/orchestrator/webviewProtocol.ts:626 '_legacy' is assigned a value but never used. 0 errors.
- The new activation.gating.test.ts block asserts over src/extension.ts source text (that file imports vscode at module scope and the suite registers no vscodeLoader hook), slicing the registerConfigPanel({...}) call with a brace-depth counter so matches cannot come from elsewhere in the file.
- In test/modelSelectorRefresh.test.ts the new leg-1 case also asserts the rehydrated claude capability carries no own staleReason key, matching the existing leg-1 cases' shape.
- Leg 1's discovered-id expectations for claude/codex/opencode/antigravity were left untouched, as the plan's risk note directs; none were failing.
