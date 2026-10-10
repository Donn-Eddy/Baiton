# Plan T10

## Steps

1. Context: what already exists (do not rewrite)

   The host-free core is complete: src/usage/index.ts exports createUsageReaders(seams: UsageReaderTableSeams) (seams: resolveExecutable(cli: 'claude'|'codex'|'agy'), runCommand(exe,args,signal,timeoutMs) -> {code,stdout}, spawnProcess(exe,args) -> CodexUsageProcess, readCodexLatestRollout(signal) -> string|undefined, fetchJson(url,{headers,signal}) -> {status, body, headers?}, credentials.{claude,codex,opencodeGo}() -> string|undefined, isTrusted(), log()); it already guards credential reads and fetch behind isTrusted and redacts logs. src/usage/usageService.ts exports UsageService({readers, now?, timer?, timeoutMs?, isTrusted?, log?}) with refresh/snapshot/onDidChange/startPolling/stopPolling/dispose, and normaliseRefreshIntervalSeconds (default 300, min 30, max 86400). src/activation/usageViewController.ts exports UsageViewController({webview:{post,onMessage}, service, getRefreshIntervalSeconds, isTrusted, now?, log}) with start(), setVisible(bool), refresh(), notifyIntervalChanged(), notifyTrustChanged(), dispose() (dispose also disposes the service). media/usage.html (placeholders ${nonce}, ${cspSource}, ${baseUri}) and media/usage.js (posts {type:'ready'} and {type:'refresh'}) exist. README already has '### Usage view (per-tool probe findings)'. T10 adds ONLY the vscode glue, real Node seams, package.json contributions, extension.ts wiring, tests for the glue, and README view/command/setting docs. No file under src/usage/ needs to change.

   Files: (none)

2. Add real Node seams: src/activation/usageViewSeams.ts

   New file, Node-only (fs, fs/promises, path, os, child_process; NO vscode import so it is unit-testable without the loader). Exports:
   - `USAGE_CLI_AGENT: Readonly<Record<UsageCliName, AgentId>> = { claude: 'claude', codex: 'codex', agy: 'antigravity' }` (import UsageCliName from '../usage', AgentId from '../adapter').
   - `USAGE_NEUTRAL_CWD = () => os.tmpdir()` (spawned CLIs never run in the workspace).
   - `nodeRunCommand(executable, args, signal, timeoutMs): Promise<UsageCommandResult>`: child_process.spawn(executable, [...args], { cwd: os.tmpdir(), shell: false, stdio: ['ignore','pipe','pipe'], windowsHide: true }); accumulate stdout (cap ~1 MiB, kill on overflow); kill('SIGTERM') on signal abort and on a setTimeout(timeoutMs) (clear it on close); resolve {code, stdout} on 'close'; reject on 'error' (preserve err.code e.g. ENOENT). If signal already aborted, reject immediately without spawning.
   - `nodeSpawnProcess(executable, args): CodexUsageProcess`: spawn(executable, [...args], { cwd: os.tmpdir(), shell: false, stdio: ['pipe','pipe','pipe'], windowsHide: true }) cast to CodexUsageProcess (same pattern as defaultSpawnAppServer in src/adapter/codex.ts). The codex reader owns killing it.
   - `codexHomeDir(env = process.env, home = os.homedir())`: $CODEX_HOME if non-empty else ~/.codex.
   - `opencodeDataDir(env, home)`: $XDG_DATA_HOME/opencode if set else ~/.local/share/opencode.
   - `readTextIfExists(file): Promise<string|undefined>`: fsp.readFile utf8; ENOENT/ENOTDIR -> undefined; other errors rethrow (reader turns them into a reason). Bound size (stat first; > 1 MiB -> throw Error('file too large')).
   - `nodeReadCodexLatestRollout(signal, root = path.join(codexHomeDir(), 'sessions'))`: walk year dirs descending (numeric names only), months descending, days descending; in the first day dir containing any `rollout-*.jsonl`, pick the newest by mtimeMs and return its text (read only the trailing 2 MiB if larger, starting at a line boundary). Check signal.aborted between directory steps and bail with undefined. Return undefined when no sessions dir/no file. Read-only.
   - `nodeFetchJson: UsageFetchJson`: uses `(globalThis as {fetch?: ...}).fetch` defensively (lib is ES2022, so declare a minimal local type as src/orchestrator/modelsDev.ts does); throw Error('fetch is unavailable in this runtime') if absent; call with { method: 'GET', headers, signal }; read text, JSON.parse (non-JSON -> body = undefined); return { status, body, headers: lower-cased object from response.headers.forEach }. Never log or include headers/URL query in thrown messages.
   - `createNodeUsageSeams(opts: { resolveExecutable(cli: UsageCliName): string|undefined; isTrusted(): boolean; log(m: string): void; env?: NodeJS.ProcessEnv; home?: string }): UsageReaderTableSeams` returning { resolveExecutable, runCommand: nodeRunCommand, spawnProcess: nodeSpawnProcess, readCodexLatestRollout, fetchJson: nodeFetchJson, credentials: { claude: () => readTextIfExists(claudeCredentialsPath()) (import from '../adapter/claude'), codex: () => readTextIfExists(path.join(codexHomeDir(env,home),'auth.json')), opencodeGo: () => readTextIfExists(path.join(opencodeDataDir(env,home),'auth.json')) }, isTrusted, log }. Credential text is returned to the reader only; nothing here logs or caches it. Nothing in this file writes any file.

   Files: `src/activation/usageViewSeams.ts`

