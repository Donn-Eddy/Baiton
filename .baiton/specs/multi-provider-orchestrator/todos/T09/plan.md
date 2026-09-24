# Plan T09

## Steps

1. Carry the provider on the inline error and its fix action (protocol core)

   In src/orchestrator/webviewProtocol.ts, `ProviderId`/`ModelSelection` are already imported as types (line ~17) and `FixAction = 'openSettings' | 'setApiKey'` already exists. Make three additions, all optional so every existing message literal still type-checks:

   1. `showError` (HostToWebview) becomes `| { type: 'showError'; message: string; action?: FixAction; provider?: ProviderId }`. Doc it: "`provider` is set when the error is about one provider's missing API key, so the fix action can open that provider's key prompt directly."
   2. `triggerFix` (WebviewToHost) becomes `| { type: 'triggerFix'; action: FixAction; provider?: ProviderId }` — the webview echoes back whatever provider the error carried; the dropdown's generic 'Set API key…' affordance keeps posting it WITHOUT a provider, which means "let the host quick-pick".
   3. `WebviewState.error` becomes `{ message: string; action?: FixAction; provider?: ProviderId }`, and the reducer's `case 'showError'` becomes `return { ...state, error: { message: msg.message, action: msg.action, provider: msg.provider } };` — note the existing code already stores an always-present `action` key whose value may be `undefined`; keep the same discipline for `provider` (always write the key) because `test/webviewProtocol.mirror.test.ts` deep-strict-compares states and a present-undefined key differs from an absent one.

   Do NOT change `setEmptyState`: T08's media/chat.js `renderEmptyState()` already derives the provider label from `state.selection` (via `providerLabel()`) and falls back to `state.empty.model`, so the empty state shows provider + model as soon as the controller posts `setProviders` before `setEmptyState`. Leave `setProviders`/`selectModel` (added by T07) untouched.

   Files: `src/orchestrator/webviewProtocol.ts`

2. Mirror the showError change in media/protocol.js and pin it with fixtures

   media/protocol.js line ~146 currently reads `case 'showError': return Object.assign({}, state, { error: { message: msg.message, action: msg.action } });`. Change it to `{ error: { message: msg.message, action: msg.action, provider: msg.provider } }` — byte-for-behaviour identical to the TS reducer, including writing the key when the value is `undefined`. Nothing else in the mirror changes (`initialWebviewState` has no `error` seed).

   In test/fixtures/protocolCases.ts, extend the existing showError block (cases (31)/(32) around line 360) with two numbered cases appended at the end of the list, following the file's existing `cases.push({...})` style and comment numbering:
   - `showError with a provider-scoped key action`: `messages: [{ type: 'showError', message: 'The Google AI Studio API key is not configured.', action: 'setApiKey', provider: 'google' }]`.
   - `showError replaces a provider-scoped error with a plain one`: start from `seed()` and fold `[{ type: 'showError', message: 'a', action: 'setApiKey', provider: 'mistral' }, { type: 'showError', message: 'b' }]`, proving the `provider` key is cleared (present-undefined) rather than carried over.
   The existing mirror suite picks these up with no change to test/webviewProtocol.mirror.test.ts.

   Files: `media/protocol.js`, `test/fixtures/protocolCases.ts`

3. Round-trip the provider through the inline error button in the webview script

   In media/chat.js `renderError()` (around line 955-970): after `errorFix.dataset.action = state.error.action;` add
   ```js
   if (state.error.provider) {
     errorFix.dataset.provider = state.error.provider;
   } else {
     delete errorFix.dataset.provider;
   }
   ```
   and in the `else` branch that hides the button also `delete errorFix.dataset.provider;` next to the existing `delete errorFix.dataset.action;`.

   In the `errorFix` click handler (around line 1166):
   ```js
   const action = errorFix.dataset.action;
   if (action) {
     const provider = errorFix.dataset.provider;
     vscode.postMessage(
       provider
         ? { type: 'triggerFix', action: action, provider: provider }
         : { type: 'triggerFix', action: action },
     );
   }
   ```
   Leave the `modelSetKey` and `emptySetKey` handlers posting `{ type: 'triggerFix', action: 'setApiKey' }` with no provider — those affordances are deliberately provider-agnostic (the host quick-picks). Update the file-header comment only if it already enumerates the fix-action behaviour.

   Files: `media/chat.js`

