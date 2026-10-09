# Plan T08

## Steps

1. Create the host-free usage webview protocol src/usage/protocol.ts

   New file. Header doc comment in the style of src/config/configPanel.ts: 'Usage view message protocol (host-free core) — spec first-party-usage, todo T08'. It has no vscode import and no Node built-in import, and imports only from './model' (USAGE_TOOL_IDS, USAGE_TOOL_LABELS, isUsageToolId, sortReadings, and types UsageReading, UsageToolId, UsageWindow, UsageSource). Every exported function is total and never throws.

   Export these:

   1. `export interface UsageViewRow { readonly tool: UsageToolId; readonly label: string; /** undefined = not read yet in this view's lifetime */ readonly reading?: UsageReading; /** true while a read for this tool is in flight */ readonly refreshing: boolean; }`

   2. `export interface UsageViewState { /** any read in flight */ readonly refreshing: boolean; /** workspace trust; false = Restricted Mode, so no credentials are read */ readonly trusted: boolean; /** effective poll interval in whole seconds */ readonly refreshIntervalSeconds: number; /** host clock (epoch ms) when the message was built; the webview computes ages from it */ readonly now: number; }`

   3. `export type UsageHostToWebview =` with two members:
      - `{ type: 'readings'; rows: UsageViewRow[]; now: number }`: always exactly one row per USAGE_TOOL_IDS entry, in that order.
      - `{ type: 'state'; state: UsageViewState }`.
      Doc-comment each member, as configPanel.ts does.

   4. `export type UsageWebviewToHost = { type: 'ready' } | { type: 'refresh' };` Docs: 'ready' means the webview mounted and the host should post state and readings; 'refresh' means the user clicked refresh in the webview.

   5. `export function parseUsageWebviewMessage(raw: unknown): UsageWebviewToHost | undefined`. It returns `{ type: 'ready' }` or `{ type: 'refresh' }` only when raw is a non-null object whose `type` is exactly that string. It returns a fresh object, so extra fields are dropped. It returns undefined for anything else.

   6. `export function toWebviewReading(r: UsageReading): UsageReading`. This is a defensive field-picking copy, so nothing a reader smuggled onto the object crosses to the webview. Pick only these fields:
      - ok: tool, status, windows (each window picked: id, label, usedPercent, raw{used,limit,remaining,unit}, resetsAt, scope{model,plan}, provenance; copy optional keys only when not undefined), tier when defined, source {mechanism, detail, provenance, readAt}.
      - stale: the same fields plus reason and failedAt.
      - unavailable: tool, status, reason, checkedAt, and mechanism when defined.
      Write a private `pickWindow(w)` and a private `pickSource(s)`. The output must stay JSON-serialisable.

   7. `export function usageViewRows(readings: readonly UsageReading[], inFlight: ReadonlySet<UsageToolId> = new Set()): UsageViewRow[]`. Map USAGE_TOOL_IDS to rows: label from USAGE_TOOL_LABELS, reading = toWebviewReading of the first reading whose tool matches (ignore entries with an invalid tool via isUsageToolId), refreshing = inFlight.has(tool). Omit the `reading` key entirely when there is none.

   8. `export function readingsMessage(readings, inFlight, now): UsageHostToWebview` returns `{ type: 'readings', rows: usageViewRows(readings, inFlight), now }`. Also `export function stateMessage(state: UsageViewState): UsageHostToWebview` returns `{ type: 'state', state: { ...state } }`.

   Do NOT re-implement credential redaction here. UsageService already redacts every reading string, and toWebviewReading only guarantees that no unknown field crosses.

   Files: `src/usage/protocol.ts`

2. Export the protocol from the usage barrel

   In src/usage/index.ts, add `export * from './protocol';` right after `export * from './usageService';`. Check that no exported name collides with the existing barrel exports. The new names are UsageViewRow, UsageViewState, UsageHostToWebview, UsageWebviewToHost, parseUsageWebviewMessage, toWebviewReading, usageViewRows, readingsMessage and stateMessage. `npm run compile` would report a collision as a duplicate export error.

   Files: `src/usage/index.ts`

