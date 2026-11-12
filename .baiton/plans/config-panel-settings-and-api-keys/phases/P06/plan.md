# Plan P06

## Steps

1. Rewrite readConfigDocument to return the merged two-layer document with a local-file token

   In src/config/configDocument.ts change the import to `import { DirLike, configFilePath, localConfigFilePath, mergeConfigLayers, writeJsonAtomic } from './loadConfig';` (localConfigFilePath and mergeConfigLayers already exist and are exported from loadConfig.ts from earlier phases).

   Add a private helper `readLayerText(p: string): Promise<Result<string | undefined, ConfigDocumentError>>` that returns ok(undefined) on ENOENT (isNotFound), err({ kind: 'io', path: p, message: `Could not read configuration at ${p}: ${describe(e)}.` }) on any other read error, ok(text) otherwise. Add a private helper `parseLayer(p, text): Result<Record<string, unknown>, ConfigDocumentError>` that returns the existing `unparseable` errors ("Configuration at ${p} is not valid JSON: ..." / "Configuration at ${p} must be a JSON object.") with `path: p` — i.e. the error always names the exact file that failed.

   Add an optional field to `ConfigDocument`: `baselineToken?: string` documented as "configToken of the committed `.baiton/config.json` baseline at read time, ABSENT_TOKEN when it does not exist; set by readConfigDocument only (writeConfigDocument never reads or writes the baseline)". Update the `ConfigDocument` doc comment: `path` is always the local file, `text` is the exact local-file text ('' when only the baseline exists), `doc` is the merged effective document, `token` is configToken(local text) or ABSENT_TOKEN when the local file is absent.

   New readConfigDocument(baitonDir):
   1. `const localPath = localConfigFilePath(baitonDir); const baselinePath = configFilePath(baitonDir);`
   2. Read the baseline text first, then the local text (both via readLayerText; return the io error as-is).
   3. If both are undefined → err({ kind: 'absent', path: localPath, message: `No configuration found at ${localPath} or ${baselinePath}. Run "Baiton: Initialize" first.` }) (same wording as loadConfig's absent message).
   4. Parse the baseline (if present) then the local (if present) with parseLayer; return the first error (baseline first, matching loadConfig's order).
   5. `doc` = baseline only → baseline object; local only → local object; both → mergeConfigLayers(baseline, local) (local wins; objects merge key-by-key; arrays/scalars replaced; unknown keys from either side preserved).
   6. return ok({ path: localPath, text: localText ?? '', doc, token: localText === undefined ? ABSENT_TOKEN : configToken(localText), baselineToken: baselineText === undefined ? ABSENT_TOKEN : configToken(baselineText) }).

   Also export `readBaselineToken(baitonDir): Promise<Result<string, ConfigDocumentError>>` — same shape as readConfigToken but over configFilePath(baitonDir) (ABSENT_TOKEN on ENOENT, io error naming the baseline path otherwise). Used only by the controller's external-change check.

   Update the module header comment: the panel reads the committed baseline and the gitignored `.baiton/config.local.json` overlay, shows the merged result, and only ever writes the local file; the token guards the local file.

   Files: `src/config/configDocument.ts`

2. Point readConfigToken and writeConfigDocument at config.local.json

   In src/config/configDocument.ts: `readConfigToken` uses `localConfigFilePath(baitonDir)` instead of `configFilePath` (ABSENT_TOKEN when the local file is missing, even if a baseline exists). `writeConfigDocument` uses `const p = localConfigFilePath(baitonDir);` for the token check, the conflict error (`path: p`, message `${p} changed on disk since it was loaded. ...` — wording otherwise unchanged), the `writeJsonAtomic(p, value)` call and the returned ConfigDocument (`path: p`, no baselineToken). Keep the expectedToken semantics exactly (ABSENT_TOKEN succeeds only while the local file is missing; a baseline's existence is irrelevant). Do not mkdir here (reset already creates the directory; a baseline or local file implies `.baiton/` exists). Update the doc comments of both functions to say `<baitonDir>/config.local.json` and that `<baitonDir>/config.json` is never written. After this step `configFilePath` is only used in configDocument.ts for reading the baseline.

   Files: `src/config/configDocument.ts`

3. Controller: reset to the local file, local-file messages, baseline-aware external-change detection

   In src/activation/configPanelController.ts:
   - Import `localConfigFilePath` (and `configFilePath`, still needed for the canReset check below) from '../config/loadConfig', and `readBaselineToken` from '../config/configDocument'.
   - `RESET_CONFIRM_MESSAGE` = 'Reset .baiton/config.local.json to the Baiton defaults? The current contents, including any keys the panel does not manage, are discarded. A committed .baiton/config.json is not changed.'
   - `ACTIVATION_VALUES_NOTE` = 'New values were written to .baiton/config.local.json; components that read the configuration at activation keep their current values until the window is reloaded.'
   - Add a private field `private baselineToken: string | undefined;`. In `load()`: on error set `this.baselineToken = undefined` next to doc/token; on success set `this.baselineToken = read.value.baselineToken`. Saves do NOT change it (they never touch the baseline).
   - In `load()` error branch for `kind === 'unparseable'`: `canReset: read.error.path !== configFilePath(this.deps.baitonDir)` — a corrupt local file can be fixed by Reset (it overwrites the local file), a corrupt committed baseline cannot (Reset would write the local file and the next load would still fail on the baseline). `absent` stays canReset: true; io stays kind 'invalid', canReset false.
   - In `reset()`: replace `configFilePath(this.deps.baitonDir)` with `localConfigFilePath(this.deps.baitonDir)` for the mkdir (rename local var to `localPath`); the subsequent `writeConfigDocument(..., defaultConfig(), undefined)` already targets the local file after step 2. Update the inline comment accordingly.
   - `notifyExternalChange()`: after the existing writing/disposed guards, read `const current = await readConfigToken(dir)` and `const baseline = await readBaselineToken(dir)`; re-check disposed/writing; if either is an error, log `ConfigPanelController: error reading config token: ${message}` and return; if `current.value === this.token && (this.baselineToken === undefined || baseline.value === this.baselineToken)` return; otherwise post `{ type: 'externalChange', token: current.value }` (the token is always the LOCAL token, because it is what the next save's expectedToken is checked against). Do not update this.token or this.baselineToken here. Update its doc comment: it is called when `.baiton/config.local.json` or the committed `.baiton/config.json` may have changed; a baseline-only change is reported with the unchanged local token.
   - `save()`: no logic change; base documents come from readConfigDocument (the merged effective doc), so the full effective document is written to the local file. `applySaved()` keeps calling `loadConfig` (merged validation). Update the class doc / comments that mention `.baiton/config.json` to say the panel edits `.baiton/config.local.json` and never writes `.baiton/config.json`.
   - Leave the openSettings/manageApiKeys seams and invokeSeam exactly as they are.

   Files: `src/activation/configPanelController.ts`

4. Provider: confirm watcher covers both files; doc touch-ups only

   src/activation/configPanel.ts already watches `new vscode.RelativePattern(baitonDir, '{config.json,config.local.json}')` and passes openSettings/manageApiKeys through; do not change behaviour. Only update any comment that still implies the panel edits `config.json` (e.g. add to the watcher comment: 'a change to the local file the panel edits, or to the committed baseline, schedules notifyExternalChange()'). If nothing needs rewording, leave the file untouched.

   Files: `src/activation/configPanel.ts`

5. Relabel the panel's config path

   In media/config.html change `<span id="config-path">.baiton/config.json</span>` to `<span id="config-path">.baiton/config.local.json</span>`. Change nothing else in the HTML (no buttons, CSP, nonce or placeholders in this phase). Do not touch media/config.js.

   Files: `media/config.html`

6. Update and extend test/configPanel.document.test.ts

   Import `localConfigFilePath`, `configFilePath` from loadConfig and `readBaselineToken` from configDocument. Replace the `config.json` write helper with two helpers: `writeLocal(dir, text)` (writes localConfigFilePath) and `writeBaseline(dir, text)` (writes configFilePath). Convert existing cases so the file under test is the local file: absent case asserts `error.path === localConfigFilePath(dir)` and the message includes both localConfigFilePath(dir) and configFilePath(dir); unparseable / non-object cases write the local file and assert the message names the local path; the valid-read case asserts `path === localConfigFilePath(dir)` and `text` equals the local file bytes; the EISDIR io case creates a directory at `config.local.json`; readConfigToken and writeConfigDocument cases read/write `config.local.json` (conflict message includes localConfigFilePath; `fs.readdirSync(dir)` after a refused write equals ['config.local.json']).
   New cases:
   - baseline-only: readConfigDocument returns doc deep-equal to the baseline, token === ABSENT_TOKEN, text === '', baselineToken === configToken(baselineText), path === local path; no local file is created.
   - both layers: local scalar wins, nested objects merge (e.g. baseline git.remote kept when local only sets git.base), local array replaces baseline array, unknown top-level keys from both sides preserved; token === configToken(localText).
   - corrupt local + valid baseline → unparseable with path/message naming the local file; corrupt baseline + valid local → unparseable naming the baseline file.
   - readConfigToken returns ABSENT_TOKEN when only the baseline exists; readBaselineToken returns configToken(baselineText) / ABSENT_TOKEN.
   - writeConfigDocument with expectedToken ABSENT_TOKEN succeeds when only a baseline exists, creates config.local.json, and leaves config.json byte-for-byte identical; overwrite (no expectedToken) also leaves config.json untouched.
   - end-to-end: baseline + local, apply a form via applyFormToDocument onto readConfigDocument's doc, writeConfigDocument, loadConfig accepts the result, baseline bytes unchanged.

   Files: `test/configPanel.document.test.ts`

7. Update and extend test/configPanel.controller.test.ts

   Change the `writeConfigFile` helper to write `localConfigFilePath(dir)` and add a `writeBaselineFile(dir, text)` helper writing `configFilePath(dir)`. Replace every `path.join(dir, 'config.json')` / `configFilePath(dir)` read in assertions that check what the panel wrote (lines ~241, 299, 329, 355, 369, 403, 412, 430, 719, 785, 1308, 1327, 1345, 1384–1388) with `localConfigFilePath(...)`. Keep RESET_CONFIRM_MESSAGE / ACTIVATION_VALUES_NOTE assertions referencing the constants, and add one assertion that both contain '.baiton/config.local.json'.
   New cases (a new describe, e.g. '11. local overlay'):
   - baseline-only workspace: ready → loaded with token ABSENT_TOKEN and the baseline's form; save with that token writes config.local.json containing the full effective document (including unknown baseline keys) and config.json bytes are unchanged; posts saved.
   - both layers: loaded form reflects the merge (local wins); save writes local only; baseline unchanged.
   - conflict: after load, externally rewrite config.local.json; save with the stale token → saveFailed conflict whose message includes localConfigFilePath(dir); baseline unchanged; overwrite then succeeds and still leaves the baseline unchanged.
   - reset accepted with a custom baseline present: config.local.json === defaultConfigJson(), config.json byte-for-byte unchanged; reset into a nonexistent dir creates config.local.json and no config.json.
   - external changes: editing config.local.json posts externalChange with the new local token; editing only config.json (local unchanged) posts externalChange with the unchanged local token; a byte-identical rewrite of either posts nothing; deleting the baseline in a baseline-only workspace posts externalChange with ABSENT_TOKEN and the following load is loadFailed absent canReset true; a write in flight (own save) is still suppressed.
   - corrupt baseline → loadFailed { kind: 'unparseable', canReset: false } naming config.json; corrupt local → loadFailed { kind: 'unparseable', canReset: true } naming config.local.json.
   Keep section 10 (openSettings/manageApiKeys) passing; only adjust its file-path reads to the local file.

   Files: `test/configPanel.controller.test.ts`

8. Extend test/configPanel.view.test.ts

   Add a case that reads media/config.html (`fs.readFileSync(path.join(__dirname, '..', 'media', 'config.html'), 'utf8')`) and asserts it contains `<span id="config-path">.baiton/config.local.json</span>` and does not contain `>.baiton/config.json<`. If any provider-level test writes a config fixture to `config.json` and then asserts on what a save wrote, switch the assertion to config.local.json (a baseline-only fixture still loads). Keep the existing watcher-pattern test ('{config.json,config.local.json}') and the seam pass-through tests unchanged.

   Files: `test/configPanel.view.test.ts`

9. Verify

   Run `npm run compile`; `npx mocha --no-config --require ts-node/register --node-option no-strip-types --reporter dot test/configPanel.*.test.ts test/config.test.ts test/config.overlay.test.ts test/config.gitignore.test.ts test/activation*.test.ts`; `npx eslint` on the changed src/test files; `git diff --check`. Then grep: `rg -n "configFilePath\(" src` must show uses only in loadConfig.ts (read) and configDocument.ts readConfigDocument/readBaselineToken (read) and the controller's canReset comparison — no write path; `rg -n "writeJsonAtomic|writeConfigDocument" src` must show every write target is localConfigFilePath / the migration's localPath. Run the full `npm test` if time allows.

   Files: (none)

## Risks

- Webview draft restore: media/config.js restores the persisted draft on `loaded` when persisted.token === token. A baseline-only edit while the local file is absent (token stays ABSENT_TOKEN) makes a pristine panel reload but then restore its old persisted form, so the new baseline values may not show until the panel is reopened. Fixing it needs a config.js change outside this phase's file list; do not edit config.js here — note it in the execution summary. When a local file exists it holds the full effective document, so baseline edits are shadowed anyway (accepted shadowing).
- Many existing controller/document tests write fixtures to config.json via a shared helper; switching the helper to config.local.json changes which file every assertion targets — missing one assertion leaves a test that reads the untouched baseline and fails (or, worse, passes vacuously). Grep the test files for 'config.json' after editing.
- The absent-case message now names both files; any test asserting an exact absent message string (rather than `includes`) must be updated.
- ConfigDocument gains an optional `baselineToken`; tests that deepStrictEqual a whole ConfigDocument returned by readConfigDocument must include it (writeConfigDocument's result omits it).
- Changing canReset for a corrupt baseline to false is a deliberate behaviour change; if any existing test asserts canReset true for an unparseable config.json fixture, rewrite that fixture as config.local.json (expected true) and add the baseline case (expected false).
- notifyExternalChange now does two reads; keep the disposed/writing re-check after both awaits so the own-write suppression still holds.

## Acceptance

- readConfigDocument returns the merged document (local wins, objects deep-merged, arrays/scalars replaced, unknown keys from both preserved), path = .baiton/config.local.json, token = configToken(local text) or ABSENT_TOKEN when only the baseline exists, and absent only when neither file exists.
- Parse errors from readConfigDocument name the exact file that failed (local or baseline).
- readConfigToken and writeConfigDocument read/write only .baiton/config.local.json; expectedToken conflict behaviour and atomic write are unchanged; .baiton/config.json is byte-for-byte unchanged after every save, overwrite and reset in tests.
- Reset writes defaultConfigJson() to config.local.json (creating .baiton/ when needed) and never creates or modifies config.json.
- RESET_CONFIRM_MESSAGE, ACTIVATION_VALUES_NOTE and conflict messages name .baiton/config.local.json.
- notifyExternalChange posts externalChange (with the local token) for a change to either config.local.json or config.json, and stays silent for own writes and byte-identical rewrites.
- The provider watcher pattern remains '{config.json,config.local.json}' and the openSettings/manageApiKeys seam tests still pass.
- media/config.html's #config-path reads .baiton/config.local.json; media/config.js is unchanged.
- npm run compile, the configPanel.*, config*, and activation* mocha suites (including mirror tests), eslint on changed files, and git diff --check all pass.
