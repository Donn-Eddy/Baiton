# Plan T14

## Steps

1. Split the composer model bar into a provider select then a model select, plus a stale badge

   In `media/chat.html`, replace the single grouped dropdown in `<div class="model-bar">` with, in order: `<label for="provider-select">Provider</label>`, `<select id="provider-select" aria-label="Provider"></select>`, `<label for="model-select">Model</label>`, `<select id="model-select" aria-label="Model"></select>`, `<span id="model-stale" class="stale-note"></span>`, then the existing `<button id="model-set-key" class="link-button" type="button">Set API key…</button>` unchanged (same id, class, text, so its handler and CSS still apply).

   CSS edits inside the `<style nonce="${nonce}">` block:
   - Change the `#model-select { … }` selector to `#provider-select,\n#model-select { … }` keeping the same declarations (`flex: 1 1 auto; min-width: 0;` plus the `--vscode-dropdown-*` colors and padding), and likewise `#provider-select:disabled, #model-select:disabled` for the existing `opacity: .5; cursor: default` rule.
   - Delete the now-dead `#model-select optgroup:disabled { … }` rule — the model select no longer contains optgroups.
   - Add a `.stale-note` rule copied in spirit from `media/config.html` (lines 179-189): `display: none; font-size: 0.9em; color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground)); white-space: nowrap;` plus `.stale-note.visible:not(:empty) { display: inline; }` so a fresh catalog leaves no gap.
   - Give the two selects a sane share of the row, e.g. `#provider-select { flex: 0 1 40%; }` so the model select stays the wider control.

   Update the two prose comments that describe the old control: the top HTML comment block ("the grouped Provider & Model dropdown: one <optgroup> per provider …") becomes a description of the provider-first pair, the stale badge and the fact that only configured providers are posted.

   Files: `media/chat.html`

2. Look up the two new elements and track the chosen provider in chat.js

   In `media/chat.js`:
   - Next to the existing `modelSelect` / `modelSetKey` lookups (around lines 53-54) add `const providerSelect = /** @type {HTMLSelectElement} */ (document.getElementById('provider-select'));` and `const staleBadge = /** @type {HTMLElement} */ (document.getElementById('model-stale'));`.
   - Next to `let renderedProviderSignature = null;` (line 92) add two module-local UI variables with comments: `let providerChoice = null;` — which provider the provider select currently shows, a webview-only concern (the host stays authoritative for `state.selection`) — and `let lastSelectionKey = null;` — the `provider\u0001model` key the choice was last synced from.
   - Update the file's top comment block (lines 24-28) the same way as chat.html: provider select then model select, only configured providers arrive, a stale badge, `(custom)` options, and the unchanged rule that the change handlers never write `state.selection` — they post `selectModel` and repaint when the host echoes `setProviders`.

   Files: `media/chat.js`

