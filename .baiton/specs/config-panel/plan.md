# plan result

```json
{
  "steps": [
    {
      "title": "Give the controller an external-change entry point that suppresses its own writes",
      "detail": "In src/activation/configPanelController.ts add a public `async notifyExternalChange(): Promise<void>` to `ConfigPanelController`. It is the host-free half of T07: the vscode watcher only says \"something touched the file\", the controller decides whether that is news.\n\nImplementation:\n  1. Import `readConfigToken` (already exported from src/config/configDocument.ts alongside `readConfigDocument`/`writeConfigDocument`, src/config/configDocument.ts:113) and `ABSENT_TOKEN`.\n  2. `const current = await readConfigToken(this.deps.baitonDir);` On `isErr(current)` (only `io` is possible — a missing file resolves to `ok(ABSENT_TOKEN)`), log through `this.deps.log` and return without posting: a transient read failure during someone else's atomic rename must not flash a banner in the panel.\n  3. If `current.value === this.token`, return. This is the self-write suppressor and it is the crux of the step: `save()` and `reset()` both set `this.token` from the `writeConfigDocument` result before the watcher event for that same write arrives, so the panel's own save never echoes back as an `externalChange` banner. It also swallows a no-op external rewrite of identical bytes, which is correct — the document did not change.\n  4. Otherwise `this.deps.webview.post({ type: 'externalChange', token: current.value })`. Do NOT update `this.token` here: the webview decides what to do (auto-reload when pristine, banner when dirty), and if the user chooses \"Keep editing\" the controller must still hold the token it loaded with so the next Save takes the conflict path in `writeConfigDocument`.\n  5. Add a `suppressed` guard for the in-flight window: set a private `this.writing = true` at the top of `save()` and `reset()` and clear it in a `finally`, and return early from `notifyExternalChange()` while it is set. The token check alone is not enough because the watcher can fire between the atomic rename and the assignment of `this.token`.\n\nAlso add `public dispose(): void` to the controller (currently it has none) that flips a `disposed` flag checked at the top of `handle()` and `notifyExternalChange()`, so a late-arriving debounced event after the panel closed posts nothing into a dead webview. Keep it idempotent.\n\nA `token` of `ABSENT_TOKEN` (`''`) is a legitimate value to post: it means the file was deleted while the panel was open, and the webview's pristine path will post `load`, yielding the `loadFailed { kind: 'absent', canReset: true }` error state with Reset to defaults — the right outcome.",
      "files": [
        "src/activation/configPanelController.ts",
        "src/config/configDocument.ts"
      ]
    },
    {
      "title": "Make ConfigPanelProvider.onClose additive so the watcher and the singleton map can both unhook",
      "detail": "`ConfigPanelProvider.onClose` (src/activation/configPanel.ts:80-82) stores a single `closeHandler`, and `openConfigPanel` already claims that slot to delete the provider from `activePanels` (src/activation/configPanel.ts:212-214). Registering a second handler for watcher teardown would silently clobber the first and leak the singleton entry, so change the field to `private readonly closeHandlers: (() => void)[] = []`, have `onClose` push, and have both call sites (`panel.onDidDispose`, src/activation/configPanel.ts:112-120, and `dispose()`, src/activation/configPanel.ts:125-135) iterate a copy of the array.\n\nMake close idempotent while you are here: `dispose()` calls `panel.dispose()`, which itself fires `onDidDispose`, so today the handlers can run twice. Add a private `closed` flag set on the first notification and have the notifier return early afterwards. Watcher disposal must tolerate being called twice regardless, but the flag keeps the log and the map delete honest.",
      "files": [
        "src/activation/configPanel.ts"
      ]
    },
    {
      "title": "Create the file watcher in openConfigPanel and tie its lifetime to the panel",
      "detail": "In `openConfigPanel` (src/activation/configPanel.ts:189-217), after `controller.start()` and before `provider.createOrReveal()`, start a watcher scoped to the one file:\n\n```ts\nconst pattern = new vscode.RelativePattern(deps.baitonDir, 'config.json');\nconst watcher = vscode.workspace.createFileSystemWatcher(pattern);\n```\n\nFollow the specExplorer precedent exactly (src/activation/specExplorer.ts:158-165): subscribe to all three of `onDidCreate`, `onDidChange` and `onDidDelete`, because `writeJsonAtomic` writes a sibling temp file and renames over the target — depending on platform and editor that surfaces as create *or* change, and an external `rm` surfaces as delete. Each event calls a local `schedule()` that coalesces into one `void controller.notifyExternalChange()` after a short debounce; reuse the specExplorer shape with its own constant, e.g. `const EXTERNAL_CHANGE_DEBOUNCE_MS = 250;` declared next to `CONFIG_HTML`. A shorter window than the explorer's 500 ms is appropriate: this is one file, not a recursive tree, and the panel is a foreground editor the user is looking at.\n\nTeardown: register `provider.onClose(() => { clearTimeout(timer); watcher.dispose(); controller.dispose(); })` — now safe because step 2 made `onClose` additive — alongside the existing `activePanels.delete(deps.baitonDir)` handler. Clearing the pending timer matters: without it a debounced callback can fire after the panel is gone and read the file for nothing.\n\nNote that `vscode.RelativePattern` accepts a plain string base, which is what `deps.baitonDir` already is (`vscode.Uri.joinPath(root, '.baiton').fsPath`, src/activation/commands.ts:596), so no Uri conversion is needed — same as `this.specsDir` in specExplorer.",
      "files": [
        "src/activation/configPanel.ts",
        "src/activation/specExplorer.ts"
      ]
    },
    {
      "title": "Harden the webview's externalChange handling against an in-flight save",
      "detail": "media/config.js already implements the T07 webview contract from T04 — pristine forms auto-reload, dirty forms raise the `external` banner with \"Reload (discard edits)\" / \"Keep editing\" (media/config.js:586-598), and a `saveFailed` with `reason: 'conflict'` raises the Reload/Overwrite banner (media/config.js:580-582) whose secondary action replays `doSave(true)` (media/config.js:528-530). Verify that end to end rather than rewriting it, and close the two gaps the watcher now makes reachable:\n\n  1. **In-flight save.** When `state.busy` is true a save response is outstanding; auto-posting `{ type: 'load' }` from the `externalChange` branch races it and can repaint the form from disk after the user's own save lands. Guard the branch: while `state.busy`, remember the event (e.g. `state.pendingExternal = msg.token`) and act on it in the `saved` / `saveFailed` handlers once `state.busy` is cleared. If the save succeeded, the controller's own token check means the event was almost certainly the panel's own write and should be dropped; the simplest correct rule is to discard a pending external event on `saved` and apply it on `saveFailed`.\n  2. **Banner precedence.** Do not let an `external` banner overwrite a `conflict` banner that is already showing (the user is mid-decision on Reload/Overwrite); the conflict banner already offers the strictly more informative choice.\n\nLeave the mirror block at the top of media/config.js (media/config.js:21-106) untouched — it mirrors `validateConfigForm` only, and T09's parity test compares exactly that block.",
      "files": [
        "media/config.js"
      ]
    },
    {
      "title": "Unit-test the controller's external-change logic against a temp directory",
      "detail": "Extend test/configPanel.controller.test.ts (or add a sibling test/configPanel.watch.test.ts in the same style — it imports the controller statically with no `vscodeLoader` hook, proving it stays host-free) with a `notifyExternalChange` describe block driving the existing `RecordingWebview`:\n\n  - **External edit posts externalChange.** `ready` against a valid file, then rewrite the file out of band with different bytes, then `await controller.notifyExternalChange()` → exactly one `externalChange` whose `token` equals `configToken(<new text>)`.\n  - **Self-write is suppressed.** `ready`, then drive a successful `save` through the webview, then `notifyExternalChange()` → no `externalChange` message is posted at all (assert the message list after the `saved` entry is empty). Do the same for `reset` (accepted), which also writes.\n  - **Identical rewrite is suppressed.** Rewrite the file with byte-identical contents → no message.\n  - **Deletion posts ABSENT_TOKEN.** `fs.rmSync` the config file → one `externalChange` with `token === ''` (`ABSENT_TOKEN`), and a following `load` yields `loadFailed { kind: 'absent', canReset: true }`.\n  - **The stale token still conflicts.** After an `externalChange` that the user \"keeps editing\" through (i.e. the controller's token is deliberately not advanced), a `save` carrying the originally loaded token yields `saveFailed { reason: 'conflict' }` and leaves the external edit on disk — this is the third clause of the todo and mostly re-pins existing T05 behaviour against the new code path.\n  - **After dispose nothing is posted.** `controller.dispose()` then `notifyExternalChange()` → no message.\n\nKeep the file-header comment's numbered coverage list up to date, matching the convention at test/configPanel.controller.test.ts:9-31.",
      "files": [
        "test/configPanel.controller.test.ts",
        "src/activation/configPanelController.ts"
      ]
    },
    {
      "title": "Compile, lint, and run the suite",
      "detail": "Run `node --check media/config.js`, `npm run compile`, `npm run lint`, `npx mocha test/configPanel.controller.test.ts test/configPanel.document.test.ts`, and the full `npm test`. Expect only the two documented pre-existing failures recorded in .baiton/specs/config-panel/review-2.md — the native-module scan in test/activation.gating.test.ts tripping over `node_modules/keytar` artifacts pulled in by `@vscode/vsce`, and the `setApiKey.test.ts` 'before all' hook that cannot resolve the bare `vscode` specifier under the CommonJS mocha run. Anything else is a regression from this todo; do not attempt to fix the two known ones here.",
      "files": [
        "package.json",
        "media/config.js",
        "test/configPanel.controller.test.ts"
      ]
    }
  ],
  "risks": [
    "Self-write echo is the main hazard: the panel's own atomic save fires the watcher. Suppression rests on two things together — `this.token` being assigned from the `writeConfigDocument` result before the event arrives, and an in-flight `writing` flag covering the window between the rename and that assignment. Drop either and every save raises a spurious 'changed on disk' banner.",
    "`writeJsonAtomic` writes a temp sibling and renames; that can surface as `onDidCreate` rather than `onDidChange`, and on some platforms as both. Subscribing to only one event kind silently misses external edits made by other editors.",
    "`ConfigPanelProvider.onClose` currently holds a single handler, already claimed by `openConfigPanel` for the `activePanels` map. Adding a second registration without making the slot additive silently leaks the singleton entry, so the command would reveal a disposed panel on the next invocation.",
    "Close is notified twice today (`dispose()` calls `panel.dispose()`, which re-fires `onDidDispose`). Watcher disposal and controller disposal must be idempotent, or the second pass throws and takes out the rest of the teardown.",
    "A debounced callback firing after the panel closed would read the file and post into a dead webview. Both the timer must be cleared on close and the controller must refuse to post after `dispose()`.",
    "Auto-reload on a pristine form races an in-flight save: the `externalChange` → `load` round trip can repaint the form from disk while the user's own `save` response is still outstanding. The webview must defer the event while `state.busy`.",
    "The controller deliberately does not advance `this.token` when it posts `externalChange`. That is what makes the 'Keep editing' → Save path surface the conflict, but it also means a stale token persists until the user reloads — intended, and worth a comment so a reviewer does not 'fix' it.",
    "A read error during someone else's atomic rename is transient. Posting a banner for it would flicker; logging and returning is the right call, at the cost of very rarely missing one event (the next one, or an explicit Reload, recovers).",
    "Host-free testing stops at the controller. `vscode.workspace.createFileSystemWatcher` and `RelativePattern` are not in the `vscode` fake at test/fixtures/vscodeFake.mjs, and loading `configPanel.ts` would drag in the whole activation graph; the watcher wiring itself must be verified by hand in an Extension Development Host.",
    "`createFileSystemWatcher` only reports events for paths inside an open workspace folder. `.baiton/config.json` always is for the resolved root, but a panel opened against a folder the user subsequently closes stops receiving events — the Save-time token check remains the backstop, which is why it must keep working independently of the watcher."
  ],
  "acceptance": [
    "While the panel is open, an external edit to `.baiton/config.json` posts exactly one `externalChange` carrying the new content token; a pristine form reloads itself automatically and a dirty form shows the 'changed on disk' banner with Reload (discard edits) / Keep editing.",
    "A save or a reset performed by the panel itself posts no `externalChange` — the controller suppresses both the token match and the in-flight write window.",
    "An external rewrite with byte-identical contents posts nothing.",
    "Deleting the file while the panel is open posts `externalChange` with `ABSENT_TOKEN` (`''`); the ensuing load renders the absent error state with Reset to defaults reachable.",
    "After dismissing the banner with Keep editing, Save with the now-stale token yields `saveFailed { reason: 'conflict' }`, the banner offers Reload / Overwrite, and Overwrite re-reads and writes while preserving unknown keys the external edit introduced.",
    "`externalChange` arriving while a save is in flight does not repaint the form under the save response.",
    "The watcher is created in `openConfigPanel` over `new vscode.RelativePattern(baitonDir, 'config.json')`, subscribes to create/change/delete, and coalesces events through a single debounce timer.",
    "Closing the panel disposes the watcher, clears any pending debounce timer, and disposes the controller; `openConfigPanel` still removes the provider from `activePanels`, and closing twice does none of it twice.",
    "`ConfigPanelController.notifyExternalChange` posts nothing after `dispose()`.",
    "test/configPanel.controller.test.ts covers external edit, self-write suppression (save and reset), identical rewrite, deletion, stale-token conflict, and post-dispose silence, and imports the controller with no `vscode` hook.",
    "`node --check media/config.js`, `npm run compile` and `npm run lint` pass clean; `npm test` shows no new failures beyond the two documented pre-existing ones (the keytar native-module scan and the setApiKey `vscode` module resolution).",
    "Manual check in an Extension Development Host: open the panel, edit `.baiton/config.json` in another editor tab, and watch the panel reload itself when untouched and raise the banner when it has unsaved edits."
  ]
}
```
