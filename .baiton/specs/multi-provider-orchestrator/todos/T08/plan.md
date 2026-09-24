# Plan T08

## Steps

1. Add the Provider & Model bar and retheme the empty state in media/chat.html

   Markup: (a) Inside `<div class="composer">`, immediately BEFORE the `<textarea id="input">`, add:

     <div class="model-bar">
       <label for="model-select">Model</label>
       <select id="model-select" aria-label="Provider and model"></select>
       <button id="model-set-key" class="link-button" type="button">Set API key…</button>
     </div>

   (b) In `#empty-state`, replace the Endpoint row with a Provider row and retitle the button: the <dl> becomes `<dt>Provider</dt><dd id="empty-provider"></dd><dt>Model</dt><dd id="empty-model"></dd>`. Delete the `id="empty-endpoint"` <dd> and its <dt> entirely (chat.js must stop referencing it). Change the button text of `#empty-set-key` from 'Set Orchestrator API Key' to 'Set Provider API Key'; keep its id and class unchanged (it still posts triggerFix/setApiKey).

   CSS (inside the existing <style nonce="${nonce}"> block, next to the other selector styles, using only VS Code theme variables — no literal colors):

     .model-bar { flex: 0 0 auto; display: flex; align-items: center; gap: var(--baiton-gap); }
     .model-bar label { color: var(--vscode-descriptionForeground); }
     #model-select { flex: 1 1 auto; min-width: 0; color: var(--vscode-dropdown-foreground); background-color: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
     #model-select:disabled { opacity: 0.5; cursor: default; }
     #model-select optgroup:disabled { color: var(--vscode-descriptionForeground); }
     #model-set-key { flex: 0 0 auto; white-space: nowrap; display: none; }
     #model-set-key.visible { display: inline; }

   Also update the file's top comment block: mention that the composer carries the grouped Provider & Model dropdown (one <optgroup> per provider, disabled groups for providers without a key) and that the empty state shows provider + model. No script tags change; no new files are loaded.

   Files: `media/chat.html`

2. Wire the new elements and provider state into media/chat.js

   In the '----- Elements -----' block add, next to the existing lookups:

     const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('model-select'));
     const modelSetKey = /** @type {HTMLButtonElement} */ (document.getElementById('model-set-key'));
     const emptyProvider = /** @type {HTMLElement} */ (document.getElementById('empty-provider'));

   and REMOVE the `emptyEndpoint` lookup (`document.getElementById('empty-endpoint')`) — the element no longer exists.

   In the '----- State -----' block add, beside `renderedSessionSignature`:

     // The signature the provider dropdown DOM was last built from; the <select>
     // is rebuilt only when it changes so opening/keyboard-navigating it is not
     // clobbered by an unrelated re-render (a stream delta, a tool update).
     let renderedProviderSignature = null;

   The view stays a pure projection of `state` (same discipline as the Auto-mode toggle): the change handler never writes `state.selection` locally, it posts `selectModel` and repaints when the host echoes `setProviders` back through the reducer. `state.providers` (ProviderGroup[]: { id, label, enabled, reason?, models: [{ id, label? }] }) and `state.selection` (ModelSelection | null) are already seeded by media/protocol.js and folded by its `setProviders` case — do not touch media/protocol.js or src/orchestrator/webviewProtocol.ts in this todo.

   Files: `media/chat.js`

