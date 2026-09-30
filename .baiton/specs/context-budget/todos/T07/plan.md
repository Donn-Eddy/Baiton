# Plan T07

## Steps

1. Protocol: add setContextUsage (host→webview), compactContext (webview→host) and WebviewState.context

   In src/orchestrator/webviewProtocol.ts:
   1. Add an exported type `export type ContextUsageSource = 'usage' | 'estimate';` and an exported interface `ContextUsageView { loaded: number; window: number | null; source: ContextUsageSource }` (doc comment: tokens the last request carried, the model's window or null when unknown, and whether `loaded` came from the endpoint's usage report or the local estimate). Keep this module host-free: do NOT import from ./contextBudget (define the literal union locally; it is structurally identical to ContextSource).
   2. Append to the `HostToWebview` union (after `setRunActive`, with a doc comment): `| { type: 'setContextUsage'; loaded: number; window: number | null; source: 'usage' | 'estimate' }` — posted after every completion and every compaction, rendered as the meter under the composer.
   3. Append to the `WebviewToHost` union: `| { type: 'compactContext' }` — the user pressed Compact: trim-then-summarise the conversation in view; refused by the host while busy.
   4. Add to `WebviewState` an OPTIONAL field `context?: ContextUsageView;` (doc: the last context measurement the host posted; absent until the first `setContextUsage`). Do NOT add it to `initialWebviewState()` — leaving it absent keeps the seed, `seed()` in test/fixtures/protocolCases.ts and the mirror's seed unchanged (the mirror test deep-compares the seed).
   5. In `reduce`, add before `default`: `case 'setContextUsage': return { ...state, context: { loaded: msg.loaded, window: msg.window, source: msg.source } };` (fresh object, never aliases msg). Add a bullet to reduce's doc comment: '`setContextUsage` replaces the context meter reading.'

   Files: `src/orchestrator/webviewProtocol.ts`

