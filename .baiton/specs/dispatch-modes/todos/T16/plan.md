# Plan T16

## Steps

1. Create src/activation/runsExplorer.ts: the tree provider

   New file, the thin `vscode` glue over the already-finished pure model in `src/model/runTreeModel.ts` (imported through the `src/model` barrel: `buildRunTree`, types `RunGroupNode`, `RunNode`, `LiveRunStageFact`). Model it on `src/activation/specExplorer.ts` — same file-level doc-comment style, same debounce constant, same emitter/disposables/refreshSeq shape.

   Exports:

   1. `export const RUNS_VIEW_ID = 'baiton.runsView';` — the id contributed in package.json (mirror of `CONFIG_VIEW_ID` in configPanel.ts so a test can pin contribution parity).
   2. `export const RUNS_REFRESH_DEBOUNCE_MS = 500;`
   3. `export type RunTreeNode = { kind: 'group'; node: RunGroupNode } | { kind: 'run'; node: RunNode };`
   4. `export function runNodeTarget(node: RunTreeNode): string | undefined` — returns `node.node.runId` for a run node, `undefined` for a group (the analogue of `treeNodeTarget`).
   5. `export interface RunsPipelineFacts { onChange(listener: (event: RunPipelineEvent) => void): () => void; currentStage(): LiveRunStage | undefined; currentRunId(): string | undefined; cancel(): boolean; }` — a structural subset of `RunPipeline` (imported type-only from `../engine/runPipeline`) so tests can pass a fake. `RunPipeline` satisfies it without a cast.
   6. `export class RunsExplorer implements vscode.TreeDataProvider<RunTreeNode>, vscode.Disposable`.

   Constructor: `constructor(private readonly store: RunStore, private readonly runsDir: string, private readonly pipeline: RunsPipelineFacts, private readonly surface: Surface)` where `runsDir` is the absolute `.baiton/runs` directory (`runsRootDir(repoRoot)` from `../engine/runStore`) and `store` is the `RunStore` already built in commands.ts.

   `start(): this` (same shape as `SpecExplorer.start`):
     - create a `vscode.FileSystemWatcher` over `new vscode.RelativePattern(this.runsDir, '*/run.json')` and hook `onDidCreate`/`onDidChange`/`onDidDelete` to `scheduleRefresh()`; push the watcher on `this.disposables`. Do NOT set the `baiton.restricted` context key here — `SpecExplorer.start()` already publishes it and two writers would be redundant (say so in a comment).
     - subscribe to the pipeline: `this.disposables.push(new vscode.Disposable(this.pipeline.onChange(() => this.refreshNow())))` — pipeline events are authoritative and must not be debounced away (a `stage-started` must repaint the spinner immediately).
     - call `this.refreshNow()` and return `this`.

   `dispose()`: clear the debounce timer, dispose every disposable, dispose the emitter — copy `SpecExplorer.dispose` verbatim in structure.

   Refresh: `private scheduleRefresh()` debounces `RUNS_REFRESH_DEBOUNCE_MS` exactly as `SpecExplorer.scheduleRefresh`; `public refreshNow(): void` re-derives synchronously (no await: `RunStore.list()` is sync) — `const live = this.liveFact(); this.groups = buildRunTree(this.safeList(), live)` when `live !== undefined` else `buildRunTree(this.safeList())` — then `this.emitter.fire(undefined)`. `refreshNow` is public because the command handlers call it after a cancel/merge. No `refreshSeq` is needed since the listing is synchronous; drop that field.
     - `private safeList(): RunManifest[]` wraps `this.store.list()` in try/catch, logging through `this.surface.log('Baiton: could not list runs: …')` and returning `[]` — `list()` rethrows non-ENOENT readdir failures, and an unreadable runs dir must not break the view.
     - `private liveFact(): LiveRunStageFact | undefined` maps `this.pipeline.currentStage()` to `{ runId, stage, attempt }`, returning `undefined` when idle.

   `getChildren(element?)`: no element -> `this.groups.map((node) => ({ kind: 'group', node }))` (always exactly two); a group -> `element.node.runs.map((node) => ({ kind: 'run', node }))`; a run -> `[]`.

   `getTreeItem(element)`:
     - group: `new vscode.TreeItem(element.node.label, vscode.TreeItemCollapsibleState.Expanded)`, `item.contextValue = element.node.contextValue` (`baiton.runGroup.active|complete`), `item.description = String(element.node.runs.length)`, `item.iconPath = new vscode.ThemeIcon(element.node.kind === 'active' ? 'play-circle' : 'history')`.
     - run: `new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)` with `item.description = node.description`, `item.tooltip = node.tooltip`, `item.contextValue = node.contextValue` (straight from the model — never rebuilt here), `item.id = node.runId` and `item.iconPath = new vscode.ThemeIcon(runIconId(node))`.
     - `function runIconId(node: RunNode): string` (module-private, pure): `node.stage !== undefined` -> `'sync~spin'`; else by `node.state`: `merged` -> `'git-merge'`, `done` -> `'check'`, `answered` -> `'lightbulb'`, `cancelled` -> `'circle-slash'`, `failed` -> `'error'`, default -> `'circle-outline'`.

   No `item.command` on any node: click-to-open is not part of this todo (the Investigate finding is surfaced by the chat promote card).

   Files: `src/activation/runsExplorer.ts`, `src/model/runTreeModel.ts`

