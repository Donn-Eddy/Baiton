# Execute T03

## Summary

OpenAiModelClient now reports every failed completion call to an injected apiLog (optional apiLog and surfaceId config, defaults noopApiLog / 'openai'). Each postCompletion rejection (abort, http-status with status and body excerpt, response-stream error, connect timeout, connection error) logs exactly once, guarded by the settled check. A non-JSON non-streaming body logs malformed-response. Thrown errors are unchanged. Missing config, the pre-start aborted check and successful calls log nothing. Added 13 tests in an 'API failure log' describe block.

## Files changed

- `src/orchestrator/modelClient.ts`
- `test/modelClient.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -c vscode src/orchestrator/modelClient.ts`

## Notes

- compile is clean; npm test: 2276 passing, 1 pending, no failures, including all pre-existing modelClient tests unmodified.
- lint reports 0 errors and 1 warning, in src/orchestrator/webviewProtocol.ts (unused '_legacy'), which this change does not touch.
- modelClient.ts has no vscode import (grep count 0).
- The truncated-stream test passes on this Node version, giving one connection entry. I gave it connectTimeoutMs 2000 as a safety net and it did not need the fallback.
- The silent-server tests call closeAllConnections() before close so the servers shut down promptly.
