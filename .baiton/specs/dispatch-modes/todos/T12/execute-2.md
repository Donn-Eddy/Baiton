# Execute T12

## Summary

Added the host-authoritative Mode select to the composer. media/chat.html gains an empty `<select id="mode-select">` as the first child of `.composer-actions` (immediately left of #auto-mode) with an aria-label and a #mode-select / #mode-select:disabled rule block built only from the existing --vscode-dropdown-* theme variables, plus an extended header comment. media/chat.js looks the element up, carries MODE_OPTIONS (mirroring RUN_MODES in src/model/mode.ts: spec/bug/quick/refactor/investigate with labels Spec/Bug/Quick/Refactor/Investigate) and a WORKSPACE_CONVERSATION_ID mirror, adds isSpecConversation() and renderMode() — which builds the five dataset.mode-carrying options exactly once, projects state.mode (pinning Spec on a spec conversation, falling back to Spec on an off-union value) and disables on state.busy || state.runActive || pinned with a title that explains why — wires renderMode() into render() between renderAutoMode() and updateEnablement(), and adds a change handler that posts { type: 'setMode', mode } only when the control is enabled and the picked mode differs from state.mode, then snaps back via renderMode() so only the host echo moves the control. The two existing fake-DOM harnesses each gained the one ELEMENT_IDS line for the new id, and test/chatView.mode.test.ts adds 8 fake-DOM cases over a file-local copy of the providers-test harness.

## Files changed

- `media/chat.html`
- `media/chat.js`
- `test/chatView.providers.test.ts`
- `test/modelSelectorRefresh.test.ts`
- `test/chatView.mode.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm run compile: clean, zero TypeScript errors.
- npm run lint: 0 errors, 1 warning — the pre-existing '_legacy is assigned a value but never used' in src/orchestrator/webviewProtocol.ts, untouched by this todo.
- npm test: 1959 passing, 1 pending, 0 failing. All 8 cases in the new 'chat view Mode select (dispatch-modes T12)' describe pass and every previously passing test still passes.
- media/protocol.js, src/orchestrator/webviewProtocol.ts, test/fixtures/protocolCases.ts, test/webviewProtocol.mirror.test.ts and test/webviewProtocol.reducer.test.ts were not touched, and nothing was wired host-side — ChatController handling the inbound setMode and posting the echo/setRunActive is a later todo.
- Until that host side lands, picking a mode makes the control visibly snap back to Spec because nothing echoes setMode. That is the required host-authoritative discipline, it is called out in the plan's Risks, and case 3 of the new test asserts exactly that behaviour.
- The two existing harness files were changed by exactly one additive ELEMENT_IDS line each; no existing assertion was altered or weakened.
- test/chatView.mode.test.ts keeps file-local copies of FakeClassList / FakeEl / ELEMENT_IDS / loadChatView / plainClone, per the plan's instruction not to extract a shared fixture.
- MODE_OPTIONS and WORKSPACE_CONVERSATION_ID are hand-kept mirrors of TypeScript sources with no parity test guarding them; each carries a comment naming its source file, as the plan directs.
