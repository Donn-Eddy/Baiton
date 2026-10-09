# Execute T02

## Summary

Implemented the host-free UsageService in src/usage/usageService.ts (injected readers, clock, timer; per-read timeout; per-tool coalescing; stale fallback keeping original source.readAt; never throws; fail-closed trusted flag; polling; dispose; redactSecrets), re-exported it from src/usage/index.ts, and added 15 mocha tests in test/usage.service.test.ts.

## Files changed

- `src/usage/usageService.ts`
- `src/usage/index.ts`
- `test/usage.service.test.ts`

## Commands run

- `npm run compile`
- `npx mocha test/usage.service.test.ts test/usage.model.test.ts (the repo mocharc ran the full suite: 2649 passing, 1 pending, 0 failing)`
- `npm run lint`

## Notes

- The todo text in the brief was truncated after 'Behaviour:'; behaviour followed the plan.
- Lint has 0 errors and one pre-existing warning in src/orchestrator/webviewProtocol.ts, none in the new files.
- isTrusted defaults to false; host wiring must pass vscode.workspace.isTrusted explicitly.
- Readers must honour ctx.signal; a timed-out reader's late result is discarded but its work may linger.
- The host-free test reads the source with fs and checks that every import/export-from line targets './model'.
