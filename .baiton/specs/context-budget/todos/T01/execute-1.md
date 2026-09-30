# Execute T01

## Summary

Added host-free toHistory (plus moved interventionHistoryText/describeAnswer) to transcriptReader.ts; ChatController.loadHistory now uses it and the local replay helpers were deleted. Added unit, regression (2026-09-30 shape) and fast-check property tests, plus a controller-level reload test.

## Files changed

- `src/orchestrator/transcriptReader.ts`
- `src/activation/chatController.ts`
- `test/transcriptReader.test.ts`
- `test/chatController.interventions.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep vscode src/orchestrator/transcriptReader.ts`
- `grep toChatMessage|interventionHistoryText|describeAnswer src/activation/chatController.ts`

## Notes

- compile and lint clean (one pre-existing warning in webviewProtocol.ts); npm test: 2336 passing, 1 pending.
- No vscode import in transcriptReader.ts; the removed helpers no longer exist in chatController.ts.
- Type imports in chatController.ts were left in place; tsc/lint reported none unused.