3. Create the host-free controller src/activation/usageViewController.ts

   New file modelled on src/activation/configPanelController.ts. It has NO vscode import and imports only from '../usage' (or '../usage/protocol', '../usage/model', '../usage/usageService'). Open with a header doc comment saying:
   - it is the host-free half of baiton.usageView (first-party-usage T08);
   - every host capability arrives as a seam;
   - nothing reads, spawns or starts a timer before the view is first shown.

   Interfaces:
   ```ts
   export interface UsageViewWebview { post(msg: UsageHostToWebview): void; onMessage(handler: (msg: unknown) => void | Promise<void>): void; }
   ```
   The handler takes `unknown` because the controller validates with parseUsageWebviewMessage. Mirror ConfigPanelWebview's two-method shape.
   ```ts
   /** The subset of UsageService the controller drives (a real UsageService satisfies it; tests may fake it). */
   export interface UsageViewService { refresh(tools?: readonly UsageToolId[]): Promise<readonly UsageReading[]>; snapshot(): readonly UsageReading[]; onDidChange(l: (r: readonly UsageReading[]) => void): { dispose(): void }; startPolling(intervalSeconds: unknown): void; stopPolling(): void; dispose(): void; }
   export interface UsageViewControllerDeps { webview: UsageViewWebview; service: UsageViewService; /** read on every use (setting baiton.usage.refreshIntervalSeconds) */ getRefreshIntervalSeconds(): unknown; isTrusted(): boolean; now?(): number; log(message: string): void; }
   ```

   The class is `export class UsageViewController`, with these private fields:
   - `disposed = false`
   - `started = false`
   - `visible = false`
   - `hasRead = false`
   - `activeRefreshes = 0`
   - `serviceSub: {dispose():void} | undefined`

   Its methods:

   - `constructor(deps)`: stores deps only. It must NOT call service.refresh, service.startPolling or any seam.

   - `start()`: registers `webview.onMessage(raw => this.handle(raw).catch(e => log('UsageViewController: unexpected error handling message: ' + msg)))`. Subscribe to service.onDidChange only once, guarded on `serviceSub === undefined`, exactly like capabilitySub in ConfigPanelController. The listener calls `postReadings()`. start() must not read or poll.

   - `private async handle(raw: unknown)`: return if disposed. Parse with parseUsageWebviewMessage, and on undefined log 'UsageViewController: unrecognised message type: …' and return. On `ready`, call `postState(); postReadings();`, then `if (this.visible && !this.hasRead) await this.refresh()`. On `refresh`, `await this.refresh()`.

   - `setVisible(visible: boolean): void`: the glue calls it from onDidChangeVisibility and once at resolve. Return if disposed. On becoming visible (false→true): set visible, `startPolling()`, then `void this.refresh()`. So it reads when it becomes visible and again on every interval while visible. On becoming hidden: set visible=false and `service.stopPolling()`, so there is no background polling while collapsed. A repeated call with the same value is a no-op.

   - `async refresh(): Promise<void>`: used by the webview button and by the baiton.usage.refresh command (T10 glue). Return if disposed. Then:
     - set `hasRead = true` and `activeRefreshes++`; when this is the first concurrent refresh, `postState()` so the state reads refreshing:true;
     - `try { await service.refresh(); } catch (e) { log(...) } finally { activeRefreshes--; if (!disposed) { postState(); postReadings(); } }`.
     Overlapping calls are fine because UsageService coalesces per tool. The controller never adds its own read de-duplication beyond that. It must never throw.

   - `notifyIntervalChanged(): void`: when visible and not disposed, call startPolling() again. UsageService.startPolling already stops the previous timer. Then postState().

   - `notifyTrustChanged(): void`: postState(); if visible, `void this.refresh()`, so trust granted in Restricted Mode re-reads with credentials allowed.

   - `private startPolling()`: `service.startPolling(deps.getRefreshIntervalSeconds())` inside try/catch with a log.

   - `private postState()`: return if disposed. Post `stateMessage({ refreshing: activeRefreshes > 0, trusted: safeTrusted(), refreshIntervalSeconds: normaliseRefreshIntervalSeconds(deps.getRefreshIntervalSeconds()), now: now() })`. Wrap isTrusted in try/catch that fails closed (false).

   - `private postReadings()`: return if disposed. Post `readingsMessage(service.snapshot(), inFlight, now())`. inFlight = new Set(USAGE_TOOL_IDS) while activeRefreshes > 0, else an empty set. That is deliberately coarse, and the row's refreshing flag mirrors the global flag.

   - `now()`: `deps.now?.() ?? Date.now()`.

   - `dispose()`: idempotent. Set disposed, dispose serviceSub, call `service.stopPolling()` and `service.dispose()` (each in try/catch). The controller owns the service's lifetime, so the timer and in-flight reads die with the view. Late service events, refresh completions and webview messages after dispose post nothing.

   Wrap every webview.post in a private `post(msg)` that try/catches and logs, so a disposed webview cannot make the controller throw.

   Files: `src/activation/usageViewController.ts`

