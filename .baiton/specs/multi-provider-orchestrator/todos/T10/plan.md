# Plan T10

## Steps

1. Add ProviderRouter.refresh(): re-resolve the selection and fire the change event

   In src/activation/providerRouter.ts the router today only fires its selection event from select(); nothing tells listeners that AVAILABILITY changed (a key was stored or cleared). Add that seam without changing any existing behaviour.

   (a) Extract the fallback half of init() into a private helper so init() and the new refresh() share one copy:

       /**
        * The first enabled provider that offers at least one model, or undefined
        * when no provider is currently usable. Availability is re-read here.
        */
       private async firstUsableSelection(): Promise<ModelSelection | undefined> {
         const enabled = await this.enabledProviders();
         for (const id of PROVIDER_IDS) {
           if (!enabled.includes(id)) { continue; }
           const models = await this.modelsFor(id);
           const model = models[0];
           if (model !== undefined) { return { provider: id, model }; }
         }
         return undefined;
       }

     init() keeps its exact current semantics: it still reads MODEL_SELECTION_KEY, still keeps a restored selection when `normalizeModelSelection` yields a known provider that is currently enabled with a non-empty model, still persists ONLY a computed fallback, still never fires the event, still swallows+logs every failure and still sets `this.lastModel` for the resolved selection. The only change is that the `for (const id of PROVIDER_IDS)` loop body is replaced by a call to `firstUsableSelection()` (when it resolves a selection: assign `this.selected`, `await this.config.workspaceState.update(MODEL_SELECTION_KEY, fallback)`).

   (b) Add the public method, documented as "availability changed out of band":

       /**
        * Re-reads availability after something outside the router changed it — an
        * API key stored or cleared, Copilot sign-in. When nothing is selected, or
        * the active provider is no longer enabled, the selection is re-resolved
        * (and the new one persisted); either way the change event fires exactly
        * once so the Chat view repaints its Provider & Model dropdown. Every
        * failure is swallowed and logged: this runs off a command handler and must
        * never reject.
        */
       public async refresh(): Promise<void> {
         try {
           const enabled = await this.enabledProviders();
           const active = this.selected;
           if (active === undefined || !enabled.includes(active.provider)) {
             const next = await this.firstUsableSelection();
             this.selected = next;
             if (next !== undefined) {
               this.lastModel.set(next.provider, next.model);
               await this.config.workspaceState.update(MODEL_SELECTION_KEY, next);
             }
           }
         } catch (err) {
           this.config.log?.(`Baiton: refreshing provider availability failed: ${describe(err)}`);
         }
         this.fire();
       }

   Note the `fire()` is OUTSIDE the try so a failed availability read still repaints the view from whatever the router holds. Nothing else in the file changes; clients stay memoised (they read their model through modelFor() at call time) and complete() is untouched.

   (c) Extend test/providerRouter.test.ts with a `describe('refresh', ...)` block using the suite's existing local fakes:
     - with no selection and a key newly present for `google`, refresh() selects `{ provider: 'google', model: <first catalog model> }`, persists it under MODEL_SELECTION_KEY and fires the listener once;
     - with an active `google` selection whose key was just cleared, refresh() re-resolves to the next enabled provider (or to `undefined` when none is enabled) and fires once;
     - with an active selection that is still enabled, refresh() leaves `getSelection()` byte-identical, writes NOTHING to workspaceState, and still fires once;
     - a throwing secrets fake makes refresh() resolve (never reject), log through `config.log`, and still fire;
     - `select()` and `init()` behaviour assertions already in the file must remain green unchanged (init still does not fire).

   Files: `src/activation/providerRouter.ts`, `test/providerRouter.test.ts`

