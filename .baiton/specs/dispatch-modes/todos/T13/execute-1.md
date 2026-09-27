# Execute T13

## Summary

Added the pure Runs tree model. src/model/runTreeModel.ts (no vscode import, no I/O) exports buildRunTree/buildRunNode plus the derivation helpers runStageFor, runOutcomeLabel, runStatementText, runStatementLabel, legalRunActions and runContextValue, the RunNode/RunGroupNode/RunActionInput/LiveRunStageFact interfaces, the RunAction/RunGroupKind vocabulary, RUN_ACTIONS, RUN_LABEL_MAX_CHARS and RUN_OUTCOME_MESSAGE_MAX_CHARS. buildRunTree always returns exactly two groups (Active then Complete, both present when empty, input order preserved inside each), splitting on the imported isRunComplete rather than a re-implementation. Each node carries mode, one-lined statement, truncated label, branch/baseBranch, state, hasWorktree/worktreeDir, a live stage+attempt or an outcomeLabel, a multi-line tooltip, its legal actions and a `baiton.run.<group> <action>…` contextValue matching specContextValue/todoContextValue's token shape. The module is re-exported from the src/model barrel and covered by 18 new mocha cases.

## Files changed

- `src/model/runTreeModel.ts`
- `src/model/index.ts`
- `test/runTreeModel.test.ts`

## Commands run

- `npm run compile`
- `npx mocha --grep runTreeModel`
- `npm test`
- `npm run lint`
- `git status --porcelain`

## Notes

- npm run compile is clean: no new barrel name collides (RunMode still comes from ./mode; RunManifest/RunStage are imported type-only and not re-exported).
- npx mocha --grep runTreeModel: 18 passing. Full npm test: 1977 passing, 1 pending — up by exactly the 18 new cases from the 1959 the suite carried before; no existing test file was modified.
- npm run lint reports only the pre-existing '_legacy is assigned a value but never used' warning in src/orchestrator/webviewProtocol.ts. It sits at line 622 in the current tree, not the 591 the plan quoted; the warning itself is untouched by this todo.
- git status --porcelain shows exactly 'M src/model/index.ts', '?? src/model/runTreeModel.ts', '?? test/runTreeModel.test.ts'.
- Action rules are implemented as the plan fixed them: cancel only for an active run with a live stage, viewDiff for a complete non-merged run with a worktree, merge only for a `done` run with a worktree. Changing them later is a one-line edit in legalRunActions plus its test — package.json `when` clauses never encode the rule, only the tokens.
- The live-stage fact is the sole source of a running stage (a stale fact naming a complete run is ignored), pinned by the case where a `confirmed` investigate run with a live investigate fact reports stage 'investigate'.
- Nothing in package.json, src/activation/ or any view glue is touched; the baiton.runsView contribution, watcher and commands come later and will consume this model.
