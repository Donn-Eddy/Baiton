# Plan T04

## Steps

1. Add the apiLog option to CopilotClientConfig

   In src/orchestrator/copilotClient.ts add `import { noopApiLog } from './apiLog';` and `import type { ApiFailureKind, ApiLog } from './apiLog';` next to the './modelClient' import. These are relative orchestrator imports, so no `vscode` runtime import is added. Add an optional field to `CopilotClientConfig`, after `justification`: `/** Receives one entry per failed Copilot call; defaults to {@link noopApiLog}. Successful calls never touch it. */ apiLog?: ApiLog;`. The doc comment matches the one on `ModelClientConfig.apiLog` in modelClient.ts:170. Existing constructors and tests compile unchanged because the field is optional.

   Files: `src/orchestrator/copilotClient.ts`

2. Add a pure classifier next to mapCopilotError

   Add an exported function below `mapCopilotError`: `export function classifyCopilotFailure(err: unknown): ApiFailureKind | undefined`. It reads the error code with the same defensive `typeof (err as { code?: unknown } | null)?.code === 'string'` logic that mapCopilotError uses. Extract a small private helper `copilotErrorCode(err: unknown): string | undefined` and use it in both functions. That refactor must leave mapCopilotError's behaviour identical: same branches, same messages, same `cause`. Rules: `err instanceof MissingConfigError` → undefined, because a missing or stale model is config, not a call failure. `code === 'NotFound'` → undefined, because it maps to MissingConfigError('model') and is not logged. `code === 'NoPermissions' || code === 'Blocked'` → 'refused'. Anything else, including an `UnreachableEndpointError` or a plain Error → 'connection'. Do NOT change mapCopilotError's return values.

   Files: `src/orchestrator/copilotClient.ts`

3. Add a private logFailure helper on CopilotModelClient

   Mirror OpenAiModelClient.logFailure (modelClient.ts:607-618). Add `private logFailure(model: string, kind: ApiFailureKind, message: string): void { try { (this.config.apiLog ?? noopApiLog).failure({ surface: COPILOT_VENDOR, operation: 'completion', target: model, kind, message }); } catch { /* logging must never change the call's outcome */ } }`. `COPILOT_VENDOR` is the string 'copilot'; you may use the literal 'copilot' instead if that reads better. Omit `status` and `bodyExcerpt`, since vscode.lm has neither. Add a helper that builds the message: for 'refused', `Copilot request was refused (${code}): ${describe(err)}`; otherwise `Copilot request failed: ${describe(err)}`. Simplest approach: log `mapCopilotError(err).message`, which already produces exactly those strings. apiLog.failure() redacts the message, so no call-site redaction is needed.

   Files: `src/orchestrator/copilotClient.ts`

4. Log at the two failure points in complete()

   Make these changes in `CopilotModelClient.complete`. (1) Leave the early `MissingConfigError('model')` from `getModel()` unlogged. Leave the pre-aborted `req.signal.aborted` check unlogged too, because no call has been made; add the comment `// Not logged: no call has been made yet.` as modelClient.ts:574 does. (2) Model selection try/catch: the local `throw new MissingConfigError('model')` when `found === undefined` lands in the catch, and classify returns undefined for it, so it stays unlogged. Change the catch body to: `const kind = classifyCopilotFailure(err); if (kind !== undefined) { this.logFailure(model, kind, mapCopilotError(err).message); } throw mapCopilotError(err);`. Better, compute `const mapped = mapCopilotError(err)` once and log `mapped.message`. (3) sendRequest/stream try/catch: replace the ternary with `if (req.signal.aborted) { this.logFailure(model, 'abort', 'request was aborted'); throw new UnreachableEndpointError('request was aborted'); } const kind = classifyCopilotFailure(err); const mapped = mapCopilotError(err); if (kind !== undefined) { this.logFailure(model, kind, mapped.message); } throw mapped;`. The thrown errors must stay exactly as they are today: same classes, messages and cause. Each rejection path writes at most one entry. The success path writes none. Update the class doc comment to say failed calls go to `config.apiLog`, and that a missing, stale or NotFound model and a pre-start abort are not logged.

   Files: `src/orchestrator/copilotClient.ts`