2. Give setProviderApiKey an onChanged notification so a stored/cleared key refreshes availability

   In src/activation/setApiKey.ts widen `setProviderApiKey` with a third, optional parameter:

       export async function setProviderApiKey(
         secrets: vscode.SecretStorage,
         providerId?: ProviderId,
         onChanged?: (id: ProviderId) => void | Promise<void>,
       ): Promise<void>

   Document it in the existing JSDoc: "Invoked with the affected provider id after a key is successfully stored or cleared — and only then — so the host can recompute provider availability. Never invoked on cancel, on the empty-submit-with-nothing-stored path, or on a store/delete failure; a throwing/rejecting callback is contained."

   Implementation: add one private helper next to it

       /** Fires the availability notification without letting it break the command. */
       async function notifyChanged(
         onChanged: ((id: ProviderId) => void | Promise<void>) | undefined,
         id: ProviderId,
       ): Promise<void> {
         try { await onChanged?.(id); } catch { /* the refresh is best-effort */ }
       }

   and call `await notifyChanged(onChanged, picked);` at exactly two places, each immediately AFTER the successful SecretStorage operation and BEFORE the confirmation message:
     - in the empty-submit branch, inside `if (hadKey) { ... }` (after `secrets.delete(key)` succeeded) — NOT on the `PROVIDER_KEY_NO_VALUE_MESSAGE` path;
     - after the successful `await secrets.store(key, input.trim())` in the non-empty branch.
   The `catch` blocks that show `providerKeySaveFailedMessage(label)` must not notify. Leave `setOrchestratorApiKey`, `migrateLegacyApiKey`, every exported message constant and the quick-pick behaviour untouched.

   Extend test/setApiKey.test.ts (it already loads this module through test/fixtures/vscodeLoader.mjs + vscodeFake.mjs) with cases that record the ids the callback receives:
     - non-empty submit for a picked provider → callback called once with that provider id, after the secret is present in the fake store;
     - empty submit that clears an existing key → callback called once with that id;
     - empty submit with nothing stored → callback NOT called;
     - cancelled input box and dismissed quick pick → callback NOT called;
     - a `store` that throws → callback NOT called and the failure message still shown;
     - a callback that throws/rejects → `setProviderApiKey` still resolves and the saved-confirmation message is still shown.

   Files: `src/activation/setApiKey.ts`, `test/setApiKey.test.ts`

3. Build the ProviderRouter in registerCommands and delete buildModelClient

   In src/activation/commands.ts:

   (1) Imports. Drop `OpenAiModelClient` from the `../orchestrator` import list (it becomes unused once `buildModelClient` is gone — leaving it trips the no-unused-vars warning). Add:

       import { ProviderRouter } from './providerRouter';
       import type { ProviderSettings } from './providerRouter';
       import { isProviderId } from '../orchestrator/providers';
       import type { ProviderId } from '../orchestrator/providers';
       import type { FixAction } from '../orchestrator/webviewProtocol';   // only if not already reachable; otherwise keep the inline 'openSettings' | 'setApiKey' union

   and extend the existing `./setApiKey` import to `{ migrateLegacyApiKey, setProviderApiKey }` (already the case).

   (2) Migration ordering. Replace the current fire-and-forget at the top of `registerCommands`

       void migrateLegacyApiKey(context.secrets, context.globalState);

   with a captured promise

       // One-time migration of the pre-multi-provider single-key secret into the
       // `openai` slot; the router's first availability read must see it, so the
       // init below is chained onto it rather than racing it.
       const legacyMigration = migrateLegacyApiKey(context.secrets, context.globalState);

   `migrateLegacyApiKey` already swallows its own failures and resolves a boolean, so no `.catch` is required (add one anyway if the lint/`no-floating-promises` style of the file suggests it).

   (3) Delete the `buildModelClient` function at the bottom of the file entirely, and replace the line `const modelClient = buildModelClient(context);` (currently just after the tool-registry construction) with the router:

       // The provider router replaces the single OpenAI client: it owns one client
       // per provider, resolves the active ModelSelection, and itself implements
       // ModelClient, so the ChatController, the tool loop and the Auto-mode gate
       // all follow a provider switch with no re-wiring.
       const providerSettings: ProviderSettings = {
         getEndpoint: () => vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('orchestrator.endpoint') || undefined,
         getModel: () => vscode.workspace.getConfiguration(SETTINGS_NS).get<string>('orchestrator.model') || undefined,
         isStreaming: () => vscode.workspace.getConfiguration(SETTINGS_NS).get<boolean>('orchestrator.streaming') ?? true,
         getMaxTokens: () => vscode.workspace.getConfiguration(SETTINGS_NS).get('orchestrator.maxTokens'),
       };
       const router = new ProviderRouter({
         secrets: context.secrets,
         workspaceState: context.workspaceState,
         settings: providerSettings,
         // `src/activation/` may import the host; the router's `lm` surface is the
         // real namespace here and a fake in its unit test.
         lm: vscode,
         version: extensionVersion(context),
         log: (message) => surface.log(message),
       });

   Each getter re-reads `vscode.workspace.getConfiguration(SETTINGS_NS)` per call (same discipline as `readOrchestratorConfig`) so a settings change while the view is open is picked up; you may hoist a local `const orchCfg = () => vscode.workspace.getConfiguration(SETTINGS_NS);` to keep the four getters short — do NOT hoist the configuration object itself.

   (4) Add the version helper near the other small module-level helpers at the bottom of the file:

       /** The extension version, rendered as `baiton/<version>` in the OpenCode User-Agent. */
       function extensionVersion(context: vscode.ExtensionContext): string {
         const raw = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
         return typeof raw === 'string' && raw.length > 0 ? raw : '0.0.0';
       }

   (5) Chain init after the migration, just below the router construction:

       // Restore the persisted selection (or pick the first usable provider) once
       // the legacy key has landed in the `openai` slot, then fire one change so a
       // Chat view that resolved first repaints its dropdown.
       void legacyMigration.then(() => router.init()).then(() => router.refresh());

   (6) Every remaining reference to the old `modelClient` identifier must now be `router`: the Auto-mode gate's `decideAsk(gateAsk, agentAllowList(agent, role, runId), router, {...})` and the `ChatController` construction's `client:` field. `ProviderRouter implements ModelClient`, so neither call site changes shape.

   Files: `src/activation/commands.ts`, `src/activation/providerRouter.ts`

