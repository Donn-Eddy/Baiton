# Plan T05

## Steps

1. Move the CatalogStore / ModelDiscoveryService construction above registerConfigPanel in src/extension.ts

   In `activate()` (src/extension.ts) the order today is: `const adapterRegistry = createAdapterRegistry();` (line ~186) -> `context.subscriptions.push(registerConfigPanel({...}))` (lines ~187-196) -> `registerConfigPanelCommand()` (line ~197) -> the `const catalogStore = new CatalogStore({...})` / `const discovery = new ModelDiscoveryService({...})` block plus `modelCatalogStore = catalogStore; modelDiscovery = discovery;` (lines ~199-219) -> the refreshModels command, the dispose disposable, the log subscription and `void discovery.refresh()` (lines ~221-242).

   Move ONLY the two constructions and the two module-level assignments so they sit immediately after `const adapterRegistry = createAdapterRegistry();` and BEFORE the `registerConfigPanel(...)` push. Leave the rest exactly where it is:

   - `context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.refreshModels, ...))`,
   - the `new vscode.Disposable(() => { discovery.dispose(); modelDiscovery = undefined; modelCatalogStore = undefined; })` push,
   - the `discovery.onDidChange((table) => surface.log(...))` push,
   - `void discovery.refresh();`

   stay after the `registerConfigPanel` / `registerConfigPanelCommand` pushes. Two reasons to keep them there: disposal runs in push order, so the config panel (whose controller subscribes to `discovery.onDidChange`) is torn down before the service it listens to; and `refresh()` must still be the last thing kicked off, after every subscriber exists, so the first `optionsChanged` cannot be lost.

   The moved block is unchanged apart from its position (same `CatalogStore({ memento: context.globalState, builtins: builtinCatalogFetches(), log })` and same `ModelDiscoveryService({ store: catalogStore, registry: adapterRegistry, cwd: () => getActivationState()?.workspace.root.fsPath, log })`). Nothing else in `activate()` reads `catalogStore`/`discovery` earlier, so no other reordering is needed; `context.globalState` is available from the first line of `activate()`.

   Files: `src/extension.ts`

2. Pass getCapabilities and onDidChangeCapabilities into registerConfigPanel

   Extend the `registerConfigPanel({...})` argument in src/extension.ts with the two live seams, keeping `capabilities: agentCapabilities()` as the static last-resort fallback the controller already prefers last (`ConfigPanelController.currentCapabilities()` resolves `getCapabilities()` -> `capabilities` -> `agentCapabilities()`):

   ```ts
   context.subscriptions.push(
     registerConfigPanel({
       extensionUri: context.extensionUri,
       resolveBaitonDir: resolveBaitonDirForCommands,
       agentIds: adapterRegistry.ids,
       capabilities: agentCapabilities(),
       // The live table: read per load/refresh, never frozen, so every
       // `applyResult` the discovery service lands reaches an open panel.
       getCapabilities: () => agentCapabilities(catalogStore.table()),
       onDidChangeCapabilities: (listener) => {
         const sub = discovery.onDidChange(() => listener());
         return new vscode.Disposable(() => sub.dispose());
       },
       log: (m) => surface.log(m),
       applyConfig: scopedApplyConfig,
     }),
   );
   ```

   Points to honour exactly:
   - `agentCapabilities(snapshots?: ModelCatalogTable)` (src/adapter/index.ts) overlays the snapshot table onto the curated builtins; `catalogStore.table()` is called INSIDE the closure so each `load()`/`refreshOptions()` re-reads the current snapshots.
   - `discovery.onDidChange` hands the listener a `ModelCatalogTable`; `RegisterConfigPanelDeps.onDidChangeCapabilities` takes a zero-arg listener, hence the `() => listener()` adapter. Wrapping the returned `{ dispose(): void }` in `new vscode.Disposable(...)` satisfies the declared `vscode.Disposable` return type (the same constructor already used at the discovery dispose push).
   - `registerConfigPanel` and `ConfigPanelController` need NO behavioural change: `registerConfigPanel` already spreads both deps conditionally and the controller already guards its single subscription in `start()`.
   - Do not remove `capabilities: agentCapabilities()`; a test (and the documented precedence) relies on the static fallback still being present.

   Files: `src/extension.ts`