3. Add the WebviewView provider and registration: src/activation/usageView.ts

   Mirror src/activation/configPanel.ts. Exports:
   - `USAGE_VIEW_ID = 'baiton.usageView'`, `USAGE_VIEW_FOCUS_COMMAND = USAGE_VIEW_ID + '.focus'`, `USAGE_REFRESH_COMMAND = 'baiton.usage.refresh'`, `USAGE_SETTINGS_SECTION = 'baiton'`, `USAGE_REFRESH_INTERVAL_KEY = 'usage.refreshIntervalSeconds'`.
   - `class UsageViewProvider implements vscode.WebviewViewProvider, UsageViewWebview, vscode.Disposable` (constructor(extensionUri)). `static registration = { webviewOptions: { retainContextWhenHidden: true } }`. post(msg) buffers into `pending` until a view exists, then webview.postMessage (void). onMessage(handler) stores the raw handler (UsageViewController validates). onResolve(handler: (view) => void), onVisibilityChange(handler: (visible:boolean)=>void), onViewDisposed(handler). resolveWebviewView(view): set view; webview.options = { enableScripts: true, localResourceRoots: [joinPath(extensionUri,'media')] }; webview.html = renderHtml (read media/usage.html, replace ${nonce} with crypto.randomBytes(16).toString('hex'), ${cspSource}, ${baseUri} exactly like configPanel); subscribe onDidReceiveMessage -> handler (swallow promise rejections), view.onDidChangeVisibility -> visibilityHandler(view.visible), view.onDidDispose -> { this.view = undefined; pending = []; viewDisposedHandler() }; flushPending(); resolveHandler(view). dispose(): dispose subscriptions, view = undefined.
   - `interface RegisterUsageViewDeps { extensionUri: vscode.Uri; log(m: string): void; resolveExecutable(cli: UsageCliName): string|undefined; createReaders?: (seams: UsageReaderTableSeams) => Readonly<Record<UsageToolId, UsageReader>> (default createUsageReaders); createSeams?: (o) => UsageReaderTableSeams (default createNodeUsageSeams) ; now?(): number; timer?: UsageTimer }` (the optional ones are test seams).
   - `registerUsageView(deps): vscode.Disposable`:
     * `isTrusted = () => vscode.workspace.isTrusted === true` (try/catch -> false).
     * `getInterval = () => vscode.workspace.getConfiguration(USAGE_SETTINGS_SECTION).get<unknown>(USAGE_REFRESH_INTERVAL_KEY)`.
     * `let controller: UsageViewController | undefined`. `ensureController(view)`: if controller exists, return; else build seams = createSeams({resolveExecutable: deps.resolveExecutable, isTrusted, log}), readers = createReaders(seams), service = new UsageService({ readers, isTrusted, log, now, timer }), controller = new UsageViewController({ webview: provider, service, getRefreshIntervalSeconds: getInterval, isTrusted, now, log }); controller.start(); controller.setVisible(view.visible). NOTHING (seams, readers, service, timer) is constructed before the first resolveWebviewView, i.e. before the view is first expanded.
     * provider.onVisibilityChange(v => controller?.setVisible(v)).
     * provider.onViewDisposed(() => { controller?.dispose(); controller = undefined; }) — disposes the service and its poll timer with the view.
     * `vscode.workspace.onDidGrantWorkspaceTrust(() => controller?.notifyTrustChanged())`.
     * `vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('baiton.usage.refreshIntervalSeconds')) controller?.notifyIntervalChanged(); })`.
     * `vscode.commands.registerCommand(USAGE_REFRESH_COMMAND, async () => { if (controller) { await controller.refresh(); return; } try { await vscode.commands.executeCommand(USAGE_VIEW_FOCUS_COMMAND); } catch { deps.log('Baiton: the Usage view is not available.'); } })` — focusing an unexpanded view resolves it, which triggers the first read; it never reads without the view.
     * Return vscode.Disposable.from(registerWebviewViewProvider(USAGE_VIEW_ID, provider, UsageViewProvider.registration), provider, the trust/config/command subscriptions, { dispose: () => { controller?.dispose(); controller = undefined; } }).
     Keep a file header comment in the repo's style naming spec first-party-usage, todo T10.

   Files: `src/activation/usageView.ts`

