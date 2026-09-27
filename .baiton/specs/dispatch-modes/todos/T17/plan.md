# Plan T17

## Steps

1. Orient: the three handlers already exist; T17 closes their behaviour gaps and proves them end to end

   Read, do not rewrite: `src/activation/runsExplorer.ts` already exports `runRunsCancel`, `runRunsViewDiff`, `runRunsMerge` and `RunsCommandDeps`; `src/activation/commands.ts` (around lines 930-972) already builds `RunsExplorer`, the `runsDeps` seams (`showDiff`, `confirm`, `refresh`, `restricted`) and registers `baiton.runs.cancel|viewDiff|merge` via `runIdArg`; `src/engine/runWorktree.ts` already implements `mergeRunWorktree` with the pinned refusal order wrong-branch -> base-moved -> dirty-tree -> missing-branch -> conflict plus post-merge `removeRunWorktree` cleanup, and `src/engine/runPipeline.ts`'s `cancel()` disposes the live terminal and records `state: 'cancelled'` while deliberately leaving the worktree and branch on disk. `src/model/runTreeModel.ts`'s `legalRunActions` is the single definition of which action is legal (cancel only while a stage is live; viewDiff on a complete, non-merged run with a worktree; merge only on `done` + worktree) and must NOT be duplicated or relaxed. So T17 makes NO new architecture: it (a) tightens three small behaviour gaps in the handlers, (b) uses the diff title that is currently dropped, and (c) adds the missing end-to-end proof against real temporary git repositories. Do not change `runTreeModel.ts`, `package.json` menus, or `runWorktree.ts` refusal semantics.

   Files: `src/activation/runsExplorer.ts`, `src/activation/commands.ts`, `src/engine/runWorktree.ts`, `src/engine/runPipeline.ts`, `src/model/runTreeModel.ts`

2. Cancel: honour the pipeline's cancel result and state the kept worktree in the log

   In `runRunsCancel` (src/activation/runsExplorer.ts), replace the bare `deps.pipeline.cancel();` with a checked call:

     const disposed = deps.pipeline.cancel();
     if (!disposed) {
       deps.surface.warn(`Baiton: run ${target} has no stage in flight to cancel.`);
       return;
     }
     deps.surface.log(`Baiton: cancel run ${target}; its worktree and branch are kept.`);
     deps.refresh();

   This closes the race where `currentRunId()` reported a run but the stage finished before `cancel()` ran (the pipeline then returns false and nothing was disposed, yet today a success line is logged). Keep the existing Restricted-Mode refusal, the `runId ?? deps.pipeline.currentRunId()` fallback and the `currentRunId() !== target` refusal exactly as they are, including their message strings — existing tests pin them verbatim. Extend the handler doc comment with the one fact that is currently implicit: the manifest reaches `cancelled` asynchronously, written by `RunPipeline` when the disposed terminal makes `awaitStageResult` resolve `closed`; the view repaints again off the pipeline's `completed` event, so the handler's own `refresh()` is only the immediate spinner-clearing paint. Do not call `removeRunWorktree` here.

   Files: `src/activation/runsExplorer.ts`

3. View diff: name the `<base commit>..<branch>` range in the title and the log

   In src/activation/runsExplorer.ts add two small exported helpers next to the handlers and use them in `runRunsViewDiff`:

     /** A commit abbreviated for a user-facing label; short shas are left alone. */
     export function shortSha(sha: string): string { return sha.length > 7 ? sha.slice(0, 7) : sha; }

     /** The diff range a run's View diff opens: `<base commit>..<branch>`. */
     export function runDiffRange(manifest: RunManifest): string { return `${shortSha(manifest.baseHead)}..${manifest.branch}`; }

   The call at the end of the handler becomes:

     const range = runDiffRange(manifest);
     deps.surface.log(`Baiton: diff for run ${runId}: ${range}.`);
     await deps.showDiff(`${manifest.mode} run ${runId}: ${range}`, text);

   Keep `deps.git.diff(manifest.baseHead, manifest.branch)` as the diff call — `git diff A B` is exactly the `A..B` comparison the todo names — and keep the four early returns and their message strings unchanged (`no run selected`, `has no worktree, so there is no diff to show`, `the branch <branch> for run <id> no longer exists`, `run <id> changed nothing on <branch>`). Leave the handler ungated on Restricted Mode: it is read-only, like `baiton.showPr`.

   Files: `src/activation/runsExplorer.ts`