2. Browser mirror: fold setContextUsage identically in media/protocol.js

   media/protocol.js is the hand-kept mirror of reduce and is loaded by test/webviewProtocol.mirror.test.ts and the chatView tests (it is not in the todo's file list but MUST change or the parity suite fails). Add before `default:`:
   ```js
   case 'setContextUsage':
     return Object.assign({}, state, {
       context: { loaded: msg.loaded, window: msg.window, source: msg.source },
     });
   ```
   Key order inside `context` must be loaded, window, source (deepStrictEqual does not care about order, but keep it identical for readability). Do NOT touch `initialWebviewState()` in the mirror.

   Files: `media/protocol.js`

3. Mirror fixture cases for the new message

   In test/fixtures/protocolCases.ts append, before `export const PROTOCOL_CASES`, numbered like the existing blocks (e.g. `// (59) setContextUsage`):
   - 'setContextUsage sets the meter with a known window': messages [{ type: 'setContextUsage', loaded: 256000, window: 1000000, source: 'usage' }].
   - 'setContextUsage with an unknown window': [{ type: 'setContextUsage', loaded: 1200, window: null, source: 'estimate' }].
   - 'setContextUsage replaces a previous reading': state seed({ context: { loaded: 5, window: 10, source: 'usage' } }), messages [{ type: 'setContextUsage', loaded: 7, window: null, source: 'estimate' }].
   - 'setContextUsage leaves busy, mode, records and error alone': state seed({ busy: true, mode: 'bug', records: [{ role: 'user', content: 'hi' }], error: { message: 'x' } }) — note error must be the full shape both reducers produce if later compared; simplest: omit error or use { message: 'x', action: undefined, provider: undefined } is NOT JSON-safe, so just omit `error` — messages [setContextUsage ...].
   - 'setContextUsage interleaved with renderConversation and setBusy': messages [setBusy true, setContextUsage {loaded 10, window 100, source 'estimate'}, renderConversation { records: [] }, setBusy false] (proves renderConversation does not clear context).
   This file is imported by the mirror test, which folds every case through both reducers.

   Files: `test/fixtures/protocolCases.ts`

4. Composer markup and styles for the meter and Compact button

   In media/chat.html, inside `.composer`, directly AFTER the `<div class="composer-actions">…</div>` block (i.e. under the composer's controls), add:
   ```html
   <div id="context-bar" class="context-bar">
     <span id="context-meter" class="context-meter" aria-live="polite"></span>
     <button id="compact-context" class="link-button" type="button" title="Compact the conversation: trim old tool results, then summarise older turns. The transcript keeps everything.">Compact</button>
   </div>
   ```
   In the <style> block (next to `.composer-actions`) add:
   ```css
   /* Context meter: tokens the last request carried against the model's window. */
   .context-bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--baiton-gap); font-size: 0.9em; color: var(--vscode-descriptionForeground); }
   .context-bar[hidden] { display: none; }
   .context-meter.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
   ```
   Update the header comment of chat.html (around line 22–28) with one sentence: the composer ends with a context meter (`~256K / 1M · usage`) and a Compact link that posts `compactContext`.

   Files: `media/chat.html`

5. Webview script: render the meter, post compactContext

   In media/chat.js:
   1. Element lookups beside the others: `const contextBar = document.getElementById('context-bar'); const contextMeter = document.getElementById('context-meter'); const compactBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('compact-context'));`. These MUST be null-tolerant: test/chatView.providers.test.ts and test/modelSelectorRefresh.test.ts run chat.js over fake DOMs whose id lists do not contain the new ids (getElementById returns null there), and those files are not being edited. Guard every use with `if (contextMeter)` / `if (compactBtn)`.
   2. Pure helper `formatTokens(n)`: `n >= 1_000_000` → `(Math.round(n / 100000) / 10) + 'M'` (so 1000000 → '1M', 1500000 → '1.5M'); `n >= 1000` → `Math.round(n / 1000) + 'K'` (256000 → '256K'); else `String(Math.max(0, Math.round(n)))`. Use plain numeric literals (1000000) since the file is a plain script.
   3. Pure helper `contextMeterText(ctx)`: window known (`typeof ctx.window === 'number' && ctx.window > 0`) → `'~' + formatTokens(ctx.loaded) + ' / ' + formatTokens(ctx.window) + ' · ' + ctx.source`; unknown → `'~' + formatTokens(ctx.loaded) + ' · window unknown'`. (Exactly the formats `~256K / 1M · usage` and `~256K · window unknown`.)
   4. `function renderContext()`: if `!contextMeter` return. When `state.context` is undefined: `contextMeter.textContent = ''` and, if contextBar, `contextBar.hidden = true`… (use `contextBar.setAttribute('hidden','')`/`removeAttribute('hidden')` so the fake DOM supports it). Otherwise show the bar, set `contextMeter.textContent = contextMeterText(state.context)`, set `contextMeter.title` to e.g. `Tokens sent with the last request (' + source + ')` plus `' of the model's ' + window + '-token window'` when known, and `contextMeter.classList.toggle('warn', window known && loaded / window >= 0.8)`. Compact button: `compactBtn.disabled = state.busy || state.records.length === 0`.
   5. Call `renderContext()` in `render()` (after `renderMode()`), and also in `updateEnablement()`'s neighbourhood is not needed — render() covers busy changes.
   6. Click handler: `if (compactBtn) compactBtn.addEventListener('click', function () { if (state.busy) { return; } vscode.postMessage({ type: 'compactContext' }); });` — host-authoritative: no local state change; the host's setBusy/appendMessage/setContextUsage repaint it.
   7. Extend the file's header comment with one sentence describing the meter and the Compact action.

   Files: `media/chat.js`

6. Controller: post setContextUsage after every completion, compaction and render

   In src/activation/chatController.ts:
   1. Add a private helper `viewKey(): string | undefined` returning `${scopeId(scope)}/${sessionId}` for the active scope's active session, or undefined when no session is active.
   2. Add `private postContextUsage(key: string): void` — only posts when `key === this.viewKey()` (a run on another conversation never paints the meter of the one in view): `const s = this.trackerFor(key).status(); this.deps.webview.post({ type: 'setContextUsage', loaded: s.loaded, window: s.window ?? null, source: s.source });`.
   3. Add `private async seedContextEstimate(key: string, slug: string | undefined, history: readonly ChatMessage[]): Promise<void>` that records a local estimate on the tracker: `const tools = this.deps.toolsFor(await this.phaseForConversation(slug)); const prompt = await this.buildPrompt(slug, this.effectiveMode()); this.trackerFor(key).record({ messages: [{ role: 'system', content: prompt }, ...history], tools }, {});` (record with no usage → source 'estimate').
   4. In `contextBudget(...)`'s `observe`, after `tracker.record(sent, completion)`, call `this.postContextUsage(key)` (covers 'after every completion', usage or estimate).
   5. After compaction, post an estimate of what the next request will carry, not the tracker's reset 0: in `onSend`, inside the `if (compacted !== undefined)` branch after `history = compacted;`, call `await this.seedContextEstimate(key, slug, history); this.postContextUsage(key);`. Leave `compact()`'s existing `this.trackerFor(key).reset()` in place (T06 behaviour; the seed overwrites it immediately).
   6. In `refresh()`, after `renderConversation(...)` for an active session: if `!this.trackers.has(key)` (conversation not measured in this window yet, e.g. after reload), read the transcript, `toHistory(records)`, and `seedContextEstimate(key, this.activeSpec, history)`; then `this.postContextUsage(key)`. For the no-session branch (fresh chat) post `{ type: 'setContextUsage', loaded: 0, window: this.deps.contextWindow?.() ?? null, source: 'estimate' }` directly (normalise a non-positive-integer window to null). Wrap the seeding in try/catch → log and skip (a meter failure must never break refresh). Do NOT post setContextUsage from `onSelectModel` / the selection-change listener: test/chatController.interventions.test.ts:586 asserts selectModel posts exactly one message (setProviders).
   7. Update the class's top-of-file responsibilities comment with one bullet: post the context meter (`setContextUsage`) after every completion, compaction and render; compact on demand (`compactContext` / `baiton.compactContext`), refused while busy.

   Files: `src/activation/chatController.ts`

7. Controller: manual compaction (compactContext message and public compactContext())

   In src/activation/chatController.ts:
   1. In `handle`, add `case 'compactContext': await this.compactContext(); return;`.
   2. Add `public async compactContext(): Promise<void>` (doc: 'Trim-then-summarise the conversation in view on demand (the Compact button and `baiton.compactContext`). Refused while busy; the transcript keeps every record.'):
   ```ts
   if (this.busy) {
     this.deps.webview.post({ type: 'showError', message: 'Wait for the current run to finish before compacting.' });
     return;
   }
   const slug = this.activeSpec;
   const scope = this.activeScope();
   const sessionId = this.activeSessions.get(scopeId(scope));
   if (sessionId === undefined || (await this.sessions.meta(scope, sessionId)) === undefined) {
     this.deps.webview.post({ type: 'showError', message: 'There is nothing to compact in this conversation yet.' });
     return;
   }
   const transcript = this.transcriptFor(scope, sessionId);
   const records = await readTranscript(transcript.path);
   if (compactionCut(records, SUMMARY_KEEP_TURNS) === undefined) {
     this.deps.webview.post({ type: 'showError', message: `Nothing to compact: only the last ${SUMMARY_KEEP_TURNS} turns are in the conversation.` });
     return;
   }
   const key = `${scopeId(scope)}/${sessionId}`;
   this.setBusy(true);
   this.runningKey = key;
   this.abort = new AbortController();
   try {
     const compacted = await this.compact(transcript, key, this.abort.signal, sessionId);
     const history = compacted ?? toHistory(await readTranscript(transcript.path));
     await this.seedContextEstimate(key, slug, history);
     this.postContextUsage(key);
   } catch (err) {
     this.surfaceError(err);
   } finally {
     this.abort = undefined;
     this.runningKey = undefined;
     this.setBusy(false);
   }
   ```
   Notes: `compact()` already posts the compaction record via appendMessage and surfaces a failed summary inline ('Compacting the conversation failed: … left as it was') without throwing, so nothing else is needed for the failure path; Stop during a manual compaction aborts the summary completion through `this.abort` (compact returns undefined on abort). Trim is round-local (it only shapes one request's payload and is re-applied by the loop's budget seam on every round), and the summary replaces every turn older than the last two — exactly the turns trim step 2 would stub — so the manual path's 'trim' is realised by the next send's budget.prepare over the compacted history; state this in the method's doc comment. A manual compaction runs regardless of the window being known (compact() already falls back to a 32 000-token summary budget).

   Files: `src/activation/chatController.ts`

8. Command baiton.compactContext

   src/activation/commands.ts: add `compactContext: 'baiton.compactContext',` to `COMMANDS` (after `refreshModels`). In the `disposables.push(...)` block that registers `COMMANDS.chat`/`COMMANDS.openChat` (~line 937), add `vscode.commands.registerCommand(COMMANDS.compactContext, () => chatController.compactContext()),`. Mention it in the file's header command list comment (one bullet: '`baiton.compactContext` — trim-then-summarise the chat conversation in view; refused while busy').
   package.json: under `contributes.commands` add `{ "command": "baiton.compactContext", "title": "Compact Chat Context", "category": "Baiton" }` (after baiton.refreshModels), and under `menus.commandPalette` add `{ "command": "baiton.compactContext", "when": "baiton.activated" }` next to the baiton.openChat entry. No new setting is needed.

   Files: `src/activation/commands.ts`, `package.json`

9. Reducer unit tests

   In test/webviewProtocol.reducer.test.ts add a `describe('context usage', …)` block at the end:
   - 'a fresh state carries no context reading': `assert.strictEqual(initialWebviewState().context, undefined)`.
   - 'setContextUsage sets loaded, window and source': reduce(initial, {type:'setContextUsage', loaded: 256000, window: 1000000, source: 'usage'}).context deepStrictEqual {loaded:256000, window:1000000, source:'usage'}.
   - 'an unknown window is carried as null': window null, source 'estimate'.
   - 'a later reading replaces the earlier one'.
   - 'setContextUsage leaves the rest of the state alone': seed with busy/mode/records/selection, compare `{ ...next, context: undefined }`-style or assert each field unchanged.
   - 'renderConversation and setBusy keep the reading'.
   - 'does not mutate its input and does not alias the message': JSON snapshot of the seed unchanged; mutating the msg object afterwards does not change state.context.
   - 'a webview compactContext message carries only its type': `const msg: WebviewToHost = { type: 'compactContext' }; assert.deepStrictEqual(msg, { type: 'compactContext' })`.

   Files: `test/webviewProtocol.reducer.test.ts`

10. Mirror test: explicit parity check for the new message

   test/webviewProtocol.mirror.test.ts already folds every PROTOCOL_CASES entry through both reducers (the new fixture cases from the earlier step cover setContextUsage). Add one explicit `it('mirrors setContextUsage, including a null window', …)` that folds [{type:'setContextUsage', loaded: 1, window: null, source: 'estimate'}, {type:'setContextUsage', loaded: 2, window: 8, source: 'usage'}] through `reduce` and `mirror.reduce` from initialWebviewState() and asserts `deepStrictEqual(hardClone(js), ts)` and `ts.context` equals `{ loaded: 2, window: 8, source: 'usage' }`; plus `assert.strictEqual(hardClone(mirror.initialWebviewState()).context, undefined)`.

   Files: `test/webviewProtocol.mirror.test.ts`

11. Fake-DOM view tests for the meter and Compact button

   In test/chatView.mode.test.ts: add `['context-bar', 'div'], ['context-meter', 'span'], ['compact-context', 'button']` to ELEMENT_IDS (the existing mode tests are unaffected). Add a new `describe('chat view context meter (context-budget T07)', …)`:
   - 'seed paint hides the meter': `view.ids['context-bar'].getAttribute('hidden') !== null`, meter text ''.
   - 'renders loaded / window · source': send setContextUsage {loaded: 256000, window: 1000000, source: 'usage'} → meter textContent === '~256K / 1M · usage'; bar not hidden.
   - 'renders window unknown': {loaded: 256000, window: null, source: 'estimate'} → '~256K · window unknown'.
   - 'small and fractional-million values': {loaded: 900, window: 1500000, source:'estimate'} → '~900 / 1.5M · estimate'.
   - 'warns at 80% of the window': {loaded: 850000, window: 1000000} → meter.classList.contains('warn') true; {loaded: 100000, …} → false.
   - 'Compact posts compactContext exactly once when idle with records': send renderConversation with one user record, fire click on compact-context → posted deepStrictEqual [{ type: 'compactContext' }].
   - 'Compact is disabled and posts nothing while busy': send renderConversation (one record) + setBusy true → button.disabled true; fire click → posted length 0; setBusy false → disabled false.
   - 'Compact is disabled on an empty conversation'.
   Also verify (no edit needed) that test/chatView.providers.test.ts and test/modelSelectorRefresh.test.ts still pass with the null-guarded lookups.

   Files: `test/chatView.mode.test.ts`

12. Controller tests for the meter posts and manual compaction

   Extend test/chatController.compaction.test.ts (its FakeWebview/FakeClient/build() harness already fits) with a `describe('context meter and manual compaction (T07)')`:
   - 'posts setContextUsage after a completion': build({ window: 100000, small: true }); client.queue.push({ content: 'ok', tool_calls: [], usage: { promptTokens: 1234, completionTokens: 5 } }); send('hi') → webview.last('setContextUsage') deepStrictEqual { type:'setContextUsage', loaded: 1234, window: 100000, source: 'usage' }.
   - 'falls back to the estimate without usage and posts window null when unknown': build({ window: undefined, small: true }); send → last setContextUsage has source 'estimate', loaded > 0, window null.
   - 'posts an estimate on the first render of a reloaded conversation': after build(), there is at least one setContextUsage with source 'estimate' and loaded > 0.
   - 'compactContext appends a compaction record and posts the new reading': build({ window: 100000 }); client.queue.push({ content: 'Goals: x', tool_calls: [] }); await webview.send({ type: 'compactContext' }); wait for setBusy false → the transcript's last record has a `compaction` marker; client.requests[0] has no tools; the last setContextUsage's loaded is smaller than the pre-compaction estimate; setBusy went true then false.
   - 'compactContext is refused while busy': start a send whose client call blocks on a deferred promise, then send compactContext → a showError mentioning 'Wait' is posted and no extra client request is made; release the deferred.
   - 'compactContext on a too-short conversation posts a notice and calls nothing': build with only the u3/a3 pair (or a fresh chat) → showError 'Nothing to compact…'/'nothing to compact' and client.requests is empty.
   - 'a failed manual summary leaves the transcript as it was': queue an Error → showError 'Compacting the conversation failed', transcript records unchanged, busy cleared.
   (This test file is outside the todo's listed files but is the existing controller harness for compaction; if the executor must stay inside the list, these can go into a new file test/chatController.contextMeter.test.ts copying the harness.)

   Files: `test/chatController.compaction.test.ts`

13. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Confirm `grep -rn "from 'vscode'" src/orchestrator` shows nothing new (webviewProtocol.ts must stay host-free). Confirm the `assertNever` exhaustiveness in reduce compiles (the new case is handled).

   Files: (none)

## Risks

- media/protocol.js and test/fixtures/protocolCases.ts are not in the todo's file list but must change: the mirror test folds every fixture through both reducers and a missing mirror case silently returns the state unchanged, failing deepStrictEqual.
- Adding `context` to initialWebviewState() (instead of leaving it optional/absent) would break the seed parity test and the `seed()` literal used across fixture cases; keep it absent until the first setContextUsage.
- chat.js is executed by test/chatView.providers.test.ts and test/modelSelectorRefresh.test.ts over fake DOMs that do not define the new element ids; any unguarded access to #context-meter/#compact-context/#context-bar throws at load and fails those suites.
- test/chatController.interventions.test.ts:586 asserts selectModel posts exactly one message; posting setContextUsage on a selection change would break it, so the meter's window only refreshes on the next completion/render/compaction.
- Posting setContextUsage from refresh() adds messages to every render; tests that count total posts after start could be affected — the executor should run the full controller suites and keep the post after renderConversation, never between setProviders and other asserted sequences.
- The observe hook runs inside the loop; posting only when the run's key equals the view key avoids painting another session's reading, but if the user switches conversation mid-run the meter shows the viewed conversation's older reading until its next completion.
- Manual compaction reuses compact(), which returns undefined both on failure (already surfaced inline) and when there is nothing older than the kept turns; the pre-check with compactionCut distinguishes the latter so the user gets a notice rather than silence. A conversation whose older part is only an existing summary still returns undefined silently — acceptable, the meter is re-posted.
- seedContextEstimate calls buildPrompt/phaseForConversation (reads spec.md) during refresh; wrap in try/catch so a read failure never breaks rendering.
- Token formatting is duplicated in chat.js (plain script, cannot import TS); only the fake-DOM tests guard its output.

## Acceptance

- HostToWebview includes `{ type: 'setContextUsage'; loaded: number; window: number | null; source: 'usage' | 'estimate' }` and WebviewToHost includes `{ type: 'compactContext' }`; reduce stores the reading in `state.context` and the TS reducer and media/protocol.js produce deep-equal states for every fixture case, including the new setContextUsage cases.
- initialWebviewState() is unchanged (no `context` key) in both the TS core and the mirror.
- The chat view renders `~256K / 1M · usage` for {loaded 256000, window 1000000, source 'usage'} and `~256K · window unknown` for a null window, under the composer controls, hidden until the first reading.
- The Compact button posts exactly one `{ type: 'compactContext' }` when idle with a non-empty conversation and is disabled/posts nothing while busy or on an empty conversation.
- The controller posts setContextUsage after every completion (source 'usage' when the endpoint reported prompt tokens, else 'estimate'), after every compaction (automatic or manual) with the post-compaction estimate, and on render of the conversation in view.
- `compactContext` and the `baiton.compactContext` command summarise the conversation in view into a compaction record (transcript remains append-only and complete), are refused with an inline message while busy, give an inline notice when there is nothing to compact, and surface a failed summary inline leaving the conversation unchanged.
- package.json contributes `baiton.compactContext` (title 'Compact Chat Context', category Baiton) with a commandPalette `when: baiton.activated` entry, and COMMANDS.compactContext is registered in commands.ts.
- No `vscode` import is added under src/orchestrator/; `npm run compile`, `npm run lint` and `npm test` all pass.