3. Derive the chosen provider from state, then rebuild both selects in renderProviders()

   Rewrite `renderProviders()` (media/chat.js ~lines 768-857) around three helpers, keeping the existing signature/rebuild guard so opening or keyboard-navigating a select is not clobbered by an unrelated re-render (a stream delta, a tool update).

   1. `function groupById(id)` — linear scan of `state.providers` returning the group or `undefined` (reuse it from `providerLabel`).
   2. `function syncProviderChoice()` — compute `selKey = state.selection ? state.selection.provider + '\u0001' + state.selection.model : ''`. When `selKey !== lastSelectionKey`, set `lastSelectionKey = selKey` and, if `state.selection`, `providerChoice = state.selection.provider` (a host-side selection change always wins). Then, if `providerChoice` is null, or it is neither a group id nor the current `state.selection.provider`, fall back in order: `state.selection && state.selection.provider`, else the first group with `enabled && models.length > 0`, else the first group, else `''`. This is what keeps a user's provider pick alive across an unrelated `setProviders` echo while still following a real selection change.
   3. `function providerSignature()` — extend the existing one so it also covers the new inputs: per group append `g.stale ? '1' : '0'`, `g.staleReason || ''`, and per model `(m.custom ? '1' : '0')`; after the existing selection and busy fields append `providerChoice || ''` and `state.refreshedAt || ''`.

   On rebuild:
   - Provider select: `providerSelect.textContent = ''`, then one `<option>` per group in host order (never sort or filter — the host posts only configured providers), `opt.value = group.id`, `opt.dataset.provider = group.id`, `opt.textContent = group.label`; when `group.enabled === false` set `opt.disabled = true` and `opt.title = group.reason || ''` so a host-shown-but-unusable provider is still visible and explained. If `state.selection` and no group has `state.selection.provider`, insert first a `(custom)` option: `value = state.selection.provider`, `dataset.provider = state.selection.provider`, `dataset.custom = '1'`, text `state.selection.provider + ' (custom)'` — a persisted provider that vanished from the feed stays selectable. If there are no groups at all and no selection, insert a single disabled selected `Select a provider…` option. Finally `providerSelect.value = providerChoice` (fall back to selecting the first option when the assignment finds nothing).
   - Model select: `modelSelect.textContent = ''`, no optgroups at all. Take `chosen = groupById(providerChoice)`. When `chosen` is undefined or `chosen.enabled === false`, append one disabled option whose text is `chosen && chosen.reason ? chosen.reason : 'Unavailable'`; when `chosen.models` is empty, one disabled `No models available`. Otherwise one `<option>` per model with `opt.value = chosen.id + '/' + model.id`, `opt.dataset.provider = chosen.id`, `opt.dataset.model = model.id`, `opt.textContent = (model.label || model.id) + (model.custom === true ? ' (custom)' : '')`, and `opt.selected = true` (remembered as `matched`) when `state.selection && state.selection.provider === chosen.id && state.selection.model === model.id`.
   - Preserved selection: when `state.selection` and `state.selection.provider === providerChoice` and nothing matched, append a selectable `(custom)` option (`value = providerChoice + '/' + state.selection.model`, `dataset.provider`/`dataset.model` set, text `state.selection.model + ' (custom)'`) and treat it as `matched`, so a model no longer in the refreshed list is still shown and still re-postable. Only when there is still no match insert the disabled selected placeholder at index 0 — `'Select a model…'`, or `providerLabel(state.selection.provider) + ' / ' + state.selection.model + ' (unavailable)'` when the selection belongs to another provider — then `modelSelect.value = matched.value` in the matched case, as today.
   - Stale badge: when `chosen && chosen.stale === true`, set `staleBadge.textContent = 'stale — showing last known models'` plus `' (last updated ' + state.refreshedAt + ')'` when `state.refreshedAt` is a non-empty string, set `staleBadge.title = chosen.staleReason` when that is a non-empty string else `staleBadge.removeAttribute('title')`, and `staleBadge.classList.add('visible')`. Otherwise clear `textContent` to `''`, `classList.remove('visible')` and `removeAttribute('title')`. textContent only — never HTML.
   - Set API key affordance: keep the `visible` class + aggregated `title` logic, but compute it as `blocked = state.providers.filter(g => !g.enabled)` OR-ed with `state.providers.length > 0 && !state.providers.some(g => g.enabled && g.models && g.models.length > 0)`; in the second case the title reads `'No provider is configured yet. Set an API key to enable one.'`. The seed paint (`state.providers.length === 0`) still shows nothing.
   - Outside the signature guard, keep enablement cheap and busy-driven: `providerSelect.disabled = state.busy || providerSelect.options.length === 0 || (providerSelect.options.length === 1 && providerSelect.options[0].disabled)`; `modelSelect.disabled = state.busy || !modelSelect.options.some(...)` — expressed with a plain loop over `modelSelect.options` looking for one non-disabled option, since the fake DOM exposes `options` as an array-like of elements.

   Files: `media/chat.js`

