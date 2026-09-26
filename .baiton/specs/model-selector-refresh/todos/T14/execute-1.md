# Execute T14

## Summary

Rebuilt the Chat view model selector as a provider select followed by a model select. media/chat.html now holds #provider-select, #model-select and a #model-stale badge span inside .model-bar, with both selects themed from --vscode-dropdown-* and the dead optgroup rule replaced by a .stale-note rule. media/chat.js tracks the webview-only providerChoice/lastSelectionKey pair, syncs it from state.selection via syncProviderChoice() (a host-side selection change wins, an unrelated setProviders echo does not revert a user's provider pick), extends providerSignature() with the stale fields, per-model custom and providerChoice/refreshedAt, and rebuilds both selects with no optgroups: the provider select lists the posted groups in host order (plus a leading '(custom)' option for a selection provider absent from the feed), the model select lists only the chosen provider's models with a ' (custom)' suffix and an appended selectable '(custom)' option for a selection model absent from the group. The stale badge shows 'stale — showing last known models' plus refreshedAt with staleReason as its title, and clears text, class and title on a fresh provider. The Set API key affordance now also appears when no configured provider offers a model. The provider change handler only repaints (posts nothing); the model handler still posts exactly one selectModel. The fake-DOM suite was reworked around a configured-only fixture (copilot/anthropic/opencode, one custom model, one stale group) with a withDisabled() variant, covering all ten scenarios in the plan.

## Files changed

- `media/chat.html`
- `media/chat.js`
- `test/chatView.providers.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint test/chatView.providers.test.ts --ext .ts`
- `npm run test:unit`
- `git status --porcelain`

## Notes

- tsc --noEmit, npm run compile and eslint on the test file are all clean with no output.
- npm run test:unit: 1603 passing, 1 pending, 1 failing — the single failure is the known pre-existing keytar/native-module case in test/activation.gating.test.ts ('includes zero native (compiled binary) modules under node_modules'). All ten tests of the new 'chat view provider-first model selector (model-selector-refresh T14)' describe pass, and the reducer plus mirror suites pass unmodified.
- git status --porcelain lists exactly media/chat.html, media/chat.js and test/chatView.providers.test.ts; no protocol, controller, router or mirror file was touched.
- One deliberate refinement of plan step 3: the model select appends the disabled 'Unavailable' row only when the chosen provider has no group AND no selection carries it. With no providers at all (the seed paint) the 'Select a model…' placeholder alone would otherwise be joined by a spurious 'Unavailable' row, and for a '(custom)' selection provider the appended custom model option already covers the case — this is what the plan's own seed-paint test (one disabled selected placeholder per select) requires. A group that is present but disabled still shows its reason row, as specified.
- providerSelect.value is assigned from providerChoice and falls back to selecting options[0] when no option carries that value, matching the real-select semantics the fake DOM models.
