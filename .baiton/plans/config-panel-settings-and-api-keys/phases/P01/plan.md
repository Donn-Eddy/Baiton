# Plan P01

## Steps

1. Extend the webview->host message union

   In src/config/configPanel.ts, append two variants to `ConfigPanelWebviewToHost` (currently ending with `| { type: 'reset' };` around line 169), each preceded by a `/** ... */` doc comment in the existing style:

     /** The user clicked "More settings…"; the host opens VS Code Settings filtered to the orchestrator namespace. One-way: no reply is posted. */
     | { type: 'openSettings' }
     /** The user clicked "Manage API keys…"; the host runs the provider API-key command with no provider argument. One-way: no reply is posted, and no key data crosses into the webview. */
     | { type: 'manageApiKeys' };

   (Move the terminating `;` from the `reset` variant to the last new variant.) Do NOT add anything to `ConfigPanelHostToWebview`. Add no imports; the file must stay free of `vscode` and Node imports.

   Files: `src/config/configPanel.ts`

2. Add optional seams to ConfigPanelControllerDeps

   In src/activation/configPanelController.ts, inside `interface ConfigPanelControllerDeps` (after `applyConfig?: ApplyConfig;`, before `log`), add two optional members with doc comments:

     /**
      * Opens the host's settings UI (wired in extension.ts to `workbench.action.openSettings` filtered to `${SETTINGS_NS}.orchestrator`).
      * Fire-and-forget: the controller posts nothing back and changes no state. A throw or rejection is logged, never surfaced as `saveFailed`. Absent → the message is a silent no-op.
      */
     openSettings?(): Promise<void> | void;
     /**
      * Starts the provider API-key flow (wired in extension.ts to `baiton.setProviderApiKey` with no argument).
      * Same contract as {@link openSettings}: one-way, state-free, errors logged only, absent → silent no-op.
      */
     manageApiKeys?(): Promise<void> | void;

   Also optionally add short doc comments to the existing `confirmReset` / `applyConfig` members only if needed for consistency (not required). Update the file header comment's sentence 'Every host capability — modal confirm and live-config apply — arrives as an injected seam.' to also mention opening settings and managing API keys.

   Files: `src/activation/configPanelController.ts`

3. Handle the new messages in ConfigPanelController.handle()

   In `handle(msg)` add, before `default:`:

     case 'openSettings':
       await this.invokeSeam('openSettings', this.deps.openSettings);
       break;
     case 'manageApiKeys':
       await this.invokeSeam('manageApiKeys', this.deps.manageApiKeys);
       break;

   Add a private helper:

     /** Calls an optional one-way host seam. Never posts, never touches doc/token/form/writing, never loads; errors are logged only. */
     private async invokeSeam(name: 'openSettings' | 'manageApiKeys', seam: (() => Promise<void> | void) | undefined): Promise<void> {
       if (seam === undefined) {
         return;
       }
       try {
         await seam.call(this.deps);
       } catch (e) {
         const message = e instanceof Error ? e.message : String(e);
         this.deps.log(`ConfigPanelController: ${name} failed: ${message}`);
       }
     }

   Key points: the try/catch must wrap both the synchronous call and the await so a sync throw AND a rejected promise are both caught here — otherwise the error would reach `start()`'s outer `.catch`, which posts `saveFailed`. Call via `seam.call(this.deps)` (or `this.deps.openSettings()` directly inside the case) so a method-style seam keeps its `this`. Do not set `this.writing`, do not call `this.load()`, do not post. The absent-seam branch returns before reaching `default`, so no 'unrecognised message type' log. Awaiting is safe: the provider's `onDidReceiveMessage` does not serialize messages.

   Update the class doc comment ("Handles `ready`, `load`, `save` ..., `reset` ..., and post-save hot-reload notifications.") to add: "`openSettings` and `manageApiKeys` (one-way hand-offs to optional injected seams; nothing is posted back, controller state is untouched, and a failing seam is only logged)".

   Do NOT change RESET_CONFIRM_MESSAGE, ACTIVATION_VALUES_NOTE, reset target, or any config-file paths in this phase (those belong to the local-config work in other phases).

   Files: `src/activation/configPanelController.ts`

