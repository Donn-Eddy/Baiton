# Execute T08

## Summary

Added the pre-flight budget check. contextBudget.ts gained DEFAULT_OUTPUT_RESERVE, resolveOutputReserve, contextOverflowNotice and fitToWindow (trim, then summarise, then re-estimate). ContextBudget in toolLoop.ts gained an optional preflight, and the loop stops with the sized notice on overflow without calling the endpoint. ChatController wires preflight through fitToWindow, trimHistory and compact, with new optional maxTokens/maxOutput deps that commands.ts supplies. An empty or whitespace-only 4xx body now throws 'endpoint returned HTTP N (empty body; payload ~T tokens)', and the API-log line carries the same text. Tests cover the loop notice path, fitToWindow, the reserve and the error text.

## Files changed

- `src/orchestrator/contextBudget.ts`
- `src/orchestrator/toolLoop.ts`
- `src/orchestrator/modelClient.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `test/toolLoop.test.ts`
- `test/contextBudget.test.ts`
- `test/modelClient.test.ts`
- `test/chatController.compaction.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -rn "from 'vscode'" src/orchestrator`

## Notes

- The existing compaction controller tests in test/chatController.compaction.test.ts broke: their 1000-token window is smaller than the ~1200-token system prompt, so the new pre-flight overflowed every request. I changed those tests to window 3000 with maxTokens: () => 1. This is a test-only change and the compaction behaviour they check is unchanged.
- I skipped the optional controller-level overflow test as brittle against the system prompt size.
- commands.ts is outside the todo's file list. I added the two-line maxTokens/maxOutput wiring there, as the plan allowed.
- compile and npm test are green (2461 passing). lint has 0 errors and 1 warning, an unused variable in webviewProtocol.ts that this change did not touch.
- The vscode grep in src/orchestrator shows only the existing type import in copilotClient.ts.