5. Add apiLog tests to test/copilotClient.test.ts

   Import `createApiLog` and `ApiLog` from '../src/orchestrator/apiLog'. Add a helper `function recordingLog(): { log: ApiLog; lines: string[] } { const lines: string[] = []; return { log: createApiLog((l) => lines.push(l), () => 'T'), lines }; }`. Add `describe('API failure log', ...)` with one test per case, each building `new CopilotModelClient({ api: clientApi, getModel: async () => 'fake-model', apiLog: log })`:
   (a) Success with a text part: `lines.length === 0`.
   (b) sendRequest rejects with `fakeMod.LanguageModelError.NoPermissions('denied')`: rejects UnreachableEndpointError. Exactly one line, containing 'copilot completion refused', ' fake-model ' and 'NoPermissions'.
   (c) The same with Blocked('quota'): one 'refused' line containing 'Blocked'.
   (d) sendRequest rejects `new Error('boom')`: one line containing 'copilot completion connection' and 'boom'.
   (e) `selectChatModels` throws: install a custom `__vscodeFake` whose lm.selectChatModels is `async () => { throw new Error('lm down'); }`. Do not use install(), or override globalThis.__vscodeFake after install(). Expect one 'connection' line and an UnreachableEndpointError rejection.
   (f) Abort mid-stream, using the existing throwMidStream + onIterate: controller.abort() pattern: one line containing 'copilot completion abort'.
   (g) A mid-stream Blocked throw without abort: one 'refused' line.
   (h) Not logged: NotFound from sendRequest, an empty model list, getModel → undefined and a pre-aborted signal each still reject as today (MissingConfigError / UnreachableEndpointError) with `lines.length === 0`.
   (i) Redaction: sendRequest rejects `new Error('bad token Bearer abc.def.ghi')`. The line contains '[REDACTED]' and not 'abc.def.ghi'.
   (j) Without apiLog: the existing tests already cover the noop default. Also add one explicit case where a throwing sink (`createApiLog(() => { throw new Error('sink'); })`) does not change the rejection class.
   All existing tests must stay unmodified and passing.

   Files: `test/copilotClient.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. All must be green. The only acceptable lint output is the pre-existing warning in webviewProtocol.ts. Use grep to confirm that src/orchestrator/copilotClient.ts still has only `import type * as vscode` and no runtime `vscode` import.

   Files: (none)

## Risks

- Changing mapCopilotError's output while extracting the code helper would break the existing error-mapping tests and the chat controller's branching. Keep its branches and messages byte-identical.
- Double logging: log only inside the two catch blocks, and throw the mapped error after logging. Do not also log in `finally` or in a caller. ProviderRouter wiring (passing apiLog in) belongs to a later todo, not here.
- The found===undefined path throws MissingConfigError inside the try, so it reaches the catch. The classifier must return undefined for MissingConfigError, otherwise a stale model would be logged as 'connection'.
- The abort check must run before classification in the stream catch. When the signal is aborted, the fake's 'cancelled' Error would otherwise be logged as 'connection'.
- Test (e) swaps globalThis.__vscodeFake. clientApi.lm must resolve through the fake module's getter to the current global. If the fake module snapshots `lm` at import time, build clientApi with a custom `lm: { selectChatModels: async () => { throw ... } }` override instead.

## Acceptance

- CopilotClientConfig has an optional `apiLog?: ApiLog`. Omitting it behaves exactly as before and uses noopApiLog.
- NoPermissions/Blocked from selectChatModels, sendRequest or mid-stream each produce exactly one entry with kind 'refused', surface 'copilot', operation 'completion' and target the configured model id.
- Other selectChatModels/sendRequest/stream throws produce exactly one 'connection' entry. An abort during the request/stream produces exactly one 'abort' entry.
- A successful completion, a NotFound model, a model missing from the list, getModel returning undefined, and a pre-aborted signal produce zero entries.
- Errors thrown by complete() and the results of mapCopilotError are unchanged: the existing tests in test/copilotClient.test.ts pass unmodified.
- Secrets in the error message are redacted in the logged line, and a throwing sink never changes the thrown error.
- src/orchestrator/copilotClient.ts has no runtime `vscode` import.
- `npm run compile`, `npm run lint` and `npm test` all pass.