4. Wire into activation: src/extension.ts (+ COMMANDS)

   In activate(), right after the registerConfigPanel(...) push and registerConfigPanelCommand() push (ahead of the activation gate, so the view works in an uninitialised folder and in Restricted Mode), add:
   ```ts
   context.subscriptions.push(
     registerUsageView({
       extensionUri: context.extensionUri,
       log: (m) => surface.log(m),
       resolveExecutable: resolveUsageCli,
     }),
   );
   ```
   and define module-level `const resolveUsageCli = (cli: UsageCliName): string | undefined => { const agent = USAGE_CLI_AGENT[cli]; const r = resolveExecutable(agent, AGENT_BINARY[agent], pathLookup, settingsOverride); return isErr(r) ? undefined : r.value.path; };` placed after the `settingsOverride` declaration (consts are evaluated before activate runs, fine). Import `resolveExecutable` from './activation' (exported via executable.ts), `AGENT_BINARY` from './adapter' (check it is re-exported from src/adapter/index.ts; it is imported there from './adapter', add to the existing import if exported, else import from './adapter/adapter'), `registerUsageView` from './activation/usageView', `USAGE_CLI_AGENT` from './activation/usageViewSeams', type UsageCliName from './usage'. This honours baiton.agents.<agent>.path overrides (agy -> antigravity). Optionally add `usageRefresh: 'baiton.usage.refresh'` to COMMANDS in src/activation/commands.ts and use it as USAGE_REFRESH_COMMAND's value source only if no circular import results; otherwise keep the constant in usageView.ts.

   Files: `src/extension.ts`, `src/activation/commands.ts`

5. Contribute the view, command, title button and setting: package.json

   1) contributes.views.baiton: insert `{ "id": "baiton.usageView", "name": "Usage", "type": "webview", "visibility": "collapsed" }` between baiton.runsView and baiton.configPanel (order: specExplorer, runsView, usageView, configPanel). Leave the other three entries byte-identical.
   2) contributes.commands: add `{ "command": "baiton.usage.refresh", "title": "Refresh Usage", "category": "Baiton", "icon": "$(refresh)" }`.
   3) contributes.menus: add a new `"view/title"` array with `{ "command": "baiton.usage.refresh", "when": "view == baiton.usageView", "group": "navigation" }`. Do NOT add a commandPalette `when` gate for it (it must work before baiton.activated, like baiton.openConfigPanel).
   4) contributes.configuration.properties: add `"baiton.usage.refreshIntervalSeconds": { "type": "integer", "default": 300, "minimum": 30, "maximum": 86400, "description": "How often, in seconds, the Usage view re-reads remaining usage while it is visible. Nothing is read before the view is first expanded, and polling stops when the view is hidden or closed. Values outside 30–86400 are clamped." }`. Defaults must equal DEFAULT/MIN/MAX_USAGE_REFRESH_INTERVAL_SECONDS in src/usage/usageService.ts.

   Files: `package.json`

