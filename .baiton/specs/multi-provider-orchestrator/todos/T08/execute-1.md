# Execute T08

## Summary

Rendered the Provider & Model dropdown in the Chat view: added a .model-bar (label + #model-select + #model-set-key button) inside the composer, styled only with VS Code theme variables; replaced the empty-state Endpoint row with a Provider row (#empty-provider / #empty-model) and renamed the empty-state button to 'Set Provider API Key'. In chat.js: added the modelSelect/modelSetKey/emptyProvider element lookups (removed the dead emptyEndpoint lookup), a renderedProviderSignature guard, renderProviders() (one optgroup per provider in host order, disabled groups with a disabled reason option, selection matching or a disabled placeholder at index 0, 'Set API key…' visible exactly when a group is disabled, disabled while busy or when no enabled model exists) called right after renderSelector() in render(); renderEmptyState() now projects provider label + model; the change handler posts { type: 'selectModel', provider, model } for enabled options (repaint only on disabled rows / re-picking the active pair) and #model-set-key posts { type: 'triggerFix', action: 'setApiKey' }. Added test/chatView.providers.test.ts, a fake-DOM vm-suite (loads media/protocol.js + media/chat.js over a hand-rolled DOM covering all 17 element ids) that asserts seed paint, optgroup order/muted disabled groups, selection matching, placeholder insertion without posting, selectModel posting semantics, the triggerFix affordance, busy enablement, and the provider/model empty state. All verification green: tsc clean, eslint clean except the pre-existing _legacy warning, npm run test:unit 1306 passing (includes the new suite). No files under src/ and nothing in media/protocol.js were touched.

## Files changed

- `media/chat.html`
- `media/chat.js`
- `test/chatView.providers.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src test --ext .ts`
- `npx mocha test/chatView.providers.test.ts`
- `npm run test:unit`

## Notes

- Test case 1 ('no options') is asserted as 'no selectable option': the planned renderProviders() always inserts a disabled 'Select a model…' placeholder at index 0 even with zero providers, so the only seed-paint option is that disabled placeholder.
- During testing, a fake-DOM bug (structuring select.value semantics on every element) was found and fixed inside the test's own fake DOM; workspace code was unaffected.
- renderError()'s 'Set Orchestrator API Key' label and the setEmptyState endpoint wire payload were deliberately left unchanged per plan (later todos).
