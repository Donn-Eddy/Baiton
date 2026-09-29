# Plan T02

## Steps

1. Add the API channel, apiLog and logApiFailure to Surface

   Edit src/activation/surface.ts.

   1. Imports: add `import { createApiLog, type ApiFailureEntry, type ApiLog } from '../orchestrator/apiLog';`. Import from the module file directly, not the '../orchestrator' barrel, so Surface does not load the whole orchestrator graph. T01 already created this module with `createApiLog(sink, now?)`, `ApiLog { failure(entry) }` and `ApiFailureEntry`. Do not change apiLog.ts.

   2. Next to `OUTPUT_CHANNEL_NAME = 'Baiton'`, add an exported constant: `/** The display name of the silent API-failure output channel. */ export const API_CHANNEL_NAME = 'API';`. VS Code shows the channel as 'Baiton: API' in the Output dropdown, alongside the extension's 'Baiton' channel. Keep `OUTPUT_CHANNEL_NAME` exactly as it is; exporting it is optional.

   3. Fields: keep `private readonly channel: vscode.OutputChannel;` and add `private readonly apiChannel: vscode.OutputChannel;` and `public readonly apiLog: ApiLog;`.

   4. Constructor: change it to `constructor(channel?: vscode.OutputChannel, apiChannel?: vscode.OutputChannel)`. The body is:
      this.channel = channel ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
      this.apiChannel = apiChannel ?? vscode.window.createOutputChannel(API_CHANNEL_NAME);
      this.apiLog = createApiLog((line) => this.apiChannel.appendLine(line));
      Keep the `??` short-circuit so that when both fakes are injected, `vscode.window.createOutputChannel` is never touched. The test fake's `window` has no createOutputChannel. The existing call `new Surface()` in extension.ts and any `new Surface(channel)` callers keep compiling unchanged.

   5. Add a getter after `outputChannel`: `/** The API-failure channel, so activation can register it for disposal. */ public get apiOutputChannel(): vscode.OutputChannel { return this.apiChannel; }`.

   6. Add a method: `/** Record one failed outbound API call on the silent API channel. Never reveals the channel or raises a notification. */ public logApiFailure(entry: ApiFailureEntry): void { this.apiLog.failure(entry); }`.

   7. Leave `log`, `info`, `warn`, `error`, `reportDispatchError` and `isHardHalt` exactly as they are. Nothing new may call `show()`, `reveal`, or any `vscode.window.show*Message`. Add one sentence to the file header doc comment: Surface also owns a second, silent 'API' channel that records one line per failed outbound API call through the host-free `createApiLog`, and nothing on that path reveals the channel or notifies.

   Files: `src/activation/surface.ts`

2. Register the API channel for disposal in extension.ts

   Edit src/extension.ts around line 146-147. Directly after `context.subscriptions.push(surface.outputChannel);`, add `context.subscriptions.push(surface.apiOutputChannel);`. Optionally, extend the existing comment above `const surface = new Surface();` to mention the silent API-failure channel. Make no other changes: no show()/reveal, and no apiLog threading into ModelDiscoveryService, ProviderRouter or commands. Later todos do that.

   Files: `src/extension.ts`

