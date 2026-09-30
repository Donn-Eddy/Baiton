# Plan T08

## Steps

1. Protocol core: SessionItem tree fields, readOnly state, setReadOnly message

   In src/orchestrator/webviewProtocol.ts:
   1. `SessionItem` (line ~286): add `/** The parent session's id for a sub-agent chat; absent for a top-level session. */ parentId?: string;` and `/** Nesting depth: 0 top-level, 1 child, 2 grandchild. */ depth: number;` (required, matching SessionMeta in src/orchestrator/sessionStore.ts). Update the doc comment of `WebviewState.sessions` to say the list is in tree order (top-level newest first, each followed by its descendants depth-first) as the host posts it; the webview never reorders.
   2. `HostToWebview`: add a variant `| { type: 'setReadOnly'; readOnly: boolean }` with a doc comment: "Set whether the session in view is a read-only sub-agent chat: no composer, no card answers, no Stop, no delete." Place it after `setActiveSession`.
   3. `WebviewState`: add `/** Whether the session in view is a sub-agent chat rendered read-only. */ readOnly: boolean;` right after `activeSessionId`.
   4. `initialWebviewState()`: add `readOnly: false,` right after `activeSessionId: ''` (key order matters only for readability; deepStrictEqual ignores order, but keep both files identical).
   5. `reduce`: add `case 'setReadOnly': return { ...state, readOnly: msg.readOnly };` next to `setActiveSession`, and add a bullet to the reduce doc comment: "`setReadOnly` sets whether the session in view is read-only." The `assertNever` default keeps the switch exhaustive.
   Do NOT make setSessions/setActiveSession touch readOnly — the host is authoritative and posts setReadOnly explicitly.

   Files: `src/orchestrator/webviewProtocol.ts`

2. Keep the host compiling: project parentId/depth in toSessionItems

   Making `SessionItem.depth` required breaks `toSessionItems` in src/activation/chatController.ts (~line 1851). Minimal, behaviour-preserving edit: map each meta to `{ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, scopeId: scopeId(scope), depth: meta.depth, ...(meta.parentId !== undefined ? { parentId: meta.parentId } : {}) }`. Do not switch `postSessions` to `listTree` and do not post `setReadOnly` from the controller — wiring the tree listing, read-only switching and live-message routing is a later todo. This is the only edit outside the listed files and exists solely to keep `npm run compile` green.

   Files: `src/activation/chatController.ts`

3. Hand-mirror the reducer in media/protocol.js

   In media/protocol.js mirror step 1 exactly:
   - `initialWebviewState()`: add `readOnly: false,` right after `activeSessionId: ''`.
   - `reduce`: add `case 'setReadOnly': return Object.assign({}, state, { readOnly: msg.readOnly });` next to `setActiveSession`.
   No other change (setSessions already copies items with `.slice()`, which carries parentId/depth through).

   Files: `media/protocol.js`

4. Fixture cases and existing literals

   In test/fixtures/protocolCases.ts:
   - `seed()`: add `readOnly: false,` after `activeSessionId: ''` (seed must stay a full literal to catch seed drift).
   - Case (30) 'setSessions and setActiveSession': add `depth: 0` to the item.
   - Add new cases before the `export const PROTOCOL_CASES` line:
     a) 'setReadOnly turns read-only on': messages `[{ type: 'setReadOnly', readOnly: true }]`.
     b) 'setReadOnly turns read-only off': state `seed({ readOnly: true })`, messages `[{ type: 'setReadOnly', readOnly: false }]`.
     c) 'setSessions carries a sub-chat tree': one setSessions with items in tree order: `{ id: 'p1', title: 'Parent', updatedAt: 3, scopeId: 'workspace', depth: 0 }`, `{ id: 'p1/c1', parentId: 'p1', title: 'Child task', updatedAt: 2, scopeId: 'workspace', depth: 1 }`, `{ id: 'p1/c1/g1', parentId: 'p1/c1', title: 'Grandchild', updatedAt: 1, scopeId: 'workspace', depth: 2 }`, `{ id: 'p2', title: 'Other', updatedAt: 0, scopeId: 'workspace', depth: 0 }`.
     d) 'setReadOnly leaves sessions, records, busy alone': state `seed({ sessions: [<p1 item>], activeSessionId: 'p1', records: [{ role: 'user', content: 'hi' }], busy: true })`, messages `[{ type: 'setReadOnly', readOnly: true }]`.
     e) multi-message 'select a child then back to the parent': `setActiveSession 'p1/c1'`, `setReadOnly true`, `renderConversation [assistant 'child reply']`, `setActiveSession 'p1'`, `setReadOnly false`.
   In test/webviewProtocol.reducer.test.ts: add `depth: 0` to every SessionItem literal (lines ~86, 87, 227, 918, 932) so they type-check. Add a `describe('sub-agent chats (read-only view and session tree)', ...)` block with tests: initialWebviewState().readOnly === false; setReadOnly true/false sets the flag and nothing else (compare the rest of the state with deepStrictEqual against the input minus readOnly); setReadOnly returns a new object and does not mutate the input; setSessions preserves parentId/depth and order verbatim and copies the array; setSessions and setActiveSession do not change readOnly. Also add `reduce(seed, { type: 'setReadOnly', readOnly: true })` to the existing 'does not mutate the input state on any message' test.
   The mirror suite (test/webviewProtocol.mirror.test.ts) picks the new fixture cases up automatically; add one explicit test there: 'mirrors setReadOnly and a session tree' folding `[setSessions(tree), setReadOnly true, setReadOnly false]` through both reducers and asserting `deepStrictEqual(hardClone(js), ts)` plus `ts.readOnly === false` and `hardClone(mirror.initialWebviewState()).readOnly === false`.

   Files: `test/fixtures/protocolCases.ts`, `test/webviewProtocol.reducer.test.ts`, `test/webviewProtocol.mirror.test.ts`