6. Extend the vscode test fake for the new glue surface

   In test/fixtures/vscodeFake.mjs add delegating members (lazy, so existing tests that never touch them are unaffected): `commands.registerCommand: (id, cb) => fake().commands.registerCommand(id, cb)`; in `workspace`: `get isTrusted() { return fake().workspace.isTrusted; }`, `onDidGrantWorkspaceTrust: (l) => fake().workspace.onDidGrantWorkspaceTrust(l)`, `onDidChangeConfiguration: (l) => fake().workspace.onDidChangeConfiguration(l)`. Update test/fixtures/vscodeFake.d.mts declarations accordingly if it enumerates members.

   Files: `test/fixtures/vscodeFake.mjs`, `test/fixtures/vscodeFake.d.mts`

7. Update the contribution test

   In test/activation.gating.test.ts, the test 'contributes the Spec Explorer, the Runs view and the bottom Configuration section…' asserts views.baiton ids equal ['baiton.specExplorer','baiton.runsView','baiton.configPanel']; change to ['baiton.specExplorer','baiton.runsView','baiton.usageView','baiton.configPanel'] (rename the test title to mention the Usage view) and add assertions: usageView.type === 'webview', usageView.visibility === 'collapsed', name === 'Usage'. Add a test: baiton.usage.refresh is contributed (category Baiton, icon $(refresh)), appears in menus['view/title'] with when 'view == baiton.usageView' and group 'navigation', and is NOT gated in commandPalette; and a test that 'baiton.usage.refreshIntervalSeconds' is an integer setting with default 300, minimum 30, maximum 86400 matching the usageService constants.

   Files: `test/activation.gating.test.ts`

8. Glue tests: test/usageView.view.test.ts

   Pattern from test/configPanel.view.test.ts (register vscodeLoader.mjs, install globalThis.__vscodeFake, dynamic import '../src/activation/usageView'). Use a fake WebviewView with `visible` flag, onDidChangeVisibility/onDidDispose listener arrays, posted[] and messageListeners. Inject test seams via deps: `createSeams` spy, `createReaders` returning readers that count calls and resolve okReading/unavailableReading, and a FakeTimer (copy from test/usageView.controller.test.ts). Cases:
   1. USAGE_VIEW_ID === 'baiton.usageView', exists in package.json views.baiton directly before baiton.configPanel; USAGE_VIEW_FOCUS_COMMAND === id + '.focus'; USAGE_REFRESH_COMMAND is a contributed command.
   2. registerUsageView registers the provider under USAGE_VIEW_ID with retainContextWhenHidden registration, registers the refresh command, and calls createSeams/createReaders zero times, spawns nothing and starts no timer (never-before-expand).
   3. resolveWebviewView: enableScripts true, localResourceRoots length 1 ending in 'media', no unreplaced ${nonce}/${cspSource}/${baseUri}, html matches /script-src 'nonce-[0-9a-f]+'/, two resolves produce different nonces, no 'http' script src.
   4. Resolving a visible view creates the service once, reads every tool once and starts one interval (FakeTimer.setIntervalCalls == [300000] with getConfiguration returning undefined); webview 'ready' then posts state+readings with 4 rows.
   5. Visibility false stops polling (pendingIntervals 0); true restarts and re-reads.
   6. onDidDispose of the view disposes the controller: no pending intervals, later timer fires/refresh do not call readers; re-resolving creates a fresh service.
   7. Refresh command: before any resolve it calls executeCommand('baiton.usageView.focus') and invokes no reader; after resolve it triggers a read for all four tools; concurrent command + webview 'refresh' share one in-flight read per tool (reader call count 1 per tool while pending).
   8. Restricted Mode: with fake workspace.isTrusted = false, the seams object passed to createSeams has isTrusted() === false and readers receive ctx.trusted === false; firing onDidGrantWorkspaceTrust (after setting isTrusted true) triggers a re-read with trusted true and a state message with trusted: true.
   9. onDidChangeConfiguration with affectsConfiguration('baiton.usage.refreshIntervalSeconds') true and getConfiguration returning 60 restarts polling at 60000 ms; an unrelated key does nothing.
   10. Disposing the returned Disposable disposes everything (no intervals left).

   Files: `test/usageView.view.test.ts`

