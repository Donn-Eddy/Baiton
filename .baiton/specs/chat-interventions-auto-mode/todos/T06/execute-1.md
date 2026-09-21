# Execute T06

## Summary

T06 implemented: added the Auto-mode toggle to the chat webview composer control row (chat.html) and its wiring (chat.js), posting setAutoMode with no host change. All four plan steps verified; compile/lint/tests pass at the recorded baseline (912 passing, 1 pending, 0 failing).

## Files changed

- `media/chat.html`
- `media/chat.js`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git status --porcelain`
- `git diff --stat`
- `node -e "new Function(fs.readFileSync('media/chat.js'))" (syntax check)`

## Notes

- chat.html: <button id="auto-mode" class="secondary" type="button" aria-pressed="false" title="Auto mode off: every ask waits for you. Click to turn on.">Auto: Off</button> inserted as the first child of <div class="composer-actions">, immediately before #stop, with no disabled attribute — it stays usable while busy.
- chat.html: header comment extended with one sentence about the Auto-mode toggle immediately left of Stop reflecting state.autoMode and posting setAutoMode.
- chat.html: #auto-mode / #auto-mode[aria-pressed='true'] / [aria-pressed='true']:hover:not(:disabled) rules added AFTER the generic button.secondary and button:disabled rules so the id+attribute selectors win; colors use only --vscode-* variables, no literal colors.
- chat.js: autoBtn declared in the Elements section immediately after stopBtn with the same @type {HTMLButtonElement} cast idiom and the exact id 'auto-mode'.
- chat.js: renderAutoMode() added directly before updateEnablement(); it derives the pressed state via Boolean(state.autoMode), sets aria-pressed, the 'Auto: On'/'Auto: Off' label, the contextual title, and forces autoBtn.disabled = false. render() now calls renderAutoMode() between renderTranscript() and updateEnablement(). updateEnablement() was left byte-for-byte unchanged (no autoBtn reference).
- chat.js: autoBtn click handler registered immediately before the stop handler; it posts exactly { type: 'setAutoMode', enabled: !state.autoMode } — no local state mutation, no optimistic render, no vscode.setState, no busy guard.
- chat.js: top block comment extended with the Auto-toggle sentence.
- No optimistic local flips: the webview remains a pure projection of host state; the pressed look is driven by the host echo through window.baitonProtocol.reduce (protocol.js already defines the setAutoMode reducer seeded with autoMode: false — untouched).
- chatController.setHost wiring intentionally not added: host handle() silently ignores setAutoMode until the later wiring todo.
- git status shows only media/chat.html and media/chat.js modified; npm test reports 912 passing, 1 pending, 0 failing — matching the recorded baseline. chat.js syntax verified to parse under the Function constructor as a brace/tag sanity check.
