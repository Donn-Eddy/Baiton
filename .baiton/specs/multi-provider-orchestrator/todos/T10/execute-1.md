# Execute T10

## Summary

T10: Wired the ProviderRouter into activation. providerRouter.ts: extracted init()'s fallback loop into firstUsableSelection() (init semantics unchanged) and added refresh() — re-reads availability, re-resolves and persists when nothing is selected or the active provider is disabled, fires the change event exactly once outside the try (including on failure), never rejects. setApiKey.ts: setProviderApiKey gained an optional onChanged(providerId), fired via a contained notifyChanged() helper immediately after a successful store and after a successful clear (inside if(hadKey)), never on cancel/empty-with-nothing-stored/store-delete-failure/throwing-callback; commands registerCommand now routes an isProviderId-validated argument into it. commands.ts: removed OpenAiModelClient import, deleted buildModelClient, built one ProviderRouter (secrets/workspaceState from context, live per-call orchestrator.* getters, lm: vscode, extensionVersion(context) with '0.0.0' fallback, log bound to Surface); init is chained onto the captured legacyMigration promise and followed by refresh(); the same instance is the ChatController's client and providers seam and the Auto-mode gate's decideAsk client; controller gets chatController.dispose() pushed onto the command disposables; both key commands and the webview triggerFix go through one promptProviderKey closure passing () => router.refresh(); triggerFix now forwards the optional provider. Tests: 7 new ProviderRouter.refresh cases and 10 new setProviderApiKey onChanged cases.

## Files changed

- `src/activation/providerRouter.ts`
- `src/activation/setApiKey.ts`
- `src/activation/commands.ts`
- `test/providerRouter.test.ts`
- `test/setApiKey.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json  (clean)`
- `npx eslint src test --ext .ts  (only the pre-existing T09 '_legacy' warning)`
- `npx mocha test/providerRouter.test.ts test/setApiKey.test.ts  (globs merge: 1413 passing / 1 pending, green)`
- `npm run test:unit  (1337 passing / 1 pending, green — above the T09 baseline of 1321)`

## Notes

- A throwing secrets.get is contained per-provider by availabilityOf (logged through config.log), so the refresh-level catch is exercised by a rejected workspaceState.update instead; both logging paths are covered in the refresh tests.
- refresh()'s failure path fires the event outside the try as planned; a listener must tolerate a no-change event (noted in the onDidChangeSelection/refresh JSDoc and asserted in the still-enabled refresh test).
- Empty-state contract check: with no provider available, complete() throws MissingConfigError('model'); chatController maps it to the openSettings fix, which opens baiton.orchestrator settings — actionable.
- commands.ts has no unit test (imports vscode at module scope), so its diff was re-read deliberately: one router instance for gate+controller, migration→init→refresh chaining, both commands on promptProviderKey, provider forwarded in triggerFix.
- The stale buildModelClient mention in migrateLegacyApiKey's JSDoc was dropped since buildModelClient no longer exists.
