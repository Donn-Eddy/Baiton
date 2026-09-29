# Execute T04

## Summary

CopilotModelClient now accepts an optional apiLog and logs failed calls: NoPermissions/Blocked as refused, other selectChatModels/sendRequest/stream throws as connection, and an abort during the request/stream as abort. NotFound, a missing or stale model, getModel returning undefined and a pre-start abort are not logged. Errors thrown and mapCopilotError's results are unchanged. Added exported classifyCopilotFailure, a private copilotErrorCode helper and a private logFailure, plus 10 tests in a new 'API failure log' describe block.

## Files changed

- `src/orchestrator/copilotClient.ts`
- `test/copilotClient.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -n "vscode'" src/orchestrator/copilotClient.ts`

## Notes

- npm test: 2286 passing, 1 pending. Lint: only the pre-existing webviewProtocol.ts warning.
- copilotClient.ts still has only `import type * as vscode`; no runtime vscode import.
- Test (e) passes an api object with a custom lm.selectChatModels that throws, rather than swapping globalThis.__vscodeFake, as the plan's risk note allowed.