4. Unit-test the protocol

   New test/usage.protocol.test.ts (mocha + assert, no vscode loader, matching test/usage.service.test.ts style). Cases:
   (a) parseUsageWebviewMessage accepts {type:'ready'} and {type:'refresh'} and strips extra fields (deepStrictEqual to the bare object). It returns undefined for null, a string, {}, {type:'save'} and {type:1}.
   (b) usageViewRows([]) gives 4 rows in the order claude, codex, antigravity, opencode-go, with the labels Claude Code, Codex, Antigravity, OpenCode Go, no `reading` own key and refreshing false.
   (c) usageViewRows with readings supplied out of order (opencode-go unavailable, claude ok, codex stale) still returns USAGE_TOOL_IDS order with each reading in place. An entry with a bogus tool is ignored. inFlight marks only the named tools as refreshing.
   (d) toWebviewReading drops smuggled fields: build an ok reading object with extra `token: 'sk-ant-xxxxxxxxxx'` at the top level, in source, and in a window. Assert that JSON.stringify(result) does not contain 'sk-ant', and that the known fields (usedPercent, raw, resetsAt, scope, tier, provenance, readAt) survive. Also check that stale keeps reason/failedAt and unavailable keeps reason/checkedAt/mechanism.
   (e) readingsMessage/stateMessage give the expected `type` and survive a JSON round-trip deepStrictEqual.
   (f) Host-free guard: read src/usage/protocol.ts as text and assert it contains no `from 'vscode'` and no Node built-in import (regex on `from '(fs|path|child_process|os|http|https)'`). usage.service.test.ts already reads source files with fs, so follow that pattern.

   Files: `test/usage.protocol.test.ts`