4. Give ChatController a provider seam and post setProviders

   All edits in src/activation/chatController.ts.

   (a) Imports: add `providerInfo` to the existing value import from `'../orchestrator'`, and add `ModelSelection`, `ProviderGroup`, `ProviderId` to the existing `import type { ... } from '../orchestrator'` block (the barrel re-exports both ./providers and ./webviewProtocol).

   (b) New exported interface, declared next to `OrchestratorConfig`, structurally satisfied by `ProviderRouter` (src/activation/providerRouter.ts) so the controller stays host-free and never imports the router:
   ```ts
   /** One provider's availability as the router reports it (see ProviderRouter.availability). */
   export interface ProviderAvailabilityView {
     id: ProviderId;
     label: string;
     enabled: boolean;
     reason?: string;
     models: readonly string[];
   }

   /** The provider selection seam: the host binds it to the ProviderRouter. */
   export interface ProviderSource {
     availability(): Promise<ProviderAvailabilityView[]>;
     getSelection(): ModelSelection | undefined;
     select(value: unknown): Promise<boolean>;
     onDidChangeSelection(listener: (s: ModelSelection | undefined) => void): { dispose(): void };
   }
   ```
   Add `providers?: ProviderSource;` to `ChatControllerDeps` (OPTIONAL — every existing test constructs the deps literal without it and must keep compiling; absent, the controller posts no `setProviders` and behaves exactly as today).

   (c) Widen the fix sink: `export type TriggerFix = (action: FixAction, provider?: ProviderId) => void | Promise<void>;` and update its doc comment to say `setApiKey` with a provider opens that provider's key prompt, without one it opens the provider quick-pick. A zero/one-argument arrow (`triggerFix: () => {}`) still satisfies this, so no existing test breaks.

   (d) New private method:
   ```ts
   /** Post the Provider & Model dropdown state; a no-op without the seam. */
   private async postProviders(): Promise<void> {
     const source = this.deps.providers;
     if (source === undefined) { return; }
     try {
       const entries = await source.availability();
       const groups: ProviderGroup[] = entries.map((e) => ({
         id: e.id,
         label: e.label,
         enabled: e.enabled,
         ...(e.reason !== undefined ? { reason: e.reason } : {}),
         models: e.models.map((id) => ({ id })),
       }));
       this.deps.webview.post({ type: 'setProviders', groups, selection: source.getSelection() ?? null });
     } catch (err) {
       this.deps.log(`Baiton chat: could not list the providers: ${describe(err)}`);
     }
   }
   ```
   Keep the router's group order and its `models` verbatim — the webview never sorts or filters, and it already ignores a disabled group's models.

   (e) `refresh()` (around line 789): insert `await this.postProviders();` immediately after the `setAutoMode` post and before `setConversations`, so the selection is in the webview state before `renderConversation`/`setEmptyState` arrive and the empty state renders provider + model on the first paint.

   (f) `start()`: subscribe exactly once per call and never stack duplicates. Add a field `private selectionSub: { dispose(): void } | undefined;` and in `start()`, before `void this.refresh()`:
   ```ts
   this.selectionSub?.dispose();
   this.selectionSub = this.deps.providers?.onDidChangeSelection(() => { void this.postProviders(); });
   ```
   Add `public dispose(): void { this.selectionSub?.dispose(); this.selectionSub = undefined; }` so the host can unwire the view.

   Files: `src/activation/chatController.ts`