3. Correct the doc comments that claim the wiring is a later/separate step

   Three comments now assert the opposite of the code and must be rewritten:

   1. src/activation/configPanel.ts, the `getCapabilities`/`onDidChangeCapabilities` block in `RegisterConfigPanelDeps` (around lines 206-215). Drop the sentence 'which is why `src/extension.ts` needs no change here - it builds the `CatalogStore`/`ModelDiscoveryService` AFTER calling `registerConfigPanel`, so that wiring is a separate step.' Replace with: both are optional (a caller passing neither keeps the static behaviour, which is what test/configPanel.view.test.ts does), and `src/extension.ts` DOES pass them - it builds the `CatalogStore`/`ModelDiscoveryService` before `registerConfigPanel` and binds `getCapabilities` to `agentCapabilities(store.table())` and `onDidChangeCapabilities` to `discovery.onDidChange`.

   2. src/extension.ts, the `getModelCatalogStore()` doc comment (around lines 116-122): 'the config panel and provider router read it in later todos' is stale - say the config panel reads it through the `getCapabilities` seam wired in `activate()`.

   3. src/extension.ts, the block comment above the `CatalogStore` construction (around lines 199-204): keep the 'ahead of the gate' rationale (refresh and `Baiton: Refresh Model Lists` must work in an uninitialized folder) and add the ordering guarantee this todo establishes: the store is built and seeded (rehydrated `cached` snapshots, else the curated `builtinCatalogFetches()`) BEFORE `registerConfigPanel`, so the panel's first `load()` already shows last known-good lists and every later `applyResult` reaches an open panel as `optionsChanged` without touching in-progress edits.

   Files: `src/extension.ts`, `src/activation/configPanel.ts`

4. Add the activation test that pins the host wiring

   src/extension.ts imports `vscode` at module scope and test/activation.gating.test.ts registers no `vscodeLoader.mjs` hook (its header states every module it touches is host-free), so the wiring is asserted over the module's SOURCE TEXT - the established pattern for host-only code in this repo (test/chatView.mode.test.ts and test/chatView.providers.test.ts read `media/*.js` the same way, and this same file already reads `package.json`/`LICENSE` from `REPO_ROOT`).

   Add a new `describe('config panel live catalog wiring (model-selector-refresh T05)')` block near the existing `describe('packaging gating ...')` section, reading `const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');` once in a `before`. Helper: slice the `registerConfigPanel({ ... })` call by scanning from `source.indexOf('registerConfigPanel({')` forward with a brace-depth counter to the matching `}`, so the assertions cannot be satisfied by text elsewhere in the file.

   Cases:
   1. 'builds the catalog store and discovery service before registering the config panel' - assert `source.indexOf('new CatalogStore(')` and `source.indexOf('new ModelDiscoveryService(')` are both >= 0 and both LESS than `source.indexOf('registerConfigPanel({')`.
   2. 'passes getCapabilities bound to the store table' - the sliced call text matches `/getCapabilities:\s*\(\)\s*=>\s*agentCapabilities\(\s*catalogStore\.table\(\)\s*\)/`.
   3. 'passes onDidChangeCapabilities bound to the discovery service' - the sliced call text contains `onDidChangeCapabilities:` and matches `/discovery\.onDidChange\(/`.
   4. 'keeps the static capabilities fallback' - the sliced call text matches `/capabilities:\s*agentCapabilities\(\)/`.
   5. 'still kicks the refresh off without awaiting it, after the panel is registered' - `source.indexOf('void discovery.refresh()')` is >= 0 and GREATER than `source.indexOf('registerConfigPanel({')`.

   Update the file's header comment ('Coverage:' list) with a bullet for this new block so the header keeps describing what the suite pins.

   Files: `test/activation.gating.test.ts`

5. Pin the ordering guarantee end to end in test/modelSelectorRefresh.test.ts

   The harness already wires the panel exactly as the host now does (`buildPanel` at ~line 451 passes `getCapabilities: () => agentCapabilities(harness.store.table())` and `onDidChangeCapabilities: (listener) => harness.discovery.onDidChange(listener)`), so only two edits are needed:

   1. Change the `buildPanel` doc comment from 'the way the host is documented to' to state that this mirrors the real wiring in `src/extension.ts` (`registerConfigPanel({ getCapabilities: () => agentCapabilities(catalogStore.table()), onDidChangeCapabilities: (l) => discovery.onDidChange(() => l()) })`).

   2. Add one case to the 'model selector refresh: reload refresh' describe (leg 1), titled roughly 'a seeded store reaches the panel's first loaded, and a later refresh arrives as optionsChanged only'. Shape it on the two existing leg-1 cases:
      - build a first harness over a fresh `fakeMemento()` and `await first.discovery.refresh()` so the memento holds real snapshots;
      - build a SECOND harness over the same memento (`buildDiscovery({ memento })`), whose store rehydrates in its constructor - i.e. the state the host is in when `registerConfigPanel` runs;
      - `buildPanel(second, dir)` over a dir written with `defaultConfigJson()`, then `await webview.send({ type: 'ready' })`;
      - assert `webview.loaded().length === 1`, that the first `loaded`'s `options.byAgent.claude.source` is `'cached'` (not `'builtin'`) and `stale === false`, and that its `models` equal `agentCapabilities(second.store.table()).claude.models` - the last known-good list is on screen before any fetch;
      - `await second.discovery.refresh()`, then assert `webview.loaded().length` is still 1 and `webview.optionsChanged().length >= 1`, and that the final `optionsChanged` carries `source: 'live'` for claude.
      Use the existing `newDir()`, `writeConfigFile()`, `fakeMemento()`, `tickingClock()` and `hasOwnKey()` helpers; the shared `afterEach` already disposes the services and temp dirs.

   Update the suite header's leg-1 description to mention that the panel's first `loaded` already shows the rehydrated list, i.e. the host builds the store before registering the panel.

   Files: `test/modelSelectorRefresh.test.ts`

