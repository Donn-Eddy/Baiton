# Execute T06

## Summary

Added the land_todo control tool (drive phase, mutating, requires a done todo, lands through the new LandTodoSeam), made submitPr refuse while any todo branch is unlanded (opt-in via deps.unlandedTodos, naming the todos), wired the land seam inside specWriter.apply and the unlanded gate in commands.ts, and updated the drive prompt stage table and scope text. Added tests for all three areas.

## Files changed

- `src/orchestrator/seams.ts`
- `src/orchestrator/toolServices.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/systemPrompt.ts`
- `src/engine/submitPr.ts`
- `src/activation/commands.ts`
- `test/registry.controlTools.test.ts`
- `test/submitPr.test.ts`
- `test/systemPrompt.test.ts`

## Commands run

- `npx tsc --noEmit -p .`
- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -rn "from 'vscode'" src/orchestrator src/engine`

## Notes

- npm run compile, npm run lint and npm test all pass (2536 passing, 1 pending).
- No vscode import was added under src/orchestrator or src/engine.
- The seam checks branch existence first, so an already-landed todo reports 'already landed' rather than a wrong-branch or dirty-tree refusal.
- The drive prompt line reads 'The next legal step follows...' (the plan's wording); existing tests only reference 'stage' in a test title, so nothing broke.