5. Handle selectModel and map a missing provider key to a provider-scoped inline error

   Still in src/activation/chatController.ts.

   (a) `handle()` switch (around line 340): add
   ```ts
   case 'selectModel':
     await this.onSelectModel(msg.provider, msg.model);
     return;
   ```
   and change `case 'triggerFix': await this.deps.triggerFix(msg.action, msg.provider); return;`.

   (b) New private method, documented as "applies to the next completion only: the router resolves the provider per `complete()` call, so nothing is re-wired, no transcript is read, written or re-rendered, and no session is created":
   ```ts
   private async onSelectModel(provider: ProviderId, model: string): Promise<void> {
     const source = this.deps.providers;
     if (source === undefined) { return; }
     let ok = false;
     try {
       ok = await source.select({ provider, model });
     } catch (err) {
       this.deps.log(`Baiton chat: could not switch the model: ${describe(err)}`);
     }
     if (!ok) {
       // Rejected or threw: repaint the dropdown from the unchanged selection so
       // the view cannot drift from the host.
       await this.postProviders();
     }
   }
   ```
   On success the router fires its change event and the `start()` subscription posts `setProviders`; do not post it a second time here (a repeat of the active selection returns true and fires nothing, and the view already matches). Deliberately do NOT call `refresh()` and do NOT touch `this.activeSessions`, the transcript or `busy`.

   (c) `surfaceError()` (around line 1025): in the `MissingConfigError` branch, when `err.missing === 'apiKey'`, attach the active provider so the fix opens its prompt:
   ```ts
   if (err instanceof MissingConfigError) {
     const action: FixAction = err.missing === 'apiKey' ? 'setApiKey' : 'openSettings';
     const provider = err.missing === 'apiKey' ? this.deps.providers?.getSelection()?.provider : undefined;
     this.deps.webview.post({
       type: 'showError',
       message: provider !== undefined ? missingProviderKeyMessage(provider) : missingConfigMessage(err.missing),
       action,
       ...(provider !== undefined ? { provider } : {}),
     });
     return;
   }
   ```
   Add the module-level helper next to `missingConfigMessage`:
   ```ts
   /** The inline message naming the provider whose API key is missing. */
   function missingProviderKeyMessage(provider: ProviderId): string {
     return `The ${providerInfo(provider).label} API key is not configured.`;
   }
   ```
   Leave `missingConfigMessage` and the `UnreachableEndpointError` branch untouched (no selection, or a missing endpoint/model, still reads exactly as today).

   (d) Update the file-header responsibility bullets (lines ~41-45): the empty state now shows provider + model, `setProviders` is posted on refresh and on every router selection change, `selectModel` switches the active provider/model for the next turn without touching the transcript, and a missing provider key maps to an inline error whose fix opens that provider's key prompt.

   Files: `src/activation/chatController.ts`

