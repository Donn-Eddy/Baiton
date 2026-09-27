# Execute T13

## Summary

Extended the chat webview protocol additively for provider-first grouped selection: ProviderModelItem gained optional `custom` and `efforts`, ProviderGroup gained optional `stale`/`staleReason` (plus corrected JSDoc for the now-open `ProviderId` and the provider-first wording on `id`/`enabled`), and both the `setProviders` message and `WebviewState` gained optional `refreshedAt`. `reduce`'s setProviders case now assigns `refreshedAt: msg.refreshedAt` unconditionally, and media/protocol.js mirrors that exact unconditional form so the own-key-with-undefined parity holds; `initialWebviewState()` is byte-unchanged in both files. ChatController's `ProviderAvailabilityView` seam gained optional `stale`, `staleReason`, `fetchedAt`, `customModels` and `efforts`, and `postProviders()` now forwards stale markers, per-model `custom: true` and `efforts`, plus a message-level `refreshedAt` computed by a new pure `latestFetchedAt()` helper that ignores entries with no or unparseable `fetchedAt` and returns the host's original string. Added a `modelItem()` fixture helper and seven new PROTOCOL_CASES (45-51) plus six new reducer unit tests covering refreshedAt present/absent-after-present, the fresh seed having no own key, stale/custom/efforts surviving the fold copied-not-aliased, and feed-derived provider ids round-tripping in both setProviders and selectModel.

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `media/protocol.js`
- `src/activation/chatController.ts`
- `test/fixtures/protocolCases.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint src/orchestrator/webviewProtocol.ts src/activation/chatController.ts test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts test/fixtures/protocolCases.ts --ext .ts`
- `npm run test:unit`
- `git status --porcelain`

## Notes

- tsc --noEmit and npm run compile are both clean.
- eslint reports 0 errors; the single warning ('_legacy' is assigned a value but never used at webviewProtocol.ts:591) is pre-existing in `projectCard` and untouched by this todo.
- npm run test:unit: 1601 passing, 1 pending, 1 failing — the failure is only the known pre-existing keytar case 'packaging gating … includes zero native (compiled binary) modules under node_modules' in test/activation.gating.test.ts. No new failures.
- All new mirror fixture cases and reducer tests pass, as do the existing chat-controller and chat-view provider suites unmodified.
- test/webviewProtocol.mirror.test.ts needed no edit: its fold over PROTOCOL_CASES is the parity guard, and its deepStrictEqual assertions were left unweakened. git status lists only the five intended files.
- New PROTOCOL_CASES were appended at the end of the file (numbered 45-51, after the existing setProviders block and the two showError cases 43-44) to keep the numbered-comment sequence contiguous.
- The `efforts` seam on ProviderAvailabilityView is unpopulated by src/activation/providerRouter.ts today, as the plan anticipated; the forwarding is asserted through fake sources only. providerRouter.ts, media/chat.html, media/chat.js, test/chatView.providers.test.ts and src/activation/setApiKey.ts are untouched.
