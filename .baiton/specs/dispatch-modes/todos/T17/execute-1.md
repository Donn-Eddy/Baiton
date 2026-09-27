# Execute T17

## Summary

Closed the three behaviour gaps in the baiton.runs.* handlers and added the missing end-to-end proof. runRunsCancel now honours RunPipeline.cancel()'s boolean (warning instead of falsely reporting success when the stage finished first) and logs that the worktree and branch are kept; its doc comment states that the manifest reaches 'cancelled' asynchronously. runRunsViewDiff gains exported shortSha/runDiffRange helpers and names the <base commit>..<branch> range in both the showDiff title and the log. runRunsMerge logs the machine-readable refusal reason token next to the user-facing prose, and logs the post-merge worktree/branch removal; no user-facing string changed. commands.ts's showDiff seam now uses the title it previously dropped (logging it, since an untitled diff document cannot be renamed). test/runCommands.test.ts adds 8 cases driving all three handlers against real temporary git repos, a real RunStore/GitService and, for cancel, the real RunPipeline.

## Files changed

- `src/activation/runsExplorer.ts`
- `src/activation/commands.ts`
- `test/runsExplorer.test.ts`
- `test/runCommands.test.ts`

## Commands run

- `npx tsc -p . --noEmit`
- `npm run compile`
- `npx mocha test/runCommands.test.ts`
- `npx mocha`
- `npm run lint`
- `git status --porcelain`

## Notes

- tsc --noEmit and npm run compile are silent. npm run lint: 0 errors, 1 warning (the pre-existing '_legacy' at src/orchestrator/webviewProtocol.ts:622 — the plan said :591, the line has since shifted; same warning).
- Full suite: 2020 passing, 1 pending, 0 failing (the 2012 baseline plus the 8 new run-command cases).
- git status --porcelain lists exactly the four files above and no .baiton/runs/ or .baiton/worktrees/ residue — every new test works inside its own fs.mkdtempSync repo.
- Only one existing assertion changed: the runRunsViewDiff diff title in test/runsExplorer.test.ts, now 'bug run bug-1: aaa..baiton/bug/bug-1'. Every other assertion in that file passed untouched.
- Plan deviation (one assertion): the dirty-tree case asserts the warn contains 'uncommitted change' rather than 'README.md'. mergeRunWorktree's dirty-tree message is a count ('the working tree has 1 uncommitted change(s)…') and carries the paths only in error.changes, which the handler does not print; the reason token 'dirty-tree' is asserted on the log as planned.
- The worktree-registration helper compares git worktree list against both the created path and its realpath (macOS /var -> /private/var), and tolerates a removed parent directory.
- No change to src/model/runTreeModel.ts, src/engine/runWorktree.ts, src/engine/runPipeline.ts or package.json: legalRunActions, the refusal order and the cancel semantics are untouched, and runRunsViewDiff remains ungated on Restricted Mode.