4. Hand the router to the ChatController as both client and provider source, and dispose it

   Still in src/activation/commands.ts, in the `new ChatController({ ... })` call:
     - `client: router,` (was `client: modelClient`);
     - add `providers: router,` right after `config: readOrchestratorConfig(),` / before `triggerFix:` — the router structurally satisfies the controller's `ProviderSource` (`availability()`, `getSelection()`, `select(value)`, `onDidChangeSelection(listener)`), so no adapter object is needed; if tsc complains about `ProviderAvailability.reason?: string` vs `ProviderAvailabilityView`, the two are structurally identical and no cast should be required — do not add one, fix the mismatch instead.
     - leave `config: readOrchestratorConfig()` in place (the endpoint/model wording for the non-provider errors is unchanged) and leave every other dep exactly as it is.

   The controller subscribes to `router.onDidChangeSelection` in `start()`, which the existing `chatWebview.onResolve(() => chatController.start())` already drives, and it disposes the previous subscription on each restart. Add the controller's own teardown to the returned disposables so a deactivate releases it:

       disposables.push(new vscode.Disposable(() => chatController.dispose()));

   Put that alongside the existing `vscode.window.registerWebviewViewProvider(...)` / `chatWebview` push so the ordering stays readable. Do not call `chatController.start()` eagerly — the resolve hook still owns that.

   Files: `src/activation/commands.ts`

5. Route the setApiKey fix action and both key commands through the per-provider prompt

   Still in src/activation/commands.ts:

   (1) Inside `registerCommands`, define one closure both the commands and the fix action use, so the availability refresh happens on every path that touches a key:

       // One entry point for key management: the palette commands, and the Chat
       // view's inline "Set API key…" fix (which names the provider that failed).
       // A stored/cleared key refreshes availability, which repaints the dropdown.
       const promptProviderKey = (provider?: ProviderId): Promise<void> =>
         setProviderApiKey(context.secrets, provider, () => router.refresh());

   (2) Replace the two command registrations:

       vscode.commands.registerCommand(COMMANDS.setProviderApiKey, (arg?: unknown) =>
         promptProviderKey(isProviderId(arg) ? arg : undefined),
       ),
       // Kept as an alias so existing key bindings and the README keep working.
       vscode.commands.registerCommand(COMMANDS.setApiKey, () => promptProviderKey()),

   (3) Change the controller's fix sink from `triggerFix: (action) => triggerFix(action)` to

       triggerFix: (action, provider) => triggerFix(action, provider, promptProviderKey),

   and change the module-level helper to take the provider and the prompt seam (it cannot close over `context`):

       /**
        * Handle an inline-error fix action from the Chat_View (Req 13.4):
        * `openSettings` opens the Baiton orchestrator settings; `setApiKey` opens
        * the per-provider key prompt — pre-selecting the provider the failing
        * completion named, or falling back to the provider quick-pick when the
        * error carried none.
        */
       function triggerFix(
         action: 'openSettings' | 'setApiKey',
         provider: ProviderId | undefined,
         promptProviderKey: (provider?: ProviderId) => Promise<void>,
       ): void {
         if (action === 'setApiKey') {
           void promptProviderKey(provider);
           return;
         }
         void vscode.commands.executeCommand(
           'workbench.action.openSettings',
           `${SETTINGS_NS}.orchestrator`,
         );
       }

   Calling the handler directly rather than `executeCommand(COMMANDS.setProviderApiKey)` is the point of the change: the command id cannot carry the provider through the webview path reliably, and the direct call also gets the `onChanged` refresh.

   (4) Update the file-header JSDoc bullet for `baiton.setProviderApiKey` to say the Chat view's inline fix opens the same prompt pre-selected on the provider that failed, and that storing/clearing a key refreshes the Provider & Model dropdown.

   Files: `src/activation/commands.ts`

