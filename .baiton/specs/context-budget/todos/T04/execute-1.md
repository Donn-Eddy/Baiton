# Execute T04

## Summary

Added CompletionUsage/CompletionResult.usage and parseUsage; parsed usage on non-streaming and SSE paths (read before the delta early return, last valid kept, key only set when defined); sent stream_options.include_usage behind isUsageInStream / baiton.orchestrator.usageInStream (wired through ProviderSettings, providerClientConfig, commands.ts, package.json); added estimateTokens, estimateMessages, ContextTracker and related exports to contextBudget.ts; added tests. Compile, lint and full test suite pass.

## Files changed

- `src/orchestrator/modelClient.ts`
- `src/orchestrator/copilotClient.ts`
- `src/orchestrator/contextBudget.ts`
- `src/activation/providerRouter.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/modelClient.test.ts`
- `test/contextBudget.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2382 passing, 1 pending, 0 failing; lint has 0 errors and one pre-existing warning (webviewProtocol.ts _legacy).
- No existing test expectations were changed.
- SseCompletionParser.handleLine also now null-guards `event` when reading choices.
