# Execute T04

## Summary

Renamed the worktree and execution engine to phase/plan vocabulary while preserving legacy branch namespaces and persisted journal keys.

## Files changed

- `src/activation/commands.ts`
- `src/activation/engineFacade.ts`
- `src/activation/planStore.ts`
- `src/activation/surface.ts`
- `src/activation/vscodeAskWatcher.ts`
- `src/engine/index.ts`
- `src/engine/launcher.ts`
- `src/engine/phaseWorktree.ts`
- `src/engine/recovery.ts`
- `src/engine/runContext.ts`
- `src/engine/runPipeline.ts`
- `src/engine/runQueue.ts`
- `src/engine/runStore.ts`
- `src/engine/stageContext.ts`
- `src/engine/submitPr.ts`
- `src/engine/todoWorktree.ts (renamed)`
- `src/engine/transitions.ts`
- `src/extension.ts`
- `src/git/types.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/seams.ts`
- `test/askWatcher.routing.test.ts`
- `test/engine.specDraft.test.ts`
- `test/engineFacade.resume.test.ts`
- `test/integration.plan-execute-review.test.ts`
- `test/integration.run-modes.test.ts`
- `test/integration.sub-agent-chats.test.ts`
- `test/phaseWorktree.test.ts`
- `test/recovery.revert.test.ts`
- `test/registry.controlTools.test.ts`
- `test/runCommands.test.ts`
- `test/runPipeline.test.ts`
- `test/runQueue.approvalGate.property.test.ts`
- `test/runQueue.attemptCount.property.test.ts`
- `test/runQueue.briefContext.test.ts`
- `test/runQueue.revert.property.test.ts`
- `test/runQueue.serialization.property.test.ts`
- `test/runQueue.worktree.test.ts`
- `test/stageContext.confinement.property.test.ts`
- `test/stageContext.test.ts`
- `test/submitPr.test.ts`
- `test/todoWorktree.test.ts (renamed)`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git diff --check`
- `rg -n "todoWorktree|TodoWorktree|todoBranchFor|todoLandMessage|unlandedTodos|createTodoGitService|isTodoWorktreeKey|TodoLand|findTodoWorktree|TodoStageWorkspace|spec-write-failed|isSpecBusy|PR_TODO_ID|checkSpecGuards" src test`
- `rg -nw "todo|todos|Todo|spec|Spec" src/engine/phaseWorktree.ts src/engine/runQueue.ts src/engine/stageContext.ts src/engine/recovery.ts src/engine/transitions.ts src/engine/launcher.ts src/engine/runContext.ts src/engine/runStore.ts src/engine/runPipeline.ts src/engine/index.ts`

## Notes

- Compile succeeded. The full test suite passed: 2,854 passing and 1 pending.
- Lint reported zero errors and one warning in unchanged src/orchestrator/webviewProtocol.ts:678.
- The Git index is read-only in this worktree, so filesystem renames appear as deletes and new files for the extension to detect.