6. Test the provider wiring in test/chatController.interventions.test.ts

   Add a local fake next to `FakeModelClient`:
   ```ts
   class FakeProviders {
     public entries: ProviderAvailabilityView[] = [
       { id: 'copilot', label: 'GitHub Copilot', enabled: false, reason: COPILOT_UNAVAILABLE_REASON, models: [] },
       { id: 'google', label: 'Google AI Studio', enabled: true, models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
       { id: 'mistral', label: 'Mistral AI', enabled: false, reason: providerNeedsKeyReason('mistral'), models: ['mistral-large-latest'] },
     ];
     public selection: ModelSelection | undefined = { provider: 'google', model: 'gemini-2.5-pro' };
     public readonly selected: unknown[] = [];
     public accept = true;
     public failAvailability = false;
     private readonly listeners = new Set<(s: ModelSelection | undefined) => void>();
     public async availability(): Promise<ProviderAvailabilityView[]> { if (this.failAvailability) { throw new Error('nope'); } return this.entries; }
     public getSelection(): ModelSelection | undefined { return this.selection; }
     public async select(value: unknown): Promise<boolean> {
       this.selected.push(value);
       if (!this.accept) { return false; }
       this.selection = value as ModelSelection;
       for (const l of [...this.listeners]) { l(this.selection); }
       return true;
     }
     public onDidChangeSelection(l: (s: ModelSelection | undefined) => void): { dispose(): void } {
       this.listeners.add(l);
       return { dispose: () => { this.listeners.delete(l); } };
     }
   }
   ```
   Declare `let providers: FakeProviders;` and `let fixes: Array<{ action: FixAction; provider?: ProviderId }>;` in the suite, create them in `buildHarness()` and pass `providers` plus `triggerFix: (action, provider) => { fixes.push({ action, provider }); }` into the `new ChatController({...})` literal (keep every other dep as-is). Import the extra types/values from '../src/activation/chatController' and '../src/orchestrator' (`ProviderAvailabilityView`, `ProviderSource`, `ModelSelection`, `ProviderId`, `FixAction`, `COPILOT_UNAVAILABLE_REASON`, `providerNeedsKeyReason`, `MissingConfigError`).

   Add a `describe('provider selection', ...)` block with these cases (use the existing `webview.last`/`webview.all` helpers and `waitFor` for the async refresh):
   1. `start()` posts one `setProviders` whose groups are the router's entries in order, with `reason` on the two disabled ones, `models` mapped to `[{ id }]`, and `selection` equal to `{ provider: 'google', model: 'gemini-2.5-pro' }`.
   2. `setProviders` is posted BEFORE the first `setEmptyState` — assert on `webview.posts.findIndex(m => m.type === 'setProviders') < webview.posts.findIndex(m => m.type === 'setEmptyState')`.
   3. `selection` is `null` when `providers.selection = undefined`.
   4. `selectModel` from the webview calls `select` exactly once with `{ provider: 'google', model: 'gemini-2.5-flash' }`, a new `setProviders` carrying that selection is posted by the change subscription, and the transcript is untouched: run a send first, snapshot `fs.readFileSync(transcriptFile(), 'utf8')` and `fs.readdirSync(path.join(baitonDir, 'chat'))`, then assert both are byte-identical after the switch and that no `renderConversation` / `appendMessage` / `setBusy` was posted by the switch.
   5. A rejected switch (`providers.accept = false`) posts a `setProviders` whose `selection` is still the old pair and never throws.
   6. A router-side change (call `providers.select(...)` directly, without a webview message) posts a `setProviders` with the new selection.
   7. Calling `controller.start()` twice yields exactly ONE extra `setProviders` per subsequent router change (no duplicate subscription), and `controller.dispose()` stops further posts.
   8. A `MissingConfigError('apiKey')` thrown by the client during a send posts `showError` with `action: 'setApiKey'`, `provider: 'google'` and the message `The Google AI Studio API key is not configured.`; feeding `{ type: 'triggerFix', action: 'setApiKey', provider: 'google' }` back records `{ action: 'setApiKey', provider: 'google' }` in `fixes`, while `{ type: 'triggerFix', action: 'setApiKey' }` records `provider: undefined`. Make the client throw by giving `FakeModelClient` a `public failWith: unknown` field thrown from `complete` when set (or push a throwing entry onto its queue) — keep the existing constructor/queue behaviour intact for the other suites in the file.
   9. Without the `providers` dep (construct a second controller with the same deps minus `providers`), `start()` posts no `setProviders` and a `selectModel` message is a silent no-op.
   10. `availability()` rejecting logs through `deps.log` and posts no `setProviders`, and the rest of the refresh still happens (`setConversations` and `renderConversation` are posted).
   Extend the suite's file-header coverage list with the new numbered items.

   Files: `test/chatController.interventions.test.ts`

7. Guard the Auto-mode interaction in test/chatController.autoMode.test.ts

   Reuse the same `FakeProviders` shape (copy it locally — the two suites already duplicate their fakes rather than sharing a fixture) and pass it as the optional `providers` dep in this suite's `new ChatController({...})` (around line 199), leaving `config`, `triggerFix` and the gate wiring as they are. Add a short `describe('provider selection and Auto mode', ...)` with:
   1. The first refresh posts BOTH `setAutoMode { enabled: true }` (restored from `autoModeMemory`) and `setProviders`, and the `setProviders` carries the active selection — i.e. adding the provider seam does not disturb the Auto-mode echo or its ordering.
   2. Switching the model while a gated run is in flight (a pending escalated card on screen) posts `setProviders` and leaves the card untouched: no new `showIntervention`, no `resolveIntervention`, the pending ask still settles normally afterwards and the transcript records are unchanged in count.
   3. Flipping Auto mode posts no `setProviders` (the two toggles are independent).
   Extend this suite's file-header coverage list with the new items.

   Files: `test/chatController.autoMode.test.ts`