6. Run the checks

   From the repo root: `npm run compile` (tsc, must be clean - the new `onDidChangeCapabilities` closure must typecheck against `vscode.Disposable`), `npm run lint` (eslint over src and test), and `npm test` (mocha over `test/**/*.test.ts`). At minimum the three suites this todo touches must pass: test/activation.gating.test.ts, test/modelSelectorRefresh.test.ts, test/configPanel.view.test.ts (it calls `registerConfigPanel` with neither seam and must keep working), plus test/configPanel.controller.test.ts and test/configPanel.mirror.test.ts, which pin the controller precedence this step relies on.

   Files: (none)

## Risks

- Disposal order: `context.subscriptions` are disposed in push order, so the config panel's registration must still be pushed BEFORE the `new vscode.Disposable(() => discovery.dispose())`. If the whole discovery block (not just the two constructions) is moved up, the service is disposed before the panel controller that subscribed to it; the controller tolerates that (`refreshOptions` is guarded by `disposed`), but the ordering intent is lost. Move only the constructions and the `modelCatalogStore`/`modelDiscovery` assignments.
- `void discovery.refresh()` must stay after the `registerConfigPanel` push. Moving it up with the constructions would let a fast source land `applyResult` before any listener is attached; the store keeps the snapshot, so nothing is corrupted, but the first `optionsChanged` would never be posted and the seeded-list assertion in the new end-to-end case would be racy.
- Type friction on the returned disposable: `ModelDiscoveryService.onDidChange` returns `{ dispose(): void }` while `RegisterConfigPanelDeps.onDidChangeCapabilities` declares `vscode.Disposable`. Wrap in `new vscode.Disposable(() => sub.dispose())` rather than returning the raw handle, so the build does not depend on structural assignability to the `vscode.Disposable` class.
- The config panel is registered ahead of the activation gate, so `getCapabilities` may run before any workspace is resolved. `catalogStore.table()` is safe then (the store is seeded in its constructor and needs no workspace), but `ModelDiscoveryService.cwd` stays a closure over `getActivationState()` — do not hoist it into a value while reordering.
- `registerConfigPanel` spreads `getCapabilities`/`onDidChangeCapabilities` conditionally to preserve the precedence for callers that pass neither; passing them from the host must not turn those spreads into unconditional properties, or test/configPanel.view.test.ts's two-arg `registerConfigPanel` calls and the `capabilities` fallback path change behaviour.
- The activation test asserts over source text, so a later refactor that renames the `catalogStore`/`discovery` locals or reformats the `registerConfigPanel` call will fail it. Keep the regexes tolerant of whitespace (as specified) and scope them to the sliced call block rather than the whole file.
- Leg 1 of test/modelSelectorRefresh.test.ts asserts specific discovered ids for claude/codex/opencode/antigravity that earlier todos in this spec changed. Do not adjust those expectations here; if one is already failing on this branch it belongs to the todo that changed the adapter, not to this wiring step.

## Acceptance

- In `src/extension.ts`, `new CatalogStore(...)` and `new ModelDiscoveryService(...)` both appear before the `registerConfigPanel({...})` call, and `modelCatalogStore`/`modelDiscovery` are assigned there.
- The `registerConfigPanel({...})` call passes `getCapabilities: () => agentCapabilities(catalogStore.table())` and `onDidChangeCapabilities` bound to `discovery.onDidChange`, while still passing `capabilities: agentCapabilities()` as the static fallback, `agentIds: adapterRegistry.ids`, `log` and `applyConfig: scopedApplyConfig`.
- The `COMMANDS.refreshModels` registration, the discovery dispose disposable, the `onDidChange` logging subscription and `void discovery.refresh()` are still registered after the panel registration, and `activate()` still never awaits discovery.
- No behavioural change to `registerConfigPanel` or `ConfigPanelController`: both seams are still optional and a caller passing neither still falls back to `capabilities` then `agentCapabilities()`.
- The doc comment in `src/activation/configPanel.ts` no longer claims `src/extension.ts` needs no change / that the wiring is a separate step, and the two stale comments in `src/extension.ts` (`getModelCatalogStore`, the catalog block) describe the new ordering guarantee.
- test/activation.gating.test.ts contains a new block asserting, over `src/extension.ts`'s source, the construction-before-registration ordering, both live seams inside the `registerConfigPanel` call, the retained static `capabilities` fallback, and that `void discovery.refresh()` follows the registration; its header 'Coverage:' list mentions it.
- test/modelSelectorRefresh.test.ts leg 1 has a case proving a memento-seeded store reaches the panel's first `loaded` as `source: 'cached'`, `stale: false` with the last known-good models, and that a subsequent `discovery.refresh()` produces `optionsChanged` (>= 1) with no second `loaded`; the `buildPanel` doc comment names `src/extension.ts` as the wiring it mirrors.
- `npm run compile`, `npm run lint` and `npm test` all pass.
