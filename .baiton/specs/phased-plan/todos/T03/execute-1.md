# Execute T03

## Summary

Added kind-aware plan and legacy document resolution, migrated plan storage, listing, branch writing, journal, artifact, submit PR and initialization paths, and rewired callers and tests.

## Files changed

- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `src/activation/engineFacade.ts`
- `src/activation/specExplorer.ts`
- `src/activation/specLister.ts`
- `src/activation/specStore.ts`
- `src/activation/planLister.ts`
- `src/activation/planStore.ts`
- `src/config/gitignore.ts`
- `src/config/initialize.ts`
- `src/engine/index.ts`
- `src/engine/recovery.ts`
- `src/engine/resultFlow.ts`
- `src/engine/runQueue.ts`
- `src/engine/specBranchWriter.ts`
- `src/engine/stageContext.ts`
- `src/engine/submitPr.ts`
- `src/engine/planBranchWriter.ts`
- `src/extension.ts`
- `src/git/gitService.ts`
- `src/git/types.ts`
- `src/journal/entry.ts`
- `src/journal/index.ts`
- `src/journal/journal.ts`
- `src/orchestrator/readTools.ts`
- `src/schema/index.ts`
- `src/storage/documentLocation.ts`
- `test/askWatcher.routing.test.ts`
- `test/config.gitignore.test.ts`
- `test/config.test.ts`
- `test/documentLocation.test.ts`
- `test/engineFacade.resume.test.ts`
- `test/gitService.test.ts`
- `test/integration.plan-execute-review.test.ts`
- `test/integration.sub-agent-chats.test.ts`
- `test/journal.roundtrip.property.test.ts`
- `test/mode.test.ts`
- `test/planBranchWriter.test.ts`
- `test/planLister.test.ts`
- `test/planStore.test.ts`
- `test/recovery.revert.test.ts`
- `test/registry.controlTools.test.ts`
- `test/resultFlow.artifacts.test.ts`
- `test/runQueue.approvalGate.property.test.ts`
- `test/runQueue.attemptCount.property.test.ts`
- `test/runQueue.briefContext.test.ts`
- `test/runQueue.revert.property.test.ts`
- `test/runQueue.serialization.property.test.ts`
- `test/runQueue.worktree.test.ts`
- `test/schema.persistencePath.property.test.ts`
- `test/specBranchWriter.test.ts`
- `test/specStore.test.ts`
- `test/submitPr.test.ts`
- `test/treeModel.property.test.ts`
- `.baiton/runs/phased-plan-T03-execute-1-1791651560419/result.json`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test -- --grep 'Integration: Plan → Execute → Review|Integration: sub-agent chats|run queue per-todo worktrees'`
- `npm test`
- `rg -n 'createSpecStore|createSpecBranchWriter|readSpecJournal|specJournalPathFor|todoJournalPathFor|specJournalPaths|listSpecs|listTodoPlans|specFolderPathspec|SpecBranchWriter|\bSpecStore\b' src test`
- `git diff --check`

## Notes

- Full test suite passed: 2,848 passing, 1 pending.
- Focused Git-backed integration tests passed: 11 passing.
- Compile succeeded. Lint reported zero errors and one existing unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- The full test suite was run outside the sandbox because Git subprocesses failed with EPERM inside it.