4. Merge: log the refusal reason token and the cleanup that landed

   In `runRunsMerge` (src/activation/runsExplorer.ts), keep every user-facing `warn`/`info` string and the confirm text byte-for-byte (tests pin them), and add diagnostics only on the log channel:

   - in the `!merged.ok` branch, before the existing `deps.surface.warn(...)`, add `deps.surface.log(`Baiton: merge refused for run ${runId} (${merged.error.reason}).`);` so the machine-readable reason (`wrong-branch`, `base-moved`, `dirty-tree`, `missing-branch`, `conflict`, `git`) reaches the output channel next to the prose the user sees. Nothing is written to the manifest on any refusal — leave that as is, and keep the `deps.refresh()` + `return`;
   - after the successful `deps.store.update(runId, { state: 'merged' })` block, add `deps.surface.log(`Baiton: removed the worktree and branch ${merged.value.branch} for run ${runId}.`);` — the removal is done by `mergeRunWorktree`'s cleanup step, so this only reports it.

   Do not add a second `info`: the existing merge test deep-equals `surface.infos` to a single line. Keep the defence-in-depth `state !== 'done' || worktreeDir === undefined` guard and its message; `legalRunActions` stays the authority.

   Files: `src/activation/runsExplorer.ts`

5. commands.ts: actually use the diff title the seam carries

   In src/activation/commands.ts the `showDiff` seam currently drops its first argument (`showDiff: async (_title, diff) => {...}`), which is why the underscore was needed to satisfy `noUnusedParameters` (a noted T16 deviation). Now that the title carries the `<base commit>..<branch>` range, use it:

     showDiff: async (title, diff) => {
       const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
       await vscode.window.showTextDocument(doc, { preview: true });
       surface.log(`Baiton: opened ${title}.`);
     },

   Keep the untitled document (an untitled `diff` document cannot be renamed; that limitation is why the range is carried in the title/log rather than the tab name) and update the comment above the seam to say so. No other change in commands.ts: the `git` service passed in is already the main-checkout one (the merge and the diff must never run inside a run's worktree), `restricted: () => workspace.restricted` is already read per call, `refresh: () => runsExplorer.refreshNow()` is already lazy, and the three registrations plus `runIdArg` already normalize a clicked `RunTreeNode` or a plain run id.

   Files: `src/activation/commands.ts`

6. Update the one existing assertion the title change touches

   In test/runsExplorer.test.ts, the `runRunsViewDiff` case asserts `shown.diffs` deep-equals `[{ title: 'bug run bug-1', diff: 'diff --git a/x b/x\n' }]`. With the manifest fixture's `baseHead: 'aaa'` and branch `baiton/bug/bug-1`, the expected title becomes `'bug run bug-1: aaa..baiton/bug/bug-1'`. Change only that string. Every other assertion in that file — including `diffArgs` deep-equalling `[['aaa', 'baiton/bug/bug-1']]`, the empty-diff `infos`, the cancel warnings and the merge `updates`/`infos` — must still pass untouched; if any other assertion fails, the handler change went too far and should be narrowed rather than the test loosened. Do not touch any other existing test file.

   Files: `test/runsExplorer.test.ts`

7. New test file: the three commands end to end against real temp git repos

   Add test/runCommands.test.ts, titled `run commands (design "dispatch modes", todo T17)`. It is the missing proof: T16's cases drive the handlers through stubbed git, so nothing yet shows a real branch merged, a real worktree removed, or a real worktree kept after a cancel.

   Harness (model the repo helper on test/runWorktree.test.ts, and the loader `before()` on test/runsExplorer.test.ts):
   - `before()`: `register(pathToFileURL(join(root,'test/fixtures/vscodeLoader.mjs')).href, ...)`, `await import('./fixtures/vscodeLoader.mjs')`, then `mod = await import('../src/activation/runsExplorer')`. Importing the module needs no installed fake (only `RunsExplorer`'s construction touches `vscode`), but install a minimal `globalThis.__vscodeFake` in `beforeEach` anyway so a stray call fails loudly rather than mysteriously.
   - `makeRepo()`: `fs.mkdtempSync`, `git init -q`, local `user.name`/`user.email`, `checkout -b main`, a committed `README.md` and a committed `.baiton/.gitignore` holding `GITIGNORE_CONTENTS` (load-bearing: without it `.baiton/worktrees/` makes the tree dirty and every merge refuses `dirty-tree`). Track repos in an array and `fs.rmSync(..., {recursive:true,force:true})` in `afterEach`.
   - `deps(repo, overrides)`: a real `createRunStore({ workspaceRoot: repo })`, a real `createGitService(repo)` as `git`, `repoRoot: repo`, a recording `Surface` (logs/infos/warns/errors arrays), a recording `showDiff`, a `confirm` returning a per-case boolean and recording its message, a `refresh` counter, `restricted: () => false`, and a fake `RunsPipelineFacts` (`onChange` no-op returning a disposer, `currentStage`/`currentRunId` returning undefined, `cancel` returning false) for the merge/diff cases.
   - `seedDoneRun(repo, store, runId)`: `createRunWorktree({workspaceRoot: repo, git}, {runId, mode:'bug', ...})`, write and commit a file inside the returned `worktreeDir` (use `execFileSync('git', [...], {cwd: worktreeDir})`), then `store.create({...})` with the real `baseBranch`/`baseHead`/`worktreeDir` from the create result and `store.update(runId, { state: 'done' })`.

   Cases:
   1. Merge success: `runRunsMerge` with `confirm: true` -> main's HEAD is a merge commit (two parents) whose message contains `Run-Id: <runId>`; the run's file is present in the main checkout; `.baiton/worktrees/<runId>` no longer exists; `git worktree list` no longer names it; `git branch --list baiton/bug/<runId>` is empty; `store.read(runId)` is `state: 'merged'` with `completedAt` set; exactly one `info` naming the merge commit; no `warn`; `refresh` called once; `git status --porcelain` in the main checkout is empty.
   2. Merge refusals, one repo each, asserting the named reason reaches the user, the manifest is still `done`, and the worktree dir and branch are both still on disk: `wrong-branch` (`git checkout -q -b side` in the main checkout before merging; the warn names `side` and the log names `wrong-branch`); `base-moved` (an extra commit on main after the run started); `dirty-tree` (append to the tracked `README.md`). Also assert main's HEAD is unchanged in each.
   3. Declined confirm: `confirm: false` on a seeded done run leaves the branch, the worktree, the manifest state and main's HEAD untouched and records no `info`.
   4. View diff: on the seeded run, `runRunsViewDiff` passes a diff whose text equals `git diff <baseHead> <branch>` run directly in the repo, names the committed file, and carries the title `bug run <runId>: <shortSha>..baiton/bug/<runId>`; then merge the run and assert a second `runRunsViewDiff` warns that the branch no longer exists and shows nothing.
   5. Cancel end to end with the REAL pipeline: build `createRunPipeline` over the temp repo with a real `createRunStore` and `createGitService(repo)`, a stub adapter that probes ok, a stub `TerminalHost` recording `dispose()`, and a stub `ResultWatcherFactory` (model all three on test/runPipeline.test.ts's `StubAdapter`/`StubTerminalHost`/`StubWatcherFactory`; poll with a real 2 ms timer, not `setImmediate`, so the real `git` child processes keep up). `start()` a `bug` run, wait for the plan stage's watcher, call `mod.runRunsCancel(deps, runId)` with `pipeline` being the real pipeline, then close the terminal and await the start's `completed` promise. Assert: the stage terminal was disposed once; the manifest is `state: 'cancelled'` with `outcome.kind === 'cancelled'`; `.baiton/worktrees/<runId>` STILL exists and `git worktree list` still names it; `baiton/bug/<runId>` still exists; main's HEAD is unchanged and its tree clean; the handler logged the cancel line and warned nothing.
   6. Cancel refusals against the real pipeline: `restricted: () => true` cancels nothing and leaves the worktree, the branch and the manifest state alone; cancelling a run id the pipeline is not driving warns and disposes nothing.

   Files: `test/runCommands.test.ts`

8. Verify

   Run, in order: `npx tsc -p . --noEmit`; `npm run compile`; `npx mocha test/runCommands.test.ts test/runsExplorer.test.ts test/runWorktree.test.ts test/runPipeline.test.ts test/runTreeModel.test.ts`; `npm run lint`; the full `npx mocha` (or `npm test`); `git status --porcelain`. Expect: tsc and compile silent; lint reporting zero errors and only the pre-existing `'_legacy' is assigned a value but never used` warning at src/orchestrator/webviewProtocol.ts:591; the full suite at the current 2012-passing / 1-pending baseline plus the new cases, with zero failures; and `git status --porcelain` listing exactly src/activation/runsExplorer.ts, src/activation/commands.ts, test/runsExplorer.test.ts and the new test/runCommands.test.ts, with no `.baiton/runs/` or `.baiton/worktrees/` residue in this repository (every test works inside its own `fs.mkdtempSync` repo). Do not commit, stash, or change branches.

   Files: (none)

## Risks

- The temptation to re-implement T17 from scratch: all three handlers, the merge primitive and the pipeline cancel already exist. Rewriting them would break the T16 assertions that pin their exact message strings. Every change here is additive or a one-line tightening.
- Message-string churn. test/runsExplorer.test.ts deep-equals `surface.warns`, `surface.infos` and `diffs` in several places. Only the diff title may change; anything new goes on `surface.log`, which no existing assertion inspects. Adding an `info` to the merge success path would break a deep-equal.
- A temp repo without a committed `.baiton/.gitignore` holding GITIGNORE_CONTENTS makes the worktree directory an untracked change, so `mergeRunWorktree` refuses `dirty-tree` in every case. Commit that file in the fixture repo, as test/runWorktree.test.ts does.
- The real-pipeline cancel case is timing sensitive: the manifest becomes `cancelled` only after the disposed terminal makes the stage resolve, so the assertions must await the `completed` promise rather than assert straight after `runRunsCancel` returns. Poll on a real timer (~2 ms), never `setImmediate`, or the real `git` child processes lose the race.
- Restricted Mode gating must not drift: cancel and merge refuse, View diff does not (it is read-only, and the `view/item/context` `when` clauses in package.json already encode exactly that). Do not add a Restricted-Mode guard to `runRunsViewDiff` and do not touch the menus.
- Merging removes the branch, so a `viewDiff` after a merge must stay a warning, not an error — `legalRunActions` already withholds `viewDiff` from a `merged` run; the handler's `branchHead === undefined` check is the fallback for a palette/stale invocation and must be kept.
- `git worktree list` reports realpaths, which differ from the created path under a symlinked temp dir (macOS `/var` -> `/private/var`). Compare through `fs.realpathSync` when asserting worktree registration, as runWorktree.ts itself does.
- A failed manifest write after a landed merge is reported but never rolled back (re-merging would then refuse `base-moved`). Keep that behaviour; do not try to undo a merge.

## Acceptance

- Cancel: `runRunsCancel` refuses in Restricted Mode, refuses a run with no stage in flight (including when `RunPipeline.cancel()` returns false), and otherwise disposes the in-flight stage's terminal; the run's manifest ends `state: 'cancelled'` and its `.baiton/worktrees/<run-id>` directory, its registration in `git worktree list` and its `baiton/<mode>/<run-id>` branch are all still present, with the main checkout's HEAD unchanged and its tree clean.
- View diff: `runRunsViewDiff` diffs `<manifest.baseHead>` against `<manifest.branch>` (i.e. `<base commit>..<branch>`), hands the text to the `showDiff` seam under a title naming that range, and logs the range; it warns instead for no selection, a run with no worktree, a branch that no longer exists, and an empty diff. It works in Restricted Mode.
- Merge: `runRunsMerge` refuses in Restricted Mode, refuses a run that is not `done` or has no worktree, asks for confirmation naming the run branch and the base branch, and merges nothing when the confirmation is declined.
- Merge refusals surface the reason: a `wrong-branch`, `base-moved` or `dirty-tree` refusal reaches the user as `mergeRunWorktree`'s own message, logs the reason token, writes nothing to the manifest, and leaves the run branch, the worktree and the base branch's HEAD untouched.
- Merge success: the base branch gains a merge commit carrying the `Run-Id: <run-id>` trailer, the worktree directory and its registration and the run branch are all gone, the manifest is `state: 'merged'`, and cleanup warnings (if any) are surfaced without failing the merge.
- No rule about which action is legal for which run state is duplicated in the handlers: `legalRunActions`/`runContextValue` in src/model/runTreeModel.ts and the `view/item/context` `when` clauses stay unchanged, and src/engine/runWorktree.ts's refusal order and src/engine/runPipeline.ts's cancel semantics stay unchanged.
- test/runCommands.test.ts proves all of the above against real temporary git repositories and a real `RunStore`/`GitService`, leaving no `.baiton/runs/` or `.baiton/worktrees/` residue in this repository.
- `npx tsc -p . --noEmit` and `npm run compile` are silent; `npm run lint` reports zero errors and only the pre-existing webviewProtocol `_legacy` warning; the full mocha suite passes with zero failures at the existing baseline plus the new cases; the only existing test file modified is test/runsExplorer.test.ts, and only its diff-title assertion.