4. Wire the two change handlers

   In media/chat.js's listener block (~lines 1147-1168):
   - Add a `providerSelect.addEventListener('change', …)` that reads the selected option's `dataset.provider` (falling back to `providerSelect.value`), and when it is a non-empty string sets `providerChoice` to it, forces a rebuild (`renderedProviderSignature = null`) and calls `renderProviders()`. It posts nothing: picking a provider only repaints the model list, so exactly one user action (picking a model) produces exactly one `selectModel` post. When the option carries no provider (the disabled placeholder), just repaint from state.
   - Keep the existing `modelSelect` change handler, with the provider fallback widened: `const provider = (opt && opt.dataset && opt.dataset.provider) || providerChoice;` and `const model = opt && opt.dataset ? opt.dataset.model : undefined;`. Unchanged afterwards: a missing provider/model repaints instead of posting; a pick equal to `state.selection` posts nothing; otherwise `vscode.postMessage({ type: 'selectModel', provider: provider, model: model })`.
   - `modelSetKey`, `errorFix`, `emptySetKey` handlers, `renderEmptyState()` and `providerLabel()` are unchanged.

   Files: `media/chat.js`

5. Rework the fake-DOM suite for the provider-first selector

   In `test/chatView.providers.test.ts` keep the `FakeEl`/`FakeClassList` harness and `loadChatView()` as they are; only the fixture and the `describe` body change.
   - Add `['provider-select', 'select']` and `['model-stale', 'span']` to `ELEMENT_IDS` (chat.js looks both up at load, so a missing id would make it throw).
   - Replace `providerFixture()` with a configured-only fixture matching what the router now posts: all `enabled: true`, mixing a builtin id and a feed-derived id, e.g. `copilot` (GitHub Copilot: `gpt-5`, `claude-sonnet-4`), `anthropic` (Anthropic: `claude-opus-5-5`, plus `claude-sonnet-5` with `custom: true`), `opencode` (OpenCode Zen: one model, `stale: true`, `staleReason: 'models.dev fetch failed: ETIMEDOUT'`), and keep a helper `withDisabled()` that returns the same list with one group flipped to `enabled: false` + `reason` for the disabled-group path.
   - Rename the describe to `chat view provider-first model selector (model-selector-refresh T14)` and cover:
     1. seed paint: `provider-select` and `model-select` each hold one disabled selected placeholder, `model-set-key` is not `visible`, `model-stale` textContent is `''` and not `visible`.
     2. `setProviders` renders exactly one option per group in host order in `provider-select`, `model-select` contains no `OPTGROUP` children, and its options are only the chosen provider's models — so a provider the host omitted can appear in neither select.
     3. a selection drives both selects: `provider-select.value` is the selection's provider, the matching model option is `selected` with `value === provider + '/' + model` and the right `dataset.provider`/`dataset.model`.
     4. changing `provider-select` repaints the model list for that provider and posts nothing (`view.posted.length === 0`); then selecting a model option and firing `change` posts exactly `[{ type: 'selectModel', provider: <picked>, model: <picked> }]`.
     5. custom values: a model with `custom: true` renders with the ` (custom)` suffix and still posts its bare id; a selection whose model is absent from the group renders an appended selectable `(custom)` option that is `selected`; a selection whose provider is absent from the groups renders a leading `(custom)` provider option that is `selected`.
     6. stale: with the stale provider chosen, `model-stale` is `visible`, its textContent starts with `'stale — showing last known models'`, includes the `refreshedAt` passed on the message, and its `title` is the `staleReason`; switching to a fresh provider clears textContent to `''`, drops `visible` and `getAttribute('title')` is `null`.
     7. `model-set-key`: hidden when every group is enabled and offers models; visible with an aggregated non-empty `title` for `withDisabled()` and when no group offers a model; clicking posts exactly `{ type: 'triggerFix', action: 'setApiKey' }`.
     8. `setBusy` disables both selects while true and re-enables them after.
     9. the empty state still shows the provider label and model (keep the existing assertions, adjusted to the new fixture).
   - Re-picking the already-active pair still posts nothing, and a disabled placeholder row repaints rather than posting — keep both assertions.

   Files: `test/chatView.providers.test.ts`

6. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json`; `npm run compile`; `npx eslint test/chatView.providers.test.ts --ext .ts` (media/*.js is neither compiled nor linted by the toolchain, so the two webview files are covered only by the fake-DOM suite); `npm run test:unit`; `git status --porcelain`. No source file outside the three named here may change — in particular `src/orchestrator/webviewProtocol.ts`, `media/protocol.js`, `src/activation/chatController.ts`, `src/activation/providerRouter.ts`, `src/activation/setApiKey.ts` and `test/webviewProtocol.mirror.test.ts` stay untouched, since T14 adds no protocol field (T13 already added `custom`, `efforts`, `stale`, `staleReason`, `refreshedAt`).

   Files: `media/chat.js`, `media/chat.html`, `test/chatView.providers.test.ts`

## Risks

- The selector is a pure projection of host state; writing `state.selection` locally on a provider or model change would desynchronise the view from the host. Only `providerChoice`/`lastSelectionKey` (webview-only UI concerns) may be written locally.
- `providerChoice` sync is the subtle part: too eager and a user's provider pick is reverted by the next unrelated `setProviders` echo (a stream/tool update triggers a repaint); too lazy and a host-driven selection change leaves the wrong provider showing. The `lastSelectionKey` guard resolves it — cover both directions in the tests.
- `providerSignature()` must include `providerChoice`, the stale fields and per-model `custom`, or a provider switch or a newly stale snapshot will not repaint at all (the rebuild is signature-gated).
- Dropping the `(unavailable)` placeholder or the `(custom)` fallbacks would silently lose a persisted `ModelSelection` whose provider or model vanished from the feed — the spec requires it to stay visible and selectable.
- The Set API key affordance previously keyed off disabled groups; now that the host posts only configured providers there are normally none, so without the added "no configured provider offers a model" condition the user would have no way into the key prompt from the chat view.
- The fake DOM's `options` getter walks OPTION and OPTGROUP children; the new markup has no optgroups, so assertions written against optgroups in the old tests must be removed rather than adapted, and `select.value = x` on a value no option carries leaves the value `''` (mirroring a real select) — set `selectedIndex` in tests that need a specific option chosen.
- `npm run test:unit` has one known pre-existing failure (the keytar/native-module gating case in `test/activation.gating.test.ts`); treat only new failures as regressions.

## Acceptance

- `media/chat.html` has a `provider-select` and a `model-select` in that order inside `.model-bar`, plus a `model-stale` badge span, with both selects themed from `--vscode-dropdown-*` and no `optgroup` CSS left.
- With a multi-group `setProviders`, the provider select lists exactly the posted groups in host order and the model select lists only the chosen provider's models, with no `<optgroup>` elements anywhere in it.
- Changing the provider select repaints the model list and posts nothing; then picking a model posts exactly one `{ type: 'selectModel', provider, model }` for that provider, and re-picking the active pair posts nothing.
- A group with `stale: true` shows the `model-stale` badge with the text `stale — showing last known models` (including the message's `refreshedAt` when present) and `staleReason` as its title; switching to a fresh group clears the badge text, its `visible` class and its title attribute.
- A model with `custom: true`, a selection model missing from the refreshed list, and a selection provider missing from the groups all still render (marked `(custom)`) and remain selectable and postable.
- The Set API key affordance is hidden on the seed paint and when every posted provider is configured with models, visible with a non-empty title when a group is disabled or no group offers a model, and posts `{ type: 'triggerFix', action: 'setApiKey' }` on click.
- `setBusy` disables both selects while busy and re-enables them afterwards; the empty state still shows the provider label and model.
- `npx tsc --noEmit -p tsconfig.json` and `npm run compile` are clean; `npx eslint test/chatView.providers.test.ts --ext .ts` reports no errors.
- `npm run test:unit` shows no new failures beyond the known keytar gating case, and the reducer plus mirror suites still pass unmodified.
- `git status --porcelain` lists only `media/chat.js`, `media/chat.html` and `test/chatView.providers.test.ts`.
