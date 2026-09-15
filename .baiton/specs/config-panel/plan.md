# plan result

```json
{
  "steps": [
    {
      "title": "Add the command id to the COMMANDS map",
      "detail": "In src/activation/commands.ts add `openConfigPanel: 'baiton.openConfigPanel'` to the `COMMANDS` const (currently src/activation/commands.ts:109-123, after `setApiKey`). This keeps the id in the single source of truth the rest of the command layer already reads, and gives the package.json contribution test something to assert against.",
      "files": [
        "src/activation/commands.ts"
      ]
    },
    {
      "title": "Contribute baiton.openConfigPanel in package.json with no when clause",
      "detail": "Add `{ \"command\": \"baiton.openConfigPanel\", \"title\": \"Open Config Panel\", \"category\": \"Baiton\" }` to `contributes.commands`. Deliberately add NO entry to `contributes.menus.commandPalette`: every Baiton command listed there is gated on `when: baiton.activated`, and omitting the entry (exactly as `baiton.initialize` does today) leaves the command unconditionally visible in the palette, which is required because `activate()` returns early — and never sets `baiton.activated` — when the workspace or config gate fails, i.e. precisely the case the panel's Reset-to-defaults path exists to repair. Do not add an `activationEvents` entry: the extension already activates on `onStartupFinished`, so the command handler is registered before the user can invoke it. Keep the JSON formatting (2-space indent) of the surrounding entries.",
      "files": [
        "package.json"
      ]
    },
    {
      "title": "Export registerConfigPanelCommand from commands.ts",
      "detail": "Next to `registerInitializeCommand` (src/activation/commands.ts:485-489) add:\n\n```ts\nexport function registerConfigPanelCommand(\n  context: vscode.ExtensionContext,\n  surface: Surface,\n): vscode.Disposable {\n  return vscode.commands.registerCommand(COMMANDS.openConfigPanel, () =>\n    runOpenConfigPanel(context, surface),\n  );\n}\n```\n\nand a private `runOpenConfigPanel(context, surface)` that mirrors `runInitialize` (src/activation/commands.ts:500-519):\n  1. `const folders = vscode.workspace.workspaceFolders ?? []` then `const root = resolveInitRoot(folders)` — reuse the existing private helper (src/activation/commands.ts:525-538) verbatim rather than duplicating the single-folder / one-.baiton-root rule; consider renaming it to something neutral like `resolveCommandRoot` since it now serves two commands, and update `runInitialize`'s call site and the helper's doc comment accordingly.\n  2. On `undefined` root, `surface.error('Baiton: Open Config Panel requires exactly one workspace folder (or one multi-root folder with a .baiton/ directory).')` and return — same shape as the Initialize refusal (Req 1.4, 22.5).\n  3. Otherwise compute `const baitonDir = vscode.Uri.joinPath(root, '.baiton').fsPath;` and call `openConfigPanel({ extensionUri: context.extensionUri, baitonDir, agentIds: createAdapterRegistry().ids, log: (m) => surface.log(m) })`. `createAdapterRegistry` is already imported at src/activation/commands.ts:81. Do NOT pass `applyConfig`: the post-save hot-reload seam is T08's scope, and `ConfigPanelController` already returns an honest 'could not be applied live' note when the seam is unset.\n  4. Push the returned `ConfigPanelProvider` onto `context.subscriptions` so the panel is disposed on deactivate. Guard against pushing the same provider twice on repeated invocations — `openConfigPanel` returns the cached singleton for a `baitonDir` that already has one — e.g. by tracking the providers this command has registered in a module-level `Set<ConfigPanelProvider>` (or by comparing against the previously returned instance) and only subscribing on first creation.\n  5. Import `openConfigPanel` and the `ConfigPanelProvider` type from `./configPanel`, alongside the existing `./openChat` / `./setApiKey` imports (src/activation/commands.ts:99-100).\n\nDo not also wire the command inside `registerCommands`: `vscode.commands.registerCommand` throws on a duplicate id, and this command is registered once, before the gate.",
      "files": [
        "src/activation/commands.ts",
        "src/activation/configPanel.ts",
        "src/activation/surface.ts"
      ]
    },
    {
      "title": "Register the command in extension.ts before the config-load gate",
      "detail": "In src/extension.ts, extend the import from './activation/commands' to `{ registerCommands, registerInitializeCommand, registerConfigPanelCommand }` and, immediately after the existing `context.subscriptions.push(registerInitializeCommand(surface));` line (before step 2 workspace resolution and before the step 4 `loadConfig` gate), add `context.subscriptions.push(registerConfigPanelCommand(context, surface));` with a comment explaining why it sits ahead of the gate: `activate` returns early on a workspace-resolution or config-load failure, and the panel's error state plus Reset to defaults is exactly what repairs an absent or unparseable `.baiton/config.json`. Registering it here — rather than inside `registerCommands` — also means it is never registered twice.",
      "files": [
        "src/extension.ts",
        "src/activation/commands.ts"
      ]
    },
    {
      "title": "Assert the contribution in the packaging test suite",
      "detail": "In the `Packaging` describe of test/activation.gating.test.ts (the block reading the real package.json at test/activation.gating.test.ts:368) add a case asserting that `contributes.commands` contains an entry with `command === 'baiton.openConfigPanel'`, `category === 'Baiton'` and `title === 'Open Config Panel'`, and that `contributes.menus.commandPalette` contains NO entry for that id (so the palette does not gate it on `baiton.activated`). A companion assertion that `baiton.initialize` is likewise absent from `commandPalette` documents the shared rule. Keep the existing file-header comment's coverage list up to date. Note that this suite has a PRE-EXISTING failure unrelated to this todo (the native-module scan trips over `node_modules/keytar` artifacts pulled in by the `@vscode/vsce` dependency, recorded in .baiton/specs/config-panel/review-2.md) — do not attempt to fix it here, but confirm the new case itself passes.",
      "files": [
        "test/activation.gating.test.ts",
        "package.json"
      ]
    },
    {
      "title": "Compile, lint, and run the suite",
      "detail": "Run `npm run compile`, `npm run lint`, and `npx mocha test/activation.gating.test.ts test/configPanel.controller.test.ts` plus the full `npm test`. Expect the two documented pre-existing failures only (the `keytar` native-module scan in activation.gating.test.ts and the `setApiKey.test.ts` 'before all' hook that cannot resolve the bare `vscode` specifier under the CommonJS mocha run); anything else is a regression from this todo. Also confirm `npm run copy:media` / `npm run package` still succeed, since the panel shell now becomes reachable and needs media/config.html and media/config.js shipped.",
      "files": [
        "package.json",
        "test/activation.gating.test.ts"
      ]
    }
  ],
  "risks": [
    "Duplicate command registration: `vscode.commands.registerCommand` throws if `baiton.openConfigPanel` is registered twice. Register it only in extension.ts before the gate, never additionally inside `registerCommands`.",
    "Palette gating: adding a `commandPalette` entry (even without a `when`) is unnecessary, and adding one with `when: baiton.activated` — copying the neighbouring entries — would hide the command in exactly the broken-config case it exists to fix, since `activate` never sets that context key when the gate fails.",
    "Provider lifecycle: `openConfigPanel` keeps a module-level singleton per `baitonDir` and returns the cached instance on re-invocation. Pushing the return value onto `context.subscriptions` unconditionally would accumulate duplicate subscriptions across repeated command invocations; subscribe only on first creation.",
    "Reusing the private `resolveInitRoot` means a rename or behaviour change affects Initialize too. Keep the rule identical (single folder, else the one multi-root folder containing `.baiton/`) and update `runInitialize`'s call site plus the doc comment in the same edit if the helper is renamed.",
    "Host-free testing of this glue is impractical: the `vscode` fake at test/fixtures/vscodeFake.mjs exposes only `window`, and would need `commands.registerCommand`, `workspace.workspaceFolders` and `Uri.joinPath` to load commands.ts — which itself pulls in the whole engine/orchestrator graph. The existing setApiKey.test.ts loader path is already failing under the CommonJS mocha run. Limit automated coverage to the package.json contribution assertions and verify the runtime behaviour manually in an Extension Development Host.",
    "The panel opens with no `applyConfig` seam until T08 lands, so a successful save reports that the running extension could not pick the values up live. That is the controller's existing honest-note path, not a defect of this todo, but a reviewer may read it as one.",
    "`context.extensionUri` must be the one passed to the register function; using a stale or derived URI would break the panel's `localResourceRoots` and leave the webview blank with a CSP violation."
  ],
  "acceptance": [
    "`package.json` declares `baiton.openConfigPanel` under `contributes.commands` with title \"Open Config Panel\" and category \"Baiton\", and has no `contributes.menus.commandPalette` entry for it.",
    "`COMMANDS.openConfigPanel === 'baiton.openConfigPanel'` in src/activation/commands.ts, and `registerConfigPanelCommand` is exported from that module.",
    "`registerConfigPanelCommand` resolves the workspace with the same rule as `runInitialize` (single folder, or the one multi-root folder containing `.baiton/`), surfacing an error through `Surface.error` and opening no panel on zero or ambiguous roots.",
    "On success the handler calls `openConfigPanel` with `context.extensionUri`, `<root>/.baiton` as `baitonDir`, and `createAdapterRegistry().ids` as `agentIds`; the created provider is disposed with the extension and is not double-subscribed on repeat invocations.",
    "src/extension.ts registers the command immediately after `registerInitializeCommand` — before workspace resolution and before the `loadConfig` gate — so invoking it in a folder with a missing or unparseable `.baiton/config.json` opens the panel in its error state with the Reset to defaults action reachable.",
    "The command is registered exactly once: it does not also appear in `registerCommands`.",
    "test/activation.gating.test.ts asserts the new contribution and its absence from the palette gating list, and passes.",
    "`npm run compile` and `npm run lint` pass clean; `npm test` shows no new failures beyond the two documented pre-existing ones (the keytar native-module scan and the setApiKey `vscode` module resolution).",
    "Manual check in an Extension Development Host: \"Baiton: Open Config Panel\" appears in the palette both in an initialized workspace and in one with no `.baiton/`; invoking it twice reveals the same panel rather than opening a second one."
  ]
}
```