3. Implement renderProviders(): one optgroup per provider in host order, disabled groups carry their reason

   Add these functions in the rendering section, immediately after `renderSelector()`:

     /** The catalog label of a provider id, falling back to the raw id. */
     function providerLabel(id) {
       for (let i = 0; i < state.providers.length; i++) {
         if (state.providers[i].id === id) { return state.providers[i].label; }
       }
       return id;
     }

     /** Signature of everything the dropdown DOM depends on. */
     function providerSignature() {
       const groups = state.providers.map(function (g) {
         return [g.id, g.label, g.enabled ? '1' : '0', g.reason || '',
           (g.models || []).map(function (m) { return m.id + '\u0002' + (m.label || ''); }).join('\u0001')
         ].join('\u0001');
       }).join('\u0000');
       const sel = state.selection ? state.selection.provider + '\u0001' + state.selection.model : '';
       return groups + '\u0003' + sel + '\u0003' + (state.busy ? '1' : '0');
     }

     function renderProviders() {
       const signature = providerSignature();
       if (signature !== renderedProviderSignature) {
         renderedProviderSignature = signature;
         modelSelect.textContent = '';
         let matched = null;
         state.providers.forEach(function (group) {
           const og = document.createElement('optgroup');
           og.label = group.label;
           if (!group.enabled) {
             og.disabled = true;
             if (group.reason) { og.title = group.reason; }
             const note = document.createElement('option');
             note.value = '';
             note.disabled = true;
             note.textContent = group.reason || 'Unavailable';
             og.appendChild(note);
           } else if (!group.models || group.models.length === 0) {
             const none = document.createElement('option');
             none.value = '';
             none.disabled = true;
             none.textContent = 'No models available';
             og.appendChild(none);
           } else {
             group.models.forEach(function (model) {
               const opt = document.createElement('option');
               opt.value = group.id + '/' + model.id;
               opt.dataset.provider = group.id;
               opt.dataset.model = model.id;
               opt.textContent = model.label || model.id;
               if (state.selection && state.selection.provider === group.id && state.selection.model === model.id) {
                 opt.selected = true;
                 matched = opt;
               }
               og.appendChild(opt);
             });
           }
           modelSelect.appendChild(og);
         });
         // No option matches the active selection (or nothing is selected yet):
         // show a disabled placeholder at the top rather than silently selecting
         // some other provider's model.
         if (matched === null) {
           const placeholder = document.createElement('option');
           placeholder.value = '';
           placeholder.disabled = true;
           placeholder.selected = true;
           placeholder.textContent = state.selection
             ? providerLabel(state.selection.provider) + ' / ' + state.selection.model + ' (unavailable)'
             : 'Select a model…';
           modelSelect.insertBefore(placeholder, modelSelect.firstChild);
         } else {
           modelSelect.value = matched.value;
         }
         // The 'Set API key…' affordance appears whenever at least one provider is
         // disabled; it reuses the existing triggerFix/setApiKey protocol message.
         const blocked = state.providers.filter(function (g) { return !g.enabled; });
         if (blocked.length > 0) {
           modelSetKey.classList.add('visible');
           modelSetKey.title = blocked.map(function (g) { return g.reason || (g.label + ' is unavailable.'); }).join(' ');
         } else {
           modelSetKey.classList.remove('visible');
           modelSetKey.title = '';
         }
       }
       // Enablement is cheap and must follow busy even when the DOM is reused.
       const anyEnabled = state.providers.some(function (g) { return g.enabled && g.models && g.models.length > 0; });
       modelSelect.disabled = state.busy || !anyEnabled;
     }

   Note: `modelSelect.insertBefore(x, modelSelect.firstChild)` requires `firstChild`; use `modelSelect.firstChild || null`. Groups are rendered in the order the host sent them — the webview never sorts or filters them.

   Files: `media/chat.js`

4. Show provider + model in the empty state and call renderProviders() from render()

   Rewrite `renderEmptyState()` so it no longer reads `state.empty.endpoint`:

     function renderEmptyState() {
       if (state.empty) {
         emptyProvider.textContent = state.selection
           ? providerLabel(state.selection.provider)
           : 'not configured';
         emptyModel.textContent =
           (state.selection && state.selection.model) || state.empty.model || 'not configured';
         emptyState.classList.add('visible');
         transcriptEl.style.display = 'none';
       } else {
         emptyState.classList.remove('visible');
         transcriptEl.style.display = '';
       }
     }

   In `render()`, insert `renderProviders();` immediately after `renderSelector();` so the dropdown repaints on every folded message (including `setBusy`, which changes its enablement). Leave the rest of the render order unchanged. Update the file's top doc comment to describe the Provider & Model dropdown and the provider/model empty state.

   Files: `media/chat.js`