5. Unit-test the controller

   New test/usageView.controller.test.ts. Import UsageViewController statically with no vscodeLoader hook, which proves the module is host-free. Also include a source-text check that src/activation/usageViewController.ts has no `from 'vscode'`.

   Helpers:
   - RecordingWebview implementing UsageViewWebview, with messages[] and an `async send(raw)` that awaits the handler. Copy the shape of RecordingWebview in test/configPanel.controller.test.ts.
   - A FakeTimer copied from test/usage.service.test.ts.
   - A real UsageService built over fake readers (counting invocations, optionally deferred), with the fake timer and an injected now.
   - A `flush()` that awaits setImmediate twice.

   Cases:
   1. Never before expand: construct plus start() → zero reader calls, zero setInterval calls, no messages posted.
   2. ready while not visible → posts exactly one state then one readings (4 rows, no readings), and zero reader calls.
   3. setVisible(true) → every reader called once, one interval registered with ms = normaliseRefreshIntervalSeconds(configured) * 1000, and a final readings message carrying ok rows. A state with refreshing:true is posted before a state with refreshing:false.
   4. Coalescing: with deferred readers, setVisible(true) followed immediately by refresh() and a webview 'refresh' message → each reader is invoked exactly once. After resolving, all three settle.
   5. Interval: fireIntervals() → readers are called a second time. setVisible(false) → pendingIntervals() === 0, and fireIntervals() causes no reads. setVisible(true) again → reads, and the interval is back.
   6. Timeout/stale surfaced: the first read is ok, then the reader hangs. refresh(), then timer.fireTimeouts(), then flush → the last readings row for that tool has status 'stale' with a non-empty reason. A tool with no prior good read and a rejecting reader shows 'unavailable' with a non-empty reason.
   7. Restricted mode: isTrusted false → state.trusted === false, and the reader's ctx.trusted is false (service isTrusted wired to the same flag). Flip trust to true and call notifyTrustChanged() → state.trusted true and a re-read with ctx.trusted true.
   8. Credential redaction end to end: a reader returns an ok reading whose source.detail contains 'Bearer abc.def.ghi-SECRET123456' and an unavailable reading whose reason contains an `access_token=...` value. JSON.stringify of every posted message contains neither secret.
   9. notifyIntervalChanged() while visible → a new setInterval with the new interval ms and only one pending interval.
   10. dispose() → pendingIntervals() 0. A later onDidChange, interval fire, refresh() or webview message posts nothing, and an in-flight read resolving afterwards posts nothing. dispose twice does not throw.
   11. start() twice → a service change posts one readings message, not two.
   12. Unrecognised webview message → logged, nothing posted, no throw.

   Files: `test/usageView.controller.test.ts`

6. Compile, lint and test

   Run `npm run compile`, `npm run lint` and `npm test`. Fix any eslint complaints (unused imports, explicit any) in the new files only. Do not touch package.json, media/ or the vscode glue (registration, commands and settings belong to later todos). Do not modify the existing UsageService/model behaviour.

   Files: (none)

## Risks

- Name collisions in the src/usage barrel: protocol.ts exports go through `export * from './protocol'`, so a name already exported by a reader module would make compile fail. Check before naming.
- Visibility semantics: this plan stops polling while the view is hidden or collapsed and re-reads when it becomes visible. That matches 'no background polling' and 'reads when it becomes visible'. If the later glue todo expects polling to continue while hidden, only setVisible changes.
- The controller owns and disposes the UsageService. The glue (later todo) must create a fresh service per resolved webview view, or the disposed service would answer 'The usage view is closed.'
- Async ordering in tests: UsageService resolves reads through several promise hops (Promise.resolve().then(reader).then(...), race, finally). Tests must flush enough (setImmediate twice, or await the refresh() promise) before asserting on posted messages.
- The row-level `refreshing` flag is coarse (all tools while any refresh is active). If the webview later wants per-tool spinners, the controller would need per-tool tracking via service.refreshTool.
- The UsageService timeout in the controller tests uses the injected FakeTimer. The service must be constructed with that timer, or real 15s timeouts will be scheduled (they are unref'd, but they slow nothing only if never awaited).

## Acceptance

- src/usage/protocol.ts exists, imports only from './model', has no vscode or Node built-in import, and exports UsageHostToWebview ('readings' | 'state'), UsageWebviewToHost ('ready' | 'refresh'), UsageViewRow, UsageViewState, parseUsageWebviewMessage, toWebviewReading, usageViewRows, readingsMessage and stateMessage.
- src/usage/index.ts re-exports './protocol'.
- src/activation/usageViewController.ts exists with no vscode import and exports UsageViewController, UsageViewWebview, UsageViewService and UsageViewControllerDeps. Constructing it and calling start() invokes no reader and starts no timer.
- Readings messages always carry exactly four rows in the order Claude Code, Codex, Antigravity, OpenCode Go, and no posted message ever contains a credential string or an unknown reading field.
- Tests test/usage.protocol.test.ts and test/usageView.controller.test.ts cover: parsing, row order, field picking, the never-before-expand path, coalescing, interval start/stop/dispose, the stale/timeout and unavailable paths, restricted mode and credential redaction.
- `npm run compile`, `npm run lint` and `npm test` all pass.
