# Plan T12

## Steps

1. Add the Mode select to the composer markup and style it

   In `media/chat.html`:

   1. Markup — inside `<div class="composer-actions">` (currently `#auto-mode`, `#stop`, `#send`), insert the select as the FIRST child, immediately left of `#auto-mode`:

   ```html
   <select
     id="mode-select"
     class="mode-select"
     aria-label="Conversation mode"
     title="Conversation mode: the pipeline a dispatch from this chat runs."
   ></select>
   ```

   Leave it empty: `media/chat.js` builds its `<option>` list (so the option set is testable in the `vm` fake-DOM harness and the labels live next to the mode list they mirror).

   2. CSS — add a rule block immediately before the existing `#auto-mode` block (which sits after `button:disabled`), reusing the dropdown theme variables already used by `#provider-select, #model-select` so no new colour literal appears:

   ```css
         /* Conversation mode select: host-authoritative, sits immediately left of
            the Auto-mode toggle. Disabled while the chat is busy, while a run is
            in flight, and on a spec conversation (which is always Spec). */
         #mode-select {
           flex: 0 0 auto;
           color: var(--vscode-dropdown-foreground);
           background-color: var(--vscode-dropdown-background);
           border: 1px solid var(--vscode-dropdown-border);
           padding: 2px 4px;
         }

         #mode-select:disabled {
           opacity: 0.5;
           cursor: default;
         }
   ```

   3. Header comment — the top-of-file comment block already describes the composer ("The composer's control row also carries the Auto-mode toggle immediately left of Stop…"). Extend that sentence to name the new control, e.g. "…and, immediately left of the Auto-mode toggle, a host-authoritative Mode select that reflects `state.mode`, posts `setMode`, and is disabled while busy, while a run is active, or on a spec conversation." No other change to chat.html.

   Files: `media/chat.html`

2. Project state.mode into the select and post setMode on change

   All edits in `media/chat.js` (a plain browser script — not compiled by `tsc`, not linted; `.eslintrc.json` ignores `**/*.js` and tsconfig does not include `media/`). Follow the existing Auto-mode/model-select discipline: the host is authoritative, the control never writes state locally.

   1. Element lookup — in the `// ----- Elements` block, after the `autoBtn` line:

   ```js
     const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('mode-select'));
   ```

   2. Constants — beside `const MAX_INPUT_CHARS = 100000;`:

   ```js
     // Mirrors RUN_MODES in src/model/mode.ts, in the same order (spec first). This
     // is a plain browser script and cannot import it, so the list and its labels
     // are kept in sync by hand, exactly as protocol.js keeps DEFAULT_MODE.
     const MODE_OPTIONS = [
       { id: 'spec', label: 'Spec' },
       { id: 'bug', label: 'Bug' },
       { id: 'quick', label: 'Quick' },
       { id: 'refactor', label: 'Refactor' },
       { id: 'investigate', label: 'Investigate' },
     ];
     // Mirrors WORKSPACE_CONVERSATION_ID in src/activation/chatController.ts; any
     // other non-empty conversation id is a spec slug.
     const WORKSPACE_CONVERSATION_ID = 'workspace';
   ```

   3. Helper — next to the other small state predicates:

   ```js
     /** Whether the active conversation is a spec conversation (always Spec). */
     function isSpecConversation() {
       return state.activeId !== '' && state.activeId !== WORKSPACE_CONVERSATION_ID;
     }
   ```

   4. Renderer — add `renderMode()` immediately after `renderAutoMode()` in the file, with a doc comment saying the control is a pure projection of `state.mode`: the change handler never writes it, it posts `setMode` and the view repaints when the host echoes `setMode` back through the reducer.

   ```js
     function renderMode() {
       // The option list is static, so it is built exactly once: rebuilding it on
       // every render would clobber an open/keyboard-navigated dropdown.
       if (modeSelect.options.length === 0) {
         MODE_OPTIONS.forEach(function (item) {
           const opt = document.createElement('option');
           opt.value = item.id;
           opt.dataset.mode = item.id;
           opt.textContent = item.label;
           modeSelect.appendChild(opt);
         });
       }
       // A spec conversation is always Spec: shown pinned, whatever state.mode says.
       const pinned = isSpecConversation();
       modeSelect.value = pinned ? 'spec' : state.mode;
       if (!modeSelect.value) {
         // An unknown mode matches no option and leaves the value empty; fall back
         // to Spec rather than showing a blank control.
         modeSelect.value = 'spec';
       }
       modeSelect.disabled = state.busy || state.runActive === true || pinned;
       modeSelect.title = pinned
         ? 'A spec conversation always runs the Spec pipeline.'
         : state.runActive === true
           ? 'A run is in flight; the mode cannot change until it finishes.'
           : 'Conversation mode: the pipeline a dispatch from this chat runs.';
     }
   ```

   5. Wire into `render()` — insert `renderMode();` between `renderAutoMode();` and `updateEnablement();`.

   6. Change handler — add next to the `autoBtn` click handler (after it, before `stopBtn`):

   ```js
     modeSelect.addEventListener('change', function () {
       if (modeSelect.disabled) {
         // Belt and braces: repaint from state rather than posting.
         renderMode();
         return;
       }
       const opt = modeSelect.options[modeSelect.selectedIndex];
       const mode = (opt && opt.dataset && opt.dataset.mode) || modeSelect.value;
       if (mode && mode !== state.mode) {
         vscode.postMessage({ type: 'setMode', mode: mode });
       }
       // Host-authoritative: snap the control back to the folded state. Only the
       // host's `setMode` echo moves it, exactly as `sendText` leaves `busy` to
       // the host and `selectModel` leaves `state.selection` to it.
       renderMode();
     });
   ```

   7. Header comment — extend the sentence in the top-of-file block that describes the Auto-mode toggle so it also names the Mode select: reflects `state.mode`, posts `setMode`, repaints only on the host echo, and is disabled while `state.busy`, while `state.runActive`, or on a spec conversation (in contrast to the Auto toggle, which stays enabled while busy).

   Do not touch `media/protocol.js` (its `setMode`/`setRunActive` cases and the `mode`/`runActive` seed already exist) and do not wire anything host-side — `ChatController` handling the inbound `setMode` and posting the echo/`setRunActive` is a later todo.

   Files: `media/chat.js`