5. Markup and styles in chat.html

   In media/chat.html:
   - Give the composer an id: `<div class="composer" id="composer">`.
   - Add a read-only note just above the composer inside #chat-pane: `<div id="readonly-note" class="readonly-note" hidden>Sub-agent chat — read only. It is driven by its parent chat.</div>`.
   - Change `#session-list` to `role="tree"` (keep aria-label="Chat sessions" and tabindex="0").
   - CSS (theme variables only, no hardcoded colours): `.composer[hidden], .readonly-note[hidden] { display: none; }`; `.readonly-note { flex: 0 0 auto; padding: 4px var(--baiton-gap); font-size: 0.9em; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }`; `.session-chevron { flex: 0 0 auto; width: 1.2em; background: none; border: none; padding: 0; color: inherit; cursor: pointer; line-height: 1; }` with `.session-chevron:hover:not(:disabled) { background: none; }`; `.session-chevron-spacer { flex: 0 0 auto; width: 1.2em; }`; indentation `.session-row.depth-1 { padding-left: calc(var(--baiton-gap) + 14px); }`, `.session-row.depth-2 { padding-left: calc(var(--baiton-gap) + 28px); }`; `.session-row.child .session-title { color: var(--vscode-descriptionForeground); }` and `.session-row.child.active .session-title { color: inherit; }`.
   - Extend the header comment with one paragraph: the session list renders sub-agent chats as collapsible rows beneath their parent, and a selected sub-agent chat renders read-only (composer hidden, card controls, Stop and delete absent).

   Files: `media/chat.html`

6. chat.js: collapsible child rows in the session list

   In media/chat.js:
   - Elements: null-tolerant lookups (fake DOMs in other tests do not define them): `const composerEl = document.getElementById('composer');` and `const readOnlyNote = document.getElementById('readonly-note');`.
   - State: `let collapsedSessions = (persisted.collapsedSessions && typeof persisted.collapsedSessions === 'object') ? Object.assign({}, persisted.collapsedSessions) : {};` (session id -> true). Add `function persistCollapsed() { vscode.setState(Object.assign({}, vscode.getState() || {}, { collapsedSessions: collapsedSessions })); }`.
   - Helpers: `sessionsById()` building an id->item map from state.sessions; `hasChildren(id)` = some session with `parentId === id`; `isAncestorOf(ancestorId, id, byId)` walking the `parentId` chain; `isSessionHidden(session, byId)` = walk up the parentId chain, return true if any ancestor is in collapsedSessions AND that ancestor is not an ancestor of (or equal to) state.activeSessionId (so the active row is never hidden). Children default to expanded.
   - `renderSessionRow(session, byId)`: className `'session-row depth-' + depth + (session.parentId ? ' child' : '') + (active ? ' active' : '')` where depth = `typeof session.depth === 'number' ? session.depth : 0`. Role `treeitem`, `aria-level` = depth + 1, `aria-selected` as today, `dataset.sessionId`, `dataset.depth = String(depth)`, and when `session.parentId` set `dataset.parentId`. Leading element: if hasChildren(session.id) a `<button type=button class=session-chevron>` with textContent `'\u25be'` (expanded) or `'\u25b8'` (collapsed), `aria-label` 'Collapse sub-agent chats'/'Expand sub-agent chats', row `aria-expanded` 'true'/'false'; its click handler calls `e.stopPropagation()`, toggles `collapsedSessions[session.id]` (delete the key when expanding), `persistCollapsed()`, sets `renderedSessionSignature = null` and calls `renderSessions()`. Otherwise a `<span class=session-chevron-spacer>`. Title and time as today. Delete button ONLY when `!session.parentId` (sub-agent chats are deleted with their parent); keep its existing busy guard. Row click unchanged (posts selectSession when not active; host decides what is selectable while busy).
   - `renderSessions()`: build byId once; include `s.parentId || ''`, `s.depth`, `collapsedSessions[s.id] ? 1 : 0` and hasChildren in each row's signature entry; iterate `state.sessions` in the host's order and append `renderSessionRow` for each session where `!isSessionHidden(s, byId)`. Empty-list text unchanged.
   - Keyboard handler on sessionListEl: rows list is still `.session-row` (hidden rows are not in the DOM). Add ArrowRight/ArrowLeft: on a row with a chevron, ArrowRight expands and ArrowLeft collapses (same toggle path); ArrowLeft on a child row moves focus to its parent row (find by dataset.sessionId === row.dataset.parentId). `Delete` must do nothing when the row has `dataset.parentId` or when `state.readOnly` and the row is the active one.

   Files: `media/chat.js`

