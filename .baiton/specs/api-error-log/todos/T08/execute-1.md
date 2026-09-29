# Execute T08

## Summary

OpencodeAdapter.discoverFromApi now writes one ctx.apiLog entry (surface 'opencode', operation 'model list', target = request URL) for a non-2xx response, a timeout, a request failure and unparseable JSON. A caller abort, a 2xx success and the CLI path log nothing. ClaudeAdapter forwards ctx.apiLog to its feed fetcher, and the default fetcher passes it on to fetchModelsDev. The adapter adds no entry of its own. Added tests for both adapters. compile, lint and npm test all pass (2328 passing, 1 pending).

## Files changed

- `src/adapter/opencode.ts`
- `src/adapter/claude.ts`
- `test/adapter.opencode.test.ts`
- `test/adapter.claude.test.ts`

## Commands run

- `npx tsc --noEmit -p .`
- `npm run compile`
- `npm run lint`
- `npm test`
- `grep -n apiLog src/adapter/opencode.ts src/adapter/claude.ts`
- `grep -rn "from 'vscode'" src/adapter`

## Notes

- The opencode non-2xx branch reads the response body for the excerpt inside the existing try, so the finally still clears the timer and removes the abort listener.
- The timedOut flag is set before controller.abort() in the timer callback, so a timeout is classified 'timeout' and not 'connection'.
- The one lint warning (unused '_legacy' in src/orchestrator/webviewProtocol.ts) was already there and is unrelated to this change.
- No vscode import was added under src/adapter/.