3. Test Surface against fake channels

   Create test/surface.apiChannel.test.ts (mocha plus node:assert), using the loader pattern from test/setApiKey.test.ts.

   Setup: in `before`, set `const root = process.cwd()`, `register(pathToFileURL(join(root,'test','fixtures','vscodeLoader.mjs')).href, pathToFileURL(join(root,'/')).href)`, then `await import('./fixtures/vscodeLoader.mjs')`, then `const mod = (await import('../src/activation/surface')) as typeof import('../src/activation/surface')`. Keep `Surface` and `API_CHANNEL_NAME` from `mod`. Do not use import.meta; the project compiles as CommonJS. In `beforeEach`, install `globalThis.__vscodeFake` with a `window` object whose showInformationMessage, showWarningMessage and showErrorMessage each push `{kind, message}` onto a `notifications` array and return `Promise.resolve(undefined)`. showInputBox, showQuickPick, registerWebviewViewProvider and registerTreeDataProvider can be no-op stubs. Include `commands: { executeCommand: async () => undefined }` for safety. In `after`, delete `globalThis.__vscodeFake` or restore the previous value.

   Fake channel: write a class `FakeChannel` that implements the members Surface uses, with records: `name`, `lines: string[]` (appendLine pushes), `appended: string[]`, `showCalls = 0` (show increments it), `hideCalls`, `disposed = false` (dispose sets it true), plus no-op `clear` and `replace`. Cast it with `as unknown as import('vscode').OutputChannel` when passing it in. Use a type-only import of 'vscode'; it is erased at compile time.

   Test cases:
   (a) 'writes API failures to the separate API channel, not the Baiton channel': call `new Surface(main, api)` and `surface.logApiFailure({ surface: 'openai', operation: 'completion', kind: 'http-status', status: 500, target: 'https://api.example.com/v1/chat/completions', message: 'server error' })`. Assert `api.lines.length === 1` and `main.lines.length === 0`. Assert the line matches `/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] openai completion http-status HTTP 500 https:\/\/api\.example\.com\/v1\/chat\/completions — server error$/`.
   (b) 'apiLog.failure writes through the same channel': call `surface.apiLog.failure({...kind:'timeout'...})` and assert one line on `api` and none on `main`.
   (c) 'is silent': after several logApiFailure and apiLog.failure calls, assert `api.showCalls === 0` and `main.showCalls === 0`, and assert that `notifications` is empty.
   (d) 'redacts secrets on the way to the channel': log an entry with `message: 'failed with Authorization: Bearer sk-abcdefghijklmnopqrstuvwx'` and `bodyExcerpt: '{"error":"bad api_key=sk-zzzzzzzzzzzzzzzzzzzzzz"}'`. Assert the line has no 'sk-abcdefghijklmnop' and no 'sk-zzzzzzzz', and that it includes '[REDACTED]'.
   (e) 'exposes the API channel for disposal, distinct from the Baiton channel': assert `surface.apiOutputChannel === api`, `surface.outputChannel === main`, and `surface.apiOutputChannel !== surface.outputChannel`. Call `surface.apiOutputChannel.dispose()` and assert that `api.disposed` is true and `main.disposed` is false.
   (f) 'existing Baiton channel behaviour is unchanged': call `surface.log('hello')` and assert that `main.lines` has exactly one line ending in '] hello' and that `api.lines` is empty. Then call `surface.warn('w')` and assert one warning notification, that `main.lines` gained a 'WARN: w' line, and that `api.lines` is still empty.
   (g) 'API_CHANNEL_NAME is API': `assert.strictEqual(API_CHANNEL_NAME, 'API')`.
   (h) Optional: 'a throwing channel never breaks the caller'. Make `api.appendLine` throw and assert that `logApiFailure` does not throw. createApiLog already swallows sink errors.

   Fix every lint issue in the new file (`npm run lint` covers test/). Avoid unused imports, and use `unknown` casts, not `any`, if the lint config forbids `any`.

   Files: `test/surface.apiChannel.test.ts`

4. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. All three must pass. Lint may show only the pre-existing warning in webviewProtocol.ts. Also grep src/activation/surface.ts to confirm that the new code adds no `show(`, `reveal` or `show*Message` calls.

   Files: (none)

## Risks

- The fake vscode module (test/fixtures/vscodeFake.mjs) has no window.createOutputChannel. The test must inject both channels, and the constructor must use `??` short-circuit so the default path is never evaluated. Do not edit the fixture; it is outside this todo's file list.
- Other tests may build Surface-like objects with `as unknown as Surface` (for example runCommands.test.ts). Adding public members does not break those casts, but check that nothing structurally implements Surface without a cast.
- Mocha loads every test file in one process. Registering the vscode loader hook again and replacing globalThis.__vscodeFake must not leak into other suites. Set the fake per test in beforeEach and restore or delete it in after, as other suites do.
- The em dash (—) in the formatted line must match exactly in the regex assertion. Build the expectation from the literal apiLog format, or use includes() checks, to avoid encoding surprises.
- Importing '../orchestrator' (the barrel) instead of '../orchestrator/apiLog' could pull in heavier modules or create cycles. Import the file directly.

## Acceptance

- src/activation/surface.ts exports `API_CHANNEL_NAME = 'API'`. Surface's constructor is `(channel?: vscode.OutputChannel, apiChannel?: vscode.OutputChannel)` and creates the API channel via `vscode.window.createOutputChannel(API_CHANNEL_NAME)` only when none is injected.
- Surface exposes `apiOutputChannel` (getter), `apiLog: ApiLog` built with `createApiLog((line) => apiChannel.appendLine(line))`, and `logApiFailure(entry: ApiFailureEntry)`, which delegates to apiLog.failure.
- No new code path in Surface calls show(), reveal, or any vscode.window.show*Message. log/info/warn/error/reportDispatchError are byte-for-byte unchanged in behaviour.
- src/extension.ts pushes `surface.apiOutputChannel` onto `context.subscriptions` immediately after `surface.outputChannel`, with no other behavioural change.
- test/surface.apiChannel.test.ts exists and passes. It proves that one failure produces exactly one formatted line on the API channel and none on the Baiton channel, that there are zero show() calls and zero notifications, that secrets are redacted in the written line, and that apiOutputChannel is the injected API channel, is distinct from outputChannel, and disposes independently.
- `npm run compile`, `npm run lint` (no new warnings or errors) and `npm test` all pass.