7. chat.js: read-only transcript view

   In media/chat.js:
   - New `renderReadOnly()` called from `render()` (after renderTranscript): `const ro = state.readOnly === true;` if composerEl: `ro ? composerEl.setAttribute('hidden','') : composerEl.removeAttribute('hidden')`; if readOnlyNote: the inverse. Also `stopBtn.hidden`-equivalent: since Stop lives inside the composer it disappears with it; additionally set `stopBtn.disabled = true` when ro (in updateEnablement) so a fake DOM without #composer still reflects it.
   - `updateEnablement()`: `sendBtn.disabled = state.busy || state.readOnly || !hasContent; stopBtn.disabled = !state.busy || state.readOnly === true; inputEl.disabled = state.busy || state.readOnly === true;` newChatBtn unchanged (New Chat is a scope action and leaves the read-only view).
   - `renderContext()`: `compactBtn.disabled = state.busy || state.readOnly === true || state.records.length === 0`.
   - `renderMode()`: add `state.readOnly === true` to the disabled condition.
   - Guards in handlers: `send()` returns early when `state.readOnly`; the stop click handler returns without posting when `state.readOnly`; the compact click handler returns when `state.readOnly`; `answerIntervention` returns early when `state.readOnly` (before setting the lock).
   - `renderInterventionCard(record)`: compute `const pending = card.status !== 'resolved';` and `const interactive = pending && state.readOnly !== true;` — use `interactive` instead of `pending` in the four control branches (option buttons, radios+text, free text, approve/decline) so a read-only view renders no answer controls. For a pending card in read-only view append `<div class="intervention-settled"><span class="intervention-decision">Waiting for an answer in the parent chat</span></div>` (textContent only). Resolved cards render exactly as today.
   - `renderSessionRow`: when `state.readOnly` and the row is the active session, render no delete button (already true for children; keeps the rule explicit).
   - Include `state.readOnly` in the session list signature so the delete buttons repaint on the flip.
   - Update the file header comment: the view also renders sub-agent chats — children as collapsible rows under their parent (collapse state kept in the webview state) — and when `state.readOnly` the composer (input, Send, Stop, Mode, Auto, Compact) is hidden, cards show no controls and delete is not offered.

   Files: `media/chat.js`