5. Post selectModel on change and keep the Set API key affordance on triggerFix

   In the '----- Actions -----' / listener section, next to the existing `selectEl.addEventListener('change', …)`, add:

     modelSelect.addEventListener('change', function () {
       const opt = modelSelect.options[modelSelect.selectedIndex];
       const provider = opt && opt.dataset ? opt.dataset.provider : undefined;
       const model = opt && opt.dataset ? opt.dataset.model : undefined;
       if (!provider || !model) {
         // A disabled placeholder/reason row: repaint from state rather than
         // posting a bogus selection.
         renderedProviderSignature = null;
         renderProviders();
         return;
       }
       if (state.selection && state.selection.provider === provider && state.selection.model === model) {
         return;
       }
       vscode.postMessage({ type: 'selectModel', provider: provider, model: model });
     });

     modelSetKey.addEventListener('click', function () {
       vscode.postMessage({ type: 'triggerFix', action: 'setApiKey' });
     });

   The payload shape must be exactly `{ type: 'selectModel', provider, model }` — the `WebviewToHost` variant added in T07. Leave the existing `emptySetKey` and `errorFix` handlers as they are (both already post `triggerFix`); the host command rename is a later todo, so do not change `renderError()`'s 'Set Orchestrator API Key' label here.

   Files: `media/chat.js`

6. Add a fake-DOM unit test for the dropdown projection

   New file `test/chatView.providers.test.ts`. It loads `media/protocol.js` and `media/chat.js` into one `vm` sandbox (same pattern as `loadProtocolMirror()` in test/webviewProtocol.mirror.test.ts) over a hand-rolled minimal DOM, then drives the view with host messages.

   Fake DOM surface the loader must provide (this is all chat.js touches): a `makeEl(tag)` factory with `tagName`, `children[]`, `parentNode`, `className`, `id`, `value`, `label`, `title`, `type`, `disabled`, `selected`, `checked`, `tabIndex`, `open`, `style = {}`, `dataset = {}`, `classList` ({ add, remove, contains, toggle } over a Set), `setAttribute`/`getAttribute`/`removeAttribute` into an attrs map, `appendChild`, `insertBefore(node, ref)`, `get firstChild`/`get lastElementChild`, `textContent` (getter concatenates descendants; setter clears children and sets a text value), `innerHTML` setter (store the string), `addEventListener(type, fn)` recording into a handlers map plus a test-only `fire(type, evt)`, `querySelector`/`querySelectorAll` walking descendants for `[data-intervention-field]`-style attribute selectors, `focus()`, `scrollTop`/`scrollHeight`/`clientHeight` numbers. For a `select` element expose an `options` getter that FLATTENS `option` children of both the select and its `optgroup` children (real HTMLOptionsCollection semantics) and a `selectedIndex` getter/setter backed by `selected` flags; setting `select.value` selects the first option with that value.

   `document` provides `createElement`, `getElementById` over a prebuilt map holding every id chat.html defines (`conversation-select`, `error-banner`, `error-message`, `error-fix`, `transcript`, `empty-state`, `empty-provider`, `empty-model`, `empty-set-key`, `input`, `send`, `stop`, `auto-mode`, `new-chat`, `session-list`, `model-select`, `model-set-key`) and `activeElement`. The sandbox also needs `window` with `addEventListener` (capture the 'message' listener), `acquireVsCodeApi()` returning `{ postMessage(m){ posted.push(m); }, getState(){…}, setState(s){…} }`, and `window.baitonSanitizeHtml = (s) => s`. Export a helper `loadChatView()` returning `{ ids, posted, send(msg) }` where `send` invokes the captured message listener with `{ data: msg }`.

   Cases to assert:
   1. Seed paint: `model-select` has no options and `model-set-key` is not `.visible`.
   2. `setProviders` with the five groups in catalog order (copilot enabled w/ models, google disabled with reason, opencode disabled with reason, mistral enabled, openai disabled) renders five `optgroup`s whose `label`s are in exactly that order; the disabled ones have `disabled === true` and a single disabled option whose text is the group's `reason`.
   3. The option matching `selection` is `selected` and `select.value` is `provider + '/' + model`.
   4. A `selection` no option matches (or `selection: null`) inserts a disabled placeholder at index 0 that is selected, and nothing is posted.
   5. Selecting an enabled option and firing 'change' posts exactly `{ type: 'selectModel', provider, model }`; firing 'change' on a disabled reason row posts nothing; re-selecting the already-active pair posts nothing.
   6. Clicking `model-set-key` posts `{ type: 'triggerFix', action: 'setApiKey' }`; it is `.visible` only when some group is disabled.
   7. `setBusy` true disables `model-select`, false re-enables it while enabled models exist.
   8. `setEmptyState` + a `setProviders` selection puts the provider LABEL in `empty-provider` and the selection's model in `empty-model`; with `selection: null` both fall back ('not configured' / the message's `model`).

   Use `describe('chat view provider dropdown (multi-provider-orchestrator T08)')`. Keep the file lint-clean under `npx eslint src test --ext .ts` (no `any` without a comment, no unused vars) and compiling under `npx tsc --noEmit -p tsconfig.json`.

   Files: `test/chatView.providers.test.ts`

7. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json` (media/ is not in `include`, so only the new test is type-checked), `npx eslint src test --ext .ts` (expect only the pre-existing `_legacy` no-unused-vars warning in src/orchestrator/webviewProtocol.ts), `npx mocha test/chatView.providers.test.ts`, and `npm run test:unit` — the reducer and mirror suites must stay green, and nothing in src/ or media/protocol.js changes in this todo.

   Files: (none)

## Risks

- media/ is neither compiled nor linted (tsconfig `include` is src/test only, .eslintrc covers .ts), so a typo in chat.js fails only at runtime in the webview or in the new fake-DOM test — keep the test broad enough to execute every new branch of renderProviders().
- The fake DOM is the fiddly part: `select.options` must flatten options nested in `optgroup`s, and `textContent` must both clear children on set and concatenate on get, or renderSelector/renderTranscript will throw at load. If the stub grows past ~200 lines, trim by giving the test only the elements chat.js actually queries rather than modelling the full shell.
- chat.js runs `render()` at load, so any missing element id in the stub crashes the whole module — add all 17 ids listed above up front.
- Removing `#empty-endpoint` from chat.html is a hard dependency of the chat.js edit: leaving the `emptyEndpoint` lookup in place while deleting the element makes `emptyEndpoint.textContent = …` throw on the first empty-state render.
- `setEmptyState` still carries `endpoint` on the wire (the host's ChatController posts it and the T07 reducer stores it); T08 only stops projecting it. Do not change the protocol or the controller here.
- The empty state's visibility depends on host message ordering (`renderConversation` clears `state.empty`) — an existing behaviour this todo does not touch. Judge the empty-state work by the projection (provider label + model in the DOM when `state.empty` is set), not by whether the pane happens to be visible in a live window.
- Disabling the dropdown while `state.busy` is a deliberate choice (mirrors input/New Chat) so a provider is not swapped mid-run; if a later todo wants mid-run switching, only the `modelSelect.disabled` line and the busy term of the signature need to change.
- A disabled `<optgroup>` renders differently across platforms; the per-group disabled option carrying the reason text is what guarantees the user sees why a provider is unavailable, so do not drop it in favour of the optgroup `title` alone.

## Acceptance

- media/chat.html contains a `.model-bar` inside the composer with `<select id="model-select">` and `<button id="model-set-key">`, styled only with VS Code theme variables, and its `#empty-state` <dl> reads Provider (`#empty-provider`) / Model (`#empty-model`) with no `#empty-endpoint` element.
- After a `setProviders` message, `#model-select` holds exactly one `<optgroup>` per group, in the order the host sent them, each labelled with the group's `label`.
- Every group with `enabled === false` renders `optgroup.disabled === true` and contains one disabled option whose text is the group's `reason`; no selectable model option exists under it.
- The option whose provider/model equals `state.selection` is the selected one; when no option matches (including `selection: null`), a disabled placeholder is selected at index 0 and no message is posted.
- Changing the selection to an enabled model posts exactly `{ type: 'selectModel', provider, model }` once; re-picking the active pair or a disabled row posts nothing, and the webview never mutates `state.selection` itself.
- The 'Set API key…' button is visible exactly when at least one provider group is disabled and posts `{ type: 'triggerFix', action: 'setApiKey' }`.
- `#model-select` is disabled while `state.busy` is true, and while no enabled group offers a model.
- The empty state shows the provider's display label (or 'not configured') and the selected model, never the endpoint URL.
- `npx tsc --noEmit -p tsconfig.json` is clean, `npx eslint src test --ext .ts` reports no new errors, and `npm run test:unit` passes including the new `test/chatView.providers.test.ts`.
- No file under src/ and neither media/protocol.js nor the protocol fixtures are modified by this todo.