4. Add controller unit tests for the two seams

   In test/configPanel.controller.test.ts, add a new `describe('10. openSettings / manageApiKeys seams', ...)` block inside the top-level describe (reuse `newDir`, `writeConfigFile`, `RecordingWebview`, `defaultConfigJson`, `configFilePath`). Update the file header 'Coverage:' list with item 10. Parameterise over both messages with a loop, e.g. `for (const [type, key] of [['openSettings','openSettings'],['manageApiKeys','manageApiKeys']] as const) { ... }`, building deps with `{ [key]: seam }`. Cases per message:

   (a) 'calls the seam exactly once and posts nothing; loaded state intact so a following save works': write defaultConfigJson(), start, send `ready`, capture `loaded` (messages.length === 1), count seam calls; send `{ type }`; assert calls === 1, messages.length still 1, logs contain no 'unrecognised'. Then edit planner model on the loaded form and send `save` with the loaded token; assert the next message is `saved` (not `saveFailed` with reason 'conflict') and the file on disk has the new model — proves doc/token were not disturbed.

   (b) 'a synchronously throwing seam is logged and posts nothing': seam = () => { throw new Error('boom-sync'); }; after `ready`, send `{ type }`; assert no new messages (in particular no `saveFailed`), exactly one log line containing 'ConfigPanelController:' and 'boom-sync'; then a `save` still yields `saved`.

   (c) 'a rejecting seam is logged and posts nothing': seam = async () => { throw new Error('boom-async'); } (or `() => Promise.reject(new Error('boom-async'))`); same assertions with 'boom-async'.

   (d) 'an unwired seam is a silent no-op': no seam in deps; after `ready`, send `{ type }`; assert messages.length unchanged and `logs` has no entry matching /unrecognised message type/ (assert logs.length unchanged).

   (e) 'works after loadFailed': no config file in dir (newDir only); send `ready` → assert single `loadFailed { kind: 'absent' }`; send `{ type }`; assert seam called once and no further messages; also with no file the seam must not trigger a load (messages.length stays 1).

   (f) 'does not trigger a load and does not touch the file': record `fs.readFileSync(configFilePath(dir),'utf8')` before and after; assert identical and that no `loaded` was re-posted.

   (g) Optional: 'seam is not called before start-independent state': sending `{ type }` before any `ready` still calls the seam once and posts nothing.

   Also add a compile-time check that the union accepts the new literals simply by sending them via `webview.send({ type: 'openSettings' })` (typed as ConfigPanelWebviewToHost). Keep the seam signatures typed as returning `void` / `Promise<void>`.

   Files: `test/configPanel.controller.test.ts`

## Risks

- If the seam call is not wrapped in its own try/catch (both sync and async), the error propagates to start()'s `.catch`, which posts `saveFailed` — violating the contract. The helper must `await` inside the try.
- Calling a seam extracted from deps without `this` binding could break method-style seams; use `seam.call(this.deps)` or call through `this.deps.x()`.
- Adding variants to `ConfigPanelWebviewToHost` could break any exhaustive switch/`never` check elsewhere; grep found only the controller and provider consuming it (the provider just forwards), so the risk is low — run `tsc` to confirm.
- Tests that assert exact log counts may be brittle if load/save emit logs; compare log arrays before and after sending the seam message rather than asserting absolute counts.
- Do not drift into the local-config (config.local.json) changes in this phase; RESET_CONFIRM_MESSAGE etc. stay as-is here so existing tests remain green.

## Acceptance

- `ConfigPanelWebviewToHost` in src/config/configPanel.ts includes `{ type: 'openSettings' }` and `{ type: 'manageApiKeys' }` with doc comments; `ConfigPanelHostToWebview` is unchanged; the file still has no `vscode`/Node imports.
- `ConfigPanelControllerDeps` has optional `openSettings?(): Promise<void> | void` and `manageApiKeys?(): Promise<void> | void`, documented; the controller still imports no `vscode`.
- `handle()` has `case 'openSettings'` and `case 'manageApiKeys'`; each calls its seam once if present, logs sync throws and rejections with a `ConfigPanelController:` prefix, posts nothing, triggers no load, and leaves doc/token/form/writing untouched; an absent seam produces no post and no 'unrecognised message type' log. The class doc comment lists the new messages.
- New tests in test/configPanel.controller.test.ts cover, for both messages: called exactly once, nothing posted, subsequent save succeeds with the loaded token, sync throw logged with no post, rejection logged with no post, unwired no-op with no unrecognised log, works after `loadFailed`, and the config file is untouched.
- `npm run compile` (tsc -p ./) succeeds with no type errors.
- `npm run lint` passes for the changed files.
- `npm run test:unit` passes, including the full existing test/configPanel.controller.test.ts, test/configPanel.view.test.ts, test/configPanel.mirror.test.ts and test/activation.gating.test.ts suites, plus `npm run test:property` stays green.