8. Verify

   Run, from the repo root, in this order and require each to be clean:
   - `npx tsc --noEmit -p tsconfig.json`
   - `npx eslint src test --ext .ts` (the pre-existing `no-unused-vars` warning on `_legacy` in src/orchestrator/webviewProtocol.ts:548 is the only acceptable output)
   - `npx mocha test/chatController.interventions.test.ts test/chatController.autoMode.test.ts test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts`
   - `npm run test:unit` — must stay green and be strictly above the T07 baseline of 1298 passing / 1 pending.
   - `npx mocha` (full suite incl. property tests) as the final check.
   Do not edit src/activation/commands.ts, src/activation/providerRouter.ts, src/orchestrator/modelClient.ts or src/orchestrator/copilotClient.ts: wiring the real router into the ChatController deps and registering `baiton.setProviderApiKey` belong to the host-wiring todo that follows.

   Files: (none)

## Risks

- Mirror drift: adding `provider` to the reducer's `error` object in src/orchestrator/webviewProtocol.ts without the identical change in media/protocol.js fails test/webviewProtocol.mirror.test.ts by design. The key must be written even when the value is `undefined`, because the suite deep-strict-compares whole states and a present-undefined key differs from an absent one.
- Making `providers` a required dep would break every existing ChatController construction in the test suites (test/chatController.*.test.ts) and the host glue. It must be optional, and every provider code path must degrade to a silent no-op when it is absent.
- `start()` is called again on reopen / window reload. Subscribing to `onDidChangeSelection` without disposing the previous handle stacks listeners and posts duplicate `setProviders` per change; the plan's `selectionSub` field plus `dispose()` is the guard, and test 7 pins it.
- Ordering: if `postProviders()` is posted after `renderConversation`/`setEmptyState`, the webview's first paint of the empty state has no `state.selection` and shows 'not configured' for the provider. It must land before `setConversations` in `refresh()`.
- `onSelectModel` must not call `refresh()`: a refresh re-reads the session list, may allocate a session id and re-renders the conversation. The todo requires the switch to apply to the next turn only, leaving the transcript untouched.
- The router reports a disabled keyed provider with its full catalog `models` list, while the ProviderGroup doc comment says models are empty for a disabled provider. The plan passes them through unchanged (media/chat.js renders the reason option instead of the models for a disabled group, so nothing leaks to the user); a filter here would misreport what the router said.
- Double-posting `setProviders` on a successful `selectModel` (once in the handler and once from the change listener) would make the 'exactly one post per change' assertions flaky; only the listener posts on success.
- The provider-scoped message text depends on the catalog label via `providerInfo(provider).label`; hard-coding 'Google AI Studio' in the controller would drift from src/orchestrator/providers.ts.

## Acceptance

- `refresh()` posts exactly one `setProviders` — groups in the router's order with `label`, `enabled`, a `reason` on each disabled provider and `models` mapped to `{ id }` — before `setConversations`, `renderConversation` and `setEmptyState`, and it carries the router's active `ModelSelection` or `null`.
- A selection change on the router (not originating from the webview) posts a fresh `setProviders`; `start()` called twice still produces exactly one post per change, and `dispose()` stops them.
- A webview `selectModel` message calls `ProviderSource.select({ provider, model })` once and posts the updated `setProviders`; the on-disk transcript bytes, the session file list, `busy` and the rendered records are all unchanged, and the next completion routes to the new provider with no re-wiring.
- A rejected or throwing `select` posts a `setProviders` carrying the unchanged selection and never throws out of `handle`.
- With a selection active, a `MissingConfigError('apiKey')` surfaces as `showError { message: 'The <provider label> API key is not configured.', action: 'setApiKey', provider: <id> }`; with no selection it keeps today's generic wording and no `provider` key. `endpoint`/`model` errors and `UnreachableEndpointError` are unchanged.
- The webview echoes `triggerFix { action: 'setApiKey', provider }` from the error button and the controller passes both arguments to `deps.triggerFix`; the dropdown's and empty state's 'Set API key…' buttons still post the provider-less form.
- The empty state shows the provider label and model of the active selection (falling back to 'not configured' when nothing is selected) with no change to the `setEmptyState` message shape.
- Omitting the `providers` dep leaves the controller behaving exactly as before this todo: no `setProviders` posts, `selectModel` a no-op, generic key error text.
- `npx tsc --noEmit`, `npx eslint src test --ext .ts` (only the pre-existing `_legacy` warning), the four named suites, `npm run test:unit` above the 1298/1 baseline, and the full `npx mocha` run are all green.
