# Execute T09

## Summary

runToolLoop now runs maximal runs of consecutive concurrent-flagged tool calls in parallel (Promise.all per segment), runs other calls alone, and appends results in call order. Added Tool.concurrent, flagged the 8 read tools and run, added the ToolLoopDeps.isConcurrent seam, wired it in chatController, and added unit tests and an ordering/pairing property test.

## Files changed

- `src/orchestrator/guard.ts`
- `src/orchestrator/readTools.ts`
- `src/orchestrator/controlTools.ts`
- `src/orchestrator/toolLoop.ts`
- `src/activation/chatController.ts`
- `test/toolLoop.test.ts`
- `test/toolLoop.termination.property.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2576 passing, 1 pending, 0 failing. Lint: 0 errors, 1 pre-existing warning in webviewProtocol.ts.
- concurrent: true appears 8 times in readTools.ts and once in controlTools.ts (run); not in specWriteTools.ts.
- chatController wiring uses `definitions?.() ?? []` because existing test fakes of ToolRegistry have no definitions(); a plain call broke the chatController interventions tests.
- The optional abort property from the plan was not added; the main ordering/pairing property (invariants 1-7) was. Abort cases are covered by unit tests (e) and (f).