3. Teach the two existing fake-DOM harnesses about the new element id

   `media/chat.js` looks `mode-select` up at load and immediately calls `addEventListener` on it, so any harness whose `document.getElementById` returns `null` for it throws at load. Two existing test files build the id map by hand and must gain one line each (purely additive — no assertion is changed or weakened):

   - `test/chatView.providers.test.ts`: in `const ELEMENT_IDS`, after `['auto-mode', 'button'],` add `['mode-select', 'select'],`.
   - `test/modelSelectorRefresh.test.ts`: in the nested `const ELEMENT_IDS` (inside the integration describe, around line 1376–1396), after `['auto-mode', 'button'],` add `['mode-select', 'select'],`.

   Nothing else in either file changes.

   Files: `test/chatView.providers.test.ts`, `test/modelSelectorRefresh.test.ts`

4. New fake-DOM test file for the Mode control

   Add `test/chatView.mode.test.ts`, modelled directly on `test/chatView.providers.test.ts`: copy its file-local `FakeClassList` / `FakeEl` classes, its `ELEMENT_IDS` list (plus `['mode-select', 'select']`), its `loadChatView()` (runs `media/protocol.js` then `media/chat.js` in one `vm` sandbox over the hand-rolled DOM, exposing `{ ids, posted, send }`) and its `plainClone()` helper. Keep them file-local; do not extract a shared fixture (that would touch the two existing files beyond the one-line id addition).

   Header comment: fake-DOM unit tests for the composer's host-authoritative Mode select added by dispatch-modes T12.

   `describe('chat view Mode select (dispatch-modes T12)')` with these cases:

   1. **seed paint** — `const modes = view.ids['mode-select']`; `modes.options.map((o) => o.value)` deep-equals `['spec', 'bug', 'quick', 'refactor', 'investigate']`; `modes.options.map((o) => o.textContent)` deep-equals `['Spec', 'Bug', 'Quick', 'Refactor', 'Investigate']`; each option's `dataset.mode` equals its value; `modes.value === 'spec'`; `modes.disabled === false`; `view.posted.length === 0`.
   2. **the host echo moves the control** — `view.send({ type: 'setMode', mode: 'bug' })` → `modes.value === 'bug'`; then `'investigate'` → `modes.value === 'investigate'`; the option count is still 5 (the list is built once, never rebuilt).
   3. **picking a mode posts exactly one setMode and does not move the control** — `modes.selectedIndex = modes.options.findIndex((o) => o.value === 'quick'); modes.fire('change', {});` → `view.posted.map(plainClone)` deep-equals `[{ type: 'setMode', mode: 'quick' }]` and `modes.value === 'spec'` (snapped back; only the echo moves it). Then `view.send({ type: 'setMode', mode: 'quick' })` → `modes.value === 'quick'` and still one posted message.
   4. **re-picking the active mode posts nothing** — after the echo above, fire `change` with `quick` still selected → `view.posted.length` unchanged.
   5. **disabled while busy** — `view.send({ type: 'setBusy', busy: true })` → `modes.disabled === true`; a `change` fired while disabled posts nothing; `setBusy false` → `modes.disabled === false`. Also assert `view.ids['auto-mode'].disabled === false` while busy, pinning that the Auto toggle stays flippable mid-run.
   6. **disabled while a run is active** — `view.send({ type: 'setRunActive', active: true })` → `modes.disabled === true`, a fired `change` posts nothing, and `modes.title` mentions the run; `active: false` → enabled again. Independent of `busy`.
   7. **pinned to Spec on a spec conversation** — `view.send({ type: 'setMode', mode: 'quick' })`, then `view.send({ type: 'setConversations', items: [{ id: 'workspace', label: 'Workspace' }, { id: 'my-spec', label: 'my-spec' }] })` and `view.send({ type: 'setActive', conversationId: 'my-spec' })` → `modes.value === 'spec'` and `modes.disabled === true`; a fired `change` posts nothing. Then `view.send({ type: 'setActive', conversationId: 'workspace' })` → `modes.disabled === false` and `modes.value === 'quick'` (the host's mode comes back, unchanged by the pinning).
   8. **an unknown mode falls back to Spec rather than blanking** — send a `setMode` with an off-union value cast through `as unknown as HostToWebview` (the reducer has no `isRunMode` guard, so the state really can hold it) and assert `modes.value === 'spec'` and the option count is still 5.

   Use typed `HostToWebview` literals for `view.send(...)` as the providers test does, and `plainClone` for every posted-message comparison (messages are created inside the vm realm).

   Files: `test/chatView.mode.test.ts`

## Risks

- `media/chat.js` throws at load if `document.getElementById('mode-select')` returns null, so every fake-DOM harness must know the id. Both existing harnesses (`test/chatView.providers.test.ts`, the nested one in `test/modelSelectorRefresh.test.ts`) are updated in step 3; forgetting either breaks a currently passing test file rather than the new one.
- `MODE_OPTIONS` duplicates `RUN_MODES` from `src/model/mode.ts` by hand, like `protocol.js`'s `mode: 'spec'` seed. It is unguarded by any parity test, so a future mode added in TypeScript will silently not appear in the composer. Keep the mirror comment pointing at the source file; do not invent a new cross-file parity fixture in this todo.
- The snap-back in the change handler means the user sees the select revert until the host echoes `setMode`. That is the required host-authoritative discipline, but until the host side lands (a later todo) the control will always appear to bounce back to Spec — expected, not a bug, and the new tests assert exactly that.
- The fake `FakeEl` select semantics differ subtly from a real `<select>`: assigning a `value` with no matching option leaves it `''`. The `if (!modeSelect.value) { modeSelect.value = 'spec'; }` fallback depends on that, and behaves the same in a real browser (an unmatched assignment clears the selection).
- Disabling on a spec conversation relies on the `'workspace'` conversation-id literal mirroring `WORKSPACE_CONVERSATION_ID`. If the host ever renames that id the control silently pins on the Workspace conversation instead; the mirror comment names the source constant.
- `.composer-actions` is `justify-content: flex-end`, so the select is drawn immediately left of Auto with no extra spacing rules; on a narrow sidebar the four controls may wrap. No new layout rule is added in this todo beyond `flex: 0 0 auto`.

## Acceptance

- `media/chat.html` has exactly one `<select id="mode-select">`, it is the first child of `.composer-actions` (immediately left of `#auto-mode`), it carries an `aria-label`, and its `#mode-select` / `#mode-select:disabled` CSS uses only existing VS Code theme variables — no hardcoded colour.
- `media/chat.js` builds the five options once, in `RUN_MODES` order with the labels Spec/Bug/Quick/Refactor/Investigate, each carrying `dataset.mode`; `renderMode()` is called from `render()` and the option list is never rebuilt on later renders.
- The change handler posts `{ type: 'setMode', mode }` at most once per user pick, posts nothing when the picked mode equals `state.mode` and nothing when the control is disabled, and never assigns `state.mode` locally — the rendered value follows only the host's `setMode` echo.
- `modeSelect.disabled` is true exactly when `state.busy`, `state.runActive`, or the active conversation id is neither `''` nor `'workspace'`; the Auto-mode toggle remains enabled while busy.
- On a spec conversation the control shows Spec regardless of `state.mode`, and returning to the Workspace conversation restores the host's mode.
- `media/protocol.js`, `src/orchestrator/webviewProtocol.ts`, `test/fixtures/protocolCases.ts`, `test/webviewProtocol.mirror.test.ts` and `test/webviewProtocol.reducer.test.ts` are untouched by this todo.
- `npm run compile` is clean (zero TypeScript errors).
- `npm run lint` reports zero errors; only the pre-existing warning(s) already present on this branch remain (`media/` is not linted).
- `npm test` passes with no failures: every previously passing test still passes (the only edits to existing tests are the two one-line `ELEMENT_IDS` additions), and the new `test/chatView.mode.test.ts` cases all pass.
