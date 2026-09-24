# Execute T07

## Summary

Extended the webview protocol with the provider view: webviewProtocol.ts now imports ProviderId/ModelSelection as types from the host-free './providers', exports ProviderModelItem and ProviderGroup, adds the setProviders (HostToWebview) and selectModel (WebviewToHost) variants, two required WebviewState fields (providers: ProviderGroup[], selection: ModelSelection | null), seeds them in initialWebviewState(), and handles setProviders in reduce by shallow-copying groups and storing selection verbatim. media/protocol.js mirrors the seed keys and the setProviders case (msg.groups.slice(), selection passed through unchanged) in the same switch position. test/fixtures/protocolCases.ts gains the group() helper, the two new seed keys, and six numbered setProviders cases (37)-(42) including the full five-group catalog list, null selection, empty groups, replacement, unrelated-state preservation and a multi-message interleaving with setEmptyState/streamDelta. test/webviewProtocol.reducer.test.ts adds a 'provider selection' block covering seed defaults, copied-not-aliased groups, null-selection clearing, replacement, non-interference with the rest of the state, input purity, and the selectModel message shape (WebviewToHost compile-time check). providers.ts itself needed no change (ProviderId/ModelSelection already existed).

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `media/protocol.js`
- `test/fixtures/protocolCases.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src test --ext .ts`
- `npx mocha test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts`
- `npm run test:unit`

## Notes

- tsc is clean; eslint reports only the pre-existing no-unused-vars warning on '_legacy' in webviewProtocol.ts (548).
- npm run test:unit: 1298 passing, 1 pending; direct mocha run of the reducer + mirror suites: 1374 passing, 1 pending (loads the full suite via the shared config). Both green, no failures.
- selectModel is added to WebviewToHost but intentionally unhandled in ChatController.handle (allowed to fall through silently) per the plan; the host wiring is a later todo.
- Mirror parity is enforced by the existing webviewProtocol.mirror.test.ts, which picked up the new cases and seed keys without modification; the mirror keeps `providers: msg.groups.slice()` and `selection: msg.selection` verbatim so a present-undefined key never diverges from null.
- Fixed one intermediate compile error by giving the new reducer-test describe block a local `rec` helper (the file-level one is scoped inside another describe).