9. Seam tests: test/usageView.seams.test.ts

   No vscode loader needed. Use fs.mkdtempSync(os.tmpdir()) temp homes (cleaned in after()). Cases:
   1. codexHomeDir/opencodeDataDir honour CODEX_HOME / XDG_DATA_HOME and fall back to ~/.codex and ~/.local/share/opencode.
   2. nodeReadCodexLatestRollout returns the newest rollout-*.jsonl text from the latest YYYY/MM/DD dir, ignores non-rollout files and non-numeric dirs, returns undefined for a missing sessions dir, and returns undefined when the signal is already aborted.
   3. readTextIfExists returns undefined for a missing file and the text for an existing file.
   4. createNodeUsageSeams(...).credentials.codex/opencodeGo read <home>/auth.json from the temp dirs (env injected), and the module never writes: snapshot the temp tree before/after a call and assert identical.
   5. nodeRunCommand runs process.execPath with ['-e','process.stdout.write("hi")'] -> {code:0, stdout:'hi'}; with cwd assertion via ['-e','process.stdout.write(process.cwd())'] equals fs.realpathSync(os.tmpdir()) (compare realpaths); a long-running child (['-e','setTimeout(()=>{},10000)']) is killed when the AbortSignal aborts and the promise settles; a missing executable rejects with code 'ENOENT'.
   6. Credential redaction end-to-end: build createUsageReaders(createNodeUsageSeams({...})) with fetchJson replaced by a stub capturing headers and returning 401, credentials returning a fake 'sk-ant-oat01-XXXXXXXXXXXXXXXX' token file, and a log spy; run the claude reader through a UsageService; assert the token appears in no log line and in no field of JSON.stringify(service.snapshot()).

   Files: `test/usageView.seams.test.ts`

10. Document the view in README.md

   1) '## The Baiton views': change the activity-bar bullet to list the Spec Explorer, the Runs view, the collapsed **Usage** section and the collapsed **Configuration** section; add a '- **Usage** — …' bullet in 'The views' list after Runs: a collapsed webview showing remaining usage for Claude Code, Codex, Antigravity and OpenCode Go in that order; each row shows windows (bar only when the source gives a percentage), reset time, scope/tier, the source line with provenance (provider-reported vs Baiton-derived, labelled) and read time, and status ok/stale/unavailable with a reason; nothing is probed or spawned before it is first expanded; it re-reads when it becomes visible and every baiton.usage.refreshIntervalSeconds while visible; polling stops when hidden or closed; a read that overruns 15 s settles as stale/unavailable; in Restricted Mode no stored credential is read and the row says why; nothing is written. Link to '### Usage view (per-tool probe findings)'.
   2) '## Commands': add '**Baiton: Refresh Usage** (`baiton.usage.refresh`) — re-reads every tool now; also the refresh button in the Usage view title. If the view has never been expanded it reveals it (which performs the first read).'
   3) '## Settings': add '`baiton.usage.refreshIntervalSeconds` — seconds between Usage view re-reads while it is visible; default 300, clamped to 30–86400.'
   Do not alter the existing per-tool probe-findings section except, if needed, one sentence pointing back to the view description.

   Files: `README.md`

11. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Fix any noUnusedLocals/noUnusedParameters errors (tsconfig is strict, lib ES2022 only — type global fetch locally, do not add 'DOM' to lib). Confirm no new runtime dependency in package.json dependencies (test asserts only ajv). Grep the new files for any fs write API (writeFile, appendFile, mkdir, rm, rename) — there must be none.

   Files: (none)

## Risks

- vscodeFake.mjs is shared by many tests; adding members must be purely delegating and lazy (getters/arrow functions) so tests that install fakes without those members still pass.
- lib is ES2022 without DOM: referencing `fetch`, `Response` or `Headers` types directly may fail to compile depending on @types/node; use a locally declared minimal fetch type via globalThis as src/orchestrator/modelsDev.ts does.
- onDidDispose of a WebviewView fires when the view is closed/moved; if the controller is not torn down there, the UsageService interval would keep polling with no view (violates 'no background polling'). Conversely, re-resolve must build a fresh controller/service since UsageViewController.dispose disposes its service permanently.
- With retainContextWhenHidden the webview DOM persists but the controller must still stop polling on visibility false; with a non-retained context the webview re-sends 'ready', which the controller already handles — either works, but visibility wiring is mandatory.
- Executing 'baiton.usageView.focus' when the view is unregistered rejects; the refresh command must contain that rejection.
- resolveExecutable for 'agy' must map to agent id 'antigravity' so baiton.agents.antigravity.path overrides apply; a wrong mapping silently falls back to PATH or reports not installed.
- nodeRunCommand must not use shell:true and must kill children on abort/timeout, or a hung CLI would outlive the read budget; the child-process test with a long-running node -e child must not leak (ensure the promise settles and the timer is cleared).
- Reading the newest Codex rollout could be expensive in a large ~/.codex/sessions tree; walk only the latest date directory and bound the bytes read.
- The activation.gating view-order test must be updated in the same change or `npm test` fails; the brief requires Spec Explorer, Runs and Configuration entries to stay otherwise unchanged.
- Credential text must flow only from the seam to the reader; do not log seam errors that might include file contents (readTextIfExists errors should be generic, e.g. code + path only).

## Acceptance

- package.json contributes.views.baiton ids are exactly ['baiton.specExplorer','baiton.runsView','baiton.usageView','baiton.configPanel']; baiton.usageView has name 'Usage', type 'webview', visibility 'collapsed'; the other three entries are unchanged.
- package.json contributes command 'baiton.usage.refresh' (category Baiton, icon $(refresh)) shown in menus['view/title'] when 'view == baiton.usageView' in group 'navigation', and the setting 'baiton.usage.refreshIntervalSeconds' (integer, default 300, min 30, max 86400).
- src/activation/usageView.ts registers a WebviewViewProvider for 'baiton.usageView' whose resolve sets enableScripts, localResourceRoots limited to media/, and renders media/usage.html with a fresh nonce and all placeholders replaced.
- No seam, reader, UsageService or timer is created and no process is spawned before the view is first resolved (covered by a unit test).
- On resolve/visible the view reads all four tools and polls at the configured interval; hiding stops polling; disposing the view disposes the controller, service and timer (covered by tests).
- The baiton.usage.refresh command re-reads when the view exists (sharing in-flight reads with webview refresh) and otherwise only reveals the view via 'baiton.usageView.focus' with any rejection contained (covered by tests).
- In Restricted Mode (workspace.isTrusted false) readers receive trusted=false and no credential seam is called; onDidGrantWorkspaceTrust triggers a trusted re-read (covered by tests).
- src/activation/usageViewSeams.ts imports no vscode, writes no file, spawns CLIs without a shell from os.tmpdir(), kills on abort/timeout, and its credential/rollout readers are covered by temp-dir tests; a token from a credential file never appears in logs or readings (covered by a test).
- extension.ts registers the Usage view ahead of the activation gate, with CLI resolution honouring baiton.agents.<agent>.path overrides (agy -> antigravity).
- README documents the Usage view in 'The Baiton views', the 'Baiton: Refresh Usage' command and the 'baiton.usage.refreshIntervalSeconds' setting; the per-tool probe-findings section remains.
- `npm run compile`, `npm run lint` and `npm test` all pass.
