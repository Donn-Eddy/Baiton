# Plan T06

## Steps

1. Add the Auto toggle button to the composer control row in media/chat.html

   In the `<div class="composer-actions">` block (currently `#stop` then `#send`, inside `<div class="composer">`), insert one new button as the FIRST child, immediately before `<button id="stop" ...>`:

       <button
         id="auto-mode"
         class="secondary"
         type="button"
         aria-pressed="false"
         title="Auto mode off: every ask waits for you. Click to turn on."
       >Auto: Off</button>

   Rules: `type="button"`, NO `disabled` attribute (unlike `#stop`, this control stays usable while a pipeline runs), and the initial markup must match the seeded `autoMode: false` state (label `Auto: Off`, `aria-pressed="false"`) so the first paint is consistent before any host message arrives. `.composer-actions` is `display:flex; justify-content:flex-end`, so placing the element before `#stop` in document order puts it immediately left of Stop with the existing `gap: var(--baiton-gap)`; do not add margins or reorder Stop/Send.

   Also extend the block comment near the top of the file (the paragraph that mentions the transcript's inline intervention cards) with one sentence: the composer's control row also carries the Auto-mode toggle immediately left of Stop, which reflects `state.autoMode` and posts `setAutoMode`.

   Files: `media/chat.html`

2. Style the pressed (on) state of the toggle from theme variables only

   In the same `<style nonce="${nonce}">` block, after the existing `button.secondary` / `button.secondary:hover:not(:disabled)` / `button:disabled` rules (so the id selectors come later and win), add:

       /* Auto-mode toggle: secondary (off) vs. primary-filled (on). The pressed
          state is driven by aria-pressed so the DOM attribute is the single source
          of truth for both the visual and the accessible state. */
       #auto-mode {
         flex: 0 0 auto;
         white-space: nowrap;
       }

       #auto-mode[aria-pressed='true'] {
         color: var(--vscode-button-foreground);
         background-color: var(--vscode-button-background);
       }

       #auto-mode[aria-pressed='true']:hover:not(:disabled) {
         background-color: var(--vscode-button-hoverBackground);
       }

   No hardcoded colors (Req 16.6/16.7 — every color is a `--vscode-*` variable). `#auto-mode[aria-pressed='true']` (id + attribute) outranks `button.secondary`, so the `class="secondary"` styling applies only in the off state; do not remove the `secondary` class from the markup.

   Files: `media/chat.html`

3. Add the element reference in media/chat.js

   In the `// ----- Elements -----` section, immediately after the `stopBtn` line (line ~48), add:

       const autoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('auto-mode'));

   Keep the same `/** @type {HTMLButtonElement} */ (document.getElementById('...'))` cast idiom as the surrounding lines; the id string must be exactly `auto-mode`, matching the markup added in step 1.

   Files: `media/chat.js`

4. Project state.autoMode onto the toggle with a renderAutoMode() function

   In the `// ----- Rendering -----` region, add a `renderAutoMode()` function next to `updateEnablement()` (place it directly before `updateEnablement` so `render()` reads top-to-bottom):

       /**
        * The Auto-mode toggle is a pure projection of `state.autoMode`: the host is
        * authoritative, so the button never writes the flag locally — it posts
        * `setAutoMode` and repaints when the host echoes `setAutoMode` back through
        * the reducer. It is deliberately never disabled: an ask normally arrives
        * while a pipeline is running, so Auto must be flippable mid-run.
        */
       function renderAutoMode() {
         const on = Boolean(state.autoMode);
         autoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
         autoBtn.textContent = on ? 'Auto: On' : 'Auto: Off';
         autoBtn.title = on
           ? 'Auto mode on: safe asks are auto-approved, the rest are escalated as cards. Click to turn off.'
           : 'Auto mode off: every ask waits for you. Click to turn on.';
         autoBtn.disabled = false;
       }

   Then call it from `render()`, adding `renderAutoMode();` between `renderTranscript();` and `updateEnablement();`. Do NOT touch `updateEnablement()`'s existing body (`sendBtn`, `stopBtn`, `inputEl`, `newChatBtn` enablement from `state.busy`) and do not add `autoBtn` to it — that is what keeps the toggle enabled while busy. `Boolean(state.autoMode)` (rather than `state.autoMode` directly) keeps the projection total even if a host message ever produced a state without the field.

   Files: `media/chat.js`

5. Post setAutoMode on click

   In the `// ----- Actions -----` region, next to the existing `stopBtn.addEventListener('click', ...)` registration (put it immediately before that stop handler so the source order matches the DOM order), add:

       autoBtn.addEventListener('click', function () {
         // Host-authoritative: request the flip and let the host's `setAutoMode`
         // echo drive the repaint, exactly as `sendText` leaves `busy` to the host.
         vscode.postMessage({ type: 'setAutoMode', enabled: !state.autoMode });
       });

   No `state.busy` guard (the toggle is intentionally live during a run), no local `state = ...` assignment, no optimistic `renderAutoMode()` call, and no `vscode.setState` persistence — cross-session persistence lives in the host's `workspaceState`, not in the webview. `enabled` must be the negation of the currently rendered flag, so a double click sends `true` then, after the echo, `false`.

   Files: `media/chat.js`

