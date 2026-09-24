# Execute T09

## Summary

T09: ChatController now learns the provider selection. Added an optional `provider` field to the protocol core's showError/triggerFix messages and WebviewState.error (key always written, present-undefined discipline mirrored into media/protocol.js and pinned with two new fixture cases 43/44); media/chat.js round-trips the provider through the inline error button while the dropdown/empty-state affordances stay provider-less; test/webviewProtocol.reducer.test.ts assertions updated for the present-undefined provider key. In src/activation/chatController.ts, added a host-free ProviderSource/ProviderAvailabilityView seam (optional `providers` dep, wide TriggerFix with optional provider) with postProviders() posted on every refresh right after setAutoMode and on router selection changes (single start() subscription guarded by selectionSub + dispose()); selectModel applies to the next turn only (no refresh, no transcript writes, repaint only on rejection); a MissingConfigError('apiKey') with an active selection now surfaces the provider-scoped message naming the provider via providerInfo and carries provider on showError, while no-selection wording and endpoint/model/UnreachableEndpointError texts are unchanged. FakeProviders added to both test suites with 10 provider-selection cases (order, ordering before setEmptyState, null selection, transcript-untouched switch, rejected switch repaint, router-side change, no stacked subscriptions/dispose, provider-scoped key error + fix echo, no-dep no-op, availability failure isolation) and 3 Auto-mode interaction guards. A pre-existing environment failure (uncommitted @opencode-ai/models dependency + keytar native module breaking activation.gating.test.ts at baseline) was cleaned up with human approval (ask-0001, answer 'cleanup'). Verification: tsc clean, eslint only the pre-existing _legacy warning, the four named suites green, test:unit 1321 passing / 1 pending (baseline 1298/1), full npx mocha 1397 passing / 1 pending.

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `media/protocol.js`
- `test/fixtures/protocolCases.ts`
- `media/chat.js`
- `src/activation/chatController.ts`
- `test/chatController.interventions.test.ts`
- `test/chatController.autoMode.test.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src test --ext .ts`
- `npx mocha test/chatController.interventions.test.ts test/chatController.autoMode.test.ts test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts`
- `npm run test:unit`
- `npx mocha`
- `git checkout -- package.json package-lock.json; rm -rf node_modules/@opencode-ai node_modules/keytar (approved environment cleanup, ask-0001)`

## Notes

- The verify command `npx mocha <four files>` runs the full .mocharc spec glob anyway (config spec merges), so it exercised the whole suite: 1397 passing / 1 pending, green.
- Environment cleanup: package.json/package-lock.json were reverted and node_modules/@opencode-ai and node_modules/keytar removed; without it the baseline activation.gating tests failed before any of my edits. Approved via asks/ask-0001.
- media/chat.js header comment was left untouched: it never enumerated the fix-action behaviour, and the plan says to update it only in that case.
- postProviders keeps the router's group order, labels, reasons and models verbatim (models mapped to { id } only); a disabled keyed provider's models are passed through as the router reports them.