6. Verify

   Run, from the repo root:
     - `npx tsc --noEmit -p tsconfig.json` — must be clean. Expect to have to remove the now-unused `OpenAiModelClient` import and to satisfy `ProviderSource` structurally.
     - `npx eslint src test --ext .ts` — must show no NEW findings; the pre-existing `_legacy` warning recorded in T09 is the only one allowed to remain.
     - `npx mocha test/providerRouter.test.ts test/setApiKey.test.ts` (the .mocharc spec glob merges, so this runs the whole suite) — green.
     - `npm run test:unit` — green, at or above the T09 baseline of 1321 passing / 1 pending (the new refresh and onChanged cases add to it, nothing should regress).
   If `node_modules/@opencode-ai` or `node_modules/keytar` have reappeared (the environment problem T09 cleaned up), the activation gating suite fails at baseline for reasons unrelated to this todo — confirm it by stashing your edits before treating it as a regression.

   Files: (none)

## Risks

- Ordering: `migrateLegacyApiKey` is asynchronous and `ProviderRouter.init()` reads `baiton.orchestrator.key.openai`. If init is not chained onto the migration promise, a user upgrading from the single-key build sees `openai` reported as keyless on the first activation of the new build and the router falls back to another provider (or to none). Chain it, and keep the `router.refresh()` after init so a Chat view that resolved during the chain still repaints.
- The `client:` dep of the ChatController is also the client the Auto-mode gate uses through `decideAsk`. Both must be the SAME router instance or a provider switch will desync the chat and the gate — do not build a second router for the gate.
- `ProviderRouter.complete()` throws `MissingConfigError('model')` when nothing is selected, which is a different inline error from the old client's `MissingConfigError('apiKey')` on a missing key. With no provider enabled at all (fresh install, no keys, no Copilot) the user now sees the model-not-configured wording rather than the API-key wording; that is the intended T06 contract, but check the empty-state/inline-error text still leads somewhere actionable before calling the todo done.
- `context.extension` is typed as present but can be undefined in older/odd host surfaces and in a fake; the version helper must tolerate that rather than throwing during activation — a throw here loses every command registration, not just the User-Agent.
- `refresh()` firing the selection-change event means the ChatController reposts `setProviders` on every key write. That is the desired repaint, but a listener added elsewhere later must tolerate an event whose selection did not actually change; the JSDoc on `onDidChangeSelection`/`refresh` should say so.
- src/activation/commands.ts has no unit test that loads it (it imports `vscode` at module scope), so tsc and eslint are the only automatic checks on steps 3–5. Re-read the diff of those steps deliberately; a typo in a command registration only shows up at runtime.
- Clearing the key of the ACTIVE provider mid-conversation re-resolves the selection to a different provider. That is deliberate (the dropdown must not point at a dead provider), but it means the next turn of an open conversation can run on another model; the transcript is untouched either way.

## Acceptance

- `buildModelClient` no longer exists in src/activation/commands.ts and `OpenAiModelClient` is no longer imported there; the only model client the command layer constructs is the `ProviderRouter`.
- The same `ProviderRouter` instance is passed as the ChatController's `client`, as its `providers` seam, and as the `decideAsk` client inside the Auto-mode gate.
- The router is constructed with `secrets: context.secrets`, `workspaceState: context.workspaceState`, `lm: vscode`, a `version` read from `context.extension.packageJSON.version` with a safe fallback, live `baiton.orchestrator.endpoint/model/streaming/maxTokens` getters, and a `log` bound to the Surface.
- `router.init()` runs only after `migrateLegacyApiKey` has resolved, and a `router.refresh()` follows it so an already-resolved Chat view repaints.
- `ProviderRouter.refresh()` exists, re-reads availability, re-resolves and persists the selection when the active provider is no longer enabled (or none was selected), fires the change event exactly once including on the failure path, and never rejects.
- `setProviderApiKey` accepts an optional `onChanged(providerId)` and invokes it exactly on a successful store and a successful clear — not on cancel, not on an empty submit with nothing stored, not on a write/delete failure — with a throwing callback contained.
- Both `baiton.setProviderApiKey` and the `baiton.setOrchestratorApiKey` alias go through one `promptProviderKey` closure that passes `() => router.refresh()`; `baiton.setProviderApiKey` pre-selects a provider when invoked with a valid provider id argument.
- The controller's `triggerFix` sink forwards the optional provider: `setApiKey` with a provider opens that provider's masked prompt directly, without a provider quick-pick; `setApiKey` without one opens the quick-pick; `openSettings` still opens `baiton.orchestrator` settings.
- `chatController.dispose()` is reached through a disposable pushed onto the returned `CommandSurface.disposables`.
- `npx tsc --noEmit -p tsconfig.json` is clean and `npx eslint src test --ext .ts` reports no new findings.
- `npm run test:unit` is green at or above the 1321 passing / 1 pending T09 baseline, with new cases covering `ProviderRouter.refresh()` in test/providerRouter.test.ts and the `onChanged` notification in test/setApiKey.test.ts.
