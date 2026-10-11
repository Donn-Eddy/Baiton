# Execute T06

## Summary

Implemented the T06 orchestrator plan and phase tool rename, legacy document compatibility, dual-root guard, and plan write tools.

## Files changed

- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `src/activation/vscodeAskWatcher.ts`
- `src/engine/planDraft.ts`
- `src/engine/runPipeline.ts`
- `src/engine/runQueue.ts`
- `src/engine/runStore.ts`
- `src/engine/submitPr.ts`
- `src/model/mode.ts`
- `src/orchestrator/autoMode.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/guard.ts`
- `src/orchestrator/index.ts`
- `src/orchestrator/readTools.ts`
- `src/orchestrator/registry.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/specWriteTools.ts`
- `src/orchestrator/planWriteTools.ts`
- `src/orchestrator/subAgent.ts`
- `src/orchestrator/systemPrompt.ts`
- `src/orchestrator/toolServices.ts`
- `test/askWatcher.routing.test.ts`
- `test/autoMode.evaluator.test.ts`
- `test/controlTools.invalidBlocks.property.test.ts`
- `test/guard.boundedRead.property.test.ts`
- `test/guard.idempotent.property.test.ts`
- `test/guard.pathContainment.property.test.ts`
- `test/guard.restrictedMode.property.test.ts`
- `test/integration.plan-execute-review.test.ts`
- `test/integration.run-modes.test.ts`
- `test/integration.sub-agent-chats.test.ts`
- `test/registry.assembleToolSpecs.test.ts`
- `test/registry.controlTools.test.ts`
- `test/runPipeline.test.ts`
- `test/runStore.test.ts`
- `test/specWriteTools.protectedState.property.test.ts`
- `test/planWriteTools.protectedState.property.test.ts`
- `test/subAgent.test.ts`
- `test/systemPrompt.mode.test.ts`
- `test/systemPrompt.subagent.test.ts`
- `test/systemPrompt.test.ts`
- `test/transcriptReader.test.ts`
- `test/webviewProtocol.reducer.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `rg -n 'draft_spec|approve_spec|land_todo|add_todo|edit_todo|remove_todo|list_specs|read_spec|DraftSpec|LandTodo|draftSpec|landTodo|createSpecWriteTools|specWriteTools|outside-specs' src test`
- `rg -nw 'spec|specs|Spec|todo|todos|Todo' src/orchestrator/controlTools.ts src/orchestrator/planWriteTools.ts src/orchestrator/guard.ts src/orchestrator/registry.ts src/orchestrator/readTools.ts src/orchestrator/toolServices.ts src/orchestrator/seams.ts src/orchestrator/autoMode.ts src/orchestrator/subAgent.ts`
- `git diff --check`
- `git status --short`

## Notes

- Full test suite passed: 2872 passing, 1 pending.
- Compile succeeded. Lint reported 0 errors and 1 existing unused-variable warning in src/orchestrator/webviewProtocol.ts:678.
- The banned-token sweep returned no matches. The orchestrator word sweep only returned the documented legacy compatibility references and persisted scope.kind === 'spec'.