6. Update the chat.js header comment and verify

   Extend the file's top block comment (the paragraph describing the transcript and intervention cards) with one sentence: the composer control row also carries an Auto-mode toggle immediately left of Stop that reflects `state.autoMode`, stays enabled while busy, and posts `setAutoMode`.

   No other files change. In particular: `media/protocol.js` already handles `setAutoMode` (`case 'setAutoMode': return Object.assign({}, state, { autoMode: msg.enabled });`) and already seeds `autoMode: false` in `initialWebviewState()`, and `src/orchestrator/webviewProtocol.ts` already carries `setAutoMode` in both message unions plus `WebviewState.autoMode` — so no protocol, reducer, fixture or host change is needed or permitted here. `src/activation/chatController.ts`'s `handle()` switch has no `default:` branch and silently ignores message types it does not list, so the new `setAutoMode` post is inert (no thrown error, no log) until the host wiring todo lands; do not add that wiring.

   Run `npm run compile`, `npm run lint` and `npm test` and confirm they still pass unchanged (the last recorded baseline is 912 passing, 1 pending, 0 failing). `media/` is excluded from eslint (`ignorePatterns` includes `**/*.js`) and from `tsc -p ./`, so these commands confirm nothing was broken elsewhere rather than checking the new code; re-read the two edited files to confirm balanced tags/braces and that `// @ts-check` in chat.js still has no unresolved cast.

   Files: `media/chat.js`, `media/chat.html`

## Risks

- The host does not handle `setAutoMode` yet (that is a later todo), so clicking the toggle will not visibly change it in a running extension until then. This is expected: `chatController.handle()` falls through silently for unlisted message types. Do not compensate with an optimistic local `state.autoMode` write — that would make the webview stop being a pure projection of host state and would fight the later echo.
- Adding `autoBtn` to `updateEnablement()` (or leaving a `disabled` attribute in the markup) would break the explicit requirement that the toggle stays usable while busy; `updateEnablement()` must remain exactly as it is.
- `button.secondary` is matched by the `class="secondary"` on the toggle; without the later, higher-specificity `#auto-mode[aria-pressed='true']` rules the on state would look identical to the off state. Keep the new rules AFTER the generic button rules in the stylesheet.
- A mismatch between the markup id and `getElementById('auto-mode')` yields `null` and the first `renderAutoMode()` call throws inside the IIFE, blanking the whole view. Keep the id literal identical in both files.
- Scope boundary: the inline intervention card rendering in `media/chat.js` was delivered by the preceding webview todo. Do not restructure `renderIntervention`/card helpers, the `answeredInterventions`/`interventionDrafts` bookkeeping, or the `.intervention*` CSS while editing these two files.
- The webview has no automated DOM test harness in this repo (no test exercises `media/chat.js`), so `npm test` cannot prove the toggle's behaviour; the acceptance checks below are read-verified against the two edited files.

## Acceptance

- `media/chat.html` contains `<button id="auto-mode" class="secondary" type="button" aria-pressed="false" ...>Auto: Off</button>` as the first child of `.composer-actions`, immediately before `<button id="stop" ...>`, with no `disabled` attribute.
- The stylesheet defines `#auto-mode[aria-pressed='true']` (and its `:hover:not(:disabled)` variant) after the generic `button.secondary` rules, using only `--vscode-*` variables — no literal color values anywhere in the added CSS.
- `media/chat.js` declares `autoBtn` from `document.getElementById('auto-mode')` in the Elements section and has a `renderAutoMode()` that sets `aria-pressed`, the label (`Auto: On` / `Auto: Off`) and the title from `state.autoMode`, and sets `autoBtn.disabled = false`.
- `render()` calls `renderAutoMode()`, and `updateEnablement()` is byte-for-byte unchanged (no reference to `autoBtn`), so the toggle remains enabled when `state.busy` is true.
- The click handler posts exactly `{ type: 'setAutoMode', enabled: !state.autoMode }` and does nothing else: no `state` mutation, no `vscode.setState` write, no `state.busy` guard, no extra postMessage.
- Folding a host `{ type: 'setAutoMode', enabled: true }` message through the existing `window.baitonProtocol.reduce` and re-rendering flips the button to the pressed appearance and the `Auto: On` label; folding `enabled: false` flips it back.
- Only `media/chat.html` and `media/chat.js` are modified — `git status` shows no other changed file, and `media/protocol.js`, `src/orchestrator/webviewProtocol.ts`, `src/activation/chatController.ts` and everything under `test/` are untouched.
- `npm run compile`, `npm run lint` and `npm test` all succeed with the test counts unchanged from the recorded baseline (912 passing, 1 pending, 0 failing).
