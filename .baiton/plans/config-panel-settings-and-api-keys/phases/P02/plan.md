# Plan P02

## Steps

1. Add optional seams to RegisterConfigPanelDeps

   In src/activation/configPanel.ts, extend `export interface RegisterConfigPanelDeps` (currently ends with `log` and `applyConfig?`) with two optional members, each with a JSDoc in the style of the existing `getCapabilities` comment:

     /**
      * Opens VS Code Settings filtered to the Baiton orchestrator settings. Optional: a caller
      * that omits it (test/configPanel.view.test.ts) gets a silent no-op for the panel's
      * "More settings…" button. `src/extension.ts` binds it to
      * `workbench.action.openSettings` with `${SETTINGS_NS}.orchestrator`.
      */
     openSettings?(): Promise<void> | void;
     /**
      * Runs the provider API-key flow (`baiton.setProviderApiKey` with no argument). Optional;
      * omitted → silent no-op. A rejection is logged by the controller and never changes panel state.
      */
     manageApiKeys?(): Promise<void> | void;

   No other import changes are needed (the file already imports vscode).

   Files: `src/activation/configPanel.ts`

2. Pass the seams into the ConfigPanelController in ensureController

   In `registerConfigPanel` → `ensureController`, inside the `new ConfigPanelController({ ... })` object, after `applyConfig: ...` and before `log: deps.log`, add (late-bound so `this` on deps is preserved and undefined stays undefined):

         openSettings:
           deps.openSettings !== undefined ? () => deps.openSettings!() : undefined,
         manageApiKeys:
           deps.manageApiKeys !== undefined ? () => deps.manageApiKeys!() : undefined,

   The controller (P01) already declares `openSettings?(): Promise<void> | void` and `manageApiKeys?()` on `ConfigPanelControllerDeps` and handles `case 'openSettings'` / `case 'manageApiKeys'` via `invokeSeam`, which treats undefined as a no-op and logs throws/rejections — do not touch src/activation/configPanelController.ts.

   Files: `src/activation/configPanel.ts`

3. Widen the config watcher to config.local.json

   In the same `ensureController`, change `const pattern = new vscode.RelativePattern(baitonDir, 'config.json');` to `new vscode.RelativePattern(baitonDir, '{config.json,config.local.json}');` so create/change/delete of either the committed baseline or the local file schedules the existing debounced `notifyExternalChange()` (keep the single watcher, the `schedule` closure and `EXTERNAL_CHANGE_DEBOUNCE_MS` unchanged). Update the `EXTERNAL_CHANGE_DEBOUNCE_MS` doc comment to say `.baiton/config.json or .baiton/config.local.json`. Do not add any import from src/config here (no `localConfigFilePath` dependency; the glob literal is enough). Keep a single `createFileSystemWatcher` call so the existing 'a second resolve does not create a second watcher' test (watcherCount === 1) still holds.

   Files: `src/activation/configPanel.ts`

4. Wire both seams in src/extension.ts

   At the `registerConfigPanel({ ... })` call (~line 238), after `applyConfig: scopedApplyConfig,` add:

         // Toolbar buttons. The panel is registered ahead of the activation gate, but
         // `baiton.setProviderApiKey` is only registered inside `registerCommands`, so in an
         // uninitialised folder or after a failed activation `executeCommand` rejects; the
         // controller logs that and the panel stays usable. Same settings target as the Chat
         // view's inline-error "open settings" fix (`triggerFix` in activation/commands.ts).
         openSettings: async () => {
           await vscode.commands.executeCommand(
             'workbench.action.openSettings',
             `${SETTINGS_NS}.orchestrator`,
           );
         },
         manageApiKeys: async () => {
           await vscode.commands.executeCommand(COMMANDS.setProviderApiKey);
         },

   `SETTINGS_NS` is already a module const in src/extension.ts (line 88, value 'baiton') and `COMMANDS` is already imported from './activation/commands' — no new imports. The `async () => { await ... }` form adapts `Thenable<unknown>` to `Promise<void>`. Pass no argument to setProviderApiKey so the user gets the provider quick pick. Keep the existing order/contents of the call otherwise (getCapabilities/onDidChangeCapabilities/capabilities regexes in the gating test must still match). Also, if any user-facing string in extension.ts in this area names `.baiton/config.json` as the file the panel edits, leave comments about the baseline alone; there is none required to change in this phase.

   Files: `src/extension.ts`