2. Add the three command handlers to runsExplorer.ts, with every host call injected

   Still in `src/activation/runsExplorer.ts`, below the class. These hold all the behaviour so they are unit-testable; commands.ts only registers them.

   ```ts
   export interface RunsCommandDeps {
     repoRoot: string;
     store: RunStore;
     git: GitWorktreeService;
     pipeline: RunsPipelineFacts;
     surface: Surface;
     /** True while the workspace is untrusted (Restricted Mode). */
     restricted: () => boolean;
     /** Show a unified diff to the user; supplied by commands.ts. */
     showDiff: (title: string, diff: string) => Promise<void>;
     /** Modal yes/no; supplied by commands.ts. */
     confirm: (message: string, action: string) => Promise<boolean>;
     /** Repaint the view after a state change. */
     refresh: () => void;
   }
   ```

   `export async function runRunsCancel(deps: RunsCommandDeps, runId: string | undefined): Promise<void>`
     - Restricted Mode first: `if (deps.restricted()) { deps.surface.warn('Baiton is read-only in Restricted Mode: trust this workspace to cancel a run.'); return; }` (same wording shape as `ensureNotRestricted`).
     - `const target = runId ?? deps.pipeline.currentRunId();` when still undefined -> `deps.surface.warn('Baiton: no run is in flight.')` and return.
     - `if (deps.pipeline.currentRunId() !== target) { deps.surface.warn(\`Baiton: run ${target} has no stage in flight to cancel.\`); return; }`
     - `deps.pipeline.cancel(); deps.surface.log(\`Baiton: cancel run ${target}\`); deps.refresh();` Do not remove the worktree or branch — `RunPipeline.cancel()` deliberately leaves both on disk.

   `export async function runRunsViewDiff(deps: RunsCommandDeps, runId: string | undefined): Promise<void>` — read-only, so NOT gated on Restricted Mode (mirrors `baiton.showPr` / `baiton.viewPlan`).
     - `runId === undefined` -> warn `'Baiton: no run selected.'` and return.
     - `const read = deps.store.read(runId); if (!read.ok) { deps.surface.error(\`Baiton: ${read.error.message}\`); return; }` (the store's messages are already user-facing and end in a period).
     - `const manifest = read.value;` if `manifest.worktreeDir === undefined` -> warn `\`Baiton: run ${runId} has no worktree, so there is no diff to show.\`` and return.
     - `if ((await deps.git.branchHead(manifest.branch)) === undefined)` -> warn `\`Baiton: the branch ${manifest.branch} for run ${runId} no longer exists.\`` and return (the case after a merge cleaned it up).
     - `let text: string; try { text = await deps.git.diff(manifest.baseHead, manifest.branch); } catch (e) { deps.surface.error(\`Baiton: could not diff ${manifest.branch} against ${manifest.baseHead}: ${describe(e)}.\`); return; }` — reuse a module-private `describe(e)` helper copied from specExplorer.ts.
     - `text.trim() === ''` -> `deps.surface.info(\`Baiton: run ${runId} changed nothing on ${manifest.branch}.\`)` and return; otherwise `await deps.showDiff(\`${manifest.mode} run ${runId}\`, text)`.

   `export async function runRunsMerge(deps: RunsCommandDeps, runId: string | undefined): Promise<void>`
     - Restricted Mode gate as in cancel (wording: '…to merge a run.').
     - `runId === undefined` -> warn and return; read the manifest as above.
     - Re-check the same rule `legalRunActions` encodes, as defence in depth: `if (manifest.state !== 'done' || manifest.worktreeDir === undefined) { deps.surface.warn(\`Baiton: run ${runId} is ${manifest.state}; only a run whose review passed can be merged.\`); return; }`
     - Confirm: `if (!(await deps.confirm(\`Merge ${manifest.branch} into ${manifest.baseBranch}? The run's worktree and branch are removed afterwards.\`, 'Merge'))) { return; }`
     - `const merged = await mergeRunWorktree({ workspaceRoot: deps.repoRoot, git: deps.git }, { runId, mode: manifest.mode, baseBranch: manifest.baseBranch, baseHead: manifest.baseHead, branch: manifest.branch, statement: manifest.statement });` (imported from `../engine`).
     - Refusal: `deps.surface.warn(\`Baiton: ${merged.error.message}\`)` — the refusal messages already name the reason (`wrong-branch`, `base-moved`, `dirty-tree`, `missing-branch`, `conflict`) — then `deps.refresh()` and return. Nothing is written to the manifest on a refusal.
     - Success: `deps.store.update(runId, { state: 'merged' })` (a failed update is logged through `deps.surface.warn` but does not undo the landed merge), then `deps.surface.info(\`Baiton: merged ${merged.value.branch} into ${merged.value.baseBranch} as ${merged.value.commit}.\`)`, log each `merged.value.cleanup` entry through `deps.surface.warn`, and `deps.refresh()`.

   Note in the doc comment why merge never touches the run pipeline: the run is complete, so there is no terminal and no lock to take.

   Files: `src/activation/runsExplorer.ts`, `src/engine/runWorktree.ts`, `src/engine/runStore.ts`

3. Wire the view and the commands in src/activation/commands.ts

   1. Command ids: add to the `COMMANDS` object — `runsCancel: 'baiton.runs.cancel'`, `runsViewDiff: 'baiton.runs.viewDiff'`, `runsMerge: 'baiton.runs.merge'`.
   2. Imports: `import { RunsExplorer, RUNS_VIEW_ID, runNodeTarget, runRunsCancel, runRunsMerge, runRunsViewDiff, type RunTreeNode, type RunsCommandDeps } from './runsExplorer';` and add `runsRootDir` to the existing `from '../engine'` import list (it is re-exported from `src/engine/runStore` through the barrel).
   3. Add a `runIdArg` normalizer beside the existing `slugArg`/`todoArgs` helpers: `function runIdArg(arg?: RunTreeNode | string): string | undefined { return typeof arg === 'string' ? arg : arg !== undefined ? runNodeTarget(arg) : undefined; }` — the tree passes the clicked node, the palette (if ever enabled) a run id.
   4. After the existing `// --- spec explorer tree provider …` block (so the `baiton.restricted` context key is already published by `SpecExplorer.start()`), add a `// --- runs view (design "dispatch modes") ---` block:
   ```ts
   const runsExplorer = new RunsExplorer(
     runStore,
     runsRootDir(repoRoot),
     runPipeline,
     surface,
   ).start();
   const runsDeps: RunsCommandDeps = {
     repoRoot,
     store: runStore,
     git,
     pipeline: runPipeline,
     surface,
     restricted: () => workspace.restricted,
     showDiff: async (title, diff) => {
       const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
       await vscode.window.showTextDocument(doc, { preview: true });
     },
     confirm: async (message, action) =>
       (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
     refresh: () => runsExplorer.refreshNow(),
   };
   disposables.push(
     vscode.window.registerTreeDataProvider(RUNS_VIEW_ID, runsExplorer),
     runsExplorer,
     vscode.commands.registerCommand(COMMANDS.runsCancel, (arg?: RunTreeNode | string) =>
       runRunsCancel(runsDeps, runIdArg(arg)),
     ),
     vscode.commands.registerCommand(COMMANDS.runsViewDiff, (arg?: RunTreeNode | string) =>
       runRunsViewDiff(runsDeps, runIdArg(arg)),
     ),
     vscode.commands.registerCommand(COMMANDS.runsMerge, (arg?: RunTreeNode | string) =>
       runRunsMerge(runsDeps, runIdArg(arg)),
     ),
   );
   ```
      `git` here is the existing main-checkout `createGitService(repoRoot)` instance — the merge and the diff must run in the main checkout, never in the worktree.
   5. Extend the file-level doc comment's bullet list with the Runs view entry (tree view + `.baiton/runs/*/run.json` watcher + the three `baiton.runs.*` commands), matching the style of the Spec_Explorer bullet.
   No other behaviour in commands.ts changes; do not touch the run pipeline construction, the lock wiring or `runningSlugs`.

   Files: `src/activation/commands.ts`, `src/activation/runsExplorer.ts`

4. Contribute the view, the commands and the menus in package.json

   1. `contributes.views.baiton`: insert `{ "id": "baiton.runsView", "name": "Runs", "type": "tree" }` BETWEEN `baiton.specExplorer` and `baiton.configPanel`, so the order becomes specExplorer, runsView, configPanel (the Runs view sits beside the Spec Explorer and the collapsed Configuration webview stays last).
   2. `contributes.commands`: append three entries, category `Baiton`, titles `Cancel Run` (`baiton.runs.cancel`), `View Run Diff` (`baiton.runs.viewDiff`), `Merge Run` (`baiton.runs.merge`).
   3. `contributes.menus.commandPalette`: add `{ "command": "baiton.runs.cancel", "when": "false" }` and the same for `viewDiff` and `merge`. All three need a run node, so they are tree-only; `when: "false"` keeps them out of the palette (VS Code shows every contributed command there by default).
   4. `contributes.menus.view/item/context`: add three entries whose `when` clauses match the tokens `runContextValue` already emits (`baiton.run.<group> cancel|viewDiff|merge`), with the Restricted-Mode negation only where the command acts:
   ```
   { "command": "baiton.runs.cancel",   "when": "view == baiton.runsView && viewItem =~ /\\bcancel\\b/ && baiton.activated && !baiton.restricted",   "group": "inline@0" },
   { "command": "baiton.runs.viewDiff", "when": "view == baiton.runsView && viewItem =~ /\\bviewDiff\\b/ && baiton.activated",                          "group": "inline@1" },
   { "command": "baiton.runs.merge",    "when": "view == baiton.runsView && viewItem =~ /\\bmerge\\b/ && baiton.activated && !baiton.restricted",    "group": "inline@2" }
   ```
   Keep the exact `viewItem =~ /\bX\b/` form the spec-explorer entries use (note the doubled backslashes in JSON). No `when` clause may re-encode which states allow which action — that rule lives only in `legalRunActions`.

   Files: `package.json`

5. Update the two package.json assertions in test/activation.gating.test.ts that the new view breaks

   `describe('packaging gating …')` contains the case `'contributes the Spec Explorer and bottom Configuration section to the activity bar in order and the Chat to the secondary side bar'`, which currently asserts `views.baiton?.map(v => v.id)` deep-equals `['baiton.specExplorer', 'baiton.configPanel']` and then reads the config view as `views.baiton?.[1]`. Both break once the Runs view is contributed. Make exactly two edits inside that case (and widen its title to mention the Runs view):
     - `assert.deepStrictEqual(views.baiton?.map((v) => v.id), ['baiton.specExplorer', 'baiton.runsView', 'baiton.configPanel']);`
     - `const configView = views.baiton?.find((v) => v.id === 'baiton.configPanel');` (find by id rather than by index, so a later view insertion cannot break it again), keeping the two following `type`/`visibility` assertions unchanged.
   Change nothing else in that file. This is a contribution-list fixture, not a Spec-mode acceptance test; the assertion is factually about the old contribution list and has to move with it.

   Files: `test/activation.gating.test.ts`

6. Extend test/fixtures/vscodeFake.mjs with the tree-view surface

   The Runs view glue needs four `vscode` members the fake does not export yet. Add them as concrete value classes/objects (like the existing `Disposable`/`ViewColumn`/`Uri`, no delegation through `globalThis.__vscodeFake`), so no existing test is affected:
     - `export class EventEmitter { constructor() { this.listeners = new Set(); } get event() { return (listener) => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); }; } fire(value) { for (const l of [...this.listeners]) l(value); } dispose() { this.listeners.clear(); } }`
     - `export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };`
     - `export class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }`
     - `export class ThemeIcon { constructor(id) { this.id = id; } }`
   Also add `registerTreeDataProvider: (viewId, provider) => fake().window.registerTreeDataProvider(viewId, provider)` to the exported `window` object (delegating, like its neighbours) so a future test can use it; nothing in this todo's tests must depend on it. `test/fixtures/vscodeFake.d.mts` needs matching declarations only if the TypeScript build references them — it is a `.d.mts` for the fake module, so add the four declarations there too if the file declares the other exports (check it and mirror its style).

   Files: `test/fixtures/vscodeFake.mjs`, `test/fixtures/vscodeFake.d.mts`

7. Add test/runsExplorer.test.ts

   New mocha file, loaded through the ESM loader hook exactly as `test/configPanel.view.test.ts` does it: in `before()`, `register(pathToFileURL(join(process.cwd(), 'test/fixtures/vscodeLoader.mjs')).href, pathToFileURL(join(process.cwd(), '/')).href)` from `node:module`, `await import('./fixtures/vscodeLoader.mjs')`, then `mod = await import('../src/activation/runsExplorer')`. Install a minimal `globalThis.__vscodeFake` in `beforeEach` covering `window.showTextDocument`/`showWarningMessage`/`showInformationMessage`/`showErrorMessage`, `commands.executeCommand`, and `workspace.createFileSystemWatcher` returning the four-method stub the config-panel test uses.

   Build manifests with a local `manifest(overrides)` helper (`version: 1`, `mode: 'bug'`, `composerMode: 'bug'`, `explicitMode: false`, `statement`, `files: []`, `baseBranch: 'main'`, `baseHead: 'aaa'`, `branch: 'baiton/bug/<id>'`, `state`, `attempts: { plan: 1, execute: 1, review: 1, investigate: 0 }`, `createdAt`/`updatedAt`) and a fake store `{ list: () => manifests, read: (id) => …, update: (id, patch) => … }` cast to `RunStore`, a fake pipeline implementing `RunsPipelineFacts` over recorded calls, and a `Surface`-shaped recorder `{ log, info, warn, error }` cast to `Surface`.

   Cases:
     1. `RUNS_VIEW_ID === 'baiton.runsView'` and `package.json`'s `contributes.views.baiton` contains that id (read the real file, the parity check `configPanel.view.test.ts` does for `CONFIG_VIEW_ID`).
     2. `package.json` contributes the three `baiton.runs.*` commands, and their `view/item/context` entries name `view == baiton.runsView`, the matching `\bcancel\b`/`\bviewDiff\b`/`\bmerge\b` token, and `!baiton.restricted` for cancel and merge but NOT for viewDiff.
     3. `start()` creates one watcher over the runs dir, hooks all three events, subscribes to the pipeline, and fires the first change event; `dispose()` disposes the watcher and unsubscribes (a later pipeline event repaints nothing).
     4. `getChildren()` returns exactly two group nodes (Active, Complete) with the model's `contextValue`s, and each group's children are its runs in input order.
     5. `getTreeItem` of a run node copies label/description/tooltip/contextValue straight off the model node, and picks `'sync~spin'` while a live stage names that run, `'check'` for `done`, `'git-merge'` for `merged`, `'error'` for `failed`.
     6. A throwing `store.list()` yields two empty groups and one logged line, not a throw.
     7. `runRunsCancel`: refuses under `restricted: () => true` with a warning and no `cancel()` call; refuses when `currentRunId()` differs from the target; cancels and refreshes when it matches; falls back to `currentRunId()` when the argument is undefined.
     8. `runRunsViewDiff`: warns for a run with no `worktreeDir`; warns when `branchHead(branch)` is `undefined`; calls `git.diff(baseHead, branch)` with exactly those arguments and hands the text to `showDiff`; reports an empty diff through `surface.info` without calling `showDiff`; and is NOT blocked by `restricted: () => true`.
     9. `runRunsMerge`: refuses under Restricted Mode; refuses a run whose state is not `done` or that has no worktree; a declined confirm calls neither `mergeRunWorktree` nor `store.update`; a refusal surfaces its message and leaves the manifest untouched; a success writes `{ state: 'merged' }` and reports the merge commit. Inject the merge by giving the deps a `git` fake whose `currentBranch`/`branchHead`/`status`/`merge`/`listWorktrees`/`removeWorktree`/`deleteBranch` drive `mergeRunWorktree` down the intended branch (its check order is `wrong-branch -> base-moved -> dirty-tree -> missing-branch -> merge`), against a temp dir for `repoRoot` so the worktree cleanup has a real path to probe.
   Give the file a doc comment in the repo's style listing the coverage, as `runTreeModel.test.ts` does.

   Files: `test/runsExplorer.test.ts`, `test/fixtures/vscodeLoader.mjs`, `test/configPanel.view.test.ts`

8. Verify

   Run, in order: `npx tsc -p . --noEmit`; `npm run compile`; `npx mocha` (the config's `spec` glob runs the whole suite, so a single-file invocation runs everything anyway — expect the previous total plus the new `runsExplorer` cases, with the two edited assertions in `activation.gating.test.ts` still passing); `npm run lint` (expect exactly the pre-existing `_legacy is assigned a value but never used` warning in `src/orchestrator/webviewProtocol.ts`); `git status --porcelain` (expect exactly `M package.json`, `M src/activation/commands.ts`, `M test/activation.gating.test.ts`, `M test/fixtures/vscodeFake.mjs` (+ `.d.mts` if edited), `?? src/activation/runsExplorer.ts`, `?? test/runsExplorer.test.ts`, and no `.baiton/runs/` or `.baiton/worktrees/` residue).

   Files: (none)

## Risks

- The existing case in test/activation.gating.test.ts asserts `contributes.views.baiton` deep-equals ['baiton.specExplorer','baiton.configPanel'] and reads the Configuration view at index 1, so contributing baiton.runsView necessarily fails it. The plan updates exactly those two assertions (and the case title); this is the one existing test file the todo must touch, and it is a contribution-list fixture rather than a Spec-mode acceptance test.
- test/fixtures/vscodeFake.mjs has no EventEmitter/TreeItem/TreeItemCollapsibleState/ThemeIcon, so runsExplorer.ts cannot be imported under the loader hook until they are added. Add them as concrete exports (not `fake()` delegates) so no existing fake installation breaks.
- `vscode.workspace.openTextDocument({ content, language: 'diff' })` and the modal `showWarningMessage` live in commands.ts (untestable host-free), so they must stay one-liners behind the injected `showDiff`/`confirm` seams; putting any decision logic there would leave it uncovered.
- `runsExplorer` is referenced by `runsDeps.refresh` before its own `const` finishes initializing only if the deps object is built above it — keep the `new RunsExplorer(...).start()` line first, and note that `refresh` is a lazily-invoked arrow, as the existing `isSpecBusy` precedent in commands.ts does.
- A merge mutates the base branch in the main checkout; `mergeRunWorktree` refuses on wrong-branch/base-moved/dirty-tree before touching git, but the modal confirm is the only user-facing gate, so its message must name both branches and say the worktree and branch are removed afterwards.
- `store.update(runId, { state: 'merged' })` runs after the merge has landed; if it fails, the branch is merged while the manifest still says `done` and the view would offer Merge again (which would then refuse with `base-moved`). Surface the update failure as a warning — do not attempt to undo the merge.
- The watcher pattern `*/run.json` also matches nothing inside launch directories (`<run-id>.<stage>.<n>/` hold brief.md/result.json, not run.json), so no extra filtering is needed; if a future launch layout changes, `isRunLaunchDirName` is the predicate to filter with.
- Restricted Mode: the `baiton.restricted` context key is published by `SpecExplorer.start()` only. If the Spec Explorer is ever removed or made lazy, the Runs menus lose their gate — the handlers' own `restricted()` check is the reason that would be a cosmetic, not a security, regression.

## Acceptance

- `npx tsc -p . --noEmit` and `npm run compile` are clean.
- `npm run lint` reports zero errors and only the pre-existing `_legacy` unused-variable warning in src/orchestrator/webviewProtocol.ts.
- `npx mocha` passes with zero failures: the previous suite total plus the new test/runsExplorer.test.ts cases; test/activation.gating.test.ts is the only pre-existing test file modified, and only its contributed-views assertions.
- package.json contributes `baiton.runsView` (type tree, name Runs) as the second entry of contributes.views.baiton, between baiton.specExplorer and baiton.configPanel.
- package.json contributes the commands baiton.runs.cancel, baiton.runs.viewDiff and baiton.runs.merge with category Baiton, each with a `commandPalette` entry whose `when` is "false".
- The three `view/item/context` entries are scoped `view == baiton.runsView`, match the model's tokens with `viewItem =~ /\bcancel\b/`, `/\bviewDiff\b/`, `/\bmerge\b/`, and include `&& !baiton.restricted` for cancel and merge but not for viewDiff.
- src/activation/runsExplorer.ts carries no rule about which states allow which action: every label, description, tooltip and contextValue comes from buildRunTree/RunNode, and legalRunActions is never re-implemented.
- RunsExplorer repaints on a `.baiton/runs/*/run.json` filesystem event (debounced ~500 ms) and immediately on every RunPipeline change event; `dispose()` releases the watcher, the pipeline subscription and the pending timer.
- A run with a live stage renders a spinner and offers Cancel; a `done` run with a worktree offers View diff and Merge; a `merged` run and an `answered` investigate run offer neither.
- runRunsCancel and runRunsMerge refuse under Restricted Mode with a warning and no side effect; runRunsViewDiff works under Restricted Mode (it only reads).
- A successful merge lands through mergeRunWorktree, sets the manifest state to `merged`, reports the merge commit, surfaces any cleanup warnings, and repaints the view; every refusal reason reaches the user verbatim and leaves the manifest unchanged.
- Nothing under .baiton/specs/ is read or written by the new code, and `git status --porcelain` after the verification run lists only this todo's files.
