# Execute T07

## Summary

Added the context meter under the composer and the manual Compact action. Protocol: setContextUsage (host to webview), compactContext (webview to host) and an optional WebviewState.context, folded identically in the TS reducer and media/protocol.js. Webview: meter markup, styles and null-tolerant rendering plus a Compact button in chat.html/chat.js. Controller: posts setContextUsage after every completion, compaction and render; public compactContext() refuses while busy, gives notices for nothing-to-compact, and surfaces a failed summary inline. Command baiton.compactContext registered and contributed. Tests added for the reducer, mirror parity, fixture cases, fake-DOM view and controller.

## Files changed

- `src/orchestrator/webviewProtocol.ts`
- `media/protocol.js`
- `media/chat.html`
- `media/chat.js`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/fixtures/protocolCases.ts`
- `test/webviewProtocol.reducer.test.ts`
- `test/webviewProtocol.mirror.test.ts`
- `test/chatView.mode.test.ts`
- `test/chatController.compaction.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `npx mocha --grep too-short`
- `grep -rn "from 'vscode'" src/orchestrator`

## Notes

- npm test: 2446 passing, 0 failing. compile is clean; lint has 0 errors and one pre-existing warning (_legacy unused in webviewProtocol.ts).
- media/protocol.js and test/fixtures/protocolCases.ts were changed although not in the todo's file list, as the plan required for mirror parity.
- Controller tests went into the existing test/chatController.compaction.test.ts, as the plan allowed. FakeWebview.send does not await the handler, so those tests use waitFor for showError.
- The only vscode reference under src/orchestrator is a pre-existing type import in copilotClient.ts; webviewProtocol.ts stays host-free.
- setContextUsage is not posted from onSelectModel or the selection listener, so the interventions test that expects one message still holds.