5. Provider pass-through tests in configPanel.view.test.ts

   In the `describe('Config Panel view and reveal command ', ...)` block of test/configPanel.view.test.ts add tests modelled on 'a second resolve does not create a second watcher or controller' (same `__vscodeFake` shape: window.registerWebviewViewProvider capturing the provider, showWarningMessage, commands.executeCommand, workspace.createFileSystemWatcher returning onDidCreate/onDidChange/onDidDelete/dispose stubs). Use a fresh temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-cfgpanel-'))`, import `os`; remove it in a finally with fs.rmSync recursive/force) as `resolveBaitonDir` so the load is deterministic.

   1. 'passes openSettings and manageApiKeys through to the controller': register with `openSettings: () => { openCalls++; }` and `manageApiKeys: async () => { keyCalls++; }` and a `log` collecting lines; resolve with `makeFakeWebviewView()`; capture `posted.length` after letting the initial load settle (`await new Promise(r => setTimeout(r, 20))`); then invoke each `messageListeners[0]({ type: 'openSettings' })` / `({ type: 'manageApiKeys' })`, settle again; assert openCalls === 1, keyCalls === 1, no new posts (posted.length unchanged, in particular no `saveFailed`), and no log line containing 'unrecognised message type'.
   2. 'omitting the seams is harmless': register without them, resolve, send both messages; assert no throw, no new posts, no 'unrecognised message type' log.
   3. 'a rejecting manageApiKeys seam is logged, not posted': `manageApiKeys: async () => { throw new Error('command not found'); }`; send message; assert a log line matching /ConfigPanelController: manageApiKeys failed: command not found/ and no new posts.
   4. 'the watcher covers config.json and config.local.json': in the fake, capture the pattern passed to createFileSystemWatcher (the vscodeFake RelativePattern class stores base/pattern — inspect test/fixtures/vscodeFake.mjs lines ~55-75 for the field name, or provide `RelativePattern` on the fake that records its args); assert the glob matches both names (e.g. pattern string equals '{config.json,config.local.json}').

   Do NOT add `more-settings` / `manage-api-keys` buttons to the fake DOM or click tests here unless media/config.html already contains them — the webview buttons are a separate phase; if they already exist in media/config.html, add `make('more-settings','button'); make('manage-api-keys','button');` next to `make('reset','button')` (~line 638) so the shell stays consistent.

   Files: `test/configPanel.view.test.ts`

6. Gating test assertions on the registerConfigPanel call text

   In test/activation.gating.test.ts, `describe('config panel live catalog wiring ', ...)` already extracts the balanced `call` text. Add two `it`s:

     it('wires openSettings to workbench.action.openSettings filtered to the orchestrator settings', () => {
       assert.match(call, /openSettings:/);
       assert.match(call, /executeCommand\(\s*'workbench\.action\.openSettings',\s*`\$\{SETTINGS_NS\}\.orchestrator`\s*,?\s*\)/);
     });
     it('wires manageApiKeys to baiton.setProviderApiKey with no argument', () => {
       assert.match(call, /manageApiKeys:/);
       assert.match(call, /executeCommand\(\s*COMMANDS\.setProviderApiKey\s*\)/);
     });

   Also assert `SETTINGS_NS` in src/extension.ts is `'baiton'` (e.g. /const SETTINGS_NS = 'baiton';/ on `source`). Extend the file-header bullet 'Config panel live catalog wiring' to mention the two toolbar seams.

   Files: `test/activation.gating.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint`, `npx mocha --no-config --require ts-node/register test/configPanel.view.test.ts test/activation.gating.test.ts test/configPanel.controller.test.ts test/configPanel.mirror.test.ts --reporter dot` (check .mocharc for the loader if the view test needs `vscodeLoader.mjs`; otherwise use plain `npx mocha <files>`), then `npm run test:unit`.

   Files: (none)

## Risks

- The view test's initial load reads the resolveBaitonDir directory asynchronously; asserting 'no new posts' must snapshot posted.length only after the load has settled, otherwise a late `loadFailed`/`loaded` looks like a post caused by the seam.
- The vscodeFake RelativePattern may not expose the pattern under an obvious field; the executor should read test/fixtures/vscodeFake.mjs (~line 55) or supply `RelativePattern` on the fake to capture args.
- Watcher widening overlaps the overview's provider section; if a later phase also edits the pattern it should be a no-op. Do not import localConfigFilePath (it does not exist yet in src/config).
- The gating regexes rely on exact formatting of the executeCommand calls in extension.ts; keep the template literal `${SETTINGS_NS}.orchestrator` and `COMMANDS.setProviderApiKey` spelled exactly and keep existing getCapabilities/onDidChangeCapabilities/capabilities lines unchanged.
- executeCommand for baiton.setProviderApiKey rejects before activation completes; this is expected and handled by the controller's invokeSeam logging — do not add try/catch or a showErrorMessage in extension.ts.

## Acceptance

- RegisterConfigPanelDeps has optional `openSettings?(): Promise<void> | void` and `manageApiKeys?(): Promise<void> | void`, and ensureController passes them to ConfigPanelController (undefined when absent).
- src/extension.ts registerConfigPanel call passes openSettings → executeCommand('workbench.action.openSettings', `${SETTINGS_NS}.orchestrator`) and manageApiKeys → executeCommand(COMMANDS.setProviderApiKey) with no argument, with a comment explaining the pre-gate rejection case; no new commands, settings or package.json changes.
- The config watcher pattern covers both config.json and config.local.json with a single watcher.
- src/activation/configPanelController.ts, src/config/configPanel.ts and src/activation/setApiKey.ts are not modified.
- New view tests: seams invoked exactly once per message with no posts and no 'unrecognised message type' log; omitted seams are harmless; a rejecting seam is logged with the `ConfigPanelController:` prefix and posts nothing; watcher pattern covers both files.
- New gating tests assert both seams wired to the expected commands in the registerConfigPanel call text.
- `npm run compile`, `npm run lint` (no new warnings) and `npm run test:unit` pass, including configPanel.mirror, configPanel.controller, configPanel.view and activation.gating suites.
