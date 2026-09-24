# Execute T04

## Summary

Implemented T04: CopilotModelClient over vscode.lm. src/orchestrator/copilotClient.ts exports CopilotModelClient implements ModelClient plus CopilotClientConfig, CopilotVscodeApi, COPILOT_VENDOR, COPILOT_JUSTIFICATION, toCopilotMessages, toCopilotTools, parseCopilotToolInput, selectCopilotModel and mapCopilotError. The vscode import is type-only (no runtime require) so the orchestrator barrel stays host-free; the vscode surface is injected. Message mapping turns system/user into User text-part messages, assistant into Assistant messages (text omitted when blank, tool calls as ToolCallParts with parsed object input) and collapses runs of consecutive tool messages into one User message of ToolResultParts in transcript order, without mutating the input. Tools map to { name, description, inputSchema }; options.tools is omitted entirely when the request carries none. complete() aborts up front on a pre-aborted signal, resolves the model by id then family via lm.selectChatModels({ vendor: 'copilot' }), streams text parts to onDelta, collects tool-call parts as ToolCall JSON-argument strings in stream order, aborts mid-stream through a CancellationTokenSource disposed in a finally on every path, and maps codes NotFound→MissingConfigError('model'), NoPermissions/Blocked and everything else→UnreachableEndpointError (our own errors never re-wrapped). src/orchestrator/index.ts re-exports the new module. test/fixtures/vscodeFake.mjs gained LanguageModelChatMessage(+Role), LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelChatToolMode, LanguageModelError (NotFound/NoPermissions/Blocked), a working CancellationTokenSource and a delegating lm, with pre-existing exports untouched; test/fixtures/vscodeFake.d.mts provides its type surface. test/copilotClient.test.ts loads the fake through fixtures/vscodeLoader.mjs and covers message mapping (direct and end-to-end), tool input/tool mapping, streaming text, tool-call collection, model resolution, abort (pre- and mid- stream plus disposal on both paths), error mapping and sessionId isolation: 36 passing.

## Files changed

- `src/orchestrator/copilotClient.ts`
- `src/orchestrator/index.ts`
- `test/fixtures/vscodeFake.mjs`
- `test/fixtures/vscodeFake.d.mts`
- `test/copilotClient.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json (clean)`
- `npx eslint src/orchestrator/copilotClient.ts src/orchestrator/index.ts test/copilotClient.test.ts --ext .ts (clean)`
- `npx mocha test/copilotClient.test.ts (36 passing, 0 failing)`
- `npx mocha test/askWatcher.routing.test.ts test/chatController.autoMode.test.ts test/chatController.interventions.test.ts test/setApiKey.test.ts test/configPanel.controller.test.ts (1310 passing, 1 pending, 0 failing — mocharc spec union; confirms the barrel stays loadable with no VS Code host)`
- `npm run test:unit (1234 passing, 1 pending, 0 failures — above the T02 baseline of 1189/1)`

## Notes

- While debugging, a temporary BAITON_DBG debug line was added to src/orchestrator/copilotClient.ts and the test's FakeChat and removed after the root cause (returning the generator function instead of its instance) was fixed; the shipped code contains no debug logging.
- The fake's CancellationTokenSource exposes a `disposed` getter; tests observe client-created instances by constructing a recording subclass during install() rather than mutating the frozen fake-module namespace.
- Debug-only note during development: plain `npx mocha test/file.test.ts` is a union with .mocharc spec (runs the whole suite); the release-adapter failure list seen before the fix was entirely from test/copilotClient.test.ts, no pre-existing suites regressed in the final runs.
- mapCopilotError reads LanguageModelError codes defensively (no instanceof) since the fake's classes live in another module realm; stream parts are duck-typed on value/callId+name for the same reason.