8. Fake-DOM view tests

   In test/chatView.mode.test.ts:
   - Add `['composer', 'div']` and `['readonly-note', 'div']` to ELEMENT_IDS. FakeEl has no `hidden` property; assert via `getAttribute('hidden')` (chat.js must use setAttribute/removeAttribute for hidden, like the context bar).
   - New `describe('chat view sub-agent chats (sub-agent-chats T08)', ...)` with a helper `tree()` returning the 4-item SessionItem list from the fixture (p1, p1/c1, p1/c1/g1, p2) and tests:
     1. 'renders children beneath their parent with depth and a chevron': send setSessions(tree); rows = `ids['session-list'].querySelectorAll('.session-row')`; assert dataset.sessionId order ['p1','p1/c1','p1/c1/g1','p2']; classList contains 'depth-1'/'depth-2'; `p1` and `p1/c1` rows contain `.session-chevron`, `p2` and the grandchild do not; `getAttribute('aria-level')` '1','2','3','1'.
     2. 'collapsing a parent hides its descendants and expanding restores them': fire 'click' (with `{ stopPropagation(){} }`) on p1's `.session-chevron`; rows now ['p1','p2']; posted is empty (collapse is webview-only); click again -> all 4 back.
     3. 'collapse survives a setSessions re-post': collapse p1, re-send setSessions(tree) -> still ['p1','p2'].
     4. 'the active child stays visible under a collapsed parent': setActiveSession 'p1/c1', collapse p1 -> rows include 'p1/c1'.
     5. 'child rows offer no delete; top-level rows do': `.session-delete` count per row: p1 1, p1/c1 0, g1 0, p2 1.
     6. 'clicking a child posts selectSession with its id': fire click on the p1/c1 row -> posted `[{ type: 'selectSession', sessionId: 'p1/c1' }]`.
     7. 'read-only hides the composer and shows the note': send setReadOnly true -> `ids.composer.getAttribute('hidden') !== null`, `ids['readonly-note'].getAttribute('hidden') === null`, send/stop/input/compact disabled; setReadOnly false restores (composer hidden attr null, note hidden).
     8. 'read-only: Stop, Send, Compact post nothing even while busy': setBusy true + setReadOnly true; fire click on stop, send (with text in input), compact-context -> posted empty.
     9. 'read-only pending cards render no answer controls': setReadOnly true, showIntervention confirm and question (options) cards -> transcript has no `[data-intervention-field]` elements and contains a `.intervention-decision` with text 'Waiting for an answer in the parent chat'; after setReadOnly false the approve/decline buttons are present.
     10. 'read-only resolved cards still show the decision': a resolved card renders `.intervention-decision` 'Approved'.
     11. 'Delete key on a child row posts nothing': focus handling is fake, so fire keydown `{ key: 'Delete', preventDefault(){} }` on session-list with document.activeElement unset and activeSessionId 'p1/c1' (the active row fallback) -> posted empty.
   Keep the file-local FakeEl as is except adding nothing unless needed; FakeEl.matches already supports `.class` and `[attr]` selectors, and `fire` dispatches handlers.

   Files: `test/chatView.mode.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Confirm test/chatView.providers.test.ts and test/modelSelectorRefresh.test.ts still pass unmodified (they lack #composer/#readonly-note, which is why those lookups must be null-tolerant). Confirm `grep -c vscode src/orchestrator/webviewProtocol.ts` still reports no vscode import.

   Files: (none)

## Risks

- Making SessionItem.depth required forces a one-line change in src/activation/chatController.ts (toSessionItems), which is outside the todo's file list; it is needed only to keep compile green and must not add tree listing or setReadOnly posting (a later todo owns controller wiring).
- The mirror suite compares whole states with deepStrictEqual: readOnly must be added to initialWebviewState in BOTH webviewProtocol.ts and protocol.js, and to the fixture seed(), or every parity case fails.
- Other fake-DOM suites (chatView.providers, modelSelectorRefresh) do not define #composer or #readonly-note; any non-null-tolerant lookup of them in chat.js will throw at load and break those suites.
- FakeEl has no `hidden` property; toggling via the `hidden` property would silently not be observable in tests — use setAttribute/removeAttribute('hidden') and a `[hidden]` CSS rule.
- Hiding a collapsed parent's descendants must never hide the active session row, otherwise keyboard navigation loses the active row; the ancestor-of-active exception handles this.
- Changing #session-list role to tree/treeitem changes accessibility semantics; no existing test asserts 'listbox'/'option', but keep aria-selected and tabIndex behaviour identical for the keyboard handler.
- The session list signature must include readOnly, collapse state, parentId and depth, or rows will not repaint after a collapse toggle or a read-only flip.

## Acceptance

- SessionItem has `parentId?: string` and `depth: number`; WebviewState has `readOnly: boolean`; initialWebviewState().readOnly === false in both the TS core and media/protocol.js.
- HostToWebview includes `{ type: 'setReadOnly'; readOnly: boolean }`; reduce sets only `readOnly` and is exhaustive (assertNever still compiles); protocol.js mirrors it.
- test/fixtures/protocolCases.ts contains setReadOnly on/off cases, a session-tree setSessions case and a multi-message child/parent switch case, and the mirror suite passes over all fixture cases.
- In the webview, sub-agent sessions render beneath their parent with depth classes and aria-level; parents with children show a chevron that collapses/expands descendants without posting any message, and collapse state survives a setSessions re-post.
- Child session rows offer no delete button and the Delete key posts nothing on them; top-level rows keep delete.
- With state.readOnly true the composer is hidden (hidden attribute), the read-only note is shown, Send/Stop/Compact/input are disabled and post nothing, and pending intervention cards render no answer controls.
- No vscode import is added to src/orchestrator/webviewProtocol.ts.
- `npm run compile`, `npm run lint` and `npm test` pass, including the unchanged chatView.providers and modelSelectorRefresh suites.
